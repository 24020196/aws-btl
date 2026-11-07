# PHÂN CHIA CÔNG VIỆC FE (TINH CHỈNH CHUẨN AWS EC2)

> **Các hạng mục cần làm mới trong đợt này**
> 1. **Kiểm soát phiên đăng nhập**: Không cho vào trang chủ (`index.html`), đăng nhập xong vào thẳng quản lý máy ảo (`instances.html`) + giới hạn thời hạn Token tự động đăng xuất (`Auto-Logout`).
> 2. **Trạng thái máy ảo chuẩn EC2**: Bổ sung các trạng thái chuyển tiếp (`PENDING`, `STOPPING`, `REBOOTING`, `SHUTTING_DOWN` / `TERMINATED`) từ Backend lên giao diện.
> 3. **Thiết kế lại vị trí Chuyển vùng (Migration)**: Bỏ tab/thẻ lịch sử di trú cũ, bố trí lại khung Tiến trình 6 bước & Lịch sử di trú ở vị trí hợp lý.
> 4. **Bổ sung Security Group + Network** và tinh chỉnh lại các `Services/` liên quan.

---

## 1. BẢNG PHÂN CÔNG CHO 3 THÀNH VIÊN

| Thành viên | Nhiệm vụ cần làm mới | File phụ trách |
| :--- | :--- | :--- |
| **1. Nguyễn Mạnh Cường** | **1. Thời hạn Token & Tự động đăng xuất + Chặn vào trang chủ<br>2. Backend trạng thái máy ảo chuẩn EC2 (`PENDING`, `STOPPING`, `TERMINATING`) & cột `security_group`** | • `Security/JwtTokenProvider.java`, `SecurityConfig.java`<br>• `Entity/InstanceStatus.java`, `InstanceEntity.java`<br>• `Services/InstanceService.java`, `AuthService.java`<br>• `static/login.html`, `static/register.html` *(luồng điều hướng & hết hạn phiên)* |
| **2. Tạ Duy Anh** | **1. Tinh chỉnh UI `instances.html` & `launch.html` hiển thị các trạng thái `PENDING`, `STOPPING`, `TERMINATING` (kèm tự động Polling)<br>2. Bỏ tab/thẻ Lịch sử di trú cũ và sắp xếp lại bố cục trong `instance-detail.html`** | • `static/instances.html`, `static/launch.html`<br>• `static/instance-detail.html` *(bố cục lại phần hiển thị & bỏ thẻ lịch sử di trú thừa)*<br>• `static/js/app.js` *(Khối Polling trạng thái EC2, khóa nút khi đang chuyển trạng thái)* |
| **3. Hoàng Xuân Lực** | **1. Thiết kế chức năng Security Group (Inbound/Outbound Rules) + Network DNS<br>2. Chỉnh sửa `NetworkService`, `MigrationService`, `MonitoringService` & CSS** | • `Controllers/NetworkController.java`, `MigrationController.java`<br>• `Services/NetworkService.java`, `MigrationService.java`, `MonitoringService.java`<br>• `static/css/dashboard.css`<br>• `static/js/app.js` *(Khối Security Group, Network & Migration)* |

---

## 2. CHI TIẾT VIỆC CẦN LÀM CỦA TỪNG NGƯỜI

### 👤 1. Nguyễn Mạnh Cường — Phiên Đăng Nhập (Token Timeout / Chặn Trang Chủ) & Backend Trạng Thái EC2

- [ ] **1. Chặn vào trang chủ & Tự động đăng xuất khi hết hạn Token:**
  - Cấu hình thời hạn sống của JWT Token (`jwt.expirationMinutes` / `JwtTokenProvider.java`) và trả thêm mốc hết hạn `expiresAt` trong `JwtResponse`.
  - Khi người dùng truy cập gốc `/` hoặc `/index.html`, tự động điều hướng thẳng về `/instances.html` (nếu đã đăng nhập) hoặc `/login.html` (nếu chưa đăng nhập) — bỏ hoàn toàn việc vào trang chủ Overview.
  - Thêm bộ kiểm tra thời hạn token định kỳ: khi hết thời gian hiệu lực của token thì tự động xóa phiên và đăng xuất về `/login.html`.
- [ ] **2. Bổ sung các trạng thái chuyển tiếp máy ảo chuẩn EC2 trong `InstanceService.java` & `InstanceStatus.java`:**
  - Cập nhật `InstanceStatus.java` gồm: `PENDING`, `RUNNING`, `STOPPING`, `STOPPED`, `REBOOTING`, `SHUTTING_DOWN`, `TERMINATED`, `MIGRATING`.
  - Chỉnh sửa `InstanceService.java`:
    - Khi tạo máy ảo mới (`launchInstance`): lưu trạng thái ban đầu là **`PENDING`** (Đang cấp phát) $\rightarrow$ sau vài giây chuyển sang **`RUNNING`**.
    - Khi bấm Dừng (`STOP`): chuyển sang **`STOPPING`** $\rightarrow$ sau đó chuyển sang **`STOPPED`**.
    - Khi bấm Bật (`START`): chuyển sang **`PENDING`** $\rightarrow$ **`RUNNING`**.
    - Khi bấm Xóa (`TERMINATE`): chuyển sang **`SHUTTING_DOWN`** / **`TERMINATING`** trước khi xóa khỏi DynamoDB.
- [ ] **3. Bổ sung trường `security_group` vào `InstanceEntity` & DTO:**
  - Thêm thuộc tính `@DynamoDbAttribute("security_group") private String securityGroup;` vào `InstanceEntity.java`, `InstanceResponse.java` và `UpdateInstanceRequest.java` để ghép với phần Security Group của Lực.

---

### 👤 2. Tạ Duy Anh — Giao Diện Trạng Thái Máy Ảo EC2 & Bố Cục Lại Trang Chi Tiết (Bỏ Tab Lịch Sử Di Trú Cũ)

- [ ] **1. Hiển thị & Tự động cập nhật (Polling) các trạng thái máy ảo chuẩn EC2 trên `instances.html`:**
  - Bổ sung hiển thị Badge màu sắc + hiệu ứng xoay (loading spinner) cho các trạng thái mới trên bảng danh sách máy ảo (`instances.html`) và bộ lọc trạng thái (`#instanceStatusFilter`):
    - `⏳ PENDING` *(Đang khởi tạo - Vàng)*
    - `● RUNNING` *(Đang chạy - Xanh lá)*
    - `⏳ STOPPING` *(Đang dừng - Cam)*
    - `○ STOPPED` *(Đã dừng - Xám)*
    - `🔄 REBOOTING` *(Đang khởi động lại - Xanh dương)*
    - `🗑 SHUTTING-DOWN` / `TERMINATED` *(Đang xóa / Đã xóa - Đỏ)*
  - Tự động bật Polling (`setInterval` 2–3 giây/lần) gọi lại `loadInstances()` khi trong bảng có máy ảo đang ở trạng thái chuyển tiếp (`PENDING`, `STOPPING`, `REBOOTING`, `SHUTTING_DOWN`) để giao diện tự nhảy sang `RUNNING` / `STOPPED` như AWS EC2 thật.
  - Khóa (disable) các nút bấm `Dừng / Bật / Reboot / Sửa / Fast Migrate` khi máy ảo đang ở trạng thái `PENDING`, `STOPPING` hoặc `SHUTTING_DOWN`.
- [ ] **2. Bỏ tab/thẻ Lịch sử di trú cũ & Thiết kế lại vị trí hợp lý trên `instance-detail.html`:**
  - Xóa bỏ thẻ "Lịch sử di trú & Tính sẵn sàng" tĩnh đang đặt rời rạc.
  - Sắp xếp lại trang `instance-detail.html` theo bố cục chuẩn AWS EC2 (chia rõ khu vực **Thông tin chung**, **Security & Network**, và **Khung Tiến trình 6 bước Chuyển vùng + Lịch sử chuyển vùng của máy ảo** nằm gọn bên dưới khi bấm chuyển vùng).
- [ ] **3. Bổ sung ô chọn Security Group trên `launch.html` & `instance-edit.html`:**
  - Thêm Dropdown chọn Security Group (`sg-default`, `sg-web-public`...) lấy từ API của Lực khi khởi tạo hoặc sửa máy ảo.

---

### 👤 3. Hoàng Xuân Lực — Thiết Kế Security Group + Network & Tinh Chỉnh Các Services

- [ ] **1. Xây dựng chức năng Security Group (Inbound / Outbound Rules) + Network:**
  - Cập nhật `NetworkService.java` và `NetworkController.java`:
    - Quản lý danh sách **Security Groups** (`sg-default`, `sg-web-http`, `sg-ssh-only`...) gồm: `groupId`, `groupName`, `description`, `vpcId`, danh sách `inboundRules` và `outboundRules` (Type: `SSH`, `HTTP`, `HTTPS`, `Custom TCP`; Protocol: `TCP`; Port Range: `22`, `80`, `443`; Source: `0.0.0.0/0`).
    - Thêm các API:
      - `GET /api/network/security-groups`: Lấy danh sách Security Group & Rules.
      - `POST /api/network/security-groups`: Tạo Security Group mới hoặc cập nhật Inbound/Outbound Rules.
  - Làm giao diện hiển thị bảng **Inbound Rules / Outbound Rules** của Security Group và thông tin mạng (VPC, Subnet, Elastic IP, Route 53 DNS) trong trang chi tiết máy ảo (`instance-detail.html`).
- [ ] **2. Chỉnh sửa `MigrationService.java` & `MonitoringService.java` cho hợp lý:**
  - Trong `MigrationService.java`:
    - Thêm API `GET /api/migrations/history/{instanceId}` trả về danh sách các lần chuyển vùng của đúng máy ảo đó từ bảng `XRegion-Migrations` để hiển thị vào khu vực chuyển vùng mới.
    - Chỉ cho phép kích hoạt chuyển vùng khi máy ảo đang ở trạng thái `RUNNING` hoặc `STOPPED` (chặn nếu máy đang `PENDING`, `STOPPING`, `SHUTTING_DOWN`).
    - Tự động gọi `NetworkService` cập nhật bản ghi DNS trỏ về `elastic_ip` mới ngay khi hoàn tất Bước 6.
- [ ] **3. Hoàn thiện CSS (`dashboard.css`) chuẩn giao diện EC2:**
  - Thêm style cho các badge trạng thái chuyển tiếp (`badge-pending`, `badge-stopping`, `badge-terminating` kèm hiệu ứng pulse/spinner), bảng Inbound/Outbound Rules của Security Group và khung tiến trình chuyển vùng.
DEADLINE: 21h 07/11/2026