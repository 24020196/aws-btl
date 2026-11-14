"""Decide whether a failing instance may be recovered by cleanup. Pure functions only.

Why a separate module
--------------------
Deciding to delete a VM is the most destructive thing this feature does. Keeping the
decision free of AWS calls means every rule is unit-testable and the scheduler cannot
"accidentally" delete something because a network read failed.

Governing rule: **unknown is not a licence to delete.** Cleanup requires positive
evidence that the instance is ours, broken, and still broken; anything unclear means
"report, do not act".
"""
import time

# Outcomes. Strings so they can be stored in DynamoDB and logged verbatim.
DELETE = "DELETE"
REPAIR = "REPAIR"          # state drift fixable in place, no destruction
OBSERVE = "OBSERVE"        # not old enough to judge, or transiently odd
SKIP = "SKIP"              # nothing wrong
HOLD = "HOLD"              # infrastructure-wide problem: never act now

# States where a VM may legitimately sit: stopped is a user choice, not a fault.
# SPEC-SF-04: shelve/unshelve bị loại bỏ hoàn toàn, không còn SHELVED/SHELVED_OFFLOADED.
STABLE_STATES = {"RUNNING", "STOPPED", "SHUTOFF"}
# Transitional states a workflow should move on from.
TRANSITION_STATES = {"PENDING", "STOPPING", "STARTING", "REBOOTING", "SHUTTING_DOWN", "MIGRATING"}
# Nova states meaning the server is gone or unusable and worth cleaning up.
DEAD_NOVA_STATES = {"TERMINATED", "DELETED", "ERROR"}
# Record already marked failed by the application; may be recovered once durable.
FAILED_STATES = {"FAILED"}
# Blocks any destructive action: something legitimate is in flight.
BLOCKING_FLAGS = ("migration_lock",)


def _age(since_epoch, now):
    if not since_epoch:
        return None
    return max(0, int(now - int(since_epoch)))


def classify(record, nova, health, policy, now=None):
    """Return ``(decision, reason, evidence)`` for one instance.

    record : XRegion-Instances item (plain Python)
    nova   : matching XRegion-Nova item, or None
    health : {"infra_ok": bool, "api_error": str|None}
    policy : {"min_age_s": int, "max_delete_per_run": int}
    """
    now = int(now if now is not None else time.time())
    evidence = {}

    if not health.get("infra_ok", False):
        return HOLD, "hạ tầng chưa khỏe: %s" % (health.get("api_error") or "không rõ"), evidence
    if not record:
        return SKIP, "không có bản ghi instance", evidence

    instance_id = record.get("instance_id") or ""
    status = str(record.get("current_status") or "").upper()
    active_nova = str(record.get("active_nova_id") or "").strip()
    evidence.update(instance_id=instance_id, status=status, active_nova_id=active_nova)

    # A user action or a workflow in progress must never be interrupted by cleanup.
    for flag in BLOCKING_FLAGS:
        if record.get(flag):
            return HOLD, "đang khóa bởi %s" % flag, evidence
    if status == "MIGRATING":
        return HOLD, "đang migration", evidence

    nova_status = str((nova or {}).get("status") or "").upper()
    evidence["nova_status"] = nova_status

    # Nova terminal error: nothing legitimate can still be running on it.
    if nova is not None and nova_status in DEAD_NOVA_STATES:
        age = _age(record.get("last_failure_at") or record.get("last_migration_timestamp"), now)
        evidence["age_s"] = age
        if age is not None and age >= policy["min_age_s"]:
            return DELETE, "Nova %s quá %ds" % (nova_status, policy["min_age_s"]), evidence
        return OBSERVE, "Nova %s nhưng chưa đủ thời gian" % nova_status, evidence

    # Record says RUNNING but the Nova row is missing: repair, never delete. Deleting would
    # destroy a working VM whose bookkeeping row merely disappeared.
    if status == "RUNNING" and active_nova and nova is None:
        age = _age(record.get("last_migration_timestamp"), now)
        evidence["age_s"] = age
        if age is not None and age >= policy["min_age_s"]:
            return REPAIR, "DDB RUNNING nhưng thiếu bản ghi Nova", evidence
        return OBSERVE, "thiếu bản ghi Nova, chưa đủ thời gian", evidence

    # Record RUNNING while Nova is stopped: repairable drift, VM may simply be user-stopped.
    if status == "RUNNING" and nova is not None and nova_status in ("SHUTOFF", "STOPPED"):
        return REPAIR, "DDB RUNNING nhưng Nova %s" % nova_status, evidence

    # Stuck transitional state: fail it through the terminate contract, do not delete blindly.
    if status in TRANSITION_STATES:
        age = _age(record.get("last_migration_timestamp"), now)
        evidence["age_s"] = age
        if age is not None and age >= policy["min_age_s"]:
            if not active_nova:
                return REPAIR, "%s quá hạn và chưa có Nova" % status, evidence
            return REPAIR, "%s quá hạn, dọn theo hợp đồng" % status, evidence
        return OBSERVE, "%s chưa đủ thời gian" % status, evidence

    if status in STABLE_STATES:
        return SKIP, "trạng thái ổn định", evidence

    # Record already failed: recoverable, but the worker additionally requires the verdict
    # to be durable (same verdict over several sweeps) before acting on DELETE.
    if status in FAILED_STATES:
        evidence["age_s"] = _age(record.get("last_failure_at")
                                 or record.get("last_migration_timestamp"), now)
        return DELETE, "instance đã ở trạng thái FAILED", evidence

    return OBSERVE, "trạng thái chưa phân loại được: %s" % (status or "?"), evidence


# SPEC-SF-04: KHÔNG dùng circuit breaker. Hệ thống thu hồi tuần tự toàn bộ máy ảo lỗi thỏa mãn
# điều kiện bền vững trong cùng một đợt quét, mỗi lượt chỉ xóa khi đã qua kiểm tra bằng chứng
# (durable) và allowlist — không cắt ngang đợt quét vì số lượng máy lỗi.

def summarize(decisions):
    """Count decisions by kind, for one log line per sweep."""
    counts = {}
    for decision, _reason, _evidence in decisions:
        counts[decision] = counts.get(decision, 0) + 1
    return counts

