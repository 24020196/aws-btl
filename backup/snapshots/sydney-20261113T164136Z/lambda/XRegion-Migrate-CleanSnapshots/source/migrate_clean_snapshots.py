"""Step 1 of MigrateInstance: Clean pending snapshots in both regions (SPEC-SF-08 v1.2.0)."""
import json
import logging
import os
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "us-east-1")
DEST_REGION = os.environ.get("DEST_REGION", "ap-southeast-2")


def _resolve_ebs_volume_id(instance_id, cand, source_region):
    if cand and str(cand).startswith("vol-"):
        return str(cand)
    for reg in dict.fromkeys([source_region, "ap-southeast-2", "us-east-1"]):
        try:
            ddb = boto3.resource("dynamodb", region_name=reg)
            item = ddb.Table("XRegion-Instances").get_item(Key={"instance_id": instance_id}).get("Item") or {}
            ebs_id = item.get("ebs_volume_id")
            if ebs_id and str(ebs_id).startswith("vol-"):
                return str(ebs_id)
        except Exception:
            pass
    return cand


def clean_pending_snapshots(ec2_client, region_name, volume_id=None):
    filters = [{"Name": "status", "Values": ["pending"]}]
    if volume_id and str(volume_id).startswith("vol-"):
        filters.append({"Name": "volume-id", "Values": [volume_id]})
    deleted = []
    try:
        resp = ec2_client.describe_snapshots(Filters=filters, OwnerIds=["self"])
        for snap in resp.get("Snapshots", []):
            snap_id = snap["SnapshotId"]
            logger.info("Deleting pending snapshot %s in %s", snap_id, region_name)
            ec2_client.delete_snapshot(SnapshotId=snap_id)
            deleted.append(snap_id)
    except Exception as e:
        logger.warning("Failed scanning/deleting pending snapshots in %s: %s", region_name, e)
    return deleted


def lambda_handler(event, context):
    logger.info("CleanPendingSnapshots input: %s", json.dumps(event, default=str))
    execution_arn = event.get("execution_arn")
    payload = dict(event.get("request", event))
    if isinstance(payload.get("detail"), dict):
        payload = dict(payload["detail"])
    if execution_arn and "execution_arn" not in payload:
        payload["execution_arn"] = execution_arn

    source_region = payload.get("source_region") or SOURCE_REGION
    dest_region = payload.get("dest_region") or DEST_REGION
    instance_id = payload.get("instance_id", "")
    raw_vol = payload.get("ebs_volume_id") or payload.get("source_volume_id") or payload.get("volume_id")
    volume_id = _resolve_ebs_volume_id(instance_id, raw_vol, source_region)

    payload["source_region"] = source_region
    payload["dest_region"] = dest_region
    if volume_id and str(volume_id).startswith("vol-"):
        payload["ebs_volume_id"] = volume_id
        payload["source_volume_id"] = volume_id

    ec2_src = boto3.client("ec2", region_name=source_region)
    ec2_dest = boto3.client("ec2", region_name=dest_region)

    payload["cleaned_source_snapshots"] = clean_pending_snapshots(ec2_src, source_region, volume_id)
    payload["cleaned_dest_snapshots"] = clean_pending_snapshots(ec2_dest, dest_region, None)
    payload["clean_snapshots_status"] = "COMPLETED"
    return payload