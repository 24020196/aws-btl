"""Lifecycle worker for the LifecycleInstance state machine (SPEC-SF-06).

Why this module exists
----------------------
`XRegion-NovaLifecycleManager` wrote `SHUTOFF`/`ACTIVE` into DynamoDB as soon as Nova
accepted the action request (HTTP 202), so the database could claim a state the VM had not
reached yet. This worker never writes a final status on the strength of an accepted action:
the state machine polls Nova and calls ``mode=SYNC`` only after observing the target state.

Modes (all invoked from the ASL, never directly by EventBridge):
* ``LOAD``     - read the instance, verify the intent status, detect duplicates
* ``DISPATCH`` - send ``os-stop``/``os-start``/``reboot`` (409 + already-there is success)
* ``STATUS``   - read Nova, track whether a transition was seen
* ``SYNC``     - write Nova + Instances with conditional expressions

SPEC-01: STOP uses only ``os-stop`` and START only ``os-start``; shelve/unshelve are banned.
"""
import json
import os
import time
import urllib.error
import urllib.request

import boto3

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
KEYSTONE_URL = os.environ.get("KEYSTONE_URL", "")
NOVA_URL = os.environ.get("NOVA_URL", "")
OS_USERNAME = os.environ.get("OS_USERNAME", "admin")
OS_PASSWORD = os.environ.get("OS_PASSWORD")
OS_PROJECT_NAME = os.environ.get("OS_PROJECT_NAME", "service")
OS_USER_DOMAIN = os.environ.get("OS_USER_DOMAIN", "Default")
OS_PROJECT_DOMAIN = os.environ.get("OS_PROJECT_DOMAIN", "Default")

INSTANCES = os.environ.get("XREGION_INSTANCES_TABLE", "XRegion-Instances")
NOVA_TABLE = os.environ.get("XREGION_NOVA_TABLE", "XRegion-Nova")

INTENT = {"STOP": "STOPPING", "START": "STARTING", "REBOOT": "REBOOTING"}
TARGET = {"STOP": {"SHUTOFF", "STOPPED"}, "START": {"ACTIVE"}, "REBOOT": {"ACTIVE"}}
SHELVED_STATES = {"SHELVED", "SHELVED_OFFLOADED"}

dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)


class LifecycleRejected(RuntimeError):
    """Business rule from SPEC-01/SPEC-SF-06 rejected the request."""


def request_json(method, url, token=None, payload=None, timeout=10):
    """Return ``(status_code, body)``; HTTP errors are returned, not raised (409 matters)."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Auth-Token"] = token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        return error.code, (json.loads(raw) if raw else {})


def keystone_token():
    if not OS_PASSWORD or not KEYSTONE_URL:
        raise LifecycleRejected("Thiếu OS_PASSWORD/KEYSTONE_URL trong cấu hình Lambda")
    payload = {"auth": {"identity": {"methods": ["password"], "password": {"user": {
        "name": OS_USERNAME, "domain": {"name": OS_USER_DOMAIN}, "password": OS_PASSWORD}}},
        "scope": {"project": {"name": OS_PROJECT_NAME, "domain": {"name": OS_PROJECT_DOMAIN}}}}}
    request = urllib.request.Request(
        KEYSTONE_URL.rstrip("/") + "/auth/tokens",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        token = response.headers.get("X-Subject-Token")
    if not token:
        raise LifecycleRejected("Keystone không trả X-Subject-Token")
    return token


def nova_status(token, nova_id):
    """Return the server projection, or ``None`` when Nova says 404."""
    code, body = request_json("GET", NOVA_URL.rstrip("/") + "/servers/" + str(nova_id), token)
    if code == 404:
        return None
    if code != 200:
        raise RuntimeError("Nova GET %s HTTP %s" % (nova_id, code))
    server = body.get("server") or {}
    return {"observed_status": str(server.get("status") or "").upper(),
            "task_state": server.get("OS-EXT-STS:task_state"),
            "vm_state": server.get("OS-EXT-STS:vm_state")}


def nova_action(token, nova_id, payload):
    return request_json("POST", NOVA_URL.rstrip("/") + "/servers/" + str(nova_id) + "/action",
                        token, payload)


def observed(context, projection):
    """Merge a Nova projection into the workflow payload under explicit field names."""
    projection = projection or {}
    return dict(context, observed_status=projection.get("observed_status") or "",
                task_state=projection.get("task_state"), vm_state=projection.get("vm_state"))


def plain(value):
    """DynamoDB AttributeValue -> plain Python (Decimal converted to int)."""
    from decimal import Decimal

    if isinstance(value, dict):
        if len(value) == 1:
            (kind, inner), = value.items()
            if kind == "S":
                return inner
            if kind == "N":
                return int(Decimal(str(inner)))
            if kind == "BOOL":
                return bool(inner)
            if kind == "NULL":
                return None
            if kind == "L":
                return [plain(item) for item in inner]
            if kind == "M":
                return {key: plain(item) for key, item in inner.items()}
            if kind == "SS":
                return set(inner)
            if kind == "NS":
                return {int(Decimal(str(number))) for number in inner}
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [plain(item) for item in value]
    return value


def get_item(table, key_name, key_value):
    response = dynamodb.get_item(TableName=table, Key={key_name: {"S": key_value}},
                                 ConsistentRead=True)
    item = response.get("Item")
    return plain(item) if item else None


def load(event):
    """Read the record, verify the intent status and detect duplicates (SPEC-SF-06 §5)."""
    action = str(event.get("action") or "").upper()
    instance_id = event.get("instance_id")
    if action not in INTENT:
        raise LifecycleRejected("Action không được hỗ trợ: %s" % (action or "(trống)"))
    if not instance_id:
        raise LifecycleRejected("Thiếu instance_id trong payload")

    record = get_item(INSTANCES, "instance_id", instance_id)
    if not record:
        raise LifecycleRejected("Không tìm thấy %s trong %s" % (instance_id, INSTANCES))

    status = str(record.get("current_status") or "").upper()
    context = dict(event, action=action, instance_id=instance_id,
                   intent_status=INTENT[action], previous_status=status,
                   saw_transition=bool(event.get("saw_transition")))
    if status != INTENT[action]:
        # A newer action (or a completed one) owns the record: never fight it.
        return dict(context, status="ALREADY_HANDLED", already_at_target=False,
                    reason="current_status=%s không phải %s" % (status or "?", INTENT[action]))

    nova_id = record.get("active_nova_id") or record.get("current_nova_id")
    if not nova_id:
        raise LifecycleRejected("%s chưa có active_nova_id" % instance_id)

    token = keystone_token()
    projection = nova_status(token, nova_id)
    if projection is None:
        raise LifecycleRejected("Nova không còn server %s (HTTP 404)" % nova_id)
    context = dict(context, nova_id=nova_id)
    if projection["observed_status"] == "ERROR":
        return observed(dict(context, status="FAILED", already_at_target=False,
                             reason="Nova ERROR"), projection)
    if action == "REBOOT":
        # Duplicate guard: a second reboot request must not reboot a running reboot.
        already = str(projection.get("task_state") or "").lower() == "rebooting"
    else:
        already = projection["observed_status"] in TARGET[action]
    return observed(dict(context, status="LOADED", already_at_target=already), projection)


def dispatch(event):
    """Send the single Nova action; an accepted-but-wrong result is never treated as success."""
    action = event["action"]
    nova_id = event["nova_id"]
    token = keystone_token()
    current = nova_status(token, nova_id)
    if current is None:
        raise LifecycleRejected("Nova không còn server %s (HTTP 404)" % nova_id)
    context = observed(event, current)
    status = current["observed_status"]
    task_state = str(current.get("task_state") or "").lower()

    if action == "STOP":
        if status in TARGET["STOP"]:
            return dict(context, status="OBSERVED", dispatched=False, saw_transition=True)
        code, _ = nova_action(token, nova_id, {"os-stop": None})
        if code not in (200, 202):
            after = nova_status(token, nova_id) or {}
            if code == 409 and after.get("observed_status") in TARGET["STOP"]:
                return dict(observed(context, after), status="OBSERVED", dispatched=False,
                            saw_transition=True)
            raise RuntimeError("Nova os-stop HTTP %s" % code)
        return dict(context, status="OBSERVED", dispatched=True, saw_transition=True)

    if action == "START":
        if status == "ACTIVE":
            return dict(context, status="OBSERVED", dispatched=False, saw_transition=True)
        if status in SHELVED_STATES:
            raise LifecycleRejected(
                "SPEC-01 cấm unshelve: VM %s đang %s, cần xử lý thủ công" % (nova_id, status))
        code, _ = nova_action(token, nova_id, {"os-start": None})
        if code not in (200, 202):
            after = nova_status(token, nova_id) or {}
            if code == 409 and after.get("observed_status") == "ACTIVE":
                return dict(observed(context, after), status="OBSERVED", dispatched=False,
                            saw_transition=True)
            raise RuntimeError("Nova os-start HTTP %s" % code)
        return dict(context, status="OBSERVED", dispatched=True, saw_transition=True)

    if action == "REBOOT":
        if task_state == "rebooting":
            return dict(context, status="OBSERVED", dispatched=False,
                        saw_transition=bool(event.get("saw_transition")))
        code, _ = nova_action(token, nova_id, {"reboot": {"type": "SOFT"}})
        if code not in (200, 202):
            raise RuntimeError("Nova reboot HTTP %s" % code)
        # No transition is claimed here: REBOOT only completes after STATUS observes one.
        return dict(context, status="OBSERVED", dispatched=True,
                    saw_transition=bool(event.get("saw_transition")))

    raise LifecycleRejected("Action không được hỗ trợ: %s" % action)


def status(event):
    """One Nova read; a transition is only claimed when it was actually observed."""
    token = keystone_token()
    projection = nova_status(token, event["nova_id"])
    if projection is None:
        return dict(event, status="REJECTED", observed_status="DELETED",
                    reason="Nova không còn server %s (HTTP 404)" % event["nova_id"])
    seen = (bool(event.get("saw_transition"))
            or projection["observed_status"] != "ACTIVE"
            or bool(projection.get("task_state")))
    return observed(dict(event, status="OBSERVED", saw_transition=seen), projection)


def sync(event):
    """Write the observed state; conditional writes keep newer user actions intact."""
    action = event["action"]
    instance_id = event["instance_id"]
    nova_id = event["nova_id"]
    intent = event["intent_status"]
    seen = str(event.get("observed_status") or "").upper()

    if action == "STOP":
        if seen not in TARGET["STOP"]:
            raise RuntimeError("SYNC STOP nhưng Nova đang %s" % (seen or "?"))
        instance_status, nova_status = "STOPPED", seen
    else:
        if seen != "ACTIVE":
            raise RuntimeError("SYNC %s nhưng Nova đang %s" % (action, seen or "?"))
        instance_status, nova_status = "RUNNING", "ACTIVE"

    # Nova first: a failed Nova write must block completing the instance record.
    dynamodb.update_item(
        TableName=NOVA_TABLE, Key={"nova_id": {"S": nova_id}},
        UpdateExpression="SET #s = :s",
        ConditionExpression="attribute_exists(nova_id)",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": nova_status}})

    try:
        dynamodb.update_item(
            TableName=INSTANCES, Key={"instance_id": {"S": instance_id}},
            UpdateExpression="SET current_status = :s, updated_at = :t",
            # Only the intent status this execution owns may be replaced.
            ConditionExpression="attribute_exists(instance_id) AND current_status = :intent",
            ExpressionAttributeValues={
                ":s": {"S": instance_status}, ":intent": {"S": intent},
                ":t": {"N": str(int(time.time()))}})
    except dynamodb.exceptions.ConditionalCheckFailedException:
        return dict(event, status="SKIPPED", instance_status=instance_status,
                    nova_status=nova_status,
                    reason="current_status không còn %s" % intent)
    return dict(event, status="SYNCED", instance_status=instance_status,
                nova_status=nova_status)


MODES = {"LOAD": load, "DISPATCH": dispatch, "STATUS": status, "SYNC": sync}


def lambda_handler(event, context):
    print("Received lifecycle event:", json.dumps(event, default=str))
    mode = str(event.get("mode") or "").upper()
    handler = MODES.get(mode)
    if handler is None:
        print("Lifecycle rejected: mode không hợp lệ: %s" % (mode or "(trống)"))
        return dict(event, status="REJECTED",
                    reason="mode không hợp lệ: %s" % (mode or "(trống)"))
    try:
        result = handler(event)
    except LifecycleRejected as error:
        print("Lifecycle rejected: %s" % error)
        return dict(event, status="REJECTED", reason=str(error))
    print("Lifecycle result:", json.dumps(
        {key: result.get(key) for key in
         ("status", "action", "observed_status", "already_at_target", "instance_status")},
        default=str))
    return result


