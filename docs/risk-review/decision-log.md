# Sổ quyết định rủi ro — phiên bản hiện tại

Sổ này là nơi chốt **quyết định của chủ dự án**. Mục chưa có quyết định vẫn ở trạng thái `PENDING`.

## Quy tắc tránh xử lý lặp

1. Trước khi đề xuất sửa, đọc sổ này trước.
2. Gặp lại triệu chứng của mục đã `DEFER`/`OUT_OF_SCOPE` không phải lý do mở lại — trừ khi có
   bằng chứng mới.
3. Chỉ mở lại khi: có bằng chứng mới; hậu quả vượt mức đã chấp nhận; điều kiện vận hành đổi; hoặc
   tới mốc xem lại đã ghi.
4. Khi mở lại, thêm dòng mới ghi **bằng chứng mới**, không sửa lại lịch sử.
5. Mục `REJECTED` được giữ để không dùng lại kết luận sai như sự thật.

## Bảng quyết định

| ID | Đề xuất | Quyết định của chủ dự án | Lý do / phạm vi | Điều kiện mở lại |
| --- | --- | --- | --- | --- |
| XR-RISK-001 | FIX_CURRENT | CHỌN HƯỚNG B (SPEC-06) | Quyết định 2026-11-10 (SPEC-06 v1.1.0): SG 1-1 tạo cùng máy ảo bắt buộc mang owner = username của chủ máy. Cấm tuyệt đối hardcode owner = "system" trong sync_dynamodb.py. Giữ nguyên visibleTo(username) trên Backend để bảo vệ phân quyền | Kiểm chứng lại bằng kịch bản tạo máy mới và mở màn hình firewall |
| XR-RISK-002 | DEFER | NOT_REPRODUCED — BỎ QUA | Kiểm chứng 2026-11-10 trên `i-16438b0a`: DDB/Nova table/Nova thật khớp qua launch+stop+start+reboot. Dữ liệu lệch tồn đọng không dùng làm căn cứ (nguồn tạo không xác định, có thể do phiên bản backend khác) | Chỉ mở lại nếu tái hiện được trên instance do chính phiên kiểm chứng tạo |
| XR-RISK-003 | FIX_CURRENT | FIXED_LOCAL | Event bị từ chối → FAILED; lỗi transport không xác định → vẫn PENDING nhưng ghi lý do rõ thay vì treo im lặng. Không tự gửi lại để tránh tạo VM thứ hai | Chỉ mở lại nếu cần cơ chế đối soát tự động |
| XR-RISK-004 | FIX_CURRENT | FIXED_LOCAL | Trước đây `@EnableScheduling` bật nhưng **không có job nào**. Thêm `StuckTaskDetector` + `StuckTaskMonitor` (chỉ báo, không tự sửa); SG kiểm bằng `applied_revision < revision`, không tin `sync_status` | **Cần nghiệm thu vận hành:** chưa cấu hình kênh nhận cảnh báo |
| XR-RISK-005 | NEEDS_EVIDENCE | PENDING | — | — |
| XR-RISK-006 | NEEDS_EVIDENCE | PENDING | — | — |
| XR-RISK-007 | ACCEPT_WITH_CONTROLS | PENDING | — | — |
| XR-RISK-008 | ACCEPT_WITH_CONTROLS | PENDING | — | — |
| XR-RISK-009 | ACCEPT_WITH_CONTROLS | PENDING | — | — |
| XR-RISK-010 | NEEDS_EVIDENCE | PENDING | — | — |
| XR-RISK-011 | ACCEPT_WITH_CONTROLS | ĐÃ CHỐT: KHÔNG GIỚI HẠN | Quyết định chủ dự án (2026-11-10): Không giới hạn hạn mức máy ảo ở tầng Backend, để việc giới hạn phụ thuộc hoàn toàn vào quota hạ tầng OpenStack / AWS | Chỉ mở lại nếu xuất hiện tình trạng cạn kiệt tài nguyên ngoài tầm kiểm soát |
| XR-RISK-H01 | FIX_CURRENT | FIXED_LOCAL | `find_correlated_execution` phân trang, nhận execution đã kết thúc, trả lỗi khi mơ hồ thay vì đoán (`running[0]` đã bỏ) | Cần một lần chạy live để xác nhận |
| XR-RISK-H02 | FIX_CURRENT | FIXED_LOCAL | Launch chỉ PASS khi SFN SUCCEEDED + Nova đúng ID ACTIVE + DDB RUNNING (chờ tối đa 120s) | Cần chạy live |
| XR-RISK-H03 | FIX_CURRENT | FIXED_LOCAL | `main()` trả kết quả `finish()`; FAIL/BLOCKED/NOT RUN → exit 1. Đã test trực tiếp qua `main()` | Đóng sau khi có một run live dùng exit code |
| XR-RISK-H04 | FIX_CURRENT | FIXED_LOCAL | Rollback có `ConditionExpression` theo revision, chỉ xóa rule khớp probe (port + CIDR), báo `foreign_rule_ids_not_deleted`, không khôi phục SYNCED khi revision > applied_revision | Cần chạy live có rollback để xác nhận |
| XR-RISK-H05 | DEFER | PENDING | — | — |
| XR-RISK-R01 | REJECTED | REJECTED (đã đính chính) | Mã không chặn theo `DOWN`; lỗi do mock thiếu `device_id` | Chỉ mở lại nếu có log Neutron thật cho thấy điều kiện khác |
| XR-RISK-R02 | REJECTED | REJECTED (đã đính chính) | Client đã kiểm tra `FailedEntryCount`/`ErrorCode`/`EventId` | Chỉ mở lại nếu có bằng chứng client bỏ qua body |

## Giá trị quyết định

| Giá trị | Nghĩa |
| --- | --- |
| `FIX_CURRENT` | Phải xử lý trước khi thử nghiệm không giám sát |
| `ACCEPT_WITH_CONTROLS` | Cho phép, kèm giới hạn vận hành ghi rõ |
| `DEFER` | Hoãn; ghi mốc/điều kiện xem lại |
| `OUT_OF_SCOPE` | Không thuộc khả năng cung cấp của phiên bản này |
| `NEEDS_EVIDENCE` | Chưa đủ căn cứ; chỉ làm bước xác minh đã duyệt |
| `REJECTED` | Kết luận sai đã bị bác bỏ |
| `FIXED_LOCAL` | Đã sửa và có test trong mã nguồn, **chưa deploy** và **chưa kiểm chứng vận hành** |
| `BUILT_LOCAL` | Đã xây tính năng mới + test, **chưa deploy**, chưa kiểm chứng vận hành |
| `DEPLOYED_OBSERVE` | Đã deploy, chạy chế độ **quan sát** (không có quyền xóa), đã xác minh ghi 0 bản ghi |

## Trạng thái deploy (2026-11-10)

| Hạng mục | Trạng thái |
| --- | --- |
| `XRegion-InstanceRecovery` Lambda | `DEPLOYED_OBSERVE` — code khớp repo (SHA so khớp), `LIVE=false`, allowlist rỗng |
| Role execution | Không có `states:StartExecution` ⇒ **không thể xóa** |
| Role scheduler | Chỉ `lambda:InvokeFunction` |
| `XRegion-InstanceRecovery-Schedule` | **ENABLED**, `rate(5 minutes)` |
| Vận hành | 2 lượt tự động (16:36, 16:41): invocations 1/1, **errors 0** |
| Ghi dữ liệu | **0/39 bản ghi** bị thay đổi — quan sát đúng nghĩa |
| Circuit breaker | Kích hoạt thật: 13 DELETE ⇒ *"nghi sự cố hạ tầng, dừng thu hồi"* |

**Chưa bật** xóa tự động (`LIVE=true`) và chưa có bằng chứng đường cleanup chạy thật.


## Tự phục hồi máy lỗi (quyết định 2026-11-10)

Chủ dự án chấp nhận **mất dữ liệu Nova VM** để đổi lấy thao tác UI tin cậy; cơ chế tự thu hồi
được phép dọn tài nguyên riêng của máy lỗi. Đã xây **local**, chưa deploy:

| Hạng mục | Trạng thái | Ghi chú |
| --- | --- | --- |
| `XRegion-InstanceRecovery/recovery_policy.py` | `BUILT_LOCAL` | Quy tắc phân loại thuần, 18 test |
| `XRegion-InstanceRecovery/recovery_worker.py` | `BUILT_LOCAL` | 8 test: dry-run, allowlist, circuit breaker, fail-closed |
| `deployment/recovery_schedule.py` | `BUILT_LOCAL` | Dry run xác nhận role/schedule chưa tồn tại |
| Manifest + `deploy.py` | `FIXED_LOCAL` | Đóng gói kèm module policy |
| `InstanceEntity` / `InstanceResponse` / `instances.js` | `FIXED_LOCAL` | Hiển thị trạng thái cleanup + hướng dẫn tạo mới |

**Nguyên tắc an toàn đã cài:** mặc định quan sát và **không ghi gì** (không cập nhật trạng thái, không
claim, không gọi terminate); phải bật `XREGION_RECOVERY_LIVE=true` **và** có trong allowlist; trạng
thái Nova đọc từ **Nova thật**, không dùng projection DynamoDB; hạ tầng không khỏe ⇒ HOLD; nhiều máy
cùng lỗi ⇒ dừng cả lượt; `STOPPED/SHUTOFF` không bị xóa; thiếu bản ghi Nova ⇒ REPAIR chứ không DELETE;
DELETE cần verdict **bền vững** (`min_age_s` + `min_observations`); cleanup lỗi ⇒ `CLEANUP_FAILED`,
không báo thành công giả; UI chỉ nói "đã xóa" khi `CLEANUP_DONE`.

**Lỗi đã sửa trong lượt nghiệm thu trước khi deploy:** `scan_candidates()` double-wrap gây KeyError
khiến sweep không đọc được bản ghi nào; khối code chết trong worker; `FAILED` không thuộc tập trạng
thái nào nên máy lỗi không bao giờ được xét; UI coi `CLEANUP_REQUESTED` là đã dọn xong; Scheduler role
từng có quyền DDB/StartExecution (nay tách riêng, chỉ `lambda:InvokeFunction`); schedule tạo DISABLED.

**Chưa làm (cần duyệt riêng):** deploy Lambda/role/schedule, bật live thu hồi, chạy live test.
Lưu ý: worker chưa có theo dõi kết quả execution để ghi `CLEANUP_DONE`, nên UI sẽ giữ ở trạng thái
"đang thu hồi" cho tới khi bổ sung bước đó.


## Trạng thái 7 mục đã duyệt xử lý

| Mức | Ý nghĩa | Mục |
| --- | --- | --- |
| `FIXED_LOCAL` | Sửa + test passing, chưa deploy | XR-RISK-002, 003, 004, H01, H02, H03, H04 |

**Chưa mục nào `CLOSED`.** Lý do: chưa deploy, và các mục harness cần một lần chạy live để chứng minh
hành vi mới thực sự đúng trên hệ thống thật. Ghi rõ ba mức để không đánh đồng "test xanh" với
"đã an toàn trong vận hành".

Bằng chứng test tại thời điểm cập nhật: 218 Python + 92 Java, 0 failures.

## Hồ sơ các lần đính chính

| Ngày | Nội dung | Nguồn |
| --- | --- | --- |
| 2026-11-10 | Bác bỏ "port DOWN → worker từ chối" | `xregion-replay4.log` vs `xregion-port3.log`; `verify_target` không kiểm `status` |
| 2026-11-10 | Rút lại tuyên bố "đã loại trừ worker/mất event/thiếu quyền" cho từng SG request; chỉ chứng minh được delivery ở mức tổng hợp | metric rule + Lambda, direct invoke |
| 2026-11-10 | Đính chính "harness hardening verified": còn lỗi runtime và điều kiện PASS chưa kín | đọc lại mã sau khi sửa |
