# PHÂN CHIA CÔNG VIỆC CÒN LẠI (TINH CHỈNH CHUẨN AWS EC2)

> **Các hạng mục cần làm mới trong đợt này (không tính các phần DB, Key Pair `.pem`, DNS, Đồng bộ thời gian & Trang sửa máy ảo đã hoàn thành):**
> 1. **Kiểm soát phiên đăng nhập (Cường)**: Không cho vào trang chủ (`index.html`), đăng nhập xong vào thẳng quản lý máy ảo (`instances.html`) + giới hạn thời hạn Token tự động đăng xuất (`Auto-Logout`).
> 2. **Trạng thái máy ảo chuẩn EC2 từ Backend lên UI (Duy Anh)**: Bổ sung các trạng thái chuyển tiếp (`PENDING`, `STOPPING`, `REBOOTING`, `SHUTTING_DOWN` / `TERMINATED`) trong `InstanceService.java`, `InstanceStatus.java` và hiển thị/Polling trên `instances.html`, `launch.html`.
> 3. **Giao diện `instance-detail.html`, Security Group + Network & Thiết kế lại vị trí Chuyển vùng (Lực)**: Bỏ thẻ lịch sử di trú cũ, thiết kế lại giao diện `instance-detail.html` gồm khu vực Security Group (Inbound/Outbound Rules), Network DNS và Tiến trình 6 bước + Lịch sử di trú kèm chỉnh sửa `NetworkService`, `MigrationService`.

---

## 1. BẢNG PHÂN CÔNG CHO 3 THÀNH VIÊN

| Thành viên | Nhiệm vụ cần làm mới | File Backend & Giao diện (`.html` / `.js` / `.css`) phụ trách |
| :--- | :--- | :--- |
| **1. Nguyễn Mạnh Cường** | **1. Thời hạn Token & Tự động đăng xuất (`Auto-Logout`) + Chặn vào trang chủ (`index.html`)<br>2. Bổ sung cột `security_group` vào Entity/DTO & trang sửa máy ảo `instance-edit.html`** | • **Backend**: `Security/JwtTokenProvider.java`, `SecurityConfig.java`, `Services/AuthService.java`, `Entity/InstanceEntity.java`, `Model/Response/InstanceResponse.java`, `Model/Request/UpdateInstanceRequest.java`<br>• **Giao diện HTML**: `static/login.html`, `static/register.html`, `static/account-tokens.html`, `static/instance-edit.html` |
| **2. Tạ Duy Anh** | **1. Backend & UI các trạng thái chuyển tiếp máy ảo chuẩn EC2 (`PENDING`, `STOPPING`, `REBOOTING`, `SHUTTING_DOWN`)<br>2. Tinh chỉnh trang Danh sách máy ảo (`instances.html`) & Khởi tạo máy ảo (`launch.html`)** | • **Backend**: `Entity/InstanceStatus.java`, `Services/InstanceService.java`<br>• **Giao diện HTML**: `static/instances.html`, `static/launch.html`<br>• **JS**: `static/js/app.js` *(Khối `loadInstances`, `filterInstancesUI`, Polling trạng thái EC2, `handleLaunchPageSubmit`)* |
| **3. Hoàng Xuân Lực** | **1. Giao diện `instance-detail.html`: Bỏ thẻ lịch sử di trú cũ, thiết kế lại khung Tiến trình/Lịch sử di trú & hiển thị Security Group + Network<br>2. Backend Security Group (`NetworkService`) & chỉnh sửa `MigrationService`** | • **Backend**: `Controllers/NetworkController.java`, `MigrationController.java`, `Services/NetworkService.java`, `Services/MigrationService.java`, `Services/MonitoringService.java`<br>• **Giao diện HTML & CSS**: `static/instance-detail.html`, `static/index.html`, `static/css/dashboard.css`<br>• **JS**: `static/js/app.js` *(Khối `initDetailPage`, Security Group, Network & Migration)* |

---

## 2. CHI TIẾT VIỆC CẦN LÀM CỦA TỪNG NGƯỜI

### 👤 1. Nguyễn Mạnh Cường — Phiên Đăng Nhập (Token Timeout / Chặn Trang Chủ) & Cột `security_group`
**File HTML phụ trách:** `login.html`, `register.html`, `account-tokens.html`, `instance-edit.html`

- [ ] **1. Chặn vào trang chủ & Tự động đăng xuất khi hết hạn Token (`Auto-Logout`):**
  - Cấu hình thời hạn sống của JWT Token (`jwt.expirationMinutes` / `JwtTokenProvider.java`) và trả thêm mốc hết hạn `expiresAt` trong `JwtResponse`.
  - Chặn truy cập trang chủ `/index.html`: nếu người dùng vào `/` hoặc `/index.html` thì tự động chuyển thẳng sang `/instances.html` (nếu đã đăng nhập) hoặc `/login.html` (nếu chưa đăng nhập).
  - Sau khi đăng nhập ở `login.html` hoặc đăng ký ở `register.html`, điều hướng thẳng vào `/instances.html`.
  - Thêm bộ đếm kiểm tra thời hạn token trên trình duyệt: khi hết thời gian hiệu lực thì tự động xóa token và đăng xuất về `/login.html`.
- [ ] **2. Bổ sung trường `security_group` vào `InstanceEntity`, DTO & Trang sửa máy ảo (`instance-edit.html`):**
  - Thêm thuộc tính `@DynamoDbAttribute("security_group") private String securityGroup;` vào `InstanceEntity.java`, `InstanceResponse.java` và `UpdateInstanceRequest.java`.
  - Thêm ô chọn Security Group trong trang `instance-edit.html` để người dùng có thể đổi Security Group cho máy ảo.

---

### 👤 2. Tạ Duy Anh — Backend & Giao Diện Trạng Thái Máy Ảo Chuẩn EC2 (`instances.html`, `launch.html`)
**File HTML phụ trách:** `instances.html`, `launch.html`  
**File Backend phụ trách:** `InstanceStatus.java`, `InstanceService.java`

- [ ] **1. Bổ sung các trạng thái chuyển tiếp máy ảo chuẩn EC2 trong `InstanceService.java` & `InstanceStatus.java`:**
  - Cập nhật `InstanceStatus.java` gồm đầy đủ: `PENDING`, `RUNNING`, `STOPPING`, `STOPPED`, `REBOOTING`, `SHUTTING_DOWN`, `TERMINATED`, `MIGRATING`.
  - Chỉnh sửa luồng xử lý trong `InstanceService.java`:
    - **Khi khởi tạo máy ảo mới (`launchInstance`)**: Lưu trạng thái ban đầu là **`PENDING`** (Đang cấp phát) $\rightarrow$ chạy tiến trình ngầm sau vài giây tự động cập nhật sang **`RUNNING`** trên DynamoDB.
    - **Khi bấm Dừng (`STOP`)**: Chuyển trạng thái sang **`STOPPING`** $\rightarrow$ sau vài giây cập nhật sang **`STOPPED`**.
    - **Khi bấm Bật (`START`)**: Chuyển trạng thái sang **`PENDING`** $\rightarrow$ sau vài giây cập nhật sang **`RUNNING`**.
    - **Khi bấm Khởi động lại (`REBOOT`)**: Chuyển sang **`REBOOTING`** $\rightarrow$ **`RUNNING`**.
    - **Khi bấm Xóa (`TERMINATE`)**: Chuyển trạng thái sang **`SHUTTING_DOWN`** / **`TERMINATING`** trước khi xóa bản ghi hoặc đánh dấu **`TERMINATED`**.
  - Cập nhật hàm `mapToResponse()` trong `InstanceService.java` để giữ nguyên các trạng thái `PENDING`, `STOPPING`, `REBOOTING`, `SHUTTING_DOWN` trả về cho giao diện (không gộp hết thành `ACTIVE` như cũ).
- [ ] **2. Hiển thị & Tự động Polling trạng thái trên `instances.html`:**
  - Cập nhật bảng máy ảo và bộ lọc `#instanceStatusFilter` trên `instances.html` để hiển thị rõ từng trạng thái chuẩn EC2 (`⏳ PENDING`, `● RUNNING`, `⏳ STOPPING`, `○ STOPPED`, `🔄 REBOOTING`, `🗑 SHUTTING-DOWN`, `⚡ MIGRATING`).
  - Tự động bật Polling (`setInterval` 2–3 giây/lần gọi `loadInstances()`) khi có máy ảo đang ở trạng thái chuyển tiếp (`PENDING`, `STOPPING`, `REBOOTING`, `SHUTTING_DOWN`) để bảng tự cập nhật sang `RUNNING` / `STOPPED` mà không cần tải lại trang.
  - Khóa (disable) các nút thao tác trên dòng máy ảo khi máy đang ở trạng thái chuyển tiếp.
- [ ] **3. Tinh chỉnh trang Khởi tạo máy ảo (`launch.html`):**
  - Thêm mục chọn **Security Group** (gắn vào `LaunchInstanceRequest.securityGroup`) trên form `launch.html` và hiển thị trong khung Tóm tắt cấu hình bên phải.

---

### 👤 3. Hoàng Xuân Lực — Giao Diện Chi Tiết Máy Ảo (`instance-detail.html`), Security Group + Network & Thiết Kế Lại Phần Di Trú
**File HTML & CSS phụ trách:** `instance-detail.html`, `index.html`, `css/dashboard.css`  
**File Backend phụ trách:** `NetworkController.java`, `NetworkService.java`, `MigrationController.java`, `MigrationService.java`, `MonitoringService.java`

- [ ] **1. Thiết kế lại giao diện `instance-detail.html` (Bỏ thẻ Lịch sử di trú cũ & Bố cục lại chuẩn EC2):**
  - Xóa bỏ thẻ *"Lịch sử di trú & Tính sẵn sàng"* tĩnh rời rạc trên `instance-detail.html`.
  - Thiết kế lại bố cục trang `instance-detail.html` gồm các khu vực (hoặc các Tab bên dưới giống AWS EC2):
    1. **Chi tiết phần cứng & Định danh máy ảo** (Flavor, OS Image, SSH Key Pair, Trạng thái hiện tại).
    2. **Khu vực Security Group & Network (Mới)**: Hiển thị Security Group đang gắn vào máy ảo kèm bảng **Inbound Rules** (Port `22 SSH`, `80 HTTP`, `443 HTTPS`, Source `0.0.0.0/0`...) & **Outbound Rules**, thông tin VPC, Subnet, Private IP, Elastic IP và nút cập nhật Route 53 DNS.
    3. **Khu vực Chuyển Vùng Liên Vùng (Cross-Region Migration Pipeline & History)**: Đặt ở vị trí hợp lý ngay trong `instance-detail.html`, hiển thị:
       - Trạng thái khóa `migration_lock` và **Đồng hồ đếm ngược Cooldown**.
       - Thanh tiến trình **6 bước chuyển vùng (6-Step Pipeline)** + Cửa sổ Log thời gian thực khi bấm **`⚡ Fast Migrate X-Region`**.
       - Bảng **Lịch sử các lần chuyển vùng của chính máy ảo đó** (`migration_id`, Vùng nguồn $\rightarrow$ Vùng đích, Thời điểm bắt đầu, Thời điểm hoàn tất, Trạng thái).
- [ ] **2. Xây dựng Backend Security Group + Network (`NetworkService.java` & `NetworkController.java`):**
  - Bổ sung quản lý danh sách **Security Groups** (`sg-default`, `sg-web-public`, `sg-ssh-only`...) kèm danh sách `inboundRules` và `outboundRules`.
  - Thêm API `GET /api/network/security-groups` và `POST /api/network/security-groups` (tạo Security Group mới / thêm rule mở port).
- [ ] **3. Chỉnh sửa `MigrationService.java` & CSS (`dashboard.css`):**
  - Thêm API `GET /api/migrations/history/{instanceId}` trong `MigrationController` & `MigrationService` để lấy lịch sử chuyển vùng của riêng máy ảo đang xem trên `instance-detail.html`.
  - Chặn kích hoạt chuyển vùng nếu máy ảo đang ở trạng thái chuyển tiếp (`PENDING`, `STOPPING`, `SHUTTING_DOWN`).
  - Bổ sung CSS trong `dashboard.css` cho các badge trạng thái EC2 mới, bảng Inbound/Outbound Rules của Security Group và khung tiến trình chuyển vùng trong `instance-detail.html`.
