# Kiểm thử giao diện tự động (Playwright)

Bộ test mở trình duyệt Chromium, tự tạo tài khoản và máy ảo qua API rồi bấm thử giao diện như người dùng thật.
Mỗi lần chạy dùng tài khoản mới nên không ảnh hưởng dữ liệu của bạn.

## Chuẩn bị (làm 1 lần)

```powershell
cd e2e
npm install
npx playwright install chromium
```

## Chạy app cho e2e (quan trọng)

Từ PR #28/#29, tạo / sửa / dừng máy ảo gửi sự kiện lên **AWS API Gateway → Step Function (tạo máy thật)**.
Vì vậy app chạy để test **phải** dùng profile `local`, **không** dùng file `.env` có key AWS:

- dữ liệu ghi vào **DynamoDB Local** (`localhost:8000`), không đụng bảng thật của nhóm;
- sự kiện gửi tới **"Step Function giả"** mà bộ test tự bật ở cổng `9999` (thay cho AWS). Khi app gửi `instance.launch`,
  nó ghi bản ghi `XRegion-Nova` trạng thái `ACTIVE` vào DynamoDB Local để máy lên `RUNNING`, giống Step Function thật.

Trước khi chạy, `global-setup.js` tự kiểm tra cả hai điều trên và tạo các bảng còn thiếu trong DynamoDB Local.
Sai một điều là **dừng ngay, không chạy bài test nào**, nên không thể lỡ tạo máy thật.

Chạy app bằng Docker (DynamoDB Local đang chạy trên máy ở cổng 8000):

```powershell
docker run --rm -p 8081:8080 `
  -e SPRING_PROFILES_ACTIVE=local `
  -e DYNAMODB_ENDPOINT=http://host.docker.internal:8000 `
  -e AWS_APIGATEWAY_EVENTENDPOINT=http://host.docker.internal:9999/prod/events `
  xregion-app
```

Hoặc chạy jar trực tiếp: `java -jar target/xregion-1.0.0.jar --spring.profiles.active=local --server.port=8081`

> Không thêm `--env-file .env` khi chạy app để test.

## Chạy

```powershell
cd e2e
npx playwright test                 # chạy tất cả, không hiện trình duyệt
npx playwright test --headed        # xem trình duyệt bấm từng bước
npx playwright test tests/07-security-group.spec.js   # chạy 1 file
npx playwright show-report          # mở báo cáo HTML
```

Biến môi trường (thường không cần đổi): `BASE_URL` (mặc định `http://localhost:8081`),
`E2E_DYNAMODB_ENDPOINT` (mặc định `http://localhost:8000`), `E2E_GATEWAY_PORT` (mặc định `9999`).

Test lỗi thì báo cáo có kèm ảnh chụp, video và trace (xem từng bước) của đúng bài lỗi.

## Các module

| File | Nội dung |
|---|---|
| `01-auth.spec.js` | Đăng nhập (hiện mật khẩu, tài khoản mẫu, sai mật khẩu, ghi nhớ tài khoản), quay lại trang đã muốn mở (?redirect), đăng ký, đăng xuất |
| `02-navigation-i18n.spec.js` | Sidebar từng trang, thu gọn sidebar, đổi ngôn ngữ ở header, English không sót chữ Việt, menu và bề ngang trên điện thoại 390px |
| `03-dashboard.spec.js` | EC2 Dashboard: bố cục, ô Resources đúng số liệu, English, điện thoại |
| `04-instances-list.spec.js` | Danh sách máy: KPI, tìm kiếm, lọc trạng thái, chọn 1 / nhiều / tất cả, khung tóm tắt 4 tab, tên Security Group, copy, hộp Kết nối, khóa mục menu, hộp xác nhận Xóa / Dừng |
| `05-launch.spec.js` | Launch: chọn vùng, hệ điều hành (từ API), loại máy, ổ đĩa, key pair, ô tóm tắt, chặn form thiếu tên, tạo máy |
| `06-instance-detail.spec.js` | Trang chi tiết: tiêu đề, 6 tab + #hash, khóa Start khi đang chạy, hộp xác nhận, trang "không tìm thấy", đổi ngôn ngữ |
| `07-security-group.spec.js` | Security Group riêng mỗi máy: không dùng chung, thêm/lọc/xóa rule, cách ly tài khoản |
| `08-migration.spec.js` | Fast Migrate: hộp xác nhận, tự cuộn tới 6 bước, hoàn tất, 2 snapshot, cooldown, lỗi theo ngôn ngữ |
| `09-launch-firewall.spec.js` | Launch bước 6: hộp thoại thêm rule, chặn trùng, cảnh báo, rule ghi vào nhóm của máy mới |
| `10-list-detail-sync.spec.js` | Trang Máy ảo và trang chi tiết đồng bộ: badge, menu, hộp Kết nối, hộp xác nhận |
| `11-instance-edit.spec.js` | Chỉnh sửa máy: 8 khung theo ?section, khóa đổi loại máy khi đang chạy, chặn giảm ổ EBS, đổi tên rồi về trang chi tiết |
| `12-account-tokens.spec.js` | Tài khoản & API Token: hồ sơ, tạo token, thu hồi qua hộp xác nhận, đổi mật khẩu |

Thêm test mới: tạo `tests/<số>-<tên>.spec.js`, dùng các hàm trong `tests/helpers.js`
(`createUser`, `createInstance`, `api`, `loginPage`, `watchPage`, `vietnameseLines`).

## Chưa kiểm thử (đang làm ở backend)

- Start / Stop / Reboot / Terminate thật qua `POST /instances/{id}/actions`: chỉ test hộp xác nhận, không gửi lệnh.
- Tạo Key Pair thật (cần AWS): test Launch thêm tạm một key giả vào ô chọn.
- Sự kiện tạo máy chưa mang vùng nên máy mới luôn ở Sydney: test cần máy ở N. Virginia thì tạo xong chuyển vùng sang (`migrateTo`).
- 3 bài đánh dấu `fixme` (hiện là *skipped* trong báo cáo), bật lại khi backend làm xong:
  tạo máy đúng vùng / ảnh đã chọn, lưu `cooldownSeconds` khi sửa máy, dùng API Token `xreg_...` để gọi API.
