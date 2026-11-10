# SPEC-03: Chuyển Vùng Xuyên Vùng Trực Tiếp (Cross-Region Live Migration)

> **Phiên bản**: `1.1.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Tài liệu cha**: [SPEC-00: Agent Scope Guard](SPEC-00-AGENT-SCOPE-GUARD.md)

---

## 1. Tổng Quan Kiến Trúc & Mô Hình Active-Passive

Hệ thống XRegion cung cấp giải pháp chuyển vùng máy ảo an toàn giữa môi trường **Private Cloud OpenStack** (chạy trên EC2 node Sydney) và **AWS Public Cloud** (`ap-southeast-2`).

> [!IMPORTANT]
> ### NGUYÊN TẮC MÔ HÌNH: LUÔN DUY TRÌ ACTIVE-PASSIVE (KHÔNG DỌN DẸP SOURCE VM)
> - Sau khi quá trình di trú chuyển vùng hoàn tất thành công sang vùng đích:
>   - **Máy ảo đích (Target VM)**: Trở thành máy ảo chính (**Active**), gắn Elastic IP mới và nhận toàn bộ lưu lượng qua Route 53 DNS.
>   - **Máy ảo nguồn (Source VM)**: Chuyển sang trạng thái dự phòng thụ động (**Passive / STOPPED**), **TUYỆT ĐỐI KHÔNG ĐƯỢC XÓA HAY DỌN DẸP**.
>   - Toàn bộ Boot Volume và cấu hình của Source VM được bảo lưu nguyên vẹn để sẵn sàng cho kịch bản phục hồi khẩn cấp (**Failback / Reverse Migration**) khi vùng đích gặp sự cố.

### Phân Định Lộ Trình Kiến Trúc (Architecture Transition Note)
- **Hiện trạng Codebase Giai đoạn 1 (`MigrationService.java`)**: Đang sử dụng luồng mô phỏng bất đồng bộ (`Thread.sleep`, sinh IP ngẫu nhiên) nhằm phục vụ việc kiểm thử giao diện Dashboard và đo lường thời gian hiển thị.
- **Tiêu Chuẩn Đích (Target Architecture - SPEC-03)**: Đây là kiến trúc chuẩn hóa bắt buộc phải tuân thủ cho toàn bộ các công việc lập trình, refactor hoặc viết test case di trú hạ tầng thật sự trong giai đoạn tiếp theo.

---

## 2. Cơ Chế Điều Phối & Khóa Phân Tán (Distributed Lock & SQS FIFO)

Nhằm đảm bảo tính tuần tự, chống nghẽn và ngăn chặn xung đột dữ liệu (Race Conditions) khi nhiều yêu cầu di trú được gửi tới cùng lúc:

1. **Tuần tự hóa qua AWS SQS FIFO**:
   - Mọi yêu cầu di trú từ Dashboard/API được đẩy vào hàng đợi **SQS FIFO**.
   - `MessageGroupId = instance_id`: Đảm bảo các yêu cầu liên quan đến cùng một máy ảo luôn được xử lý tuần tự theo đúng thứ tự đến trước.
   - `MessageDeduplicationId`: Ngăn chặn việc gửi trùng lặp yêu cầu di trú trong cửa sổ 5 phút.
2. **Khóa phân tán qua Redis Distributed Lock (Redisson)**:
   - Trước khi bắt đầu Bước 1, tiến trình bắt buộc phải chiếm thành công Redis Lock với khóa: `lock:migration:{instance_id}`.
   - Cơ chế: `SET lock:migration:{instance_id} {worker_id} NX EX 900` (TTL mặc định 15 phút).
   - Tích hợp cơ chế **Watchdog / Auto-Renew**: Tự động gia hạn thêm thời gian giữ khóa nếu quá trình sao chép Snapshot dung lượng lớn kéo dài vượt ngưỡng an toàn.
   - Bất kỳ yêu cầu nào không chiếm được khóa sẽ bị từ chối với lỗi **`HTTP 409 Conflict`**.
3. **Thời gian bảo vệ Cooldown (10 phút)**:
   - Sau khi hoàn tất Bước 7 và giải phóng Redis Lock, hệ thống thiết lập cờ `cooldown_until = now + 600s` trong DynamoDB.
   - Trong vòng 10 phút này, mọi yêu cầu di trú tiếp theo trên máy ảo đó đều bị chặn.

---

## 3. Chuỗi Pipeline 7 Bước Thực Thi Chuẩn Hóa

```mermaid
flowchart TD
    Req([Yêu cầu Live Migration]) --> Q[SQS FIFO Queue]
    Q --> Lock[Chiếm Redis Distributed Lock - TTL 15m]
    
    Lock --> S1[Bước 1: Dừng Nova VM STOPPED & Bấm giờ RTO]
    S1 --> S2[Bước 2: Tạo EBS Snapshot của Volume nguồn]
    S2 --> S3[Bước 3: Kiểm tra tính toàn vẹn Snapshot]
    S3 --> S4[Bước 4: Sao chép Incremental Snapshot sang vùng đích]
    S4 --> S5[Bước 5: Dựng lại EBS Volume từ Snapshot tại đích]
    S5 --> S6[Bước 6: Khởi tạo Nova VM tại vùng đích từ Volume]
    S6 --> S7[Bước 7: Cập nhật DNS Route 53 sang IP mới]
    
    S7 --> Done([Hoàn tất: Dừng đo RTO, Giải phóng Lock, Đặt Source VM = Passive STOPPED])

    S1 -.->|Lỗi| Rollback[Auto-Rollback: Bật lại Source VM, Mở Redis Lock, Báo FAILED]
    S2 -.->|Lỗi| Rollback
    S3 -.->|Lỗi| Rollback
    S4 -.->|Lỗi| Rollback
    S5 -.->|Lỗi| Rollback
    S6 -.->|Lỗi| Rollback
    S7 -.->|Lỗi| RollbackDNS[Revert Route 53 về Source IP -> Auto-Rollback]
```

### Chi tiết hành động tại từng bước:
- **Bước 1: Dừng Nova VM an toàn (`STOP_SOURCE_VM`)**:
  - Gửi lệnh tắt máy ảo nguồn, chờ trạng thái chuyển hẳn sang `STOPPED` (`SHUTOFF`).
  - Bấm giờ đo Downtime RTO (`sourceStoppedMs = currentTimeMillis()`).
  - Cập nhật trạng thái `MIGRATING` trên DynamoDB `XRegion-Instances`.
- **Bước 2: Tạo EBS Snapshot (`CREATE_EBS_SNAPSHOT`)**:
  - Gọi AWS EC2 API `CreateSnapshot` trên EBS volume gắn với máy ảo nguồn.
  - Tiến độ ghi nhận: 20%.
- **Bước 3: Kiểm tra tính toàn vẹn Snapshot (`VERIFY_SNAPSHOT`)**:
  - Polling kiểm tra trạng thái snapshot cho đến khi đạt `completed`.
  - Xác thực kích cỡ và mã checksum đảm bảo dữ liệu không bị hỏng.
  - Tiến độ ghi nhận: 40%.
- **Bước 4: Sao chép Snapshot lũy tiến (`COPY_INCREMENTAL_SNAPSHOT`)**:
  - Truyền tải dữ liệu snapshot sang vùng đích.
  - Sử dụng cơ chế sao chép lũy tiến (Incremental Copy) dựa trên parent snapshot để tối ưu thời gian truyền và chỉ copy phần dữ liệu delta thay đổi.
  - Tiến độ ghi nhận: 65%.
- **Bước 5: Dựng lại EBS Volume tại vùng đích (`PROVISION_TARGET_VOLUME`)**:
  - Khởi tạo EBS Volume mới (chuẩn `gp3`, cấu hình IOPS và Throughput tối ưu) từ Snapshot vừa chuyển giao.
  - Chờ volume chuyển sang trạng thái `available`.
  - Tiến độ ghi nhận: 80%.
- **Bước 6: Khởi tạo Nova VM tại vùng đích (`BOOT_TARGET_VM`)**:
  - Gọi Nova API khởi tạo máy ảo mới từ boot volume tại vùng đích.
  - Cấp phát và gắn Elastic IP mới, đồng bộ SSH Keypair và Security Group 1-1 tương ứng.
  - Kiểm tra trạng thái máy ảo chuyển sang `RUNNING` và thực hiện TCP ping/port 22 healthcheck.
  - Tiến độ ghi nhận: 90%.
- **Bước 7: Chuyển đổi DNS Route 53 Cutover (`ROUTE53_DNS_CUTOVER`)**:
  - Cập nhật bản ghi DNS A-Record trên AWS Route 53 (TTL 60s) trỏ về Elastic IP mới của máy ảo đích.
  - Dừng đồng hồ đo Downtime RTO, tính toán và lưu `downtime_seconds` vào `XRegion-Migrations`.
  - Cập nhật DynamoDB: `current_region = target_region`, `current_status = RUNNING`.
  - Đặt Source VM ở trạng thái **Passive (`STOPPED`)** (không xóa).
  - Giải phóng Redis Distributed Lock và kích hoạt thời gian Cooldown 10 phút.
  - Tiến độ ghi nhận: 100%.

---

## 4. Kịch Bản Rollback & Phục Hồi Khi Phát Sinh Sự Cố

- **Lỗi ở Bước 1 đến Bước 6 (Trước thời điểm DNS Cutover)**:
  1. Hủy bỏ máy ảo đích và xóa EBS volume dở dang tại vùng đích.
  2. Xóa snapshot tạm thời nếu đang sao chép dở.
  3. Khởi động lại máy ảo nguồn (`START`) về trạng thái `RUNNING`.
  4. Giải phóng Redis Lock.
  5. Cập nhật DynamoDB trạng thái `FAILED`, ghi rõ chi tiết bước gặp sự cố.
- **Lỗi ở Bước 7 (Trong hoặc sau thời điểm DNS Cutover)**:
  1. Lập tức gọi Route 53 API hoàn nguyên (Revert) bản ghi DNS A-Record trỏ ngược lại Elastic IP của máy ảo nguồn.
  2. Bật lại máy ảo nguồn (`START`).
  3. Giải phóng Redis Lock và báo lỗi `FAILED`.

---

## 5. Ràng Buộc Kiểm Thử & Chống Sai Lệch Cho Agent (Testing Constraints)

> [!WARNING]
> Khi Agent lập trình hoặc viết Test Suite cho tính năng Live Migration:
> 1. **CẤM TUYỆT ĐỐI**:
>    - Không được tự ý rút gọn còn 4-5 bước hoặc hoán đổi vị trí của Bước 3 (Verify Snapshot).
>    - Không được tự thêm các bước phụ như backup S3 ngoài phạm vi đã định.
>    - Không được sinh code tự động xóa Source VM sau khi di trú thành công (vi phạm mô hình Active-Passive).
> 2. **Bộ Test Suite BẮT BUỘC phải bao quát tối thiểu 4 kịch bản**:
>    - `test_migration_happy_path_7_steps`: Di trú thành công qua đủ 7 bước, đo đúng RTO, Source VM chuyển Passive `STOPPED`.
>    - `test_redis_lock_contention`: Hai yêu cầu di trú cùng 1 instance -> Yêu cầu thứ 2 nhận lỗi `HTTP 409 Conflict`.
>    - `test_rollback_on_snapshot_copy_failure`: Bước 4 sao chép snapshot lỗi -> Dọn tài nguyên đích dở dang, bật lại Source VM.
>    - `test_rollback_dns_revert_on_step7_failure`: Bước 7 lỗi -> Hoàn nguyên DNS Route 53 về IP cũ.

---

## 6. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành tài liệu chuẩn hóa quy trình Live Migration 7 bước Active-Passive và Redis Distributed Lock. |
| `2026-11-10` | `1.1.0` | Lead Architect / Product Owner | Phân định lộ trình kiến trúc chuyển tiếp: MigrationService.java hiện tại là Mock UI giai đoạn 1, SPEC-03 là kiến trúc đích bắt buộc. Đồng bộ enum RUNNING/STOPPED. |
