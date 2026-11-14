"""Step 3 of MigrateInstance: Non-blocking Start/Check for Snapshot & Cross-Region Copy (SPEC-SF-08 v1.2.0)."""
import json
import logging
import os
import time
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


def lambda_handler(event, context):
    action = event.get("action") or "start_source_snapshot"
    instance_id = event["instance_id"]
    source_region = event.get("source_region") or SOURCE_REGION
    dest_region = event.get("dest_region") or DEST_REGION
    raw_vol = event.get("ebs_volume_id") or event.get("source_volume_id") or event.get("volume_id")
    volume_id = _resolve_ebs_volume_id(instance_id, raw_vol, source_region)
    event["source_volume_id"] = volume_id
    event["ebs_volume_id"] = volume_id

    short_inst = instance_id[:8] if len(instance_id) >= 8 else instance_id
    now = int(time.time())

    ec2_src = boto3.client("ec2", region_name=source_region)
    ec2_dest = boto3.client("ec2", region_name=dest_region)

    if action == "start_source_snapshot":
        snap = ec2_src.create_snapshot(
            VolumeId=volume_id,
            Description=f"Migration snapshot for {instance_id} volume {volume_id}",
            TagSpecifications=[{
                "ResourceType": "snapshot",
                "Tags": [
                    {"Key": "Project", "Value": "xregion"},
                    {"Key": "ManagedBy", "Value": "XRegion-Migrate"},
                    {"Key": "InstanceId", "Value": instance_id},
                    {"Key": "VolumeId", "Value": volume_id},
                    {"Key": "Name", "Value": f"mig-src-{short_inst}-{now}"},
                ],
            }],
        )
        event["source_snapshot_id"] = snap["SnapshotId"]
        event["source_snapshot_status"] = snap.get("State", "pending")
        return event

    if action == "check_source_snapshot":
        snap_id = event["source_snapshot_id"]
        resp = ec2_src.describe_snapshots(SnapshotIds=[snap_id])
        state = resp["Snapshots"][0]["State"]
        if state == "error":
            raise RuntimeError(f"Source snapshot {snap_id} failed with state=error")
        event["source_snapshot_status"] = state
        return event

    if action == "start_copy_snapshot":
        src_snap_id = event["source_snapshot_id"]
        copy = ec2_dest.copy_snapshot(
            SourceRegion=source_region,
            SourceSnapshotId=src_snap_id,
            Description=f"Cross-region migration replica of {src_snap_id} for {instance_id}",
            DestinationRegion=dest_region,
            TagSpecifications=[{
                "ResourceType": "snapshot",
                "Tags": [
                    {"Key": "Project", "Value": "xregion"},
                    {"Key": "ManagedBy", "Value": "XRegion-Migrate"},
                    {"Key": "InstanceId", "Value": instance_id},
                    {"Key": "SourceSnapshotId", "Value": src_snap_id},
                    {"Key": "Name", "Value": f"mig-dest-{short_inst}-{now}"},
                ],
            }],
        )
        event["dest_snapshot_id"] = copy["SnapshotId"]
        event["dest_snapshot_status"] = "pending"
        return event

    if action == "check_copy_snapshot":
        dest_snap_id = event["dest_snapshot_id"]
        resp = ec2_dest.describe_snapshots(SnapshotIds=[dest_snap_id])
        state = resp["Snapshots"][0]["State"]
        if state == "error":
            raise RuntimeError(f"Destination snapshot copy {dest_snap_id} failed with state=error")
        event["dest_snapshot_status"] = state
        return event

    raise ValueError(f"Unsupported CreateAndCopy action: {action}")