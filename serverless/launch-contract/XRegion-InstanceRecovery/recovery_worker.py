"""Scheduled instance recovery: detect broken trial VMs and recover them.

Safety model (see docs/risk-review and XR-RISK-002/004):

* **Dry run by default.** ``XREGION_RECOVERY_LIVE`` must be ``true`` *and* the instance
  must be in ``XREGION_RECOVERY_ALLOWLIST`` before anything is destroyed.
* **Unknown never deletes.** Decisions come from ``recovery_policy.classify``; a failed
  OpenStack read yields HOLD, not DELETE.
* **Sequential recovery (no circuit breaker).** Every instance that is durable-broken and
  allowlisted is recovered in the same sweep, one at a time; the sweep is never aborted just
  because many instances look broken (see SPEC-SF-04).
* **Cleanup goes through the terminate contract** so volume/network/EIP ownership checks
  are reused instead of re-implemented here.
* The instance record is kept and marked FAILED with a cleanup status, so the UI can tell
  the user what happened and invite them to create a new instance.
"""
import json
import os
import time
import uuid

import boto3
from botocore.config import Config

import recovery_policy as policy

REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
INSTANCES = os.environ.get("XREGION_INSTANCES_TABLE", "XRegion-Instances")
NOVA_TABLE = os.environ.get("XREGION_NOVA_TABLE", "XRegion-Nova")
TERMINATE_ARN = os.environ.get("XREGION_TERMINATE_STATE_MACHINE", "")
NOVA_URL = os.environ.get("NOVA_URL", "")
OS_ENV = ("OS_USERNAME", "OS_PASSWORD", "OS_PROJECT_NAME")

SESSION = boto3.Session(region_name=REGION)
CONFIG = Config(connect_timeout=3, read_timeout=15,
                retries={"mode": "standard", "total_max_attempts": 2})


def plain(value):
    """DynamoDB AttributeValue -> plain Python (no Decimal), mirrors the worker's helper."""
    from decimal import Decimal

    def walk(item):
        if isinstance(item, dict):
            if len(item) == 1:
                (kind, inner), = item.items()
                if kind == "S":
                    return inner
                if kind == "N":
                    return int(Decimal(str(inner)))
                if kind == "BOOL":
                    return bool(inner)
                if kind == "NULL":
                    return None
                if kind == "L":
                    return [walk(v) for v in inner]
                if kind == "M":
                    return {k: walk(v) for k, v in inner.items()}
            return {k: walk(v) for k, v in item.items()}
        if isinstance(item, list):
            return [walk(v) for v in item]
        return item

    return walk(value)


def log(event_name, **fields):
    """Structured one-line log; the scheduler's only alerting channel for now."""
    print(json.dumps(dict(event=event_name, ts=int(time.time() * 1000), **fields), default=str))


def durable(evidence, record, policy_cfg, now):
    """A fault must be *observed repeatedly*, not merely old.

    ``age_s`` alone is not enough: a record can carry an ancient timestamp while the fault
    only appeared in this sweep. This requires the same verdict to have been recorded for
    at least ``min_age_s`` (``recovery_decision_at``) with ``min_observations`` sweeps.
    """
    since = record.get("recovery_decision_at")
    seen = int(record.get("recovery_observations") or 1)
    if not since:
        return False, "chưa có lịch sử quan sát"
    elapsed = now - int(since)
    if elapsed < policy_cfg["min_age_s"]:
        return False, "mới được đánh giá lỗi %ds" % elapsed
    if seen < policy_cfg.get("min_observations", 3):
        return False, "mới quan sát %d lần" % seen
    return True, ""


def lambda_handler(event, context):
    """One recovery sweep. Observe-only unless live mode is on *and* allowlisted."""
    config = load_config()
    health = check_health()
    if not health["infra_ok"]:
        log("SWEEP_HOLD", reason=health["api_error"], live=config["live"])
        return summary(config, [], health=health, stopped="hạ tầng không khỏe")

    candidates = scan_candidates(config)
    decisions, by_id = [], {}
    repairs = []
    for record in candidates:
        instance_id = record.get("instance_id")
        # Verify any in-flight cleanup first: this is how the UI learns data is really gone.
        tracked = track_cleanup(record, config)
        if tracked:
            log("CLEANUP_TRACKED", instance=instance_id, status=tracked)
        live_nova = read_nova(record.get("active_nova_id")) if record.get("active_nova_id") else None
        decision, reason, evidence = policy.classify(
            record, live_nova, health, config["policy"], now=int(time.time()))
        evidence = dict(evidence, instance_id=instance_id)
        decisions.append((decision, reason, evidence))
        by_id[instance_id] = (decision, reason, evidence)
        # Observe mode must not write anything: a scheduler that mutates while "dry" is
        # not a dry run, and it would corrupt the very state we are trying to measure.
        if config["live"]:
            record_observation(instance_id, decision, reason)
            if decision == policy.REPAIR:
                repairs.append(repair(record, live_nova, reason))
        log("DECISION", instance=instance_id, decision=decision, reason=reason,
            live=config["live"])

    acted = []
    for record in candidates:
        instance_id = record.get("instance_id")
        decision, reason, _ = by_id.get(instance_id, (policy.SKIP, "", {}))
        if decision != policy.DELETE:
            continue
        if not config["live"]:
            log("WOULD_RECOVER", instance=instance_id, reason=reason)
            continue
        if instance_id not in config["allowlist"]:
            log("SKIPPED_NOT_ALLOWLISTED", instance=instance_id)
            continue
        stable, why_not = durable(None, record, config["policy"], int(time.time()))
        if not stable:
            log("NOT_DURABLE_YET", instance=instance_id, reason=why_not)
            continue
        # SPEC-SF-04: thu hồi tuần tự toàn bộ danh sách lỗi trong cùng một đợt quét.
        acted.append(recover(record, reason))

    return summary(config, decisions, health=health, acted=acted, repaired=repairs)


def record_observation(instance_id, decision, reason):
    """Track how long a verdict has persisted, so only durable faults reach DELETE.

    ``recovery_decision``     last verdict
    ``recovery_decision_at``  when this verdict started (reset when it changes)
    ``recovery_observations`` how many consecutive sweeps agreed
    """
    table = SESSION.client("dynamodb", config=CONFIG)
    now = int(time.time())
    try:
        item = plain(table.get_item(TableName=INSTANCES,
                                    Key={"instance_id": {"S": instance_id}},
                                    ConsistentRead=True).get("Item") or {})
        if item.get("recovery_decision") == decision:
            table.update_item(
                TableName=INSTANCES, Key={"instance_id": {"S": instance_id}},
                UpdateExpression="ADD recovery_observations :one",
                ConditionExpression="attribute_exists(instance_id)",
                ExpressionAttributeValues={":one": {"N": "1"}})
            return
        table.update_item(
            TableName=INSTANCES, Key={"instance_id": {"S": instance_id}},
            UpdateExpression="SET recovery_decision = :d, recovery_decision_at = :t, "
                             "recovery_observations = :one",
            ConditionExpression="attribute_exists(instance_id)",
            ExpressionAttributeValues={":d": {"S": decision}, ":t": {"N": str(now)},
                                       ":one": {"N": "1"}})
    except Exception as error:  # noqa: BLE001 - observation must never break the sweep
        log("OBSERVE_FAILED", instance=instance_id, error=str(error)[:200])


def read_nova(nova_id):
    """Read the server from Nova itself, not only the DynamoDB projection.

    Deleting based on a cached row is how a healthy VM gets destroyed: the row may be
    stale, or belong to a previous generation of the instance.
    """
    if not nova_id or not NOVA_URL:
        return None
    try:
        token = keystone_token()
        status, _headers, body = http("GET", NOVA_URL.rstrip("/") + "/servers/" + str(nova_id), token)
        if status == 404:
            # Nova says it is gone; report that explicitly instead of "unknown".
            return {"status": "DELETED", "source": "nova-404"}
        server = body.get("server") or {}
        if not server.get("id"):
            return None
        return {"status": str(server.get("status") or "").upper(),
                "nova_id": server.get("id"), "source": "nova"}
    except Exception as error:  # noqa: BLE001 - unknown state must not become DELETE
        log("NOVA_READ_FAILED", nova_id=nova_id, error=str(error)[:200])
        return None



def keystone_token():
    payload = {"auth": {"identity": {"methods": ["password"], "password": {"user": {
        "name": os.environ["OS_USERNAME"], "domain": {"name": "Default"},
        "password": os.environ["OS_PASSWORD"]}}}, "scope": {"project": {
            "name": os.environ.get("OS_PROJECT_NAME", "service"), "domain": {"name": "Default"}}}}}
    url = os.environ["KEYSTONE_URL"].rstrip("/") + "/auth/tokens"
    status, headers, body = http("POST", url, None, payload)
    token = headers.get("x-subject-token")
    if status != 201 or not token:
        raise RuntimeError("Keystone auth HTTP %s" % status)
    return token


def http(method, url, token=None, payload=None):
    import urllib.error
    import urllib.request
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Auth-Token"] = token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, \
                json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return 404, {}, {}
        raise RuntimeError("%s %s HTTP %s" % (method, url, error.code)) from None


def http_json(method, url, token=None, payload=None):
    return http(method, url, token, payload)[2]


def check_health():
    """Infrastructure must be reachable before anything is destroyed."""
    if not NOVA_URL:
        return {"infra_ok": False, "api_error": "NOVA_URL chưa cấu hình"}
    try:
        token = keystone_token()
        body = http_json("GET", NOVA_URL.rstrip("/") + "/servers/detail?limit=1", token)
        if "servers" not in body:
            return {"infra_ok": False, "api_error": "Nova trả dữ liệu không hợp lệ"}
        return {"infra_ok": True, "api_error": None}
    except Exception as error:  # noqa: BLE001 - a health probe must never crash the sweep
        return {"infra_ok": False, "api_error": str(error)[:200]}


def scan_candidates(config):
    """Scan instance records, converting each DynamoDB item.

    ``plain()`` already unwraps the AttributeValue layer, so wrapping the item in another
    ``{"M": ...}`` and reading ``["M"]`` raised KeyError on every record — the sweep could
    never classify anything. The double-wrap is removed and asserted by tests.
    """
    table = SESSION.client("dynamodb", config=CONFIG)
    items, token = [], None
    while True:
        params = {"TableName": INSTANCES, "Limit": config["limit"]}
        if token:
            params["ExclusiveStartKey"] = token
        page = table.scan(**params)
        items.extend(plain(item) for item in page.get("Items", []))
        token = page.get("LastEvaluatedKey")
        if not token or len(items) >= config["limit"]:
            break
    return items


def get_nova(nova_id):
    if not nova_id:
        return None
    item = SESSION.client("dynamodb", config=CONFIG).get_item(
        TableName=NOVA_TABLE, Key={"nova_id": {"S": str(nova_id)}}, ConsistentRead=True).get("Item")
    return plain(item) if item else None



def load_config():
    allowlist = {item.strip() for item in
                 os.environ.get("XREGION_RECOVERY_ALLOWLIST", "").split(",") if item.strip()}
    return {
        "live": os.environ.get("XREGION_RECOVERY_LIVE", "false").lower() == "true",
        "allowlist": allowlist,
        "policy": {
            "min_age_s": int(os.environ.get("XREGION_RECOVERY_MIN_AGE_S", "1800")),
            "max_delete_per_run": int(os.environ.get("XREGION_RECOVERY_MAX_DELETE", "1")),
            "min_observations": int(os.environ.get("XREGION_RECOVERY_MIN_OBSERVATIONS", "3")),
        },
        "limit": int(os.environ.get("XREGION_RECOVERY_SCAN_LIMIT", "200")),
    }


def claim(instance_id, expected_status):
    """Take an exclusive lease so two sweeps cannot clean the same instance twice."""
    table = SESSION.client("dynamodb", config=CONFIG)
    owner = "recovery-%s" % uuid.uuid4()
    try:
        table.update_item(
            TableName=INSTANCES, Key={"instance_id": {"S": instance_id}},
            UpdateExpression="SET recovery_owner = :o, recovery_started_at = :t",
            ConditionExpression="attribute_exists(instance_id) AND "
                                "(attribute_not_exists(recovery_owner) OR recovery_owner = :empty) "
                                "AND current_status = :expected",
            ExpressionAttributeValues={":o": {"S": owner}, ":t": {"N": str(int(time.time()))},
                                       ":empty": {"S": ""}, ":expected": {"S": expected_status}})
        return owner
    except table.exceptions.ConditionalCheckFailedException:
        return None


def mark(instance_id, owner, status, cleanup_status, reason, extra=None):
    """Conditional write: only the sweep holding the lease may change the record.

    ``extra`` adds fields to the same atomic update, so status and its supporting data
    never disagree (for example CLEANUP_REQUESTED and the execution id).
    """
    table = SESSION.client("dynamodb", config=CONFIG)
    values = {":s": {"S": status}, ":c": {"S": cleanup_status},
              ":r": {"S": str(reason or "")[:900]}, ":t": {"N": str(int(time.time()))}}
    expression = "SET current_status = :s, recovery_status = :c, recovery_reason = :r, " \
                 "recovery_updated_at = :t"
    names = {}
    for index, (key, value) in enumerate((extra or {}).items()):
        placeholder, name_placeholder = ":e%d" % index, "#e%d" % index
        names[name_placeholder] = key
        values[placeholder] = {"S": value} if isinstance(value, str) else {"NULL": True} \
            if value is None else {"S": str(value)}
        expression += ", %s = %s" % (name_placeholder, placeholder)
    try:
        kwargs = {"TableName": INSTANCES, "Key": {"instance_id": {"S": instance_id}},
                  "UpdateExpression": expression,
                  "ExpressionAttributeValues": values}
        # The lease check only applies while we still own it; a completed cleanup keeps the
        # owner for traceability but must still be updatable by the same owner id.
        kwargs["ConditionExpression"] = "recovery_owner = :o"
        values[":o"] = {"S": owner}
        if names:
            kwargs["ExpressionAttributeNames"] = names
        table.update_item(**kwargs)
    except Exception as error:  # noqa: BLE001 - the caller already reported the failure
        log("MARK_FAILED", instance=instance_id, error=str(error)[:200])


def recover(record, reason):
    """Destroy the VM through the terminate contract, then record the outcome honestly."""
    instance_id = record["instance_id"]
    owner = claim(instance_id, record.get("current_status"))
    if not owner:
        log("LEASE_NOT_ACQUIRED", instance=instance_id)
        return {"instance_id": instance_id, "cleanup_status": "SKIPPED_BUSY"}

    mark(instance_id, owner, "RECOVERING", "CLEANUP_RUNNING", reason,
         extra={"recovery_execution": None})
    try:
        if not TERMINATE_ARN:
            raise RuntimeError("XREGION_TERMINATE_STATE_MACHINE chưa cấu hình")
        response = SESSION.client("stepfunctions", config=CONFIG).start_execution(
            stateMachineArn=TERMINATE_ARN,
            input=json.dumps({"instance_id": instance_id,
                              "nova_id": record.get("active_nova_id"),
                              "action": "TERMINATE", "requested_by": "instance-recovery",
                              "reason": reason}))
        execution = response["executionArn"]
        log("RECOVERY_STARTED", instance=instance_id, execution=execution)
        # Store the execution id: a later sweep verifies its outcome before the UI is told
        # the data is gone. Without this the record would say "requested" forever.
        mark(instance_id, owner, "FAILED", "CLEANUP_REQUESTED", reason,
             extra={"recovery_execution": execution})
        return {"instance_id": instance_id, "cleanup_status": "CLEANUP_REQUESTED",
                "execution": execution}
    except Exception as error:  # noqa: BLE001 - never report success when cleanup failed
        log("RECOVERY_FAILED", instance=instance_id, error=str(error)[:300])
        # The VM may still exist: say so instead of pretending it was removed.
        mark(instance_id, owner, "FAILED", "CLEANUP_FAILED",
             "%s — %s" % (reason, str(error)[:200]))
        return {"instance_id": instance_id, "cleanup_status": "CLEANUP_FAILED",
                "error": str(error)[:300]}


def track_cleanup(record, config):
    """Advance CLEANUP_REQUESTED to DONE only when the workflow actually succeeded.

    Runs in observe mode too: reading a state machine costs nothing and is not destructive,
    and it is the only way the UI learns that data really was removed.
    """
    instance_id = record.get("instance_id")
    execution = record.get("recovery_execution")
    if record.get("recovery_status") != "CLEANUP_REQUESTED" or not execution:
        return None
    try:
        described = SESSION.client("stepfunctions", config=CONFIG).describe_execution(
            executionArn=execution)
        status = described.get("status")
    except Exception as error:  # noqa: BLE001 - unknown outcome stays "requested"
        log("CLEANUP_STATUS_UNKNOWN", instance=instance_id, error=str(error)[:200])
        return None
    if status == "SUCCEEDED":
        if config["live"]:
            mark(instance_id, record.get("recovery_owner"), "FAILED", "CLEANUP_DONE",
                 record.get("recovery_reason") or "cleanup verified")
        log("CLEANUP_DONE", instance=instance_id, execution=execution)
        return "CLEANUP_DONE"
    if status in ("FAILED", "TIMED_OUT", "ABORTED"):
        if config["live"]:
            mark(instance_id, record.get("recovery_owner"), "FAILED", "CLEANUP_FAILED",
                 "workflow %s" % status)
        log("CLEANUP_FAILED", instance=instance_id, execution=execution, workflow_status=status)
        return "CLEANUP_FAILED"
    return "CLEANUP_REQUESTED"



def repair(record, live_nova, reason):
    """Correct record/Nova drift in place, without touching the VM.

    Only runs when live mode is on. Two cases are safe to reconcile:
    * record RUNNING but Nova stopped  → record STOPPED (the VM really is off)
    * record RUNNING but no Nova row    → mark the record FAILED so the user sees it
    A missing Nova row is never treated as permission to delete a VM.
    """
    instance_id = record.get("instance_id")
    nova_status = str((live_nova or {}).get("status") or "").upper()
    if nova_status in ("SHUTOFF", "STOPPED"):
        target = "STOPPED"
    elif live_nova is None and record.get("active_nova_id"):
        target = "FAILED"
    else:
        log("REPAIR_SKIPPED", instance=instance_id, nova_status=nova_status)
        return None
    table = SESSION.client("dynamodb", config=CONFIG)
    try:
        table.update_item(
            TableName=INSTANCES, Key={"instance_id": {"S": instance_id}},
            UpdateExpression="SET current_status = :s, recovery_status = :c, "
                             "recovery_reason = :r, recovery_updated_at = :t",
            # Never overwrite a concurrent user action: the record must still be RUNNING.
            ConditionExpression="current_status = :expected",
            ExpressionAttributeValues={":s": {"S": target}, ":c": {"S": "REPAIRED"},
                                       ":r": {"S": reason[:900]}, ":expected": {"S": "RUNNING"},
                                       ":t": {"N": str(int(time.time()))}})
        log("REPAIRED", instance=instance_id, target=target, reason=reason)
        return {"instance_id": instance_id, "repaired_to": target}
    except Exception as error:  # noqa: BLE001 - a lost race is not an error worth failing on
        log("REPAIR_SKIPPED", instance=instance_id, error=str(error)[:200])
        return None


def summary(config, decisions, health=None, stopped=None, acted=None, repaired=None):
    counts = policy.summarize(decisions)
    return {"live": config["live"], "allowlist": sorted(config["allowlist"]),
            "health": health, "stopped": stopped, "decisions": counts,
            "acted": acted or [], "repaired": [r for r in (repaired or []) if r], "details": [
                {"instance_id": d[2].get("instance_id"), "decision": d[0], "reason": d[1]}
                for d in decisions]}

