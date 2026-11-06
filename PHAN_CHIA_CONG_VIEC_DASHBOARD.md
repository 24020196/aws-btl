# PHÂN CHIA CÔNG VIỆC DASHBOARD


> - **3 thành viên (Duy Anh, Cường, Lực) chỉ tập trung làm:**
>   1. **Lấy dữ liệu từ Database (DynamoDB) về và hiển thị lên giao diện Dashboard.**
>   2. **Làm hoàn chỉnh Giao diện (Form nhập liệu + các Nút bấm) để gửi Request từ Web xuống Controller.**

---

## 1. BẢNG PHÂN CÔNG  CHO 3 THÀNH VIÊN


| Thành viên | Nhiệm vụ chính | File phụ trách |
| :--- | :--- | :--- |
| **1. Nguyễn Mạnh Cường** | **Đọc dữ liệu từ DynamoDB & Chuẩn bị DTO/Controller nhận Request** | • `Config/DynamoDbConfig.java`, `DynamoDbTableInitializer.java`<br>• `Entity/InstanceEntity.java`, `MigrationEntity.java`<br>• `Model/Request/*`, `Model/Response/*`<br>• `Controllers/InstanceController.java`, `MigrationController.java` |
| **2. Tạ Duy Anh** | **Giao diện & Nút gửi Request phần Máy ảo (Compute, Launch Instance, Storage, Images) + Đưa Web lên chạy** | • `static/index.html` *(Khối `#tab-compute`, `#tab-storage`, `#tab-images`, `#launchModal`)*<br>• `static/js/app.js` *(Hàm `loadInstances`, `submitLaunch`, `instanceAction`, `loadVolumes`, `loadImages`)*<br>• `Dockerfile`, `docker-compose.yml`, `.env` |
| **3. Hoàng Xuân Lực** | **Giao diện & Nút gửi Request phần Chuyển vùng, Mạng DNS, Giám sát & Logs** | • `static/index.html` *(Khối `#tab-migration`, `#tab-network`, `#tab-monitoring`, `#scenarioModal`)*<br>• `static/js/app.js` *(Hàm `loadScenarios`, `submitCreateScenario`, `triggerDirectMigration`, `loadNetwork`, `loadMetrics`, `loadAuditLogs`)*<br>• `static/css/dashboard.css` |

*(Lưu ý: Phần `Services/` giữ nguyên khung hàm hiện tại để tối Lâm vào gắn code bắn request xuống IaaS).*

---

## 2. CHI TIẾT VIỆC CẦN LÀM CỦA TỪNG NGƯỜI

### 👤 1. Nguyễn Mạnh Cường — Phần Lấy Dữ Liệu Từ DB & Nhận Request Ở Controller
**Mục tiêu:** Đảm bảo kết nối DynamoDB đọc dữ liệu mượt mà trả về cho giao diện, và các API ở `Controller` nhận đúng JSON từ các nút bấm trên Web để tối Lâm chỉ việc viết tiếp trong `Service`.

- [ ] **Kiểm tra đọc dữ liệu từ DynamoDB (`XRegion-Instances` & `XRegion-Migrations`):**
  - Rà soát `InstanceEntity.java` và `MigrationEntity.java` khớp 100% với tên cột (attribute) trên bảng DynamoDB thật của nhóm (`instance_id`, `instance_name`, `current_region`, `current_status`, `elastic_ip`, `private_ip`, `flavor`, `migration_lock`...).
  - Đảm bảo hàm đọc danh sách máy ảo (`GET /api/instances`), chi tiết máy ảo (`GET /api/instances/{id}`) và danh sách kịch bản (`GET /api/migrations/scenarios`) lấy đúng dữ liệu từ DynamoDB trả về thành `InstanceResponse` / `MigrationResponse` cho giao diện hiển thị.
- [ ] **Chuẩn bị sẵn các đầu API nhận Request (`Controllers` + `Model/Request`):**
  - Kiểm tra các class nhận dữ liệu từ nút bấm:
    - `LaunchInstanceRequest.java`: Nhận dữ liệu khi bấm nút **Khởi tạo máy ảo** (`name`, `region`, `flavor`, `imageId`, `ebsSizeGb`, `domainName`).
    - `InstanceActionRequest.java`: Nhận dữ liệu khi bấm nút **Bật / Dừng / Reboot / Xóa** (`action`: `START`, `STOP`, `REBOOT`, `TERMINATE`).
    - `CreateScenarioRequest.java` & `TriggerMigrationRequest.java`: Nhận dữ liệu khi bấm nút **Lưu kịch bản** và **Chuyển vùng**.
  - Giữ các hàm trong `Services/` gọn gàng, đúng tên hàm để tối Lâm vào viết phần gửi request xuống IaaS.

---

### 👤 2. Tạ Duy Anh — Hiển Thị & Nút Gửi Request Phần Máy Ảo (Compute / Storage / Images)
**Mục tiêu:** Hiển thị danh sách máy ảo lấy từ DB lên bảng và làm các nút bấm gửi Request tạo/điều khiển máy ảo.

- [ ] **Hiển thị danh sách máy ảo từ DB lên bảng (`#tab-compute`):**
  - Gọi `GET /api/instances` lấy danh sách máy ảo từ DB về, hiển thị lên:
    - 4 ô thống kê trạng thái (`Total Instances`, `Running`, `Stopped`, `Migrating` - Hình 2.2).
    - Bảng máy ảo gồm các cột: `ID`, `Tên Máy Ảo`, `Vùng`, `Flavor`, `IP Nội Bộ`, `Public / Elastic IP`, `DNS`, `Trạng Thái`.
- [ ] **Làm Form & Nút gửi Request Khởi tạo máy ảo (`#launchModal` - Hình 2.3):**
  - Form chọn Tên máy ảo, Vùng (`Region A` / `Region B`), Hệ điều hành (`OS Image`), Cấu hình (`Flavor`), Dung lượng ổ đĩa (`EBS Size GB`) kèm khung `Instance Summary` bên phải.
  - Khi bấm nút **🚀 Launch Compute Instance**, gửi `POST /api/instances` kèm JSON xuống Backend và tải lại bảng danh sách từ DB.
- [ ] **Làm các Nút gửi Request Điều khiển vòng đời trên từng dòng máy ảo:**
  - Nút **Bật (`START`)**, **Dừng (`STOP`)**, **Reboot (`REBOOT`)**, **Xóa (`TERMINATE`)** $\rightarrow$ bấm vào gửi `POST /api/instances/{id}/actions` với `{ "action": "..." }`.
- [ ] **Hiển thị & Nút gửi Request ở tab Storage (`#tab-storage`) và Images (`#tab-images`):**
  - Nút tạo ổ đĩa (`POST /api/volumes`), gắn/tháo ổ đĩa, xem danh sách Image (`GET /api/images`).

---

### 👤 3. Hoàng Xuân Lực — Hiển Thị & Nút Gửi Request Phần Chuyển Vùng, Mạng & Giám Sát
**Mục tiêu:** Hiển thị dữ liệu kịch bản/tiến trình chuyển vùng lấy từ DB và làm các nút gửi Request tạo kịch bản, kích hoạt chuyển vùng, xem giám sát.

- [ ] **Hiển thị & Nút gửi Request ở tab Kịch bản chuyển vùng (`#tab-migration` - Hình 2.4):**
  - Gọi `GET /api/migrations/scenarios` lấy dữ liệu từ bảng `XRegion-Migrations` trên DB về hiển thị lên bảng danh sách kịch bản.
  - Làm Form & Nút **+ Tạo Kịch Bản Chuyển Vùng** (`#scenarioModal`) $\rightarrow$ bấm nút Lưu gửi `POST /api/migrations/scenarios` (gồm tên kịch bản, máy ảo nguồn, vùng nguồn $\rightarrow$ vùng đích, kiểu kích hoạt `MANUAL` / `SCHEDULED`, thời gian `cooldown`).
  - Làm Nút **⚡ Chạy Kịch Bản Ngay / Fast Migrate** $\rightarrow$ bấm vào gửi `POST /api/migrations/trigger` với `{ "id": "..." }`.
  - Hiển thị thanh tiến trình **6 bước chuyển vùng** và khung log lấy từ `GET /api/migrations/progress/{instanceId}`.
- [ ] **Hiển thị ở tab Mạng DNS (`#tab-network`) và Giám sát & Logs (`#tab-monitoring`):**
  - Hiển thị thông tin VPC, bản ghi DNS (`GET /api/network`), biểu đồ hiệu năng & chi phí (`GET /api/metrics/instances/{id}`) và bảng Nhật ký hệ thống (`GET /api/logs`).
  - Căn chỉnh lại CSS (`dashboard.css`) cho toàn bộ các bảng, badge trạng thái và nút bấm đồng bộ, dễ nhìn.

---

## 3. TỔNG HỢP CÁC NÚT BẤM & REQUEST TRÊN DASHBOARD 

| Nút bấm trên Giao diện | Endpoint gọi vào Controller | JSON Request gửi xuống (Body) | Hàm trong `Service` |
| :--- | :--- | :--- | :--- |
| **🚀 Launch Compute Instance** | `POST /api/instances` | `{ "name", "region", "flavor", "imageId", "ebsSizeGb", "domainName" }` | `InstanceService.launchInstance(request)` |
| **Bật / Dừng / Reboot / Xóa VM** | `POST /api/instances/{id}/actions` | `{ "action": "START" \| "STOP" \| "REBOOT" \| "TERMINATE" }` | `InstanceService.executeAction(id, request)` |
| **+ Tạo Ổ Đĩa EBS** | `POST /api/volumes` | `{ "name", "sizeGb", "region", "volumeType": "gp3" }` | `VolumeService.createVolume(request)` |
| **Lưu Kịch Bản Chuyển Vùng** | `POST /api/migrations/scenarios` | `{ "name", "targetInstanceId", "sourceRegion", "destRegion", "triggerType", "cooldownMinutes" }` | `MigrationService.createScenario(request)` |
| **⚡ Chạy Chuyển Vùng / Fast Migrate** | `POST /api/migrations/trigger` | `{ "id": "<instanceId hoặc scenarioId>" }` | `MigrationService.triggerMigration(targetId)` |

---

## 4. CHỐT PHÂN CÔNG



Chia việc cụ thể như sau để không đụng file nhau:

1️⃣ Cường (Đọc DB & Nhận Request ở Controller):
- Phụ trách Entity, DTO (Model/Request, Response) và Controllers.
- Đảm bảo đọc đúng dữ liệu từ 2 bảng DynamoDB (XRegion-Instances, XRegion-Migrations) trả về cho giao diện hiển thị.
- Giữ chuẩn các đầu API ở Controller nhận JSON từ nút bấm để tối Lâm chỉ việc viết tiếp trong tầng Service.

2️⃣ Duy Anh (Giao diện hiển thị & Nút gửi Request phần Máy ảo, Ổ đĩa, Image):
- Phụ trách #tab-compute, #tab-storage, #tab-images và #launchModal trong index.html & app.js + cấu hình chạy Docker/Server.
- Hiển thị bảng danh sách máy ảo lấy từ DB (kèm 4 ô thống kê trạng thái như Hình 2.2).
- Làm Form Launch Instance 2 cột (Hình 2.3) và các nút bấm gửi Request: Tạo máy ảo (POST /api/instances), Bật/Dừng/Reboot/Xóa (POST /api/instances/{id}/actions).

3️⃣ Lực (Giao diện hiển thị & Nút gửi Request phần Chuyển vùng, Mạng, Giám sát):
- Phụ trách #tab-migration, #tab-network, #tab-monitoring trong index.html, app.js và dashboard.css.
- Hiển thị danh sách kịch bản lấy từ DB và thanh trạng thái 6 bước chuyển vùng (Hình 2.4).
- Làm Form & Nút gửi Request: Lưu kịch bản (POST /api/migrations/scenarios), Kích hoạt chuyển vùng (POST /api/migrations/trigger) và hiển thị biểu đồ/logs.

Hạn 21h 06/11/2026
```
