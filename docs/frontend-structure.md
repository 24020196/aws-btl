# Cấu trúc frontend (src/main/resources/static)

Frontend được chia nhỏ theo từng trang để mỗi người sửa file của mình, hạn chế xung đột khi merge.
Không dùng công cụ build: các file JS là script thường, dùng chung phạm vi toàn cục (global), nạp bằng thẻ `<script>` theo thứ tự.

## CSS (`css/`)

Mọi trang vẫn chỉ nạp **một** file `css/dashboard.css`. File này giờ chỉ là danh sách `@import`, theo đúng thứ tự cũ:

| Thứ tự | File | Nội dung | Phụ trách |
|---|---|---|---|
| 1 | `base/tokens.css` | Biến màu (:root), reset, body | **Dùng chung** |
| 2 | `base/header.css` | Header trên cùng | **Dùng chung** |
| 3 | `base/layout.css` | Khung nội dung, card, bảng dữ liệu | **Dùng chung** |
| 4 | `base/status-badges.css` | Badge trạng thái kiểu EC2 | **Dùng chung** |
| 5 | `base/pipeline.css` | Pipeline 6 bước, terminal | **Dùng chung** |
| 6 | `base/feedback.css` | Modal, thanh lỗi API, toast | **Dùng chung** |
| 7 | `base/sub-nav.css` | Thanh menu trang | **Dùng chung** |
| 8 | `auth.css` | Đăng nhập, đăng ký | Cường |
| 9 | `overview.css` | Trang chủ: hero, KPI, thẻ vùng | Duy Anh / Lực |
| 10 | `launch.css` | Trang Launch: thẻ chọn OS, vùng, flavor | Duy Anh |
| 11 | `console-detail.css` | Style kiểu AWS console dùng ở các trang quản lý (kv-table, form sửa máy) | Duy Anh / Cường |
| 12 | `instance-detail.css` | Trang chi tiết máy ảo | Lực |
| 13 | `overview-migration.css` | Khung tóm tắt chuyển vùng trên trang chủ | Lực |
| 14 | `actions-menu.css` | Menu "Hành động" nhiều cấp | Cường |
| 15 | `header-extras.css` | Ô chọn ngôn ngữ, co giãn header trên điện thoại | **Dùng chung** |

Thứ tự import quyết định CSS nào ghi đè CSS nào, **không đổi thứ tự** nếu chưa kiểm tra lại giao diện.

Ngoài ra có CSS **chỉ dành cho một trang**, nằm trong `css/pages/` và chỉ trang đó nạp bằng `<link>` riêng (trước đây viết thẳng trong thẻ `<style>`):
`pages/login.css`, `pages/register.css` (Cường), `pages/account-tokens.css` (Cường), `pages/instance-edit.css` (Cường).
Thêm CSS cho trang mình thì viết vào file của trang đó. Cần file mới thì thêm một dòng `@import` vào **cuối** `dashboard.css`.

## JavaScript (`js/`)

```
js/core/ui.js            FLAVOR_SPECS, openModal/closeModal, showApiError/clearApiError, showToast, getStatusBadgeConfig
js/core/api.js           apiRequest
js/core/session.js       biến toàn cục (API_BASE, authToken...), chặn trang khi chưa đăng nhập, đồng bộ giờ server, tự đăng xuất
js/core/auth.js          đăng nhập, đăng ký, đăng xuất
js/core/i18n.js          song ngữ Việt/Anh (t, setGlobalLang, applyPageTranslations), badge người dùng
js/shared/legacy-console.js  code console một trang cũ; instances.html vẫn cần (triggerDirectMigration → switchTab → load*)
js/pages/overview.js           trang chủ                (index.html)
js/pages/overview-migration.js khung chuyển vùng trang chủ (index.html)      — Lực
js/pages/instances.js          danh sách máy ảo         (instances.html)     — Duy Anh
js/pages/launch.js             Launch + Key Pair        (launch.html, instance-edit.html) — Duy Anh / Lâm
js/pages/instance-edit.js      sửa máy ảo               (instance-edit.html) — Cường
js/pages/instance-detail/      chi tiết máy ảo, chia theo tab (instance-detail.html) — Lực
    core.js        trạng thái trang, tiện ích, tải/hiển thị máy, thanh nút
    migration.js   tab Chuyển vùng
    dialogs.js     Esc đóng modal, lệnh SSH, hộp xác nhận, menu Trạng thái/Hành động
    security.js    tab Bảo mật & Mạng
    storage.js     tab Lưu trữ
    monitoring.js  tab Giám sát
js/pages/login.js, register.js     code trang đăng nhập/đăng ký (trước đây viết thẳng trong HTML) — Cường
js/pages/account-tokens.js         trang Tài khoản & API Token — Cường
```

### Thứ tự nạp (đã có sẵn trong từng file HTML)

Mọi trang nạp 5 file core theo thứ tự:

```html
<script src="/js/core/ui.js"></script>
<script src="/js/core/api.js"></script>
<script src="/js/core/session.js"></script>
<script src="/js/core/auth.js"></script>
<script src="/js/core/i18n.js"></script>
```

`ui.js` và `api.js` phải đứng **trước** `session.js`, vì `session.js` chạy kiểm tra đăng nhập ngay khi nạp và có thể gọi `showToast`.

Sau đó mỗi trang nạp thêm file của mình:

| Trang | File nạp thêm |
|---|---|
| `login.html` | `pages/login.js` |
| `register.html` | `pages/register.js` |
| `account-tokens.html` | `pages/account-tokens.js` |
| `index.html` | `pages/overview.js`, `pages/overview-migration.js` |
| `instances.html` | `shared/legacy-console.js`, `pages/instances.js` |
| `launch.html` | `pages/launch.js` |
| `instance-edit.html` | `pages/launch.js`, `pages/instance-edit.js` |
| `instance-detail.html` | `pages/instance-detail/core.js`, `migration.js`, `dialogs.js`, `security.js`, `storage.js`, `monitoring.js` (đúng thứ tự này) |

## Quy ước làm việc

1. Chỉ sửa file của trang mình. File trong `js/core/`, `css/base/`, `header-extras.css` là dùng chung: sửa qua PR nhỏ và **báo cả nhóm trước**.
2. Hàm mới chỉ trang mình dùng thì đặt trong file trang mình, không thêm vào `core/`.
3. Vì dùng chung phạm vi toàn cục, **đừng đặt trùng tên hàm** với file khác (file nạp sau sẽ ghi đè file nạp trước).
4. Trang mới: tạo `js/pages/<tên-trang>.js` và `css/pages/<tên-trang>.css`, nạp 5 file core rồi file của trang; CSS riêng của trang thì `<link>` thẳng trong trang đó, không thêm vào `dashboard.css`.
5. Luôn `git pull` bản `main` mới nhất trước khi tạo nhánh. Không tạo lại cả file từ bản cũ.
6. Không viết khối `<style>` / `<script>` dài thẳng trong HTML; đưa ra file trong `css/pages/` hoặc `js/pages/`.
