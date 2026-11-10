# SPEC-06: Phục Hồi Lỗi Bền Vững & Quản Trị Khóa SSH/Bảo Mật (Recovery & Security)

> **Phiên bản**: `1.2.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Tài liệu cha**: [SPEC-00: Agent Scope Guard](SPEC-00-AGENT-SCOPE-GUARD.md)

---

## 1. Cơ Chế Phục Hồi Lỗi Bền Vững (Durable Fault Recovery)

Quá trình tự động phát hiện và dọn dẹp các máy ảo thử nghiệm bị hỏng (`recovery_worker.py` & `recovery_policy.py`) được thiết kế nhằm bảo vệ tính toàn vẹn của dữ liệu và hạ tầng:

### 1.1. Năm Mức Quyết Định Phân Loại (Classification Outcomes)
1. **`HOLD`**: Tuyệt đối không can thiệp. Áp dụng khi: Hạ tầng đang mất kết nối (`infra_ok == false`), máy ảo đang có cờ khóa `migration_lock == true`, hoặc máy ảo đang ở trạng thái `MIGRATING`.
2. **`SKIP`**: Máy ảo đang ở trạng thái ổn định bình thường (`RUNNING`, `STOPPED`).
3. **`OBSERVE`**: Phát hiện dấu hiệu bất thường nhưng chưa đủ thời gian xác thực hoặc chưa đủ số lần quan sát liên tiếp.
4. **`REPAIR`**: Khắc phục lệch trạng thái (State Drift) mà không hủy tài nguyên:
   - Ví dụ: DynamoDB ghi `RUNNING` nhưng Nova Compute API báo `SHUTOFF` -> Chỉ cập nhật lại DynamoDB thành `STOPPED`, tuyệt đối **CẤM XÓA MÁY ẢO**.
5. **`DELETE`**: Chỉ áp dụng khi máy ảo đã rơi vào trạng thái chết trên Nova (`ERROR`, `TERMINATED`, `DELETED`) và thỏa mãn điều kiện bền vững dưới đây.

### 1.2. Điều Kiện Bắt Buộc Để DELETE (Durable Fault Policy)
> [!IMPORTANT]
> ### NGUYÊN TẮC: LỖI BỀN VỮNG MỚI ĐƯỢC XÓA (UNKNOWN NEVER DELETES)
> Một máy ảo lỗi KHÔNG ĐƯỢC PHÉP bị xóa ngay trong chu kỳ quét đầu tiên phát hiện lỗi. Bắt buộc phải thỏa mãn đồng thời:
> 1. **Tuổi của lỗi**: Thời gian kể từ khi ghi nhận lỗi lần đầu phải **lớn hơn hoặc bằng 30 phút** (`min_age_s >= 1800s`).
> 2. **Số lần quan sát liên tiếp**: Quyết định lỗi phải được xác nhận lặp lại trong **tối thiểu 3 chu kỳ quét liên tiếp** (`recovery_observations >= 3`).
> 3. **Xác thực trực tiếp Nova API**: Bắt buộc đọc trạng thái thực tế từ Nova REST API (`GET /servers/{id}`), tuyệt đối không dựa vào bản ghi đệm trên DynamoDB.
> 4. **Xử lý tuần tự**: Hệ thống xử lý xóa tuần tự từng máy cho đến hết danh sách lỗi để đảm bảo không gây nghẽn mạng hay quá tải API.

---

## 2. Quản Trị Khóa SSH (SSH Keypair Management)

### 2.1. Định Danh Duy Nhất Bằng `key_id`
- **Quy chuẩn mã khóa**: Chỉ sử dụng `key_id` làm định danh duy nhất trong toàn hệ thống, tuân thủ định dạng:
  ```
  key-<tên_do_người_dùng_đặt>-<8_ký_tự_uuid>
  (Ví dụ: key-my-web-key-a1b2c3d4)
  ```
- **Ràng buộc loại bỏ `key_name`**:
  - Tuyệt đối không sử dụng `key_name` hoặc `name` làm định danh gửi qua EventBridge hoặc Nova API để tránh xung đột namespace giữa OpenStack và AWS.

### 2.2. Luồng Đồng Bộ & Bảo Mật Private Key
1. **Sinh cặp khóa**:
   - Sinh cặp khóa RSA 2048 chuẩn PKCS#1 PEM (`-----BEGIN RSA PRIVATE KEY-----`).
2. **Đồng bộ qua API Gateway IAM SigV4**:
   - Backend gửi sự kiện `key.import` tới EventBridge qua API Gateway sử dụng chữ ký điện tử AWS IAM SigV4.
   - Payload chỉ chứa `key_id`, `publicKey`, `fingerprint` và `target_regions`.
3. **Lưu trữ bảo mật**:
   - Chỉ khi EventBridge xác nhận trả về `EventId` thành công, Backend mới lưu Public Key vào bảng DynamoDB `XRegion-Users` (mảng `ssh_keys`).
   - Chuỗi `privateKey` chỉ được trả về **đúng 1 lần duy nhất** trong phản hồi HTTP để trình duyệt người dùng tải file `.pem`. Server **tuyệt đối không lưu private key** trong cơ sở dữ liệu.

---

## 3. Quy Chuẩn Security Group 1-1 & Đồng Bộ Theo Revision

### 3.1. Ràng Buộc Bất Biến: Cách Ly Tuyệt Đối 1-1 (No-Shared Security Groups)
> [!CAUTION]
> ### RÀNG BUỘC KIẾN TRÚC: CẤM DÙNG CHUNG SECURITY GROUP
> 1. **Mỗi máy ảo bắt buộc sở hữu một Security Group 1-1 riêng biệt**, được Backend sinh tự động ngay từ thời điểm gọi API `POST /api/instances`.
> 2. **Quyền sở hữu (`owner`)**:
>    - Bắt buộc phải mang giá trị **`owner = username` của chủ sở hữu máy** (người gửi yêu cầu launch).
>    - ⛔ **CẤM TUYỆT ĐỐI**: Lambda `sync_dynamodb.py` không được hard-code giá trị `"owner": {"S": "system"}` vào bản ghi DynamoDB `XRegion-SecurityGroups`. Giá trị `"system"` chỉ dành riêng cho các nhóm template mẫu dùng chung.
> 3. **Vòng đời gắn liền với máy ảo**:
>    - Khi máy ảo bị Terminate, Step Function `TerminateInstance` bắt buộc phải xóa Security Group 1-1 này trên OpenStack Neutron VÀ xóa vĩnh viễn bản ghi trong DynamoDB `XRegion-SecurityGroups`.

### 3.2. Quản Lý Phiên Bản Bằng Số Nguyên (`revision` & `applied_revision`)
- Mỗi bản ghi Security Group mang hai trường phiên bản:
  - **`revision`**: Tăng `+1` mỗi khi người dùng thay đổi danh sách rule Ingress/Egress trên Dashboard. Đồng thời chuyển trạng thái `sync_status = PENDING_SYNC`.
  - **`applied_revision`**: Số phiên bản cấu hình đã được Lambda áp dụng thành công trên OpenStack Neutron hoặc AWS VPC.
- Khi Lambda cấu hình xong:
  - Cập nhật: `applied_revision = revision`, `sync_status = SYNCED`.
- Bản ghi do launch tạo chỉ là **cấu hình mong muốn**: `sync_status = PENDING_SYNC`, **không** có `applied_revision` cho tới khi worker xác nhận. Trạng thái `PENDING_DEPLOY` đã bị loại bỏ cùng feature-flag `xregion.security-group.sync.enabled`.

### 3.3. Liên Kết 1-1 Bằng `instance_id` (Bắt Buộc)
- Mọi bản ghi Security Group phải mang `instance_id` của máy sở hữu; đây là khóa nhận diện chuẩn giữa backend, pipeline launch và worker đồng bộ.
- **Cấm** dùng chuỗi `description` hoặc hình dạng `group_id` (`sg-*` hay UUID) để suy ra máy sở hữu. Dữ liệu legacy chưa có `instance_id` chỉ được nhận diện tạm thời bằng mô tả cố định `Security group of <instance_id>`.
- Khi Terminate, phải xóa bản ghi theo `group_id = nova_id` **và** mọi bản ghi có `instance_id` tương ứng để không để lại nhóm mồ côi.

### 3.4. Cơ Chế Chống Ghi Đè Lạc Hậu (Stale Writer Protection)
Mọi thao tác cập nhật trạng thái đồng bộ đều sử dụng DynamoDB Condition Expression:
```
ConditionExpression: attribute_exists(group_id) AND revision = :current_rev AND (attribute_not_exists(applied_revision) OR applied_revision <= :new_ar)
```
👉 **Kết quả**: Một worker cũ chạy chậm không bao giờ có thể ghi đè kết quả của mình lên một cấu hình mới hơn mà người dùng vừa chỉnh sửa.

---

## 4. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành tài liệu đặc tả chính sách phục hồi lỗi bền vững, quản trị SSH Key 1-1 và đồng bộ Security Group theo Revision. |
| `2026-11-10` | `1.1.0` | Lead Architect / Product Owner | Bổ sung quy định cấm dùng chung SG, bắt buộc SG 1-1 mang `owner = username` của chủ máy, cấm tuyệt đối hardcode `owner = "system"`. |
| `2026-11-11` | `1.2.0` | Chủ dự án (yêu cầu trực tiếp) | Nêu rõ launch chỉ ghi cấu hình mong muốn (`PENDING_SYNC`, không `applied_revision`); loại bỏ `PENDING_DEPLOY`; bổ sung mục 3.3 bắt buộc liên kết 1-1 bằng `instance_id` và cấm suy ra chủ sở hữu từ `description`/hình dạng `group_id`. |
