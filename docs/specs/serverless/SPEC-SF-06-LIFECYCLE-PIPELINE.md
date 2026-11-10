# SPEC-SF-06: Quy Trình Vòng Đời Máy Ảo Step Function (Lifecycle Pipeline)

> **Phiên bản**: `1.0.0`
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`
> **Ngày phê duyệt**: `2026-11-11`
> **Tài liệu cha**: [SPEC-SF-00: Serverless Scope Guard](SPEC-SF-00-SERVERLESS-SCOPE-GUARD.md)
> **Tài liệu nghiệp vụ**: [SPEC-01: Instance Lifecycle](../SPEC-01-INSTANCE-LIFECYCLE.md)

---

## 1. Mục Đích & Bất Biến

Chuyển `STOP` / `START` / `REBOOT` từ Lambda "ghi trạng thái ngay sau khi gửi lệnh" sang một
Step Functions chuẩn. Nguyên tắc tối cao:

> [!IMPORTANT]
> 1. **Quan sát trước, ghi sau (Observe-Before-Write)**: `XRegion-Instances.current_status` và
>    `XRegion-Nova.status` chỉ được ghi trạng thái **cuối** khi Nova đã thực sự ở trạng thái đó.
> 2. **Cấm `shelve`/`unshelve`** (SPEC-01 §1): `STOP` chỉ dùng `os-stop`, `START` chỉ dùng `os-start`.
> 3. **Cấm ghi đè thao tác mới hơn**: mọi lệnh ghi phải có `ConditionExpression` theo trạng thái
>    chuyển tiếp (`STOPPING`/`STARTING`/`REBOOTING`).
> 4. **Không thêm trạng thái mới** ngoài bảng ánh xạ của SPEC-01 §1.

---

## 2. Kiến Trúc

```
Backend (Java)                         AWS
────────────────                       ─────────────────────────────────────────────
executeAction(STOP|START|REBOOT)
  → ghi intent STOPPING|STARTING|REBOOTING (conditional từ RUNNING|STOPPED)
  → EventBridge  source=xregion.backend.instance
                 detail-type=instance.lifecycle  ──► XRegion-InstanceLifecycleRule
                                                      (detail.action in START/STOP/REBOOT)
                                                      InputPath = $.detail
                                                      │
                                                      ▼
                                             LifecycleInstance (STANDARD, 300s)
                                                      │
                                              Lambda XRegion-InstanceLifecycle
                                                      │ mode=LOAD|DISPATCH|STATUS|SYNC
                                                      ▼
                                                   Nova API
```

- Rule cũ `XRegion-BackendEventRule` **không còn** target `XRegion-NovaLifecycleManager`; log group và
  `XRegion-KeySyncManager` giữ nguyên.
- `XRegion-NovaLifecycleManager` vẫn tồn tại trên AWS làm đường lùi (rollback), không nhận traffic
  vòng đời nữa.

---

## 3. Sơ Đồ State

| State | Loại | Vai trò |
| :--- | :--- | :--- |
| `LoadInstance` | Task (mode=LOAD) | Đọc `XRegion-Instances` + Nova; kiểm tra intent; phát hiện trùng |
| `ChoiceLoaded` | Choice | `ALREADY_HANDLED` → Succeed; `REJECTED`/`FAILED` → Fail; đã ở đích → `SyncDynamoDB` |
| `DispatchAction` | Task (mode=DISPATCH) | Gửi `os-stop`/`os-start`/`reboot SOFT`; coi 409 + đã ở đích là thành công |
| `ChoiceDispatched` | Choice | `REJECTED` → Fail |
| `WaitStatus` | Wait | 5 giây |
| `CheckStatus` | Task (mode=STATUS) | Đọc Nova; cập nhật `saw_transition` |
| `ChoiceStatus` | Choice | Đạt trạng thái đích → `SyncDynamoDB`; `ERROR`/`SHELVED` → Fail; còn lại → `WaitStatus` |
| `SyncDynamoDB` | Task (mode=SYNC) | Ghi Nova + Instances với điều kiện |
| `LifecycleSucceeded` / `AlreadyHandled` | Succeed | |
| `LifecycleRejected` | Fail (`LifecycleRejected`) | Vi phạm SPEC-01 (ví dụ START trên VM `SHELVED`) |
| `LifecycleFailed` | Fail (`LifecycleError`) | Nova `ERROR`, 404, lỗi transport sau retry |

`TimeoutSeconds = 300` (đồng bộ 2 workflow hiện có), `Wait = 5s` ⇒ tối đa ~58 vòng quan sát.

### Bảng quyết định của `ChoiceStatus`

| Action | Điều kiện thành công | Điều kiện thất bại ngay |
| :--- | :--- | :--- |
| `STOP` | `observed_status ∈ {SHUTOFF, STOPPED}` | `ERROR` |
| `START` | `observed_status = ACTIVE` | `ERROR`, `SHELVED`, `SHELVED_OFFLOADED` |
| `REBOOT` | `ACTIVE` **và** `saw_transition=true` **và** `task_state` null | `ERROR` |

`REBOOT` không thấy transition ⇒ chạy tới `TimeoutSeconds` và execution `FAILED`; **không** được
tuyên bố thành công (giữ đúng hành vi của `wait_for_final_status` trước đây).

---

## 4. Payload Contract (`XRegion-InstanceLifecycle`)

### 4.1 Trường vào (từ `$.detail`)

| Trường | Kiểu | Bắt buộc | Ghi chú |
| :--- | :--- | :--- | :--- |
| `action` | string | có | `START` \| `STOP` \| `REBOOT` |
| `instance_id` | string | có | `i-xxxxxxxx` |
| `instance_name`, `requested_by`, `key_id`, `flavor`, `target_region` | string | không | chỉ để log/truy vết |
| `mode` | string | có (nội bộ) | `LOAD` \| `DISPATCH` \| `STATUS` \| `SYNC` |

### 4.2 Trường nội bộ (do state trước thêm vào)

`intent_status`, `previous_status`, `nova_id`, `observed_status`, `task_state`, `vm_state`,
`saw_transition`, `already_at_target`, `dispatched`, `status`, `reason`.

`status` là **mã điều khiển** của workflow, không phải trạng thái máy ảo:
`LOADED` | `OBSERVED` | `SYNCED` | `SKIPPED` | `ALREADY_HANDLED` | `REJECTED` | `FAILED`.

---

## 5. Idempotency & Đồng Bộ

1. **Trùng event**: `LOAD` trả `ALREADY_HANDLED` khi `current_status` khác `intent_status`
   (một thao tác mới hơn hoặc bản ghi đã hoàn tất). Không POST lại, không ghi đè.
2. **Đã ở đích**: `LOAD`/`DISPATCH` bỏ qua POST khi Nova đã `SHUTOFF` (STOP), `ACTIVE` (START),
   `task_state=rebooting` (REBOOT). `os-stop`/`os-start` trả 409 nhưng Nova đã ở đích ⇒ thành công.
3. **Ghi Nova** (`XRegion-Nova`): `ConditionExpression=attribute_exists(nova_id)`.
4. **Ghi Instances**: `ConditionExpression=attribute_exists(instance_id) AND current_status=:intent`.
   `ConditionalCheckFailedException` ⇒ trả `SKIPPED` (không ghi đè), execution vẫn `Succeed`.
5. Thứ tự ghi: **Nova trước, Instances sau** — lỗi ghi Nova phải chặn hoàn tất Instances.

---

## 6. Xử Lý Lỗi & Trạng Thái Kẹt

| Tình huống | Kết quả |
| :--- | :--- |
| Nova `ERROR` khi đang chờ | `LifecycleFailed`; `XRegion-Instances` **không** bị ghi `FAILED` tự động — Recovery xử lý |
| Nova 404 | `LifecycleRejected` ("Nova không còn server") |
| Quá 300s chưa tới đích | `States.Timeout`; bản ghi giữ `STOPPING/STARTING/REBOOTING` để `StuckTaskMonitor` (30 phút) và `XRegion-InstanceRecovery` (khi bật) xử lý |
| START trên VM `SHELVED*` | `LifecycleRejected` — cần xử lý thủ công, không dùng `unshelve` |
| Thiếu `instance_id`/action lạ | `LifecycleRejected` |

---

## 7. IAM & Hạ Tầng

- Lambda `XRegion-InstanceLifecycle`: role `DB-AccessRole`, VPC của host OpenStack, timeout 60s,
  env `NOVA_URL`, `KEYSTONE_URL`, `OS_*` (secret tham chiếu, không hard-code trong repo).
- State machine `LifecycleInstance`: role `openstack_step_functions_role`, log
  `/aws/vendedlogs/states/XRegion-LifecycleInstance`.
- Rule `XRegion-InstanceLifecycleRule`: target SFN + DLQ `XRegion-InstanceLifecycle-DLQ`,
  `RetryPolicy = {MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300}`.
- `EventBridge-StepFunctions-ExecutionRole` phải có ARN `LifecycleInstance` trong
  `AllowStartStepFunctionExecution`.

---

## 8. Nghiệm Thu

| # | Tiêu chí | Cách đo |
| :--- | :--- | :--- |
| 1 | ASL hợp lệ và đúng generator | `workflows.py LifecycleInstance` + `validate-state-machine-definition` = OK |
| 2 | Không ghi sớm | STOP: `current_status` vẫn `STOPPING` khi execution chưa Succeeded |
| 3 | Idempotent | 2 event STOP ⇒ 1 `Succeed`, 1 `AlreadyHandled` |
| 4 | Không shelve | Artifact deploy không chứa `shelve`/`unshelve` |
| 5 | Không đè thao tác mới | `SYNC` bị `ConditionalCheckFailed` ⇒ `SKIPPED` |
| 6 | Không double-execution | Log `XRegion-NovaLifecycleManager` không còn invocation START/STOP/REBOOT |

---

## 9. Lịch Sử Phiên Bản

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-11` | `1.0.0` | Lead Architect / Product Owner | Ban hành Lifecycle Pipeline: STOP/START/REBOOT qua Step Functions, observe-before-write, cấm shelve/unshelve, timeout 300s, idempotent theo intent status. |

