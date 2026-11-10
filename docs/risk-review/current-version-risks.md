# Danh mục rủi ro — phiên bản hiện tại

Tài liệu này dùng để **quyết định phạm vi**, không phải danh sách lỗi đã được duyệt sửa.

Mọi mục ghi rõ bằng chứng và độ chắc chắn. Mục có độ chắc chắn thấp **không** được dùng làm
lý do sửa code; mục `REJECTED` không được dùng lại làm nguyên nhân.

Ghi chú trạng thái: phân tích này thực hiện ngày 2026-11-10 bằng đọc mã, đọc receipt/log đã lưu
và các lần chạy live trong phiên. Không có thay đổi tài nguyên nào trong lúc lập danh mục.

## Phạm vi dữ liệu được chấp nhận (quyết định chủ dự án, 2026-11-10)

Bản thử nghiệm này **chấp nhận mất dữ liệu Nova VM**. Mục tiêu là bảo đảm các thao tác qua UI
(tạo, quản lý vòng đời, xóa, thêm key, thêm/sửa SG) hoạt động tin cậy và lỗi được báo rõ — không
phải bảo toàn dữ liệu máy.

Hệ quả cho mọi mục rủi ro:

- Cho phép dọn Nova và volume **riêng của máy lỗi đã xác minh**.
- **Không** xóa tài nguyên dùng chung: image, keypair dùng chung, network/subnet/router, host EC2,
  hoặc tài nguyên pool chưa chứng minh thuộc máy.
- Tài nguyên thuê từ pool (EIP/volume) giải phóng theo hợp đồng pool, không xóa tài nguyên nền.
- Không tự tạo VM thay thế, không tự phát lại launch không xác định; người dùng chủ động tạo mới.
- Không cam kết VM tiếp tục chạy sau khi người vận hành tắt host ngoài hệ thống; chỉ cam kết phát
  hiện và thông báo trạng thái sau khi hạ tầng phục hồi.
- Rollback code **không** phục hồi dữ liệu VM đã xóa.

Quyết định này thay đổi yêu cầu phục hồi, **không** phải bằng chứng rằng các lỗi cũ đã sửa xong.


| Trường | Ý nghĩa |
| --- | --- |
| Độ chắc chắn | `REPRODUCED` = đã tái hiện; `FROM_CODE` = suy ra từ mã đọc được; `UNVERIFIED` = chưa kiểm chứng; `REJECTED` = đã bị bác bỏ |
| Tác nhân | UI bình thường / vô ý / cố tình / sự cố hệ thống / công cụ test |
| Quyết định | `FIX_CURRENT`, `ACCEPT_WITH_CONTROLS`, `DEFER`, `OUT_OF_SCOPE`, `NEEDS_EVIDENCE`, `REJECTED` — **giá trị trong bảng là đề xuất, chưa phải quyết định của chủ dự án** |

## Tóm tắt theo nhóm

| Nhóm | Số mục | Ý nghĩa cho thử nghiệm không giám sát |
| --- | ---: | --- |
| Sản phẩm — có thể xảy ra khi dùng UI bình thường | 5 | Cần quyết định trước khi chạy tự động |
| Sản phẩm — khi người dùng gửi sai hoặc cố tình vượt UI | 6 | Phụ thuộc hồ sơ tin cậy người dùng |
| Công cụ test/cleanup | 5 | Không chặn sản phẩm, nhưng chặn việc dùng harness làm bằng chứng tự động |
| Đã bác bỏ | 2 | Giữ lịch sử, không mở lại |

## Bảng quyết định (đề xuất — cần chủ dự án chốt)

| ID | Rủi ro | Tác nhân | Chắc chắn | Đề xuất |
| --- | --- | --- | --- | --- |
| XR-RISK-001 | SG không hội tụ, nguyên nhân chưa xác định | UI bình thường | **REPRODUCED (2026-11-10)** — gốc: `owner=system` vs `visibleTo(username)` | FIX_CURRENT |
| XR-RISK-002 | DynamoDB ghi RUNNING trong khi Nova SHUTOFF | sự cố hệ thống | NOT_REPRODUCED (2026-11-10) | DEFER — xem verification-log |
| XR-RISK-003 | Launch thất bại để lại bản ghi PENDING | sự cố hệ thống | REPRODUCED | FIX_CURRENT |
| XR-RISK-004 | Không có cảnh báo khi tác vụ kẹt hoặc SG lệch | sự cố hệ thống | FROM_CODE | FIX_CURRENT |
| XR-RISK-005 | Thao tác hợp lệ nhưng nguy hiểm không có xác nhận phía server | UI bình thường | UNVERIFIED | NEEDS_EVIDENCE |
| XR-RISK-006 | Gửi lại khi UI timeout tạo thao tác trùng | vô ý | UNVERIFIED | NEEDS_EVIDENCE |
| XR-RISK-007 | Hai tab/người thao tác xung đột trên một máy | vô ý | FROM_CODE | ACCEPT_WITH_CONTROLS |
| XR-RISK-008 | Cố tình đổi instance/group ID để thao tác tài nguyên người khác | cố tình | FROM_CODE | ACCEPT_WITH_CONTROLS |
| XR-RISK-009 | Cố tình gửi action/trạng thái sai | cố tình | FROM_CODE | ACCEPT_WITH_CONTROLS |
| XR-RISK-010 | Payload quá lớn hoặc sai kiểu gây lỗi muộn | cố tình | UNVERIFIED | NEEDS_EVIDENCE |
| XR-RISK-011 | Chạy lặp nhiều lần làm cạn pool hoặc phát sinh chi phí | cố tình | UNVERIFIED | ACCEPT_WITH_CONTROLS |
| XR-RISK-H01 | Harness chọn nhầm SFN execution | công cụ test | FROM_CODE | FIX_CURRENT |
| XR-RISK-H02 | Launch PASS dù DDB sai | công cụ test | FROM_CODE | FIX_CURRENT |
| XR-RISK-H03 | CLI exit 0 khi có ca FAIL | công cụ test | FROM_CODE | FIX_CURRENT |
| XR-RISK-H04 | Rollback ghi đè/ xóa tài nguyên ngoài phạm vi | công cụ test | FROM_CODE | FIX_CURRENT |
| XR-RISK-H05 | Schema receipt lệch reporter | công cụ test | FROM_CODE | DEFER |
| XR-RISK-R01 | "Port DOWN làm worker từ chối" | — | REJECTED | REJECTED |
| XR-RISK-R02 | "Backend che lỗi EventBridge" | — | REJECTED | REJECTED |

## A. Rủi ro sản phẩm khi dùng UI bình thường

### XR-RISK-001 — SG nhận yêu cầu nhưng không hội tụ

- **Trạng thái 2026-11-10: `REPRODUCED`** trên instance do phiên kiểm chứng tự tạo (`i-16438b0a`).
  Chi tiết và bằng chứng: `verification-log.md`.
- **Nguyên nhân đã xác định:** `sync_dynamodb.py:105` ghi `"owner": {"S": "system"}`; backend lọc
  bằng `NetworkService.visibleTo()` → `owner.equalsIgnoreCase(username)` nên SG không bao giờ hiện
  với người dùng. 14/271 SG đang ở trạng thái `owner=system`.
- **Ảnh hưởng thực tế:** người dùng thấy firewall rỗng, không xem/sửa được rule của máy mình — dù
  Neutron đã áp dụng đúng. Không phải "hội tụ thất bại" mà là **lọc hiển thị sai**.
- **Chưa chứng minh:** còn lý do hội tụ khác hay không (bản ghi cũ `applied_revision` 15 vs 16/17).
- **Đề xuất:** `FIX_CURRENT` — chọn hướng A (backend kiểm ownership) hoặc B (Lambda ghi owner thật +
  migration). Không được nới `visibleTo` thành cho xem mọi SG `system`.
- **Lịch sử:** trước đây ghi `NEEDS_EVIDENCE` vì chưa truy được nhánh chặn bên trong worker.

### XR-RISK-002 — DynamoDB ghi `RUNNING` trong khi Nova `SHUTOFF`

- **Trạng thái 2026-11-10: `NOT_REPRODUCED`** — trên instance tự tạo (`i-16438b0a`), DynamoDB, bảng
  Nova và Nova thật **khớp nhau** qua launch, stop, start, reboot. Theo quy tắc chủ dự án: **bỏ qua,
  không sửa code** cho tới khi tái hiện được.
- **Không dùng làm căn cứ:** các bản ghi lệch tồn đọng (`i-a6d8494b` DDB `SHUTTING_DOWN`/Nova `ACTIVE`;
  `i-ed5ee75f` DDB `TERMINATED`/Nova `SHUTTING_DOWN`) — nguồn tạo không xác định, có thể do phiên bản
  backend khác.
- **Vấn đề gốc:** chưa xác định. Đây là chênh lệch từng thấy; nguyên nhân chưa chốt.
- **Bằng chứng đã có:** `XRegion-Instances` của `i-7953bdff` = `RUNNING` trong khi Nova
  `e38550db-…` = `SHUTOFF` (`vm_state=stopped`, `power_state=4`, `task_state=null`).
- **Dữ kiện mới (2026-11-10, giờ UTC+7):** host EC2 `i-056d7f3dd24156234` có `StopInstances`
  lúc 03:34:31 (`force=false`, `skipOsShutdown=false`) và `StartInstances` lúc 13:31:37.
  Nova ghi **action `stop` riêng cho canary lúc 13:33:37** (request
  `req-ccdf89f0-719f-47cd-89a4-62dbbc2da9c7`), tức **sau** khi host được bật lại.
  Rule `XRegion-NovaStatusRule` hiện `DISABLED`.
- **Đã bị bác bỏ:** kết luận trước của tôi rằng `autoLinkNovaIfAvailable` chọn sai Nova là nguyên
  nhân. Canary đã có `active_nova_id`, và hàm đó thoát ngay trong trường hợp này.
- **Ảnh hưởng:** danh sách máy và các tác vụ sau ra quyết định theo dữ liệu sai.
- **Đề xuất:** `NEEDS_EVIDENCE` — truy nguồn action `stop` và đường đồng bộ trạng thái trước khi sửa.
  Không đóng mục này chỉ vì đã thêm cơ chế phục hồi.


- **Vấn đề gốc:** chưa xác định nguồn ghi. Hai nguồn dữ liệu lệch nhau và không có cơ chế đối soát
  chủ động.
- **Bằng chứng:** `XRegion-Instances` của `i-7953bdff` = `RUNNING`; Nova `e38550db-…` = `SHUTOFF`
  (đọc trong phiên 2026-11-10).
- **Ảnh hưởng:** danh sách máy và các tác vụ sau ra quyết định theo dữ liệu sai; nếu không giám sát
  thì sai lệch tồn tại im lặng.
- **Giới hạn:** chưa chứng minh đây là trạng thái vĩnh viễn hay trung gian; cần đọc lại theo thời gian.
- **Đề xuất:** `FIX_CURRENT` — xác định trạng thái có thẩm quyền và cơ chế phát hiện lệch.

### XR-RISK-003 — Launch thất bại để lại bản ghi `PENDING`

- **Vấn đề gốc:** `InstanceService.createInstance` ghi bản ghi `PENDING` rồi mới phát event; nếu gửi
  event thất bại, chỉ trạng thái được đổi sang `FAILED` cho một loại lỗi, bản ghi vẫn tồn tại.
- **Bằng chứng:** `src/main/java/com/iaas/xregion/Services/InstanceService.java:201–207` (putItem),
  `:229–238` (chỉ `EventRejectedException` mới đổi trạng thái); phiên trước còn bản ghi mồ côi
  `i-p3-launch-launch` trạng thái `FAILED` do harness dừng giữa chừng.
- **Ảnh hưởng:** người dùng thấy máy “lỗi” tồn đọng, phải dọn tay; có thể chiếm chỗ trong pool.
- **Đề xuất:** `FIX_CURRENT` — nêu rõ chính sách: dọn bản ghi hay giữ để truy vết.

### XR-RISK-004 — Không có cảnh báo khi tác vụ kẹt hoặc cấu hình lệch

- **Vấn đề gốc:** trạng thái kẹt (PENDING/STOPPING/SYNC chờ) chỉ hiện khi người dùng mở UI; không có
  tín hiệu cho người vận hành.
- **Bằng chứng:** `sync_attempts`, `sync_status`, `sync_error` có trong bản ghi nhưng không có
  cơ chế cảnh báo; SG.4 chờ 300s rồi FAIL mà không có thông báo ngoài phiên test.
- **Ảnh hưởng:** đúng loại lỗi mà giám sát thủ công đang che; bỏ người ra khỏi vòng lặp thì mất luôn
  khả năng phát hiện.
- **Đề xuất:** `FIX_CURRENT` — tối thiểu một cảnh báo theo ngưỡng thời gian cho tác vụ kẹt.
### XR-RISK-005 — Thao tác hợp lệ nhưng nguy hiểm không có xác nhận phía server

- **Vấn đề gốc:** các thao tác như mở SSH `0.0.0.0/0` hoặc terminate máy là chức năng hợp lệ.
  Cần xác định xác nhận hiện chỉ ở UI hay có kiểm soát phía server.
- **Ảnh hưởng:** nếu chỉ ở UI thì gọi API trực tiếp bỏ qua được; với dùng UI bình thường, rủi ro là
  bấm nhầm.
- **Giới hạn:** phụ thuộc hồ sơ tin cậy. Với người dùng nội bộ, đây có thể là rủi ro được chấp nhận.
- **Đề xuất:** `NEEDS_EVIDENCE` — kiểm tra trước khi coi là blocker.

## B. Rủi ro khi người dùng vô ý hoặc cố tình gửi request sai

### XR-RISK-006 — Bấm lại sau khi UI timeout

- **Vấn đề gốc:** nếu backend đã nhận nhưng phản hồi không tới, người dùng bấm lại.
- **Biện pháp đang có (cần kiểm chứng):** launch sinh ID phía server
  (`InstanceService.java:164`), nên hai lần bấm tạo hai bản ghi khác nhau — nghĩa là **không** chống
  trùng mà là nhân đôi tác vụ. Chưa có khóa idempotency theo yêu cầu.
- **Ảnh hưởng:** hai VM/volume/EIP thay vì một; chi phí và tài nguyên tăng.
- **Đề xuất:** `NEEDS_EVIDENCE` — xác nhận thực tế trước khi thiết kế khóa idempotency.

### XR-RISK-007 — Hai tab hoặc hai người thao tác cùng một máy

- **Vấn đề gốc:** thao tác dựa trên trạng thái đọc trước đó.
- **Biện pháp đang có:** `updateInstanceState` dùng `conditionExpression` theo `current_status`
  (`InstanceService.java:45–57`), nên một số chuyển trạng thái cạnh tranh sẽ bị từ chối.
- **Khoảng trống:** chưa rõ mọi nhánh đều dùng điều kiện này; SG dùng revision nên có bảo vệ tốt hơn.
- **Đề xuất:** `ACCEPT_WITH_CONTROLS` — giới hạn một người thao tác trong giai đoạn thử.

### XR-RISK-008 — Cố tình đổi `instance_id` / `group_id`

- **Biện pháp đang có:** `isOwner(...)` được kiểm tra trước các thao tác đọc/ghi
  (`InstanceService.java:67`, `:154`, `:253`, `:391`); SG có kiểm tra chủ sở hữu
  (`NetworkService.java:1165`).
- **Khoảng trống:** chưa rà toàn bộ endpoint; chưa có test cố tình đổi ID giữa hai người dùng.
- **Đề xuất:** `ACCEPT_WITH_CONTROLS` nếu tài khoản thử đều tin cậy; cần test bổ sung trước khi mở
  cho người dùng ngoài.

### XR-RISK-009 — Cố tình gửi `action` hoặc chuyển trạng thái sai

- **Biện pháp đang có:** lifecycle ánh xạ theo trạng thái hiện tại và từ chối một số chuyển
  (`InstanceService.java:277–298`, `:400–478`).
- **Khoảng trống:** cần xác nhận danh sách trạng thái cho phép là đầy đủ.
- **Đề xuất:** `ACCEPT_WITH_CONTROLS`.

### XR-RISK-010 — Payload sai kiểu hoặc quá lớn

- **Tình trạng:** chưa đo. EventBridge giới hạn kích thước entry; backend và Lambda có kiểm tra riêng
  nhưng chưa có bằng chứng cho toàn bộ trường.
- **Ảnh hưởng tiềm năng:** lỗi muộn sau khi đã tạo bản ghi.
- **Đề xuất:** `NEEDS_EVIDENCE`.

### XR-RISK-011 — Chạy lặp làm cạn pool hoặc tăng chi phí

- **Vấn đề gốc:** pool volume/EIP hữu hạn; chạy nhiều lần liên tiếp có thể làm cạn.
- **Bằng chứng gián tiếp:** harness có bước `reserve_pool_state` và `choose_image`, cho thấy pool là
  tài nguyên cần cân nhắc.
- **Đề xuất:** `ACCEPT_WITH_CONTROLS` — đặt hạn mức số VM mỗi lần chạy.



## C. Rủi ro của công cụ test/cleanup (không phải lỗi sản phẩm)

Các mục này **không** chứng minh Lambda/SFN sai. Chúng chặn việc dùng harness làm bằng chứng tự động.

### XR-RISK-H01 — Chọn nhầm SFN execution

- **Vấn đề gốc:** launch/terminate từng lấy `list_executions(RUNNING)[0]`.
- **Bằng chứng:** phiên này đã thay bằng `find_correlated_execution()` dựa trên EventId; **chưa chạy
  live** để xác nhận.
- **Ảnh hưởng:** có thể theo dõi execution của người khác và kết luận sai.
- **Đề xuất:** `FIX_CURRENT` (đã sửa mã, cần live xác nhận).

### XR-RISK-H02 — Launch PASS dù DynamoDB sai

- **Vấn đề gốc:** `test_api_gateway_e2e.py:796` chỉ kiểm tra `server.get("status") == "ACTIVE"`;
  DDB được ghi vào receipt nhưng không bắt buộc `RUNNING`.
- **Ảnh hưởng:** báo xanh cho luồng mà bản ghi trạng thái chưa đúng.
- **Đề xuất:** `FIX_CURRENT`.

### XR-RISK-H03 — CLI exit 0 khi còn ca FAIL

- **Vấn đề gốc:** `main()` gọi `finish(writer, out_dir, args)` trong `finally` nhưng bỏ giá trị trả
  về (`test_api_gateway_e2e.py:1654–1655`), nên `sys.exit(main())` có thể nhận `None`.
- **Ảnh hưởng:** pipeline tự động coi là thành công.
- **Đề xuất:** `FIX_CURRENT`.

### XR-RISK-H04 — Rollback ghi đè hoặc xóa ngoài phạm vi

- **Vấn đề gốc:** `restore_sg()` ghi DynamoDB không có `ConditionExpression`
  (`test_api_gateway_e2e.py:1515–1525`); xóa mọi rule ID mới xuất hiện giữa hai snapshot
  (`:1543`), chưa chứng minh thuộc test; chưa khôi phục đủ metadata.
- **Ảnh hưởng:** chạy test trên môi trường có hoạt động khác có thể ghi đè hoặc dọn nhầm.
- **Đề xuất:** `FIX_CURRENT` — đây là lý do **không** nên chạy lại SG live bằng harness hiện tại.

### XR-RISK-H05 — Schema receipt lệch reporter

- **Vấn đề gốc:** harness ghi `observed={"after_stale": ...}` còn reporter kiểm tra
  `observed.get("after")` (`apigw_acceptance.py:141`).
- **Ảnh hưởng:** SG.5 bị đánh INCONCLUSIVE dù có dữ liệu.
- **Đề xuất:** `DEFER` — không ảnh hưởng an toàn hệ thống, chỉ ảnh hưởng cách tổng hợp.

## D. Đã bác bỏ — không dùng lại làm nguyên nhân

### XR-RISK-R01 — "Port DOWN vì unbind nên worker từ chối"

**REJECTED.** `verify_target` (`sync_security_group.py:400–441`) kiểm tra `device_id`, `name` và tính
độc quyền, **không** từ chối theo `status == DOWN`. Neutron thật trả
`device_id = e38550db-…`, `device_owner = compute:nova`; lỗi `unbound` chỉ xuất hiện trong replay do
mock thiếu trường `device_id`. Kết luận này từng được ghi vào báo cáo nghiệm thu và **đã được đính
chính**.

### XR-RISK-R02 — "Backend che lỗi EventBridge"

**REJECTED.** `EventBridgeGatewayClient.sendEvent` đã kiểm tra `FailedEntryCount`, `Entries[].ErrorCode`
và `EventId`. HTTP 200 kèm entry lỗi là hợp đồng `PutEvents`, không phải lỗi backend.

## E. Điều kiện tối thiểu trước thử nghiệm không giám sát

Danh sách **cần chủ dự án xác nhận**, không phải điều kiện tôi tự áp đặt:

1. Chỉ dùng tài khoản và tài nguyên thử; không dùng chung với người dùng thật.
2. Không chạy SG live bằng harness hiện tại cho tới khi đóng `XR-RISK-H04`.
3. Giới hạn số VM mỗi lần chạy và có người kiểm tra tài nguyên sau mỗi lượt (`XR-RISK-011`).
4. Chấp nhận rằng SG chưa chứng minh hội tụ (`XR-RISK-001`) — firewall có thể không đổi.
5. Biết rằng không có cảnh báo kẹt tự động (`XR-RISK-004`), nên vẫn cần người rà định kỳ.
6. Không dùng kết quả harness làm bằng chứng PASS cho tới khi đóng `XR-RISK-H01..H03`.
