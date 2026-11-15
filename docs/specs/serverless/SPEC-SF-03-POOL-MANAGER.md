# SPEC-SF-03: Trình Quản Lý & Tự Bù Đắp Warm Pool (Cinder Pool Manager)

> **Phiên bản**: `1.5.0`<br>
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`<br>
> **Ngày phê duyệt**: `2026-11-15`<br>
> **Tài liệu cha**: [SPEC-SF-00: Serverless Scope Guard](SPEC-SF-00-SERVERLESS-SCOPE-GUARD.md)

---

## 1. Tổng Quan Mục Đích & Kiến Trúc Bù Đắp Tự Động

Lambda `XRegion-CinderPoolManager` chỉ duy trì boot volume Cinder **`1 GiB` cho image logic `cirros-0.6.2-x86_64`**, chuẩn `aws-ebs-gp3`, ở trạng thái `AVAILABLE` trong `XRegion-Volumes`. Áp dụng [SPEC-09](../SPEC-09-COMPUTE-CATALOG.md): chọn UUID image của đúng vùng, không bù pool Alpine/Ubuntu hoặc image khác. Hai flavor được hỗ trợ là `tiny` và `mini`.

- **Mã nguồn**: `serverless/launch-contract/XRegion-CinderPoolManager/cinder_pool_manager.py`.
- **Cơ chế kích hoạt kép (Dual Trigger)**:
  1. **Định kỳ (Periodic Schedule)**: Kích hoạt mỗi **10 phút** qua AWS EventBridge Scheduler.
  2. **Theo sự kiện (Event-Driven)**: Nhận sự kiện `instance.terminated` để kích hoạt dọn dẹp hoặc cân bằng pool ngay lập tức.

---

## 2. Ràng Buộc Dung Lượng Pool Bất Biến (Capacity Mandate)

> [!IMPORTANT]
> ### GIỚI HẠN WARM POOL TỐI ĐA 5 ĐƠN VỊ (`max(0, 5 - occupied)`)
> - Số lượng tài nguyên rảnh rỗi (`AVAILABLE` hoặc đang `CREATING`) trong Warm Pool đối với mỗi catalog ảnh (`image_id`) **TẠI MỌI THỜI ĐIỂM TỐI ĐA LÀ 5 ĐƠN VỊ (<= 5)**.
> - Chỉ có một image logic `cirros-0.6.2-x86_64` mỗi vùng; tính `occupied` theo UUID image và region tương ứng. Không cộng volume thuộc vùng khác hoặc bù thêm pool cho image ngoài danh mục SPEC-09.
> - Công thức bù đắp trong Lambda bắt buộc phải tuân thủ:
>   ```python
>   occupied = sum(r["status"] in ("AVAILABLE", "CREATING") for r in rows)
>   refill_count = max(0, 5 - occupied)
>   ```
> - **CẤM TUYỆT ĐỐI**: Không được tăng con số này lên 3 hay bất kỳ giá trị nào khác nếu chưa có sự phê duyệt bằng văn bản của Chủ dự án (để bảo vệ ngân sách chi phí lưu trữ EBS gp3 trên AWS).

---

## 3. Cơ Chế Khóa Phân Tán & Chống Trùng Lặp (Atomic Lock & Idempotency)

1. **Khóa nguyên tử theo catalog ảnh (`EBS-POOL-LOCK#{image_id}`)**:
   - Trước khi quét và bù đắp pool cho một image, tiến trình phải ghi bản ghi khóa vào `XRegion-Volumes`:
     ```python
     Item = {
         "volume_id": f"EBS-POOL-LOCK#{image_id}",
         "status": "CONTROL",
         "lock_token": token,
         "lock_until": now + 1200  # TTL 20 phút
     }
     ```
   - Điều kiện ghi: `attribute_not_exists(volume_id) OR lock_until < :now`.
   - Nếu xảy ra `ConditionalCheckFailedException`: Bỏ qua lượt quét cho image đó để tránh 2 worker cùng tạo tài nguyên đồng thời.
2. **Ghi nhận `post_attempted` trước khi gọi Cinder POST**:
   - Trước khi gửi lệnh `POST /volumes` tạo volume trên Cinder, Lambda bắt buộc phải cập nhật cờ `post_attempted = True` vào DynamoDB.
   - Nếu lệnh POST bị timeout hoặc mất kết nối, các lượt chạy sau **tuyệt đối không được gửi lại lệnh POST thứ hai mù quáng** (tránh sinh volume rác ngoài tầm kiểm soát).

---

## 4. Cơ Chế Phát Hiện & Xử Lý Bản Ghi Rác (Stale Volume Detection)

Trước khi tính `occupied` slots, Lambda đối soát trực tiếp với hạ tầng thực tế:
- Gọi Cinder REST API kiểm tra volume ID thực tế.
- Nếu Cinder trả về `HTTP 404` hoặc volume không còn thuộc tính `bootable=true`:
  - Cập nhật trạng thái bản ghi trong DynamoDB sang **`STALE`**.
  - Các bản ghi `STALE` bị loại khỏi số lượng `occupied` để nhường chỗ bù đắp volume mới.
- Nếu gặp lỗi mạng tạm thời (Transient Error / Throttling): Giữ nguyên vị trí slot, không đánh dấu `STALE` bừa bãi.

---

> Thông số flavor bắt buộc theo SPEC-09 v1.1.0: `m1.tiny` ID `1` = 1 vCPU, 1024 MiB RAM, root disk 1 GiB; `m1.mini` ID `2` = 1 vCPU, 2048 MiB RAM, root disk 1 GiB.

## 5. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành đặc tả Cinder Pool Manager, chuẩn hóa giới hạn pool <= 2 volume rảnh rỗi, khóa nguyên tử 20 phút và cơ chế chống ambiguous POST. |
| `2026-11-12` | `1.1.0` | Lead Architect / Product Owner | Cập nhật kích thước pool volume động max(1, min_disk), chuẩn hóa 1 GiB cho CirrOS/Alpine qua xacnhan-skill. |
| `2026-11-13` | `1.3.0` | Chủ dự án (`xacnhan-skill`) | Đồng bộ công thức `refill_count = max(0, 5 - occupied)` với ngưỡng tối đa `5` Volume rảnh rỗi (phân tách với ngưỡng `2` EIP rảnh rỗi tại `SPEC-02 v1.2.0`). |
| `2026-11-15` | `1.4.0` | Chủ dự án (yêu cầu trực tiếp) | Chỉ bù pool CirrOS-0.6.2 1 GiB theo vùng; tối đa 5 AVAILABLE/CREATING mỗi vùng, không bù Alpine/Ubuntu. |
| `2026-11-15` | `1.5.0` | Chủ dự án (kế hoạch đã duyệt) | Chuẩn hóa tên image cirros-0.6.2-x86_64; tiny ID 1: 1 vCPU/1024 MiB/1 GiB, mini ID 2: 1 vCPU/2048 MiB/1 GiB theo SPEC-09 v1.1.0. |
