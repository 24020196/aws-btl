# Cấu trúc frontend (src/main/resources/static)

Frontend được chia nhỏ theo từng trang để mỗi người sửa file của mình, hạn chế xung đột khi merge.
Không dùng công cụ build: các file JS là script thường, dùng chung phạm vi toàn cục (global), nạp bằng thẻ `<script>` theo thứ tự.

## CSS (`css/`)

Mọi trang vẫn chỉ nạp **một** file `css/dashboard.css`. File này giờ chỉ là danh sách `@import`, theo đúng thứ tự cũ:

| Thứ tự | File | Nội dung | Phụ trách |
|---|---|---|---|
| 1 | `base.css` | Biến màu, header, sub-nav, card, bảng, badge, modal, toast, thanh lỗi API | **Dùng chung** |
| 2 | `auth.css` | Đăng nhập, đăng ký | Cường |
| 3 | `overview.css` | Trang chủ: hero, KPI, thẻ vùng | Duy Anh / Lực |
| 4 | `launch.css` | Trang Launch: thẻ chọn OS, vùng, flavor | Duy Anh |
| 5 | `console-detail.css` | Style kiểu AWS console dùng ở các trang quản lý (kv-table, form sửa máy) | Duy Anh / Cường |
| 6 | `instance-detail.css` | Trang chi tiết máy ảo | Lực |
| 7 | `overview-migration.css` | Khung tóm tắt chuyển vùng trên trang chủ | Lực |
| 8 | `actions-menu.css` | Menu "Hành động" nhiều cấp | Cường |
| 9 | `header-extras.css` | Ô chọn ngôn ngữ, co giãn header trên điện thoại | **Dùng chung** |

Thứ tự import quyết định CSS nào ghi đè CSS nào, **không đổi thứ tự** nếu chưa kiểm tra lại giao diện.
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
js/pages/instance-detail.js    chi tiết máy ảo          (instance-detail.html) — Lực
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
| `login.html`, `register.html`, `account-tokens.html` | (không) |
| `index.html` | `pages/overview.js`, `pages/overview-migration.js` |
| `instances.html` | `shared/legacy-console.js`, `pages/instances.js` |
| `launch.html` | `pages/launch.js` |
| `instance-edit.html` | `pages/launch.js`, `pages/instance-edit.js` |
| `instance-detail.html` | `pages/instance-detail.js` |

## Quy ước làm việc

1. Chỉ sửa file của trang mình. File trong `js/core/`, `base.css`, `header-extras.css` là dùng chung: sửa qua PR nhỏ và **báo cả nhóm trước**.
2. Hàm mới chỉ trang mình dùng thì đặt trong file trang mình, không thêm vào `core/`.
3. Vì dùng chung phạm vi toàn cục, **đừng đặt trùng tên hàm** với file khác (file nạp sau sẽ ghi đè file nạp trước).
4. Trang mới: tạo `pages/<tên-trang>.js` và `css/<tên-trang>.css`, nạp 5 file core rồi file của trang, thêm `@import` vào cuối `dashboard.css`.
5. Luôn `git pull` bản `main` mới nhất trước khi tạo nhánh. Không tạo lại cả file từ bản cũ.
