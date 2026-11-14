"""Compensating Rollback for MigrateInstance (SPEC-SF-08 v1.2.0)."""
import json
import logging
import os
import time
import boto3
import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "us-east-1")
DEST_REGION = os.environ.get("DEST_REGION", "ap-southeast-2")


def _start_source_vm(nova_id):
    if not nova_id:
        return "SKIPPED"
    try:
        runtime.os_api("NOVA", f"/servers/{nova_id}/action", "POST", {"os-start": None})
        return "STARTED"
    except Exception as e:
        logger.warning("os-start failed for %s: %s", nova_id, e)
        return f"ERROR: {e}"


def _record_rollback(event, source_region):
    instance_id = event.get("instance_id")
    migration_id = event.get("migration_id")
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ddb = boto3.resource("dynamodb", region_name=source_region)

    if instance_id:
        ddb.Table("XRegion-Instances").update_item(
            Key={"instance_id": instance_id},
            UpdateExpression="SET current_status = :act, current_region = :reg, migration_lock = :lock, updated_at = :now",
            ExpressionAttributeValues={
                ":act": "ACTIVE",
                ":reg": source_region,
                ":lock": False,
                ":now": now_iso,
            },
        )
    if instance_id and migration_id:
        err_msg = json.dumps(event.get("error", event.get("failure_reason", "Migration failed")), default=str)[:500]
        ddb.Table("XRegion-Migrations").update_item(
            Key={"instance_id": instance_id, "migration_id": migration_id},
            UpdateExpression="SET #s = :failed, failure_reason = :reason, updated_at = :now",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":failed": "FAILED", ":reason": err_msg, ":now": now_iso},
        )
    return "RECORDED"


def lambda_handler(event, context):
    payload = dict(event.get("detail", event))
    action = payload.get("action")
    source_region = payload.get("source_region") or SOURCE_REGION
    dest_region = payload.get("dest_region") or DEST_REGION
    nova_id = payload.get("source_nova_id") or payload.get("nova_id")

    if action == "delete_dest_snapshot":
        snap_id = payload.get("dest_snapshot_id")
        if snap_id:
            try:
                boto3.client("ec2", region_name=dest_region).delete_snapshot(SnapshotId=snap_id)
            except Exception as e:
                logger.warning("Failed deleting dest snapshot %s: %s", snap_id, e)
        return payload

    if action == "delete_source_snapshot":
        snap_id = payload.get("source_snapshot_id")
        if snap_id:
            try:
                boto3.client("ec2", region_name=source_region).delete_snapshot(SnapshotId=snap_id)
            except Exception as e:
                logger.warning("Failed deleting source snapshot %s: %s", snap_id, e)
        return payload

    if action == "start_source_vm":
        payload["source_vm_rollback"] = _start_source_vm(nova_id)
        return payload

    if action == "record_rollback_result":
        payload["rollback_recorded"] = _record_rollback(payload, source_region)
        return payload

    # Direct EventBridge trigger from MigrateTargetBoot Tier-2 rollback (instance.migration.rollback)
    payload["source_vm_rollback"] = _start_source_vm(nova_id)
    payload["rollback_recorded"] = _record_rollback(payload, source_region)
    return payload
