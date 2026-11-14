import json
import os
import time
import urllib.error
import urllib.request
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import ClientError

REGION_NAME = os.environ.get("REGION_NAME", "ap-southeast-2")
SCENARIOS_TABLE_REGION = os.environ.get("SCENARIOS_TABLE_REGION", "ap-southeast-2")
EVENT_GATEWAY_URL = os.environ["EVENT_GATEWAY_URL"]
INSTANCES_TABLE = os.environ.get("INSTANCES_TABLE", "XRegion-Instances")
SCENARIOS_TABLE = os.environ.get("SCENARIOS_TABLE", "XRegion-MigrationScenarios")
MIGRATIONS_TABLE = os.environ.get("MIGRATIONS_TABLE", "XRegion-Migrations")
NOVA_TABLE = os.environ.get("NOVA_TABLE", "XRegion-Nova")

COOLDOWN_SECONDS = 300
ALLOWED_STATUSES = {"RUNNING", "ACTIVE", "STOPPED", "SHUTOFF"}
ALL_REGIONS = ("ap-southeast-2", "us-east-1")

dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
scenarios_ddb = boto3.resource("dynamodb", region_name=SCENARIOS_TABLE_REGION)
session = boto3.Session(region_name=REGION_NAME)


def _send_signed_event(payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = AWSRequest(
        method="POST",
        url=EVENT_GATEWAY_URL,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    creds = session.get_credentials().get_frozen_credentials()
    SigV4Auth(creds, "execute-api", REGION_NAME).add_auth(req)

    http_req = urllib.request.Request(
        EVENT_GATEWAY_URL,
        data=body,
        headers=dict(req.headers),
        method="POST",
    )
    with urllib.request.urlopen(http_req, timeout=15) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {"status": resp.status}


def _in_cooldown(instance_id: str, now_sec: int) -> bool:
    table = dynamodb.Table(MIGRATIONS_TABLE)
    resp = table.query(KeyConditionExpression=Key("instance_id").eq(instance_id))
    for item in resp.get("Items", []):
        if str(item.get("status", "")).upper() != "COMPLETED":
            continue
        completed = item.get("completed_at")
        if completed is None:
            continue
        try:
            comp_sec = int(completed)
            if comp_sec > 10_000_000_000:
                comp_sec //= 1000
            if now_sec - comp_sec < COOLDOWN_SECONDS:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _pause_scenario_and_schedules(scenario_id: str, instance_id: str, now_sec: int) -> None:
    try:
        scenarios_ddb.Table(SCENARIOS_TABLE).update_item(
            Key={"scenario_id": scenario_id},
            UpdateExpression="SET #s = :paused, updated_at = :ts",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":paused": "PAUSED", ":ts": now_sec},
        )
    except Exception as exc:
        print(f"WARN: failed to pause scenario {scenario_id}: {exc}")

    for reg in ALL_REGIONS:
        sched_name = f"xregion-mig-{instance_id}-{reg}"
        try:
            sched_client = boto3.client("scheduler", region_name=reg)
            existing = sched_client.get_schedule(Name=sched_name)
            kwargs = {
                "Name": sched_name,
                "ScheduleExpression": existing["ScheduleExpression"],
                "FlexibleTimeWindow": existing["FlexibleTimeWindow"],
                "Target": existing["Target"],
                "State": "DISABLED",
            }
            if existing.get("ScheduleExpressionTimezone"):
                kwargs["ScheduleExpressionTimezone"] = existing["ScheduleExpressionTimezone"]
            if existing.get("Description") is not None:
                kwargs["Description"] = existing["Description"]
            sched_client.update_schedule(**kwargs)
        except Exception as exc:
            print(f"WARN: failed to disable schedule {sched_name} in {reg}: {exc}")


def lambda_handler(event, context):
    instance_id = str((event or {}).get("instance_id") or "").strip()
    scenario_id = str((event or {}).get("scenario_id") or "").strip()
    expected_src = str((event or {}).get("expected_source_region") or "").strip()
    dest_region = str((event or {}).get("dest_region") or "").strip()

    if not instance_id or not scenario_id or not expected_src or not dest_region:
        return {"status": "SKIPPED", "reason": "missing_required_fields"}

    scen_resp = scenarios_ddb.Table(SCENARIOS_TABLE).get_item(Key={"scenario_id": scenario_id})
    scen = scen_resp.get("Item")
    if not scen or str(scen.get("status") or "").upper() != "ACTIVE":
        return {"status": "SKIPPED", "reason": "scenario_not_active"}

    inst_table = dynamodb.Table(INSTANCES_TABLE)
    inst = inst_table.get_item(Key={"instance_id": instance_id}).get("Item")
    if not inst:
        return {"status": "SKIPPED", "reason": "instance_not_found"}

    inst_region = str(inst.get("current_region") or inst.get("requested_region") or "").strip()
    if inst_region != expected_src:
        return {"status": "NOOP", "reason": "instance_in_other_region", "current_region": inst_region}

    cur_status = str(inst.get("current_status") or "").upper()
    if cur_status not in ALLOWED_STATUSES:
        return {"status": "SKIPPED", "reason": f"invalid_status_{cur_status}"}

    now_sec = int(time.time())
    if _in_cooldown(instance_id, now_sec):
        return {"status": "SKIPPED", "reason": "cooldown_active"}

    try:
        inst_table.update_item(
            Key={"instance_id": instance_id},
            UpdateExpression="SET migration_lock = :locked, current_status = :mig, last_migration_timestamp = :ts",
            ConditionExpression="attribute_exists(instance_id) AND (migration_lock = :unlocked OR attribute_not_exists(migration_lock))",
            ExpressionAttributeValues={
                ":locked": True,
                ":unlocked": False,
                ":mig": "MIGRATING",
                ":ts": now_sec,
            },
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return {"status": "SKIPPED", "reason": "migration_lock_held"}
        raise

    _pause_scenario_and_schedules(scenario_id, instance_id, now_sec)

    active_nova_id = str(inst.get("active_nova_id") or "").strip()
    source_volume_id = str(inst.get("ebs_volume_id") or "").strip()
    if active_nova_id:
        nova = dynamodb.Table(NOVA_TABLE).get_item(Key={"nova_id": active_nova_id}).get("Item")
        if nova:
            source_volume_id = str(nova.get("ebs_volume_id") or nova.get("volume_id") or source_volume_id).strip()

    migration_id = f"mig-{uuid.uuid4().hex[:8]}"
    dynamodb.Table(MIGRATIONS_TABLE).put_item(
        Item={
            "migration_id": migration_id,
            "instance_id": instance_id,
            "source_region": expected_src,
            "dest_region": dest_region,
            "status": "IN_PROGRESS",
            "current_step": "QUEUED",
            "copy_progress": 15,
            "started_at": now_sec,
            "triggered_by": f"scheduler:{scenario_id}",
        }
    )

    detail = {
        "migration_id": migration_id,
        "instance_id": instance_id,
        "source_region": expected_src,
        "dest_region": dest_region,
        "phase": "START",
        "status": "IN_PROGRESS",
        "progress_percent": 15,
        "requested_by": f"scheduler:{scenario_id}",
        "timestamp": int(time.time() * 1000),
    }
    if active_nova_id:
        detail["nova_id"] = active_nova_id
    if source_volume_id:
        detail["source_volume_id"] = source_volume_id

    gateway_resp = _send_signed_event(
        {
            "source": "xregion.backend.migration",
            "detailType": "Migration Lifecycle Event",
            "detail": detail,
        }
    )
    return {
        "status": "TRIGGERED",
        "migration_id": migration_id,
        "instance_id": instance_id,
        "source_region": expected_src,
        "dest_region": dest_region,
        "gateway_response": gateway_resp,
    }