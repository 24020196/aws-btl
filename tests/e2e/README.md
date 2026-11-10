# Kiểm thử giao diện tự động (Playwright) — Phủ 100% Service gọi AWS API Gateway

Bộ test mở trình duyệt Chromium, tự động tạo tài khoản test, thực hiện các thao tác UI thực tế và xác thực việc phát sự kiện trực tiếp lên **AWS API Gateway** (`POST /prod/events`) và đồng bộ xuống hạ tầng AWS / OpenStack (Step Functions, EventBridge, DynamoDB, Neutron Security Groups).

> [!IMPORTANT]
> **Bộ test này tương tác với hạ tầng AWS & OpenStack thật.**
> - Bộ test sử dụng **duy nhất 1 máy ảo xuyên suốt** toàn bộ chuỗi kiểm thử nhằm bảo toàn Warm Pool ($\le 2$ volumes) theo `SPEC-02` và `SPEC-SF-03`.
> - **100% các bài test đều kiểm chứng các thao tác gửi sự kiện lên AWS API Gateway**. Toàn bộ các bài test tĩnh, kiểm tra DOM hoặc chỉ gọi API đọc nội bộ đã được loại bỏ.
> - **Yêu cầu ứng dụng backend**: Biến môi trường `XREGION_SG_SYNC_ENABLED=true` phải được kích hoạt trên backend để `NetworkService` gửi sự kiện `security-group.updated` lên API Gateway (HTTP `202 Accepted`).

---

## 1. Chuẩn bị (làm 1 lần)

```powershell
cd tests/e2e
npm install
npx playwright install chromium
```

---

## 2. Biến môi trường bắt buộc

Trước khi chạy, cần thiết lập 2 biến môi trường:

| Biến | Ý nghĩa | Ví dụ |
|---|---|---|
| `BASE_URL` | Địa chỉ URL của ứng dụng backend đã deploy | `http://localhost:8081` hoặc `https://app.xregion.net` |
| `E2E_ALLOW_REAL_AWS` | Bắt buộc gán `1` để xác nhận cho phép tạo tài nguyên thật | `1` |

Ví dụ thiết lập trên PowerShell:
```powershell
$env:BASE_URL = "http://localhost:8081"
$env:E2E_ALLOW_REAL_AWS = "1"
```

---

## 3. Chạy kiểm thử tự động (Khuyến nghị)

Bạn có thể chạy kiểm thử tự động với 1 lệnh duy nhất bằng file script PowerShell (tự động thiết lập `BASE_URL`, bật `E2E_ALLOW_REAL_AWS=1`, cài npm nếu thiếu và chạy Playwright):

```powershell
# Chạy với BASE_URL mặc định http://localhost:8081
.\run-e2e.ps1

# Hoặc chỉ định URL của môi trường deploy
.\run-e2e.ps1 "http://localhost:8081"
.\run-e2e.ps1 "https://app.xregion.net"

# Chạy có hiển thị giao diện trình duyệt trực quan
.\run-e2e.ps1 -Headed

# Chạy và tự động mở báo cáo HTML sau khi hoàn tất
.\run-e2e.ps1 -Report
```

*(Nếu đang đứng sẵn trong thư mục `tests/e2e`, bạn có thể gõ `.\run.ps1`)*

---

## 4. Chạy thủ công từng lệnh

Nếu muốn chạy thủ công từng bước:

```powershell
$env:BASE_URL = "http://localhost:8081"
$env:E2E_ALLOW_REAL_AWS = "1"

cd tests/e2e
npx playwright test
```

---

## 4. Xử lý sự cố & Dọn dẹp thủ công (Cleanup)

Nếu quá trình chạy test bị ngắt đột ngột giữa chừng (Ctrl+C hoặc sự cố mạng):
File `%TEMP%/xregion-e2e/state.json` vẫn lưu thông tin phiên làm việc. Hãy chạy lệnh sau để dọn dẹp các máy còn sót:

```powershell
npm run cleanup
```

---

## 5. Danh mục các module kiểm thử (100% phát sự kiện lên AWS API Gateway)

| File Test | Sự kiện API Gateway | Service Backend & Phương thức | Thao tác kiểm thử |
|---|---|---|---|
| `05-launch.spec.js` | `key.import` | `KeyService.createKeyPair` | Mở `#createKeyModal` trên `launch.html`, tạo SSH Key Pair mới (`POST /api/keys`), nhận file `.pem` và kiểm tra `key_id` định danh duy nhất (SPEC-06 §2.1). |
| `05-launch.spec.js` | `instance.launch` | `InstanceService.launchInstance` | Điền form Launch kèm rule HTTPS 443 ở Bước 6 Firewall, bấm tạo máy (`POST /api/instances` nhận HTTP 202 `PENDING`), chờ Step Functions cấp phát và máy đạt `RUNNING`. |
| `07-security-group.spec.js` | `security-group.updated` | `NetworkService.createOrUpdateSecurityGroup` & `deleteRule` | Mở tab Security (`instance-detail.html`), thêm rule TCP 8443 (`POST`) rồi xóa rule (`DELETE`). Kiểm tra tăng `revision`, `lastEventId = revision` và `syncStatus = PENDING_SYNC`. |
| `13-instances-sg-editor.spec.js` | `security-group.updated` | `NetworkService.replaceInstanceRules` | Mở modal `#sgEditModal` trên trang Máy ảo (`instances.html`), ghi đè Inbound & Outbound rules (`PUT`). Kiểm tra HTTP 202, `eventPublished = true`, `syncAccepted = true`. |
| `14-instance-lifecycle.spec.js` | `instance.lifecycle` | `InstanceService.executeAction` | **1. STOP**: Kiểm tra START khi RUNNING trả 400; gửi STOP → chờ `STOPPED`.<br/>**2. START**: Kiểm tra STOP/REBOOT khi STOPPED trả 400; gửi START → chờ `RUNNING`.<br/>**3. REBOOT**: Gửi REBOOT → `REBOOTING` → về lại `RUNNING`.<br/>**4. TERMINATE**: Gửi TERMINATE → `SHUTTING_DOWN`; gọi lặp lại trả 409; chờ xóa cứng (Hard Delete — biến mất khỏi danh sách và GET trả 404). |
