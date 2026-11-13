# SPEC-SF-05: Đồng Bộ Hóa Nhóm Bảo Mật (Security Group Synchronizer)

> **Phiên bản**: `1.2.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-11`  
> **Tài liệu cha**: [SPEC-SF-00: Serverless Scope Guard](SPEC-SF-00-SERVERLESS-SCOPE-GUARD.md)

---

## 1. Tổng Quan Kiến Trúc & Luồng Xử Lý

Lambda `XRegion-SyncSecurityGroup` chịu trách nhiệm đồng bộ hóa các quy tắc mạng Ingress/Egress từ bảng DynamoDB `XRegion-SecurityGroups` xuống hạ tầng OpenStack Neutron thực tế khi người dùng thực hiện cập nhật quy tắc Firewall trên giao diện.

- **Mã nguồn**: `serverless/launch-contract/XRegion-SyncSecurityGroup/` hoặc module sync tương ứng.
- **Cơ chế kích hoạt**: Rule EventBridge `XRegion-SecurityGroupSync` lọc `source = xregion.backend.security` và `detail-type = security-group.updated`, đẩy sự kiện vào Lambda `XRegion-SyncSecurityGroup`. `SecurityGroupSyncStore.java` chỉ là kênh ghi trạng thái đồng bộ vào DynamoDB, **không** phát sự kiện.

---

## 2. Kiểm Soát Xung Đột Lạc Quan Theo Phiên Bản (Revision Optimistic Lock)

Để ngăn chặn việc ghi đè cấu hình cũ lên cấu hình mới (Stale Overwrite) khi người dùng chỉnh sửa rule liên tục trong thời gian ngắn:

1. **Thuộc tính quản lý phiên bản trong DynamoDB**:
   - `revision`: Số nguyên tăng dần mỗi khi người dùng bấm Lưu rule trên UI.
   - `applied_revision`: Số phiên bản quy tắc đã được Neutron xác nhận áp dụng thành công.
   - `sync_status`: Trạng thái đồng bộ. Tập giá trị hợp lệ: `PENDING_SYNC` (đã lưu cấu hình, chưa có bằng chứng hạ tầng áp dụng), `SYNCING` (worker đang áp dụng), `SYNCED` (hạ tầng đã xác nhận đúng revision), `SYNC_FAILED` (lần áp dụng gần nhất lỗi), `SYNC_NOT_APPLICABLE` (máy không còn tài nguyên mạng), `SYNC_BLOCKED` (chưa thể nhận quản lý toàn bộ firewall).
2. **Biểu thức điều kiện cập nhật bắt buộc (Conditional Write Expression)**:
   ```dynamodb
   ConditionExpression: attribute_exists(group_id) AND revision = :rev AND (attribute_not_exists(applied_revision) OR applied_revision <= :ar)
   ```
   - Nếu một worker xử lý chậm cố tình ghi nhận kết quả của phiên bản cũ (`applied_revision > request.revision`), DynamoDB sẽ ném `ConditionalCheckFailedException` và yêu cầu hủy bỏ để tránh ghi đè dữ liệu sai lệch.

---

## 3. Hợp Đồng Sự Kiện Đồng Bộ (Bắt Buộc)

### 3.1. Sự kiện EventBridge

| Trường | Giá trị |
| :--- | :--- |
| `source` | `xregion.backend.security` |
| `detail-type` | `security-group.updated` (dấu gạch nối; **không** dùng `security_group.updated`) |
| Đích | Lambda `XRegion-SyncSecurityGroup` |

`detail` gồm:

| Khóa | Kiểu | Bắt buộc | Ý nghĩa |
| :--- | :--- | :--- | :--- |
| `event_id` | string | Không | Mã vết của lần phát sự kiện (`evt-sg-sync-*`). |
| `group_id` | string | **Có** | Khóa bản ghi trong `XRegion-SecurityGroups`. |
| `instance_id` | string | **Có** | Máy ảo sở hữu nhóm (liên kết 1-1). |
| `revision` | number | **Có** | Revision mong muốn; worker bỏ qua nếu lệch bản ghi. |
| `nova_id` | string | Không | Gợi ý để tra cứu; worker **không** tin trực tiếp mà đối chiếu `XRegion-Nova`. |
| `rule_count` | number | Không | Số rule mong muốn tại thời điểm phát; chỉ để đối chiếu. |
| `requested_by` | string | Không | Người thực hiện thay đổi. |
| `timestamp` | number | Không | Thời điểm phát (epoch ms). |

**Không** truyền danh sách rule trong sự kiện: worker đọc cấu hình mong muốn từ DynamoDB theo `group_id`, nhờ vậy một sự kiện cũ không thể áp đè rule mới hơn.

### 3.2. Liên Kết Nhóm ↔ Máy Ảo

- Bản ghi Security Group **bắt buộc** mang `instance_id` của máy sở hữu; đây là khóa nhận diện chuẩn.
- Worker chỉ chấp nhận khi `group.instance_id == detail.instance_id`. Bản ghi legacy chưa có `instance_id` mới được nhận diện bằng mô tả cố định `Security group of <instance_id>`.
- `group_id` của bản ghi do launch tạo bằng `nova_id`; nhóm do backend tạo cho dữ liệu legacy dùng `sg-<uuid>` nhưng vẫn phải có `instance_id`. Vì vậy **không** được suy ra máy sở hữu từ hình dạng `group_id` hay từ chuỗi `description`.
- Khi máy bị Terminate, bản ghi nhóm phải bị xóa theo cả `group_id = nova_id` và mọi bản ghi có `instance_id` tương ứng.

---

## 4. Quy Trình Đồng Bộ Hóa Xuống OpenStack Neutron

Khi nhận yêu cầu đồng bộ cho một Security Group (`group_id`):
0. **Đối chiếu chủ sở hữu**: đọc bản ghi nhóm và bản ghi máy; từ chối (`SYNC_NOT_APPLICABLE`) nếu `instance_id` của nhóm khác máy trong sự kiện, nếu chủ nhóm khác `user_id` của máy, hoặc nếu revision của sự kiện lệch revision trong bảng.
1. **Lấy Keystone Token**: Xác thực với OpenStack Keystone lấy Auth Token quản trị.
2. **Đọc danh sách quy tắc hiện tại**: Gọi `GET /v2.0/security-groups/{id}` để lấy danh sách `security_group_rules` thực tế trên Neutron.
3. **Đối soát & Bổ sung quy tắc mới**:
   - Duyệt qua các rule mong muốn (SSH 22, ICMP, TCP/UDP tùy biến).
   - Nếu rule chưa có trong Neutron -> Gọi `POST /v2.0/security-group-rules`.
   - Nếu gặp lỗi `HTTP 409 Conflict`: Đọc lại để xác nhận rule đã tồn tại (idempotent).
4. **Gỡ bỏ quy tắc đã bị xóa**:
   - So sánh các rule hiện có trên Neutron với danh sách mong muốn.
   - Nếu rule trên Neutron không còn nằm trong cấu hình mới -> Gọi `DELETE /v2.0/security-group-rules/{rule_id}`.
5. **Cập nhật trạng thái thành công**:
   - Gọi DynamoDB `markApplied(groupId, appliedRevision, revision, ruleCount, note)`.
   - Đặt `sync_status = SYNCED`, `synced_at = now`, xóa bỏ `sync_error`.

---

## 5. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành đặc tả Security Group Synchronizer, chuẩn hóa khóa lạc quan theo revision, cơ chế đồng bộ lũy tiến và giải quyết xung đột 409 trên Neutron. |
| `2026-11-10` | `1.1.0` | xacnhan-skill (1-1 Security Sync) | Đồng bộ 1-1 cả Inbound và Outbound rules; quản trị toàn diện chiều Egress xóa bỏ rule mặc định ngoài cấu hình; liên kết group_id=nova_id tương thích SPEC-SF-01. |
| `2026-11-11` | `1.2.0` | Chủ dự án (yêu cầu trực tiếp) | Sửa mô tả cơ chế kích hoạt (EventBridge `security-group.updated` → Lambda, không phải DynamoDB Streams); bổ sung hợp đồng `detail` bắt buộc; chuẩn hóa liên kết nhóm ↔ máy qua `instance_id` thay cho chuỗi `description`; liệt kê đủ 6 trạng thái `sync_status`; bỏ trạng thái `PENDING_DEPLOY` sau khi loại bỏ feature-flag. |
