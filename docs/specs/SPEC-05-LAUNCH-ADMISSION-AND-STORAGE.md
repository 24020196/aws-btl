# SPEC-05: Kiểm Soát Nhập Lệnh & Lưu Trữ Đĩa Cinder/EBS (Admission & Storage)

> **Phiên bản**: `1.3.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-13`  
> **Tài liệu cha**: [SPEC-00: Agent Scope Guard](SPEC-00-AGENT-SCOPE-GUARD.md)

---

## 1. Cổng Kiểm Soát Nhập Lệnh (Launch Admission Control Gate)

Để bảo vệ hạ tầng máy chủ trong các đợt bảo trì hoặc khắc phục sự cố, hệ thống áp dụng cơ chế Admission Gate tại lớp Backend (`LaunchAdmissionService.java`):

### 1.1. Tham số Cấu Hình Trung Tâm
- **Nơi lưu trữ**: AWS Systems Manager Parameter Store.
- **Tên tham số**: `/xregion/{region}/launch/admission` (ví dụ: `/xregion/us-east-1/launch/admission` cho Region A và `/xregion/ap-southeast-2/launch/admission` cho Region B).
- **Định dạng dữ liệu**: Chuỗi JSON có cấu trúc:
  ```json
  {
    "mode": "open",
    "canary": {
      "username": "admin",
      "name": "ping-test-canary",
      "key_id": "key-canary-uuid"
    }
  }
  ```

### 1.2. Quy Tắc Xét Duyệt Nhập Lệnh (Admission Logic)
Mỗi khi có yêu cầu `POST /api/instances`:
1. **Kiểm tra trạng thái hệ thống**:
   - Backend phân giải vùng mục tiêu từ request và đọc SSM Parameter tương ứng `/xregion/{region}/launch/admission`.
   - Nếu `mode == "open"`: Cho phép tất cả người dùng hợp lệ trong hệ thống khởi tạo máy ảo.
   - Nếu `mode == "maintenance"`: **Chặn toàn bộ người dùng thông thường**. Chỉ cho phép yêu cầu nếu thỏa mãn đồng thời 3 điều kiện Canary:
     - `username == canary.username`
     - `request.name.trim() == canary.name`
     - `request.keyPairName == canary.key_id`
   - Bất kỳ yêu cầu nào vi phạm đều bị từ chối ngay lập tức với ngoại lệ **`LaunchUnavailableException`** (`HTTP 503 Service Unavailable`).
2. **Xác thực tính hợp lệ của tham số yêu cầu**:
   - **Vùng (Region)**: Bắt buộc phải thuộc danh mục vùng hỗ trợ: **`us-east-1` (Region A - N. Virginia)** hoặc **`ap-southeast-2` (Region B - Sydney)**.
   - **Kích thước đĩa (ebsSizeGb)**: Bắt buộc là số nguyên nằm trong khoảng **`1 <= ebsSizeGb <= 5` (tối đa 5 GiB)**, ràng buộc đồng bộ tại cả Frontend (`launch.html`/`launch.js`) và Backend (`LaunchInstanceRequest` `@Min(1) @Max(5)` & `LaunchAdmissionService`).
   - **Mã ảnh (ImageId)**: Bắt buộc là chuỗi chuẩn UUID (36 ký tự) và phải tồn tại bản ghi trong bảng DynamoDB `XRegion-Images`.
   - **Cấu hình máy (Flavor)**: Mặc định là **`m1.tiny`** trên UI (`launch.html`/`launch.js`) và `LaunchInstanceRequest`; bắt buộc phải tồn tại trong bảng DynamoDB `XRegion-Flavors` (so khớp theo `flavorName` hoặc `flavorId`).
   - **Khóa SSH (KeyPair)**: Bắt buộc phải tồn tại trong danh mục khóa của người dùng qua `KeyService` (trừ trường hợp canary test đã cấu hình).
3. **Hạn mức máy ảo mỗi người dùng (Per-User Instance Quota)**:
   - Mỗi người dùng (bao gồm **cả `admin`**) chỉ được phép sở hữu tối đa **5 máy ảo** đang ở tập trạng thái hoạt động/chuyển tiếp: `PENDING`, `RUNNING`, `STOPPED`, `REBOOTING`, `STOPPING`, `MIGRATING` (không tính các máy ở trạng thái `FAILED`, `ERROR`, `TERMINATED`, `SHUTTING_DOWN`).
   - Nếu số lượng hiện tại `>= 5`, Backend từ chối ngay với **`HTTP 409 Conflict` (`ConflictException`)**.

---

## 2. Quy Chuẩn Mở Rộng Ổ Đĩa Cinder/EBS (Volume Extend Contract)

Mỗi máy ảo khởi tạo theo mô hình Boot-from-Volume sử dụng một ổ đĩa Cinder backend gp3 EBS (kích thước mặc định trong pool được xác định động theo ảnh: `max(1, min_disk)`, cụ thể là 1 GiB cho CirrOS/Alpine và 10 GiB cho Ubuntu). Khi người dùng yêu cầu kích thước lớn hơn dung lượng sẵn có của volume trong pool (`ebsSizeGb > pool_volume_size`):

### 2.1. Ràng Buộc Resize Một Lần Duy Nhất Trong Đời (One-Time Lifetime Resize)
> [!IMPORTANT]
> ### CHÍNH SÁCH BẢO VỆ ĐĨA KHỐI (STORAGE INTEGRITY POLICY)
> - **Mỗi EBS Volume chỉ được phép mở rộng dung lượng đúng 1 lần duy nhất trong suốt vòng đời của nó.**
> - Trước khi gửi yêu cầu `ModifyVolume` lên AWS EC2 hoặc Cinder:
>   - Ghi Tag bất biến vào tài nguyên: `Key = "XRegionResizeTargetGiB"`, `Value = "<target_size>"`.
>   - IAM Policy chỉ cấp quyền gán tag này nếu tag đó chưa từng tồn tại trên volume (`Condition: StringNotLike`).
>   - Mọi nỗ lực resize lần thứ hai trên cùng một volume sẽ bị từ chối ngay lập tức với lỗi `ConflictException`.

### 2.2. Cơ Chế Chống Duplicate POST Khi Timeout (`extend_volume.py`)
Để tránh tình trạng mạng chập chờn khiến Step Functions gọi lặp lại lệnh POST làm Cinder/EBS bị lỗi trạng thái:
1. **Ghi nhận trạng thái trước khi gọi API (Persist-Before-POST)**:
   - Trước khi gọi API mở rộng, Lambda ghi cờ vào DynamoDB `XRegion-Volumes`:
     ```
     extend_reservation_id = execution_id
     extend_target_gb = target_size
     extend_deadline_at = now + 300s
     extend_post_attempted = true
     ```
   - Sử dụng Condition Expression: `attribute_not_exists(extend_post_attempted)`.
2. **Gọi API thực thi**:
   - Gửi yêu cầu Cinder REST API: `POST /v3/{project_id}/volumes/{id}/action` với payload `{"os-extend": {"new_size": target_size}}`.
3. **Thời gian chờ và Giới hạn xử lý (Deadline & Timeout)**:
   - Thời hạn tối đa cho việc mở rộng hoàn tất: **300 giây**.
   - Nếu sau 300 giây trạng thái volume vẫn chưa đạt `available` với kích thước `>= target_size`:
     - Ném ngoại lệ `TimeoutError`.
     - Kích hoạt Rollback toàn bộ tiến trình tạo máy.
4. **Xác nhận hoàn tất**:
   - Khi volume đạt `available` và kích thước mới được xác thực, cập nhật DynamoDB `extend_status = "CONFIRMED"` và chuyển sang bước `BootNovaVM`.

---

## 3. Ràng Buộc Kiểm Thử & Chống Sai Lệch Cho Agent (Testing Constraints)

> [!WARNING]
> Khi Agent lập trình hoặc viết test case cho phần Admission và Storage:
> 1. **CẤM TUYỆT ĐỐI**:
>    - Không được phép cho phép mở rộng volume nhiều lần trong code hoặc test.
>    - Không được phép bypass bước kiểm tra SSM Parameter `/xregion/ap-southeast-2/launch/admission`.
>    - Không được phép cho phép giá trị `ebsSizeGb` là số âm, số 0 hoặc boolean.
> 2. **Bộ Test Suite BẮT BUỘC phải bao quát các kịch bản**:
>    - `test_maintenance_mode_rejects_non_canary_users`: Chế độ bảo trì từ chối user thường với mã lỗi HTTP 503.
>    - `test_volume_extension_idempotent_persist_before_post`: Chống duplicate POST khi bị timeout mạng.
>    - `test_volume_extension_timeout_after_300s`: Bắn lỗi khi quá deadline 300 giây.

---

## 4. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành tài liệu đặc tả Launch Admission Gate và quy chuẩn mở rộng đĩa Cinder/EBS. |
| `2026-11-12` | `1.1.0` | Lead Architect / Product Owner | Chuẩn hóa dung lượng tối thiểu 1 GiB cho CirrOS/Alpine, xác nhận chế độ mở cổng Admission Gate và ràng buộc SSH Key Pair của người dùng qua xacnhan-skill. |
| `2026-11-12` | `1.2.0` | Chủ dự án (xacnhan-skill) | Chuẩn hóa hỗ trợ 2 vùng hợp lệ: us-east-1 (Region A - N. Virginia) và ap-southeast-2 (Region B - Sydney), phân giải động SSM Parameter /xregion/{region}/launch/admission. |
| `2026-11-13` | `1.3.0` | Chủ dự án (`xacnhan-skill`) | Ràng buộc Root Disk tối đa `5 GiB` (`1..5`), flavor mặc định `m1.tiny`, và giới hạn tối đa `5` máy ảo đang hoạt động/chuyển tiếp cho mỗi user (kể cả `admin`, trả `HTTP 409 Conflict`). |
