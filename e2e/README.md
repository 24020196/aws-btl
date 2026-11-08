# Kiểm thử giao diện tự động (Playwright)

Bộ test mở trình duyệt Chromium, tự tạo tài khoản và máy ảo qua API rồi bấm thử giao diện như người dùng thật.
Mỗi lần chạy dùng tài khoản mới nên không ảnh hưởng dữ liệu của bạn.

## Chuẩn bị (làm 1 lần)

```powershell
cd e2e
npm install
npx playwright install chromium
```

## Chạy

App phải đang chạy (DynamoDB Local + `xregion-app`, mặc định `http://localhost:8081`).

```powershell
cd e2e
npx playwright test                 # chạy tất cả, không hiện trình duyệt
npx playwright test --headed        # xem trình duyệt bấm từng bước
npx playwright test tests/12-security-group.spec.js   # chạy 1 file
npx playwright show-report          # mở báo cáo HTML
```

App chạy ở địa chỉ khác: `$env:BASE_URL="http://localhost:8080"; npx playwright test`

Test lỗi thì báo cáo có kèm ảnh chụp, video và trace (xem từng bước) của đúng bài lỗi.

## Các module

| File | Nội dung | Phụ trách |
|---|---|---|
| `10-dashboard.spec.js` | EC2 Dashboard: bố cục, ô Resources đúng số liệu, English, điện thoại | Lực |
| `11-instance-detail.spec.js` | Trang chi tiết: tiêu đề, 6 tab + #hash, khóa Start khi đang chạy, hộp xác nhận, trang "không tìm thấy", đổi ngôn ngữ | Lực |
| `12-security-group.spec.js` | Security Group riêng mỗi máy: không dùng chung, thêm/lọc/xóa rule, cách ly tài khoản | Lực |
| `13-migration.spec.js` | Fast Migrate: hộp xác nhận, tự cuộn tới 6 bước, hoàn tất, 2 snapshot, cooldown, lỗi theo ngôn ngữ | Lực |
| `14-launch-firewall.spec.js` | Launch bước 6: hộp thoại thêm rule, chặn trùng, cảnh báo, rule ghi vào nhóm của máy mới | Lực |
| `15-list-detail-sync.spec.js` | Trang Máy ảo và trang chi tiết đồng bộ: badge, menu, hộp Kết nối, hộp xác nhận | Lực |

Thêm test mới: tạo `tests/<số>-<tên>.spec.js`, dùng các hàm trong `tests/helpers.js`
(`createUser`, `createInstance`, `loginPage`, `watchPage`, `vietnameseLines`).

## Chưa kiểm thử được ở local

- Start / Stop / Reboot đổi trạng thái (backend đang sửa).
- Tạo Key Pair thật (cần AWS) — test Launch thêm tạm một key giả vào ô chọn.
