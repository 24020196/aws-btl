# SPEC-01: Quản Trị Vòng Đời Máy Ảo (Instance Lifecycle & Provisioning)

> **Phiên bản**: `1.6.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Tài liệu cha**: [SPEC-00: Agent Scope Guard](SPEC-00-AGENT-SCOPE-GUARD.md)

---

## 1. Ma Trận Ánh Xạ Trạng Thái Ba Tầng (Three-Tier Status Mapping Matrix)

Để đồng nhất trải nghiệm quản trị chuẩn AWS EC2 trên giao diện người dùng đồng thời tương thích với trạng thái máy ảo thực tế của OpenStack Nova, hệ thống quy chuẩn ma trận ánh xạ 3 tầng bất biến:

| Trạng thái OpenStack Nova | Trạng thái DynamoDB (`current_status`) | Trạng thái hiển thị Dashboard UI | Ý nghĩa kỹ thuật |
| :--- | :--- | :--- | :--- |
| *(Chưa có Nova VM)* | `PENDING` | `PENDING` | Yêu cầu tạo máy đã nhận, đang chờ Step Functions cấp tài nguyên |
| `BUILD` | `CREATING` | `CREATING` | Nova đang build máy từ Cinder volume |
| `ACTIVE` | `RUNNING` | `RUNNING` | Máy ảo đang chạy bình thường, đã nhận IP và thông mạng |
| *(Đang gửi lệnh start)* | `STARTING` | `STARTING` | Lệnh bật máy đang được xử lý qua EventBridge |
| *(Đang gửi lệnh stop)* | `STOPPING` | `STOPPING` | Lệnh tắt máy đang được xử lý qua EventBridge |
| `SHUTOFF` / `STOPPED` | `STOPPED` | `STOPPED` | Máy ảo đã tắt an toàn (vẫn giữ nguyên volume và cấu hình) |
| *(Đang reboot)* | `REBOOTING` | `REBOOTING` | Máy ảo đang trong tiến trình khởi động lại |
| *(Đang terminate)* | `SHUTTING_DOWN` | `SHUTTING_DOWN` | Step Functions đang dọn dẹp tài nguyên để xóa máy |
| `ERROR` | `FAILED` | `FAILED` | Khởi tạo thất bại hoặc gặp sự cố phần cứng không thể phục hồi |
| *(Có migration_lock)* | `MIGRATING` | `MIGRATING` | Máy ảo đang trong tiến trình chuyển vùng trực tiếp (Live Migration) |
| *(Sau khi Terminate xong)* | *(Đã xóa cứng khỏi DB)* | *(Biến mất khỏi UI)* | Bản ghi đã bị Hard Delete hoàn toàn, không lưu rác |

> [!WARNING]
> **QUY CHUẨN CẤM**:
> - Agent **TUYỆT ĐỐI KHÔNG ĐƯỢC PHÉP** tự ý thêm mới các trạng thái phụ ngoài bảng trên vào codebase hay test cases.
> - **CẤM SỬ DỤNG TÍNH NĂNG `shelve` / `unshelve` CỦA NOVA**: Lệnh STOP chỉ dùng API `os-stop` và START chỉ dùng `os-start` để đảm bảo ánh xạ trạng thái 1-1 chính xác, không làm phức tạp hóa trạng thái hệ thống bằng các trạng thái `SHELVED` hay `SHELVED_OFFLOADED`.

---

## 2. Quy Định Về Điều Kiện Tiên Quyết (Action Pre-conditions)

| Thao tác yêu cầu | Trạng thái hợp lệ cho phép thực hiện | Trạng thái BỊ CẤM TUYỆT ĐỐI | Mã lỗi trả về |
| :--- | :--- | :--- | :--- |
| **Launch (Tạo mới)** | Không áp dụng (Tạo mới) | Trùng lặp `instance_id` | `HTTP 409 Conflict` |
| **Start (Bật máy)** | `STOPPED` | `RUNNING`, `MIGRATING`, `PENDING`, `CREATING`, `SHUTTING_DOWN` | `HTTP 400 Bad Request` |
| **Stop (Tắt máy)** | `RUNNING` | `STOPPED`, `MIGRATING`, `PENDING`, `CREATING`, `SHUTTING_DOWN` | `HTTP 400 Bad Request` |
| **Reboot (Soft/Hard)**| `RUNNING` | `STOPPED`, `MIGRATING`, `PENDING`, `CREATING`, `SHUTTING_DOWN` | `HTTP 400 Bad Request` |
| **Terminate (Hủy máy)**| `RUNNING`, `STOPPED`, `FAILED` | `MIGRATING`, `PENDING`, `CREATING` | `HTTP 409 Conflict` |
| **Live Migration** | `RUNNING`, `STOPPED` | `MIGRATING`, `PENDING`, `CREATING`, `SHUTTING_DOWN`, `STARTING`, `STOPPING`, `REBOOTING` | `HTTP 409 Conflict` |
| **Sửa cấu hình (Update)**| **CẤM TUYỆT ĐỐI (IMMUTABLE)** | Mọi trạng thái | `HTTP 405 Method Not Allowed` |

---

## 3. Ràng Buộc Bất Biến: Cấu Hình Máy Ảo Là Bất Biến Sau Khi Launch

> [!IMPORTANT]
> ### CHÍNH SÁCH BẤT BIẾN (IMMUTABLE INSTANCE POLICY) & ĐỒNG BỘ GIAO DIỆN UI
> - **Máy ảo sau khi khởi tạo thành công là bất biến (Immutable)**: Hệ thống tuyệt đối không hỗ trợ việc chỉnh sửa cấu hình phần cứng hay mạng sau khi launch.
> - **CẤM TUYỆT ĐỐI**:
>   - Không hỗ trợ đổi Flavor (Instance Type).
>   - Không hỗ trợ đổi dung lượng đĩa EBS/Cinder runtime.
>   - Không hỗ trợ đổi SSH Keypair hay Security Group.
>   - Không hỗ trợ hoán đổi hoặc gán lại Elastic IP sau khi máy đã chạy.
> - **Loại bỏ endpoint Backend**: Endpoint `PUT /api/instances/{id}` (`updateInstance`) bị loại bỏ hoàn toàn khỏi codebase để triệt tiêu mã nguồn dư thừa và loại trừ rủi ro lệch cấu hình giữa UI và hạ tầng.
> - **Xóa sạch Giao diện UI Modify**:
>   - Xóa bỏ hoàn toàn trang `instance-edit.html`, stylesheet `instance-edit.css` và script `instance-edit.js`.
>   - Xóa bỏ mọi mục menu trỏ tới `instance-edit` trong menu đa cấp `instance-actions-menu.js` và `instances.js`.
> - **Loại bỏ VolumeController & VolumeService**: Loại bỏ hoàn toàn `VolumeController` và `VolumeService` khỏi Backend vì hệ thống quản lý lưu trữ 100% tự động qua Warm Pool Boot-from-Volume và EBS Snapshot, không mở API thao tác volume độc lập.
> - Nếu người dùng cần cấu hình khác, bắt buộc phải Terminate máy ảo cũ và Launch máy ảo mới.

---

## 4. Kiến Trúc Lưu Trữ Dữ Liệu Hai Bảng (Two-Table Data Architecture)

Hệ thống phân định ranh giới trách nhiệm rõ ràng giữa hai bảng DynamoDB:

1. **Bảng `XRegion-Instances` (Lớp Quản Trị Vòng Đời & Người Dùng)**:
   - Quản lý các thuộc tính: `instance_id` (PK), `instance_name`, `user_id`, `username`, `current_status`, `migration_lock`, `last_migration_timestamp`.
   - Lưu trữ con trỏ máy ảo hiện hành: `active_nova_id`.
   - Lưu trữ danh sách toàn bộ các máy ảo OpenStack lịch sử từng phục vụ instance này: `nova_ids` (List chuỗi).
2. **Bảng `XRegion-Nova` (Lớp Hạ Tầng Vật Lý OpenStack)**:
   - Quản lý các thuộc tính kỹ thuật thực tế: `nova_id` (PK), `instance_id` (GSI: `instance_id-index`), `region`, `flavor`, `private_ip`, `elastic_ip`, `volume_id`, `key_id`, `network_mode`, `status`, `created_at`, `terminated_at`.
   - Lớp `NovaLookup.java` trên Backend chịu trách nhiệm tra cứu và nạp (fill) dữ liệu từ `XRegion-Nova` vào đối tượng `InstanceEntity` khi phục vụ các API Controller hoặc giao diện.

---

## 5. Quy Trình Khởi Tạo Máy Ảo (Boot-from-Volume Provisioning)

### 5.1. Hợp đồng Giao Tiếp Backend (Backend Contract)
1. **Tiếp nhận & Xét duyệt**:
   - Quản trị viên gửi yêu cầu tạo VM từ UI -> `POST /api/instances`.
   - `LaunchAdmissionService` (quy định tại [SPEC-05](SPEC-05-LAUNCH-ADMISSION-AND-STORAGE.md)) kiểm tra Admission Gate SSM Parameter `/xregion/ap-southeast-2/launch/admission` (`open` vs `maintenance`) và đối soát ImageId UUID, Flavor, KeyPair.
   - Nếu vi phạm -> Trả lỗi đồng bộ `HTTP 400 Bad Request` hoặc `HTTP 503 Service Unavailable` ngay tại Controller.
2. **Khởi tạo trạng thái ban đầu & Tự động sinh Security Group 1-1**:
   - Backend sinh UUID ngẫu nhiên cho `instance_id`.
   - **RÀNG BUỘC CỐT LÕI**: Backend tự động gán và ánh xạ **Security Group 1-1 riêng biệt** cho máy ảo này (`owner = currentUser`). Tuyệt đối cấm dùng chung Security Group mẫu (`sg-default`, `sg-web-public`) giữa các máy ảo.
   - Backend ghi bản ghi ban đầu vào DynamoDB `XRegion-Instances` với trạng thái `PENDING`.
   - Bắn sự kiện `instance.launch` tới API Gateway `XRegion-EventGateway` (`POST /prod/events`) với chữ ký AWS IAM SigV4.
   - **Phản hồi ngay lập tức**: Trả về **`HTTP 202 Accepted`** kèm payload JSON:
     ```json
     {
       "instanceId": "i-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
       "status": "PENDING"
     }
     ```
3. **Xử lý Ngoại lệ Gửi Sự Kiện Launch**:
   - Nếu API Gateway từ chối dứt khoát (`EventRejectedException`): Cập nhật bản ghi ngay sang `FAILED`, ghi rõ lý do từ chối.
   - Nếu lỗi timeout mạng / transport failure: Giữ nguyên trạng thái `PENDING` kèm ghi chú *"Chưa xác minh được sự kiện launch đã được nhận"* để phục vụ đối soát, **tuyệt đối không tự ý gửi lại mù quáng** để tránh tạo trùng lặp máy ảo.

### 5.2. Chuỗi Bước Thực Thi Step Functions (`LaunchInstance`)
1. **`CheckPool`**: Kiểm tra Cinder Warm Pool (`XRegion-Volumes`) và Elastic IP Pool. Nếu thiếu tài nguyên, Lambda ném `PoolNotReady`. Step Functions retry tối đa **5 lần với exponential backoff** (tổng tối đa **180 giây**). Nếu sau 180s vẫn thiếu -> ném lỗi `POOL_EXHAUSTED`, chuyển sang `MarkNetworkFailure`.
2. **`AllocateResource`**: Chiếm khóa nguyên tử Volume Cinder trong DynamoDB (`status = ALLOCATED`, `lease_instance_id = instance_id`). Gán Tag AWS EC2 EIP: `ClaimedBy = instance_id`.
3. **`ReserveNetwork`**: Cấp phát và đặt trước địa chỉ IP nội bộ (`guest_private_ip`) và mapping mạng.
4. **`ExtendVolume`**: Mở rộng đĩa nếu yêu cầu > 10GB theo chuẩn [SPEC-05](SPEC-05-LAUNCH-ADMISSION-AND-STORAGE.md) (1 lần duy nhất trong đời, tag `XRegionResizeTargetGiB`, timeout 300s).
5. **`BootNovaVM`**: Gọi Nova API boot máy ảo gắn volume (`boot-from-volume`), bật `config_drive = true`.
6. **`CommitNetworkMapping` & `AssignSecurityGroup`**: Gán Security Group 1-1 cho Nova VM và đăng ký Secondary IP trên AWS ENI `ens6`. Lambda `sync_dynamodb.py` bắt buộc lưu Security Group vào DynamoDB với **`owner = currentUser`**, **`instance_id`** của máy và **rule nguyên văn từ payload launch** (tuyệt đối không hardcode `system`, không tự thêm rule mặc định); trạng thái là `PENDING_SYNC` cho tới khi worker `XRegion-SyncSecurityGroup` xác nhận.
7. **`ApplyNatMapping` & `CheckNatCommand`**: Thiết lập `nftables` qua SSM và xác nhận `command_status = SUCCEEDED` cùng `applied_generation` khớp `generation` (quy định tại [SPEC-04](SPEC-04-NETWORK-NAT-ROUTING.md)). Không còn bước `VerifyNetwork`.
8. **`SyncDynamoDB`**: Lưu trữ metadata Nova VM vào `XRegion-Nova` và `XRegion-Instances`, chuyển trạng thái `RUNNING`.

---

## 6. Phương Thức Kết Nối & Quản Trị Máy Ảo: Bắt Buộc Dùng SSH Terminal

- **Loại bỏ Web VNC Console**: Hệ thống hoàn toàn không hỗ trợ giao diện Web VNC Console để loại bỏ nguy cơ bảo mật từ VNC proxy không mã hóa.
- **Kết nối chuẩn duy nhất**: Người dùng bắt buộc phải sử dụng cặp khóa SSH Keypair (`.pem`) đã tải về khi tạo khóa để kết nối trực tiếp qua lệnh terminal:
  ```bash
  ssh -i <ten_file_khoa>.pem ubuntu@<elastic_ip>
  ```

---

## 7. Quy Trình Hủy Diệt Máy Ảo & Xóa Cứng Toàn Diện (Terminate VM)

Khi có yêu cầu Terminate từ người dùng (`DELETE /api/instances/{id}`):
1. Backend kiểm tra điều kiện (Instance không nằm trong trạng thái `MIGRATING`, `PENDING` hoặc `CREATING`).
2. Cập nhật trạng thái `SHUTTING_DOWN`.
3. Kích hoạt Step Function `TerminateInstance` thực thi chuỗi dọn dẹp tuần tự:
   - **Bước 1 (Hạ tầng mạng)**: Dispatch SSM lệnh gỡ bỏ quy tắc `nftables`, chờ SUCCEEDED, disassociate Elastic IP khỏi ENI `ens6`, unassign secondary IP, giải phóng Claim Tags hoàn trả EIP về Warm Pool.
     > ⛔ **RÀNG BUỘC BẢO VỆ**: Card mạng `OPENSTACK_PUBLIC_ENI` (`eni-091eaee3e69e3f42d` trên host `ens6`) là tài nguyên dùng chung của toàn bộ OpenStack node. Tuyệt đối cấm xóa card mạng này!
   - **Bước 2 (Xóa Compute)**: Gọi Nova API `DELETE /servers/{id}` xóa máy ảo Compute.
   - **Bước 3 (XÓA SẠCH SECURITY GROUP 1-1)**: Xóa Security Group 1-1 trên OpenStack Neutron VÀ xóa vĩnh viễn bản ghi trong DynamoDB `XRegion-SecurityGroups`, không giữ lại tài nguyên rác.
   - **Bước 4 (Xóa Lưu Trữ)**: Xóa Boot Volume Cinder và AWS EBS Volume liên kết.
   - **Bước 5 (Dọn dẹp Pool)**: Kiểm tra dung lượng Warm Pool: Nếu số lượng Elastic IP hoặc Volume rảnh rỗi trong pool > 2, tự động dọn dẹp theo nguyên tắc FIFO (quy định tại [SPEC-02](SPEC-02-RESOURCE-POOL-CLEANER.md)).
   - **Bước 6 (XÓA CỨNG BẢN GHI TẠI `syncDynamoDB` & TRẢI NGHIỆM GIAO DIỆN UI)**:
     - **Hiển thị trên UI**: Trong suốt thời gian Step Function đang dọn dẹp, giao diện Dashboard hiển thị badge trạng thái màu cam **`SHUTTING_DOWN`** (hoặc `TERMINATING`).
     - **Xóa cứng (Hard Delete)**: Khi Step Function hoàn tất các bước dọn dẹp hạ tầng mạng, compute, volume và SG, bước `syncDynamoDB` gọi trực tiếp DynamoDB `delete_item` xóa vĩnh viễn bản ghi máy ảo khỏi bảng `XRegion-Instances`.
     - Đồng thời gọi `delete_item` xóa sạch tất cả các bản ghi Nova liên quan trong bảng `XRegion-Nova`.
     - **Biến mất hoàn toàn**: Ngay sau khi bản ghi bị xóa khỏi DynamoDB, máy ảo sẽ tự động **biến mất hoàn toàn** khỏi bảng danh sách máy ảo trên Dashboard (không còn lưu lại dòng `TERMINATED` xám).

---

## 8. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành tài liệu chuẩn hóa vòng đời máy ảo sau đợt phỏng vấn nghiệp vụ. |
| `2026-11-10` | `1.1.0` | Lead Architect / Product Owner | Chuẩn hóa HTTP 202 Accepted, CheckPool retry 5 lần (180s timeout), ném lỗi `POOL_EXHAUSTED`. |
| `2026-11-10` | `1.2.0` | Lead Architect / Product Owner | Chuẩn hóa Ma Trận Trạng Thái 3 Tầng, Security Group 1-1 tự sinh từ lúc Launch và xóa sạch khi Terminate. |
| `2026-11-10` | `1.3.0` | Lead Architect / Product Owner | Loại bỏ hoàn toàn cơ chế `shelve`/`unshelve`, chuẩn hóa `os-stop`/`os-start` ánh xạ 1-1, phân định kiến trúc 2 bảng Instances vs Nova. |
| `2026-11-10` | `1.4.0` | Lead Architect / Product Owner | Quy định máy ảo bất biến (cấm sửa cấu hình sau launch, loại bỏ updateInstance); Xóa cứng (Hard Delete) bản ghi ở step syncDynamoDB khi Terminate; Loại bỏ Web VNC Console (bắt buộc SSH terminal); Ràng buộc bảo vệ ENI dùng chung `ens6`; Tinh gọn VolumeService và ImageService. |
| `2026-11-10` | `1.5.0` | Lead Architect / Product Owner | Xóa sạch UI instance-edit.html và menu sửa máy ảo; Quy định trải nghiệm UI khi Terminate (hiển thị SHUTTING_DOWN rồi biến mất hoàn toàn); Loại bỏ triệt để VolumeController & VolumeService khỏi backend; Xác nhận không giới hạn quota ở tầng backend. |
| `2026-11-11` | `1.6.0` | Chủ dự án (yêu cầu trực tiếp) | Đồng bộ với SPEC-SF-01 `1.5.0`: bước 6 lưu Security Group kèm `instance_id` và rule nguyên văn từ payload với `sync_status = PENDING_SYNC`; bước 7 đổi `VerifyNetwork` thành `CheckNatCommand` (khớp SPEC-04 `1.2.0`). |
