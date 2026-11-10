# SPEC-00: Quy Chế Quản Lý Nghiệp Vụ & Ràng Buộc Agent (Agent Scope Guard)

> **Phiên bản**: `1.9.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Áp dụng cho**: Toàn bộ AI Coding Agents (Gemini, Antigravity, Codex, Cline, Claude Code...) tham gia phát triển dự án XRegion.

---

## 1. Mục Đích & Nguyên Tắc Tối Cao

Tài liệu này đặt ra quy chế bất biến nhằm giải quyết triệt để tình trạng: **Agent tự suy diễn yêu cầu, tự đặt ra các trạng thái/luồng phi thực tế, sinh ra quá nhiều code và test case không phù hợp với kiến trúc hạ tầng.**

> [!IMPORTANT]
> ### NGUYÊN TẮC BẤT BIẾN: SPEC-FIRST & ZERO-SPECULATION (ĐẶC TẢ ĐI TRƯỚC - CẤM TỰ SUY DIỄN)
> 1. **Mọi quyết định sinh code hoặc viết test case ĐỀU BẮT BUỘC phải dựa trên tài liệu đặc tả có sẵn trong thư mục `docs/specs/`.**
> 2. **Nếu một chức năng, luồng xử lý, trường dữ liệu hoặc tham số kỹ thuật CHƯA ĐƯỢC QUY ĐỊNH RÕ RÀNG trong các file SPEC:**
>    - ⛔ **CẤM TUYỆT ĐỐI**: Agent không được tự ý suy diễn (speculate), không được tự bịa ra enum/trạng thái mới, không được tự viết test case theo giả định chủ quan.
>    - ⏸️ **HÀNH ĐỘNG BẮT BUỘC (PAUSE PROTOCOL)**: Agent phải **TẠM NGƯNG NGAY LẬP TỨC** tác vụ, xuất thông báo rõ ràng cho người dùng:
>      ```
>      [AGENT SCOPE GUARD - PAUSE ALERT]
>      Nghiệp vụ cho chức năng/luồng [Tên chức năng/luồng cần làm] chưa được quy định trong tài liệu đặc tả hiện tại (docs/specs/).
>      Theo quy chế SPEC-00, Agent đã tạm ngưng sinh code/test.
>      Vui lòng cập nhật bổ sung tài liệu Spec (tăng phiên bản) trước khi tiếp tục thực hiện.
>      ```
>    - 🛑 **Agent KHÔNG ĐƯỢC tự ý hỏi dồn dập hay tự động sinh code tạm.** Chỉ tiếp tục công việc khi tài liệu Spec đã được bổ sung thành công và mang phiên bản mới.

---

## 2. Quy Chuẩn Quản Lý Phiên Bản (Semantic Versioning - SemVer)

Tất cả các tài liệu trong `docs/specs/` bắt buộc phải có phần header quản lý phiên bản theo chuẩn SemVer: `MAJOR.MINOR.PATCH` (Ví dụ: `1.0.0`).

| Loại thay đổi | Khi nào áp dụng | Hành động của Agent |
| :--- | :--- | :--- |
| **PATCH** (`1.0.x`) | Sửa lỗi chính tả, làm rõ câu từ diễn đạt, không thay đổi luồng kỹ thuật hoặc trạng thái. | Được phép tiếp tục công việc đang làm. |
| **MINOR** (`1.x.0`) | Bổ sung thêm luồng nghiệp vụ mới, thêm bước trong pipeline, thêm trạng thái mới được phê duyệt. | Agent phải đối soát lại toàn bộ test case liên quan. |
| **MAJOR** (`x.0.0`) | Thay đổi kiến trúc cốt lõi (ví dụ: chuyển từ cơ chế A sang B, đổi cơ chế Distributed Lock). | Phải rà soát và cập nhật lại toàn bộ codebase. |

### Cấu trúc Header bắt buộc trên mọi file Spec:
```markdown
# [MÃ SPEC]: [TÊN ĐẶC TẢ NGHIỆP VỤ]

> **Phiên bản**: `X.Y.Z`  
> **Trạng thái**: `DRAFT` | `REVIEWING` | `APPROVED`  
> **Cập nhật lần cuối**: `YYYY-MM-DD`  
> **Tác giả / Người phê duyệt**: `[Tên/Vai trò]`  
```

### Bảng Lịch Sử Thay Đổi (Changelog) ở cuối mỗi file:
Mỗi file Spec bắt buộc có bảng Changelog ghi rõ:
- Ngày cập nhật
- Phiên bản mới
- Nội dung thay đổi
- Người xác nhận

---

## 3. Quy Trình Kiểm Tra Phạm Vi Trước Khi Code (Agent Pre-flight Checklist)

Trước khi Agent bắt đầu soạn thảo Plan hoặc gõ dòng code/test đầu tiên, Agent bắt buộc phải tự tích vào Checklist sau:

- [ ] **Bước 1**: Đã xác định đúng mã Spec áp dụng cho tác vụ (`SPEC-01`, `SPEC-02`, hay `SPEC-03`...)?
- [ ] **Bước 2**: File Spec đó có đang ở trạng thái `APPROVED` không?
- [ ] **Bước 3**: Danh mục trạng thái, tham số request/response, kịch bản lỗi dự kiến có khớp 100% với Spec không?
- [ ] **Bước 4**: Có trường hợp nào đang phải "tự giả định" không? (Nếu CÓ -> Kích hoạt ngay **Pause Protocol** ở Mục 1).

---

## 4. Danh Mục Các Đặc Tả Nghiệp Vụ Hiện Có

### 4.1. Bộ Đặc Tả Kiến Trúc & Backend (`docs/specs/`)

| Mã Spec | Tên Đặc Tả Nghiệp Vụ | Phiên Bản | Trạng Thái |
| :--- | :--- | :--- | :--- |
| **`SPEC-00`** | Quy Chế Quản Lý Nghiệp Vụ & Ràng Buộc Agent | `1.8.0` | `APPROVED` |
| **`SPEC-01`** | Quản Trị Vòng Đời Máy Ảo (Instance Lifecycle & Provisioning) | `1.6.0` | `APPROVED` |
| **`SPEC-02`** | Quản Lý Pool Tài Nguyên & Dọn Dẹp Mồ Côi (Resource Pool Cleaner) | `1.0.0` | `APPROVED` |
| **`SPEC-03`** | Chuyển Vùng Xuyên Vùng Trực Tiếp (Cross-Region Live Migration) | `1.1.0` | `APPROVED` |
| **`SPEC-04`** | Hạ Tầng Mạng NAT & Điều Tuyến L2 (Network NAT & Routing) | `1.2.0` | `APPROVED` |
| **`SPEC-05`** | Kiểm Soát Nhập Lệnh & Lưu Trữ Đĩa Cinder/EBS (Admission & Storage) | `1.0.0` | `APPROVED` |
| **`SPEC-06`** | Phục Hồi Lỗi Bền Vững & Quản Trị Khóa SSH/Bảo Mật (Recovery & Security) | `1.2.0` | `APPROVED` |
| **`SPEC-07`** | Xác Thực & Quản Trị API Token Dài Hạn (Authentication & API Tokens) | `1.0.0` | `APPROVED` |

### 4.2. Bộ Đặc Tả Serverless & Step Functions (`docs/specs/serverless/`)

| Mã Spec | Tên Đặc Tả Nghiệp Vụ Serverless | Phiên Bản | Trạng Thái |
| :--- | :--- | :--- | :--- |
| **`SPEC-SF-00`** | Quy Chế Quản Trị Serverless Scope Guard (Step Functions & Lambda) | `1.0.0` | `APPROVED` |
| **`SPEC-SF-01`** | Quy Trình Khởi Tạo Máy Ảo Step Function (Launch Pipeline) | `1.5.0` | `APPROVED` |
| **`SPEC-SF-02`** | Quy Trình Hủy Máy Ảo Step Function (Terminate Pipeline) | `1.1.0` | `APPROVED` |
| **`SPEC-SF-03`** | Trình Quản Lý & Tự Bù Đắp Warm Pool (Cinder Pool Manager) | `1.0.0` | `APPROVED` |
| **`SPEC-SF-04`** | Hệ Thống Tự Thu Hồi Máy Ảo Lỗi (Instance Fault Recovery) | `1.0.0` | `APPROVED` |
| **`SPEC-SF-05`** | Đồng Bộ Hóa Nhóm Bảo Mật (Security Group Synchronizer) | `1.2.0` | `APPROVED` |
| **`SPEC-SF-06`** | Quy Trình Vòng Đời Máy Ảo Step Function (Lifecycle Pipeline) | `1.0.0` | `APPROVED` |

---

## 5. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Khởi tạo tài liệu quy chế gốc sau phỏng vấn chuyên sâu. |
| `2026-11-10` | `1.1.0` | Lead Architect / Product Owner | Bổ sung đầy đủ SPEC-01 v1.1.0, SPEC-04, SPEC-05, SPEC-06 sau đợt rà soát toàn bộ code và Lambda. |
| `2026-11-10` | `1.2.0` | Lead Architect / Product Owner | Cập nhật SPEC-01 v1.2.0, SPEC-06 v1.1.0 (Quy tắc SG 1-1 không dùng chung, cấm hardcode owner=system), SPEC-03 v1.1.0 và xuất bản mới SPEC-07. |
| `2026-11-10` | `1.3.0` | Lead Architect / Product Owner | Cập nhật SPEC-01 v1.3.0 (loại bỏ shelve/unshelve, chuẩn hóa os-stop/os-start 1-1, đồng bộ toàn bộ nova_ids lịch sử khi Terminate, phân tách 2 bảng Instances vs Nova). |
| `2026-11-10` | `1.4.0` | Lead Architect / Product Owner | Cập nhật SPEC-01 v1.4.0 (Quy định máy ảo bất biến sau launch, Hard Delete ở syncDynamoDB khi Terminate, loại bỏ Web VNC Console, bảo vệ card mạng ENI dùng chung ens6, tinh gọn VolumeService & ImageService). |
| `2026-11-10` | `1.5.0` | Lead Architect / Product Owner | Mở rộng danh mục bộ đặc tả chuyên biệt Serverless & Step Functions (SPEC-SF-00 đến SPEC-SF-05 trong docs/specs/serverless/); cập nhật SPEC-01 v1.5.0 và SPEC-04 v1.1.0. |
| `2026-11-10` | `1.6.0` | Lead Architect / Product Owner | Cập nhật SPEC-SF-02 v1.1.0: Loại bỏ hoàn toàn nhánh Legacy trong Terminate Step Function, bắt buộc 100% linux_nat_v1 và Hard Delete. |
| `2026-11-10` | `1.7.0` | Lead Architect / Product Owner | Cập nhật SPEC-SF-01 v1.3.0 và SPEC-SF-05 v1.1.0: Đồng bộ hóa 1-1 cả Inbound/Outbound rules theo payload API, loại bỏ tiêm rule mặc định, xóa Orphan SG khi Rollback, chuẩn hóa group_id=nova_id. |
| `2026-11-11` | `1.8.0` | Chủ dự án (yêu cầu trực tiếp) | Đồng bộ danh mục với header thực tế: SPEC-01 `1.6.0`, SPEC-04 `1.2.0`, SPEC-06 `1.2.0`, SPEC-SF-01 `1.5.0`, SPEC-SF-05 `1.2.0`. Ghi nhận việc chuẩn hóa tên event `security-group.updated`, liên kết SG 1-1 bằng `instance_id` và loại bỏ trạng thái `PENDING_DEPLOY`. |
| `2026-11-11` | `1.9.0` | Lead Architect / Product Owner | Bổ sung SPEC-SF-06 v1.0.0 vào danh mục: STOP/START/REBOOT chuyển sang Step Functions `LifecycleInstance`, cấm Lambda ghi trạng thái cuối trước khi quan sát Nova. |
