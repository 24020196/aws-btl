# PHÂN CHIA CÔNG VIỆC XÂY DỰNG XREGION DASHBOARD 

> **Mục tiêu hiện tại:** Hoàn thiện gọn gàng ứng dụng **XRegion Dashboard** (Giao diện + API trong project hiện tại) để **Trưởng nhóm (Nguyễn Tuấn Lâm)** dùng Dashboard test luồng **Tạo & Quản lý máy ảo (Compute) ở Vùng 1** trước. Phần Chuyển vùng và Giám sát chuyên sâu sẽ triển khai ở bước tiếp theo sau khi test tạo máy ảo thành công.

---

## 1. NGUYÊN TẮC LÀM VIỆC
- **Không thêm thư viện hay kiến trúc phức tạp mới:** Bám sát đúng cấu trúc project hiện có (`Controllers`, `Services`, `Entity`, `Model`, `static/index.html`, `static/css/dashboard.css`, `static/js/app.js`).
- **Tập trung dứt điểm luồng Tạo & Quản lý máy ảo trước:** Để Lâm bấm trên Dashboard gửi JSON chuẩn đi tạo máy ảo và xem trạng thái máy ảo ở Vùng 1.
- **Chia việc theo đúng các file đang có sẵn trong repo** để 3 người code song song không bị đụng code (Conflict) khi gộp nhánh Git.

---

## 2. BẢNG PHÂN CHIA CÔNG VIỆC CHI TIẾT CHO 3 THÀNH VIÊN

| Thành viên | Phần việc phụ trách trên Dashboard | Các file làm việc chính trong Project |
| :--- | :--- | :--- |
| **1. Hoàng Xuân Lực** | **Deploy Dashboard & Kết nối API tạo máy ảo với Lâm** | • `Dockerfile`, `docker-compose.yml`, `.env`<br>• `src/main/resources/application.yaml`<br>• `src/main/java/com/iaas/xregion/Config/DynamoDbConfig.java`<br>• `src/main/java/com/iaas/xregion/Services/InstanceService.java` *(phần gọi API sang hệ thống của Lâm)* |
| **2. Nguyễn Mạnh Cường** | **Backend API của Dashboard (Instances, Volumes, Images) & Lưu DynamoDB** | • `Controllers/InstanceController.java`, `VolumeController.java`, `ImageController.java`<br>• `Services/InstanceService.java`, `VolumeService.java`, `ImageService.java`<br>• `Entity/InstanceEntity.java`, `RegionType.java`<br>• `Model/Request/LaunchInstanceRequest.java`, `InstanceActionRequest.java`<br>• `Model/Response/InstanceResponse.java` |
| **3. Tạ Duy Anh** | **Giao diện Web UI/JS của Dashboard (Màn hình Máy ảo, Form Khởi tạo, Ổ đĩa, Image)** | • `src/main/resources/static/index.html`<br>• `src/main/resources/static/css/dashboard.css`<br>• `src/main/resources/static/js/app.js` |

---

## 3. ĐẦU VIỆC CỤ THỂ CỦA TỪNG NGƯỜI

### 👤 1. Hoàng Xuân Lực — Đưa Dashboard lên Server & Nối API với Lâm
1. **Chạy và đưa Dashboard lên EC2 Public (hoặc môi trường chung):**
   - Cấu hình `.env` và `application.yaml`, chạy `docker compose up -d` để đưa Dashboard lên địa chỉ IP công khai cho Lâm và cả nhóm truy cập.
2. **Thống nhất đầu mối API với Lâm:**
   - Nhận đường link API Gateway / Endpoint từ Lâm.
   - Phối hợp với Cường để chuyển dữ liệu JSON từ `InstanceService.java` khi người dùng bấm *Launch Instance* hoặc *Start / Stop / Reboot / Terminate* sang API của Lâm thay vì chỉ tạo dữ liệu giả lập.

---

### 👤 2. Nguyễn Mạnh Cường — Phụ trách Backend API & DynamoDB trên Dashboard
1. **Chuẩn hóa dữ liệu tạo máy ảo (`LaunchInstanceRequest.java` & `InstanceEntity.java`):**
   - Đảm bảo các trường JSON nhận từ giao diện khớp với yêu cầu tạo máy ảo của Lâm:
     - `name`: Tên máy ảo
     - `region`: Mã vùng (thống nhất với Lâm dùng `ap-southeast-1` Singapore hay `ap-southeast-2` Sydney)
     - `flavor`: Cấu hình (`t3.small` / `t3.medium` / `t3.large` hoặc `m1.small` / `m1.medium`)
     - `imageId`: Hệ điều hành (`img-u22`, `img-deb12`, `img-rocky9`, `img-alp319`)
     - `ebsSizeGb`: Dung lượng ổ đĩa EBS gp3 (GB)
     - `keyPairName`, `securityGroup`
2. **Hoàn thiện các API trong `InstanceService.java`, `VolumeService.java`, `ImageService.java`:**
   - `GET /api/instances`: Lấy danh sách máy ảo từ bảng DynamoDB `XRegion-Instances` trả về lên giao diện.
   - `POST /api/instances`: Nhận thông tin từ Form tạo máy ảo, gửi yêu cầu tạo máy ảo và lưu thông tin máy ảo (`instanceId`, `privateIp`, `elasticIp`, `currentStatus`) vào DynamoDB.
   - `POST /api/instances/{id}/actions`: Xử lý các nút bấm `START`, `STOP`, `REBOOT`, `TERMINATE` và cập nhật lại trạng thái vào DynamoDB.
   - `GET /api/volumes`, `POST /api/volumes` và `GET /api/images`: Đảm bảo trả đúng danh sách ổ đĩa EBS gp3 và danh sách OS Image cho giao diện.
3. *(Tạm gác phần `MigrationService.java` sang giai đoạn sau khi đã test tạo máy ảo thành công).*

---

### 👤 3. Tạ Duy Anh — Phụ trách Giao diện Điều khiển (Frontend HTML/CSS/JS)
1. **Hoàn thiện Màn hình Danh sách Máy ảo (`#tab-compute` trong `index.html` & `app.js`):**
   - Hiển thị 4 ô thống kê tổng quan phía trên bảng: `Total Instances`, `Running`, `Stopped`, `Migrating` (giống Hình 2.2 trong báo cáo).
   - Hoàn thiện bảng danh sách máy ảo hiển thị rõ: `ID`, `Tên Máy Ảo`, `Vùng`, `Cấu hình (Flavor)`, `IP Nội Bộ`, `Public / Elastic IP`, `DNS Domain`, `Trạng Thái` và các nút `Bật (Start)`, `Dừng (Stop)`, `Reboot`, `Xóa (Terminate)`.
2. **Hoàn thiện Form Khởi tạo Máy ảo (`#launchModal` trong `index.html` & `app.js`):**
   - Chỉnh lại giao diện khởi tạo máy ảo (theo Hình 2.3 trong báo cáo):
     - Chọn Tên máy ảo, Vùng triển khai (Region A / Region B), Ảnh hệ điều hành (Ubuntu, Debian, Rocky, Alpine), Cấu hình Flavor (vCPU/RAM), Dung lượng ổ đĩa EBS gp3 (GB).
     - Hiển thị phần tóm tắt cấu hình & chi phí ước tính (`Instance Summary` - `$/hour` & `$/month`) tự động nhảy số khi chọn cấu hình.
   - Khi bấm nút **Xác nhận khởi tạo**, hàm `submitLaunch(e)` trong `app.js` gửi đúng JSON lên `POST /api/instances`, thông báo kết quả rõ ràng (nếu lỗi thì hiện chi tiết lỗi trả về để Lâm dễ kiểm tra) và tải lại bảng danh sách máy ảo.
3. **Kiểm tra hiển thị ở Tab Storage (`#tab-storage`) và Images (`#tab-images`):**
   - Đảm bảo bảng danh sách ổ đĩa EBS và danh sách OS Image hiển thị mượt, không lỗi giao diện.
4. *(Tạm thời giữ nguyên chưa cần sửa các tab Migration, Network, Monitoring cho đến khi test xong phần tạo máy ảo).*

---

## 4. MẪU JSON GỬI TỪ GIAO DIỆN XUỐNG BACKEND (ĐỂ 3 BẠN & LÂM THỐNG NHẤT)

### 1. Khi bấm nút "Khởi tạo máy ảo" (`POST /api/instances`)
**JSON gửi đi từ `app.js` (Lực) $\rightarrow$ `InstanceController` (Cường):**
```json
{
  "name": "Web-Prod-01",
  "region": "ap-southeast-1",
  "flavor": "t3.medium",
  "imageId": "img-u22",
  "ebsSizeGb": 50,
  "ebsVolumeType": "gp3",
  "keyPairName": "xregion-key",
  "securityGroup": "sg-default",
  "domainName": "web-prod-01.xregion.net"
}
```

**JSON trả về cho giao diện hiển thị (`InstanceResponse`):**
```json
{
  "success": true,
  "message": "Instance launched successfully",
  "data": {
    "id": "i-0a3f9c21e7b4d5810",
    "name": "Web-Prod-01",
    "region": "ap-southeast-1",
    "regionName": "Singapore (Region A)",
    "flavor": "t3.medium (2 vCPU / 4 GB RAM)",
    "status": "ACTIVE",
    "privateIp": "10.0.1.125",
    "publicIp": "54.214.10.15",
    "dnsDomain": "web-prod-01.xregion.net",
    "imageId": "img-u22",
    "imageName": "Ubuntu 22.04 LTS (Jammy Jellyfish)"
  }
}
```

### 2. Khi bấm nút "Bật / Dừng / Reboot / Xóa" (`POST /api/instances/{id}/actions`)
```json
{
  "action": "STOP"
}
```
*(Các giá trị của `action`: `"START"`, `"STOP"`, `"REBOOT"`, `"TERMINATE"`)*

---

## 5. TRÌNH TỰ PHỐI HỢP TRONG NHÓM
1. **Bước 1:** **Lực** chỉnh sửa giao diện `#tab-compute` và `#launchModal` trong `index.html`, `dashboard.css`, `app.js`. Song song đó **Cường** rà soát và hoàn thiện `InstanceController`, `InstanceService`, `LaunchInstanceRequest` và bảng DynamoDB.
2. **Bước 2:** Gộp code của **Lực** và **Cường** lại, chạy thử trên máy local để đảm bảo bấm nút tạo máy ảo, bật, dừng, xóa trên giao diện hoạt động mượt mà.
3. **Bước 3:** **Duy Anh** đưa bản Dashboard này lên EC2 Public và nối endpoint tạo máy ảo vào API Gateway / Lambda của **Lâm** để Lâm bấm test tạo máy ảo thật ở Vùng 1.
4. **Bước 4:** Sau khi Lâm test tạo máy ảo Vùng 1 thành công, **Cường** và **Lực** mới bắt đầu làm tiếp phần Kịch bản chuyển vùng và Giám sát.

