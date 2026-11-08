# PHÂN CHIA CÔNG VIỆC UI — NGÀY 08/11 (CHỈ STATIC RESOURCE)

> **Phạm vi:** chỉ sửa `src/main/resources/static/**` (HTML / CSS / JS / ảnh). **Không** sửa Backend Java trong đợt này.
> **Tài liệu gốc:** [`docs/frontend-structure.md`](docs/frontend-structure.md) (cấu trúc file, quy ước), [`PHAN_CHIA_CONG_VIEC_DASHBOARD.md`](PHAN_CHIA_CONG_VIEC_DASHBOARD.md) (ai sở hữu trang nào).
>
> **4 hạng mục hôm nay:**
> 1. Chuyển thanh menu ngang (`.sub-nav`) sang **sidebar navigation** bên trái kiểu AWS Console.
> 2. **Chuẩn hóa song ngữ** Việt / Anh cho mọi trang (một cơ chế duy nhất, một bảng thuật ngữ).
> 3. **Xóa icon cũ** (emoji ⏳ ⚡ 🗑 🔄…, SVG vẽ tay copy trong từng trang, favicon data-URI) → thay bằng **thư viện icon dùng chung**.
> 4. **Bố cục phân tầng kiểu AWS EC2**: Sidebar → Breadcrumb → Page header → Danh sách → Panel chi tiết / Tabs.

---

## 0. THƯ VIỆN HÌNH ẢNH DÙNG CHUNG (ĐÃ CÓ SẴN — PULL VỀ LÀ DÙNG)

| File | Nội dung |
|---|---|
| `static/img/icons/sprite.svg` | **69 icon** trong 1 file: `svc-*` (17 dịch vụ đám mây), `ui-*` (45 icon thao tác), `os-*` (7 hệ điều hành) |
| `static/img/logo.svg` | Logo XRegion **EC2** (mark + chữ) cho header / trang đăng nhập |
| `static/img/favicon.svg` | Favicon, thay cho chuỗi `data:image/svg+xml,...` đang copy trong `index.html`, `instance-detail.html` |
| `static/css/base/icons.css` | Class `.ico`, kích thước `.ico-xs … .ico-3xl`, màu `.ico-muted/-accent/-success/-warning/-danger`, `.ico-spin`, `.ico-btn`, `.ico-label`, `.svc-tile` |
| `static/icons-preview.html` | **Mở `http://localhost:8080/icons-preview.html`** để xem toàn bộ icon, tìm kiếm, bấm để copy snippet |

**Cách dùng (mọi người dùng y hệt):**

```html
<svg class="ico" aria-hidden="true"><use href="/img/icons/sprite.svg#ui-refresh"></use></svg>
<svg class="ico ico-2xl"><use href="/img/icons/sprite.svg#svc-ec2"></use></svg>
```

Trong JS (template string):

```js
const ICON = (id, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="/img/icons/sprite.svg#${id}"></use></svg>`;
```

> ⚠️ Hàm `ICON()` ở trên sẽ được **Cường đặt sẵn trong `js/core/ui.js`** (PR shell). Không ai tự khai báo lại hàm này trong file trang (trùng tên toàn cục).

**Bảng icon theo ý nghĩa — dùng thống nhất, không tự chọn khác:**

| Ý nghĩa | Icon | Ý nghĩa | Icon |
|---|---|---|---|
| EC2 Dashboard | `svc-ec2` | Máy ảo / Instances | `svc-instance` (to) · `ui-server` (menu) |
| Launch instance | `ui-plus` | AMI / OS Image | `svc-ami` |
| EBS Volume | `svc-ebs` · `ui-storage` | Snapshot | `svc-snapshot` |
| VPC / Subnet | `svc-vpc` · `svc-subnet` | Route 53 DNS | `svc-route53` |
| Elastic IP | `svc-elastic-ip` | Security Group | `svc-security-group` · `ui-shield` |
| Key Pair | `svc-key-pair` | API Token | `ui-token` |
| DynamoDB | `svc-dynamodb` | Giám sát (Monitoring) | `svc-cloudwatch` · `ui-chart` |
| Audit log | `svc-cloudtrail` | Chuyển vùng | `svc-migration` · `ui-migrate` |
| Vùng (Region) | `svc-region` · `ui-globe` | Ngôn ngữ | `ui-globe` |
| Start | `ui-play` | Stop | `ui-stop` |
| Reboot | `ui-reboot` | Terminate | `ui-trash` |
| Instance state ▾ | `ui-power` | Actions ▾ | `ui-chevron-down` |
| Connect (SSH) | `ui-terminal` | Sửa | `ui-edit` |
| Làm mới | `ui-refresh` | Tìm kiếm / Lọc | `ui-search` · `ui-filter` |
| Copy (ID, IP, DNS) | `ui-copy` | Menu ⋯ trên dòng | `ui-more` |
| Trạng thái chuyển tiếp | `ui-spinner ico-spin` | Cooldown / thời gian | `ui-clock` |
| `migration_lock` | `ui-lock` / `ui-unlock` | Lịch sử | `ui-history` |
| Thông báo: info / warn / error / ok | `ui-info` · `ui-warning` · `ui-error` · `ui-check-circle` | Đóng modal | `ui-close` |
| Người dùng / Đăng xuất | `ui-user` · `ui-logout` | Thu gọn sidebar | `ui-sidebar` · `ui-menu` (mobile) |
| Ubuntu / Debian / CentOS / Rocky / Amazon Linux / Windows / khác | `os-ubuntu` · `os-debian` · `os-centos` · `os-rocky` · `os-amazon-linux` · `os-windows` · `os-linux` | | |

> Trạng thái máy ảo (RUNNING, STOPPED…) **vẫn dùng badge CSS** trong `base/status-badges.css` (chấm tròn màu), **không** dùng emoji. Trạng thái chuyển tiếp thêm `ui-spinner ico-spin` trước chữ.
> Cần icon mới → nhắn nhóm, **một người** thêm `<symbol>` vào `sprite.svg` (có `<title>`), không vẽ SVG inline trong trang.

---

## 1. BẢNG PHÂN CÔNG

| Thành viên | Việc hôm nay | File sở hữu (chỉ người này sửa) |
|---|---|---|
| **1. Nguyễn Mạnh Cường** — *Shell & i18n core* | **A.** PR "shell" (chặn các bạn khác, ưu tiên merge trước): sidebar, layout khung, breadcrumb/page-header dùng chung, `ICON()`, `registerI18n`, favicon/logo trên header<br>**B.** Áp dụng sidebar + icon + i18n cho trang của mình<br>**C.** Viết bảng thuật ngữ EN/VI (mục 4) vào code i18n | **Dùng chung:** `js/core/ui.js`, `js/core/i18n.js`, **mới** `js/core/sidebar.js`, `css/dashboard.css`, `css/base/header.css`, `css/base/layout.css`, `css/base/sub-nav.css`, **mới** `css/base/sidebar.css`, `css/header-extras.css`<br>**Trang:** `login.html`, `register.html`, `account-tokens.html`, `instance-edit.html` + `js/pages/login.js`, `register.js`, `account-tokens.js`, `instance-edit.js`, `css/auth.css`, `css/actions-menu.css`, `css/pages/auth-shared.css`, `login.css`, `register.css`, `account-tokens.css`, `instance-edit.css` |
| **2. Tạ Duy Anh** — *Danh sách & Khởi tạo máy ảo* | **A.** `instances.html` theo bố cục EC2 Instances (list + split-pane chi tiết + **chọn nhiều máy ảo cùng lúc để thao tác hàng loạt** Start/Stop/Reboot/Terminate)<br>**B.** `launch.html` theo bố cục EC2 "Launch an instance" (section + Summary bên phải)<br>**C.** Xóa emoji/SVG cũ, chuyển text sang `data-i18n` cho 2 trang | `instances.html`, `launch.html`, `js/pages/instances.js`, `js/pages/launch.js`, `css/launch.css`, `css/console-detail.css`, **mới** `css/pages/instances.css` |
| **3. Hoàng Xuân Lực** — *Dashboard & Chi tiết máy ảo* | **A.** `index.html` theo bố cục "EC2 Dashboard" (Resources tiles, Region cards, migration summary)<br>**B.** `instance-detail.html` theo bố cục EC2 Instance summary + Tabs<br>**C.** Xóa emoji/SVG cũ, chuyển text sang `data-i18n` cho 2 trang | `index.html`, `instance-detail.html`, `js/pages/overview.js`, `overview-migration.js`, `js/pages/instance-detail/*.js`, `css/overview.css`, `css/overview-migration.css`, `css/instance-detail.css`, `css/base/status-badges.css`, `css/base/pipeline.css` |

> **Quy tắc vàng hôm nay:** chỉ Cường được sửa `js/core/*`, `css/base/*` (trừ `status-badges.css`, `pipeline.css` của Lực), `dashboard.css`. Ai cần thêm gì vào file dùng chung → nhắn Cường, không tự sửa.

---

## 2. TRÌNH TỰ TRIỂN KHAI

| Giai đoạn | Cường | Duy Anh | Lực |
|---|---|---|---|
| **1. Khởi động** | Cả nhóm `git pull origin main`, mở `/icons-preview.html`, đọc tài liệu này | ← | ← |
| **2. Bố cục & Shell** | **PR shell** (mục 3.1) | Thay emoji/SVG trong `instances.js`, `launch.js`; dựng bố cục mới **bên trong** vùng nội dung (chưa đụng nav) | Thay emoji/SVG trong `overview*.js`, `instance-detail/*.js`; dựng bố cục mới bên trong vùng nội dung |
| **3. Merge Shell** | **Merge PR shell vào `main`** → báo nhóm | `git pull` / rebase | `git pull` / rebase |
| **4. Ghép trang** | Gắn sidebar + i18n cho 4 trang của mình | Gắn sidebar, breadcrumb, `data-i18n` cho `instances`, `launch` | Gắn sidebar, breadcrumb, `data-i18n` cho `index`, `instance-detail` |
| **5. Mở PR** | Mở PR trang | Mở PR trang | Mở PR trang |
| **6. Review** | Review PR Lực | Review PR Cường | Review PR Duy Anh |
| **7. Nghiệm thu** | Merge lần lượt: Cường → Duy Anh → Lực; chạy checklist nghiệm thu (mục 6) | ← | ← |


---

## 3. CHI TIẾT TỪNG NGƯỜI

### 👤 1. Nguyễn Mạnh Cường — Shell (Sidebar + Layout) & i18n core

#### 3.1 PR shell (Ưu tiên làm trước)

- [ ] **`css/dashboard.css`**: thêm vào **cuối** 2 dòng `@import url('base/icons.css');` và `@import url('base/sidebar.css');`.
- [ ] **`js/core/ui.js`**: thêm hàm `ICON(id, cls)` (mục 0).
- [ ] **Mới `js/core/sidebar.js`**: tự render sidebar vào `<aside id="appSidebar" data-active="...">`. Danh sách menu khai báo **một chỗ** trong file này:

  | Nhóm (giống EC2) | Mục | Link | `data-active` | Icon |
  |---|---|---|---|---|
  | — | EC2 Dashboard | `/index.html` | `dashboard` | `svc-ec2` |
  | Instances | Instances | `/instances.html` | `instances` | `ui-server` |
  | | Launch instance | `/launch.html` | `launch` | `ui-plus` |
  | Images | AMIs | — *(mờ, "Coming soon")* | | `svc-ami` |
  | Elastic Block Store | Volumes · Snapshots | — *(mờ)* | | `svc-ebs` · `svc-snapshot` |
  | Network & Security | Security Groups · Elastic IPs · Key Pairs | — *(mờ, sẽ mở khi có API của Lực)* | | `svc-security-group` · `svc-elastic-ip` · `svc-key-pair` |
  | Migration | Cross-Region Migration | — *(mờ)* | | `svc-migration` |
  | Account | API Tokens | `/account-tokens.html` | `tokens` | `ui-token` |

  - `instance-detail.html` và `instance-edit.html` dùng `data-active="instances"` (đúng phân tầng EC2: chi tiết máy thuộc nhóm Instances).
  - Nút thu gọn (`ui-sidebar`) lưu trạng thái vào `localStorage['xregion_sidebar_collapsed']`; khi thu gọn chỉ còn icon (rộng 56px), mở rộng 240px.
  - Màn hình < 900px: sidebar ẩn, nút `ui-menu` trên header mở dạng drawer + lớp phủ.
  - Tên mục menu lấy qua `t()` / từ điển i18n.
- [ ] **Mới `css/base/sidebar.css`**: `.app-shell` (flex ngang), `.app-sidebar`, `.app-sidebar.collapsed`, `.sidebar-group-title`, `.sidebar-item`, `.sidebar-item.active` (viền trái `--accent-cyan`), `.sidebar-item.disabled`, `.app-main` (flex: 1, cuộn riêng), **`.breadcrumb`**, **`.page-header`** (tiêu đề + số lượng + nhóm nút bên phải).
- [ ] **`css/base/sub-nav.css`**: để lại file nhưng đánh dấu `/* DEPRECATED — xóa sau khi 8 trang đã chuyển sang sidebar */`.
- [ ] **`css/base/layout.css`**: điều chỉnh khung nội dung để chạy được trong `.app-main` (bỏ max-width cứng nếu có).
- [ ] **`css/base/header.css`**: header cố định trên cùng, logo dùng `<img src="/img/logo.svg">`, thêm chỗ cho nút `ui-menu` (mobile).
- [ ] **`js/core/i18n.js`** — **một cơ chế duy nhất**:
  ```js
  registerI18n({ instancesTitle: ['Máy ảo', 'Instances'], ... }); // mỗi trang gọi trong file JS của mình
  tk('instancesTitle');                                           // lấy chuỗi theo ngôn ngữ hiện tại
  ```
  `applyPageTranslations()` xử lý `[data-i18n]` (text), `[data-i18n-placeholder]`, `[data-i18n-title]`, `[data-i18n-aria]`.
  - Giữ `t(vi, en)` cho chuỗi động trong JS.
  - Giữ `I18N_PAIRS` + `data-i18n-vi/en` **tạm thời** làm fallback, ghi chú `LEGACY`; trang nào chuyển xong thì xóa cặp của trang đó.
  - Chuyển từ điển riêng trong `login.js`, `register.js` sang `registerI18n` (đang có 2 cơ chế `data-i18n` tự viết riêng).
  - Đặt `<html lang>` theo ngôn ngữ hiện tại.

**Hợp đồng HTML cho mọi trang có đăng nhập (sau PR shell):**

```html
<header class="header">…logo + region pill + ô ngôn ngữ + user badge…</header>
<div class="app-shell">
  <aside id="appSidebar" class="app-sidebar" data-active="instances"></aside>
  <main class="app-main">
    <nav class="breadcrumb">
      <a href="/index.html">EC2</a>
      <svg class="ico ico-xs"><use href="/img/icons/sprite.svg#ui-chevron-right"></use></svg>
      <span data-i18n="navInstances">Instances</span>
    </nav>
    <div class="page-header">
      <h1><span data-i18n="navInstances">Instances</span> <span class="page-count">(3)</span></h1>
      <div class="page-actions">…nút…</div>
    </div>
    <!-- nội dung trang -->
  </main>
</div>
<!-- 5 file core như cũ, rồi THÊM: -->
<script src="/js/core/sidebar.js"></script>
<!-- rồi file của trang -->
```

Thứ tự nạp mới: `ui.js → api.js → session.js → auth.js → i18n.js → sidebar.js → pages/*.js`. Cập nhật lại bảng trong `docs/frontend-structure.md`.

#### 3.2 Các trang của Cường
- [ ] `account-tokens.html`, `instance-edit.html`: xóa `<nav class="sub-nav">` (7 và 4 SVG vẽ tay), thay bằng hợp đồng HTML trên. Breadcrumb: `EC2 › Instances › i-xxx › Edit` và `Account › API Tokens`.
- [ ] `login.html`, `register.html` (**không** có sidebar): logo `img/logo.svg`, favicon `img/favicon.svg`, bỏ emoji (2 + 6 trong HTML, 3 + 12 trong `login.js`/`register.js`), dùng `ui-user`, `ui-lock`, `ui-error`.
- [ ] `instance-edit.js` (1 emoji), `ui.js` (4 emoji trong toast/modal → `ui-check-circle`, `ui-warning`, `ui-error`, `ui-info`), `i18n.js` (6 emoji trong từ điển).

---

### 👤 2. Tạ Duy Anh — `instances.html` & `launch.html` kiểu EC2

#### 3.3 `instances.html` — bố cục "EC2 › Instances"
- [ ] Breadcrumb: `EC2 › Instances`.
- [ ] Page header: `Instances (N)` + nút bên phải: `ui-refresh` · **Connect** (`ui-terminal`) · **Instance state ▾** (`ui-power`: Start/Stop/Reboot/Terminate) · **Actions ▾** · **Launch instances** (nút cam, `ui-plus`). Các nút sáng/tối theo dòng đang chọn.
- [ ] Thanh lọc: ô tìm kiếm có `ui-search` + `#instanceStatusFilter` (giữ id cũ).
- [ ] Bảng: cột checkbox chọn dòng · Name · Instance ID (kèm nút `ui-copy`) · Instance state (badge) · Instance type · Region · Public IPv4 / DNS. Phân trang `ui-chevron-left/right` góc phải trên bảng.
- [ ] **Chọn nhiều máy ảo cùng lúc (Multi-instance selection & Bulk actions like AWS EC2)**:
  - Checkbox "Chọn tất cả" trên `<thead>` (hỗ trợ toggle all và trạng thái `indeterminate` khi chỉ chọn một phần).
  - Checkbox trên từng dòng máy ảo; lưu trạng thái danh sách `selectedInstanceIds` (Array / Set).
  - Khi chọn $\ge 1$ máy ảo:
    - Hiển thị số lượng máy ảo đang chọn trên thanh công cụ (ví dụ: `2 instances selected` / `Đã chọn 2 máy ảo`).
    - Nút menu **Instance state ▾** kích hoạt cho phép thao tác đồng thời: **Start**, **Stop**, **Reboot**, **Terminate** hàng loạt (gọi API xử lý song song/tuần tự kèm thông báo toast kết quả).
    - Nếu chọn đúng 1 máy ảo: nút **Connect** sáng và panel split-pane chi tiết bên dưới hiển thị thông tin máy đó. Nếu chọn nhiều máy ảo: ẩn hoặc hiển thị panel tóm tắt bulk action.
- [ ] **Split-pane chi tiết** (như EC2): chọn 1 dòng → panel dưới bảng hiện tabs `Details | Security | Networking | Storage` tóm tắt, có link **"View full details"** sang `instance-detail.html?id=…`. Kéo được hoặc tối thiểu có nút đóng `ui-close`.
- [ ] Trạng thái chuyển tiếp: `ui-spinner ico-spin` + badge; khóa nút khi `PENDING/STOPPING/REBOOTING/SHUTTING_DOWN`.
- [ ] Xóa 4 emoji trong `instances.js`, 5 SVG trong `instances.html`.

#### 3.4 `launch.html` — bố cục "EC2 › Instances › Launch an instance"
- [ ] Breadcrumb 3 tầng. Cột trái gồm các panel giống EC2 (mỗi panel có tiêu đề + icon):
  1. **Name and tags**
  2. **Application and OS Images (AMI)** — thẻ chọn OS dùng `os-*` (`os-ubuntu`, `os-debian`, `os-centos`, `os-rocky`, `os-amazon-linux`, `os-windows`; khác → `os-linux`)
  3. **Instance type** — bảng flavor (vCPU / RAM)
  4. **Key pair (login)** — `svc-key-pair`
  5. **Network settings** — Region (`svc-region`), Security Group (`svc-security-group`)
  6. **Configure storage** — `svc-ebs`
- [ ] Cột phải **Summary** dính (sticky): số lượng, AMI, type, SG, storage + nút **Launch instance** / Cancel.
- [ ] Xóa 7 emoji trong `launch.html`, 6 trong `launch.js`, 4 SVG nav.
- [ ] CSS mới riêng trang `instances` đặt ở `css/pages/instances.css` (`<link>` riêng), không thêm vào `dashboard.css`.

---

### 👤 3. Hoàng Xuân Lực — `index.html` & `instance-detail.html` kiểu EC2

#### 3.5 `index.html` — bố cục "EC2 Dashboard"
- [ ] Breadcrumb: `EC2 › Dashboard`. Page header: `Resources` + nút `ui-refresh`.
- [ ] Khối **Resources** dạng lưới `.svc-tile`: Instances (running) `svc-instance` · Volumes `svc-ebs` · Snapshots `svc-snapshot` · Key pairs `svc-key-pair` · Security groups `svc-security-group` · Elastic IPs `svc-elastic-ip` · Regions `svc-region`. Mỗi ô: icon + nhãn + số (bấm được nếu có trang).
- [ ] Thẻ **Region** (primary / standby) dùng `svc-region`, khối **Migration summary** dùng `svc-migration`, audit log dùng `svc-cloudtrail`.
- [ ] Favicon → `/img/favicon.svg`; xóa 4 SVG nav; xóa emoji trong `overview.js` (1), `overview-migration.js` (4).

#### 3.6 `instance-detail.html` — bố cục "Instance summary for i-xxx"
- [ ] Breadcrumb: `EC2 › Instances › i-xxxx`.
- [ ] Page header: `Instance summary for i-xxxx (Name)` + nút: `ui-refresh` · Connect (`ui-terminal`) · Instance state ▾ · Actions ▾ (Edit → `instance-edit.html`, Migrate, Terminate).
- [ ] **Khối summary 3 cột** (kv-grid như EC2): Instance ID, State, Instance type, AMI, Private/Public IP, DNS, Region, Key pair, Launch time — mỗi giá trị copy được (`ui-copy`).
- [ ] **Tabs** dưới summary: `Details` · `Security` (`ui-shield`) · `Networking` (`ui-network`) · `Storage` (`ui-storage`) · `Monitoring` (`ui-chart`) · `Migration` (`ui-migrate`). Tab đang mở giữ trên URL hash (`#security`) để sidebar/link khác trỏ thẳng vào.
- [ ] Tab Migration: `ui-lock/ui-unlock` cho `migration_lock`, `ui-clock` cho cooldown, pipeline 6 bước dùng `ui-check-circle` / `ui-spinner ico-spin` / `ui-error` thay emoji.
- [ ] Favicon → `/img/favicon.svg`; xóa 4 SVG nav + 2 emoji HTML; emoji trong `core.js` (7), `migration.js` (6); SVG inline trong `monitoring.js` (1) nếu là icon.
- [ ] `status-badges.css`: bổ sung badge `pending / stopping / rebooting / shutting-down / terminated` (nếu chưa đủ) — Duy Anh dùng chung.

---

## 4. CHUẨN HÓA NGÔN NGỮ (ÁP DỤNG CHO CẢ 3 NGƯỜI)

1. **Một cơ chế:** text tĩnh trong HTML → `data-i18n="key"`; text động trong JS → `t('vi', 'en')` hoặc `tk('key')`. Không dùng thêm `I18N_PAIRS`, không tự viết vòng lặp `data-i18n` riêng trong trang.
2. **Đặt tên key:** `camelCase`, tiền tố theo trang: `nav*` (sidebar, Cường), `inst*` (instances), `launch*`, `dash*` (index), `detail*`, `edit*`, `tokens*`, `auth*`. Từ điển của trang đặt ở **đầu file JS của trang** bằng `registerI18n({...})`.
3. **Không trộn 2 ngôn ngữ trong một nhãn** (bỏ kiểu "Danh Sách Máy Ảo (Instances)", "Khởi Tạo Máy Ảo (+ Launch VM)").
4. **Viết hoa:** kiểu câu (Sentence case) như AWS: "Launch instance", "Khởi tạo máy ảo" — không "Khởi Tạo Máy Ảo".
5. **Thuật ngữ giữ nguyên tiếng Anh ở cả 2 chế độ** (giống AWS Console bản tiếng Việt):

| Giữ nguyên (cả VI & EN) | Dịch |
|---|---|
| Instance ID, AMI, VPC, Subnet, Security group, Key pair, Elastic IP, Route 53, EBS, Snapshot, DNS, IPv4, Region, Inbound / Outbound rules, Token, `migration_lock` | — |

| Khóa gợi ý | Tiếng Việt | English |
|---|---|---|
| `navDashboard` | Bảng điều khiển EC2 | EC2 Dashboard |
| `navInstances` | Máy ảo | Instances |
| `navLaunch` | Khởi tạo máy ảo | Launch instance |
| `navTokens` | API Token | API Tokens |
| `navComingSoon` | Sắp ra mắt | Coming soon |
| `actInstanceState` | Trạng thái máy ảo | Instance state |
| `actActions` | Hành động | Actions |
| `actConnect` | Kết nối | Connect |
| `actStart` / `actStop` / `actReboot` / `actTerminate` | Khởi động / Dừng / Khởi động lại / Xóa máy ảo | Start / Stop / Reboot / Terminate |
| `actRefresh` | Làm mới | Refresh |
| `actViewDetails` | Xem chi tiết | View details |
| `stRunning` … | Đang chạy · Đã dừng · Đang khởi tạo · Đang dừng · Đang khởi động lại · Đang xóa · Đang chuyển vùng | Running · Stopped · Pending · Stopping · Rebooting · Shutting-down · Migrating |
| `tabDetails` … | Chi tiết · Bảo mật · Mạng · Lưu trữ · Giám sát · Chuyển vùng | Details · Security · Networking · Storage · Monitoring · Migration |

> Key `nav*`, `act*`, `st*`, `tab*` là **dùng chung** → Cường khai báo trong `i18n.js` (PR shell). Key riêng trang thì tự khai trong file trang.

---

## 5. DANH SÁCH ICON CŨ CẦN XÓA (quét lúc 09:00)

| File | Emoji | SVG vẽ tay / data-URI | Người xử lý |
|---|---|---|---|
| `account-tokens.html` | – | 7 SVG | Cường |
| `instance-edit.html` / `instance-edit.js` | 2 / 1 | 4 SVG | Cường |
| `login.html` / `login.js` | 2 / 3 | – | Cường |
| `register.html` / `register.js` | 6 / 12 | – | Cường |
| `js/core/ui.js` / `js/core/i18n.js` | 4 / 6 | – | Cường |
| `instances.html` / `instances.js` | – / 4 | 5 SVG | Duy Anh |
| `launch.html` / `launch.js` | 7 / 6 | 4 SVG | Duy Anh |
| `index.html` / `overview.js` / `overview-migration.js` | – / 1 / 4 | 4 SVG + favicon data-URI | Lực |
| `instance-detail.html` / `core.js` / `migration.js` / `monitoring.js` | 2 / 7 / 6 / – | 4 SVG + favicon data-URI / 1 SVG | Lực |

Lệnh tự kiểm tra trước khi mở PR (PowerShell, chạy trong `src/main/resources/static`) — kết quả phải **rỗng** với file của mình:

```powershell
Select-String -Encoding UTF8 -Path *.html,js\*\*.js,js\pages\instance-detail\*.js -Pattern '[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF]|[\uD83C-\uD83E][\uDC00-\uDFFF]'
Select-String -Path *.html -Pattern '<svg viewBox|data:image/svg'
```

(Ký tự mũi tên `→` trong chữ được giữ lại; ưu tiên thay bằng `ui-chevron-right` nếu là nút.)

---

## 6. CHECKLIST NGHIỆM THU

- [ ] 6 trang có đăng nhập đều có sidebar, đúng mục `active`, thu gọn/mở rộng nhớ trạng thái khi chuyển trang.
- [ ] Màn hình 375px: sidebar thành drawer, không tràn ngang.
- [ ] Mọi trang có breadcrumb + page header; `instance-detail` có tabs, `instances` có split-pane.
- [ ] `instances.html`: chọn được nhiều máy ảo cùng lúc (checkbox thead/tbody), menu **Instance state ▾** thực hiện thao tác hàng loạt (Start/Stop/Reboot/Terminate) cho các máy đã chọn.
- [ ] Đổi ngôn ngữ sang EN: không còn chữ tiếng Việt (trừ dữ liệu người dùng); đổi lại VI: không còn nhãn kiểu "Việt (English)".
- [ ] 2 lệnh quét ở mục 5 trả về rỗng; DevTools tab Network không có 404 cho `/img/**`.
- [ ] Không có lỗi Console; login → instances → detail → edit → migrate vẫn chạy như trước.
- [ ] `docs/frontend-structure.md` đã cập nhật: thêm `sidebar.js`, `sidebar.css`, `icons.css`, thư mục `img/`.

## 7. ROLLBACK

Mỗi người 1 PR nhỏ → lỗi trang nào `git revert` PR trang đó. PR shell lỗi → revert PR shell; các trang chưa merge vẫn chạy với `.sub-nav` cũ vì `sub-nav.css` chưa bị xóa trong hôm nay.
