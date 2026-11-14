"""Step 3: Create EBS snapshot at Sydney and copy to Virginia.
Theo SPEC-SF-08 và SPEC-03.
"""
import json
import logging
import os
import time
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "ap-southeast-2")
DEST_REGION = os.environ.get("DEST_REGION", "us-east-1")


def create_and_copy_snapshot(instance_id, volume_id, source_region=SOURCE_REGION, dest_region=DEST_REGION):
    """Chụp snapshot tại Sydney, chờ completed, rồi copy sang Virginia và chờ completed."""
    now = int(time.time())
    short_inst = instance_id[:8] if len(instance_id) >= 8 else instance_id
    ec2_src = boto3.client("ec2", region_name=source_region)
    ec2_dest = boto3.client("ec2", region_name=dest_region)

    # 1. Chụp snapshot tại nguồn (Sydney)
    desc = f"Migration snapshot for instance {instance_id} volume {volume_id}"
    snap_resp = ec2_src.create_snapshot(
        VolumeId=volume_id,
        Description=desc,
        TagSpecifications=[{
            "ResourceType": "snapshot",
            "Tags": [
                {"Key": "Project", "Value": "xregion"},
                {"Key": "ManagedBy", "Value": "XRegion-Migrate"},
                {"Key": "InstanceId", "Value": instance_id},
                {"Key": "VolumeId", "Value": volume_id},
                {"Key": "CreatedAt", "Value": str(now)},
                {"Key": "Name", "Value": f"mig-snap-{short_inst}-{now}"}
            ]
        }]
    )
    src_snap_id = snap_resp["SnapshotId"]
    logger.info("Đã tạo snapshot nguồn %s tại %s", src_snap_id, source_region)

    # Chờ snapshot nguồn completed
    waiter_src = ec2_src.get_waiter("snapshot_completed")
    logger.info("Chờ snapshot nguồn %s hoàn tất...", src_snap_id)
    waiter_src.wait(SnapshotIds=[src_snap_id], WaiterConfig={"Delay": 3, "MaxAttempts": 40})
    logger.info("Snapshot nguồn %s đã completed!", src_snap_id)

    # 2. Sao chép snapshot sang đích (Virginia)
    copy_desc = f"Cross-region migration replica of {src_snap_id} for {instance_id}"
    copy_resp = ec2_dest.copy_snapshot(
        SourceRegion=source_region,
        SourceSnapshotId=src_snap_id,
        Description=copy_desc,
        DestinationRegion=dest_region,
        TagSpecifications=[{
            "ResourceType": "snapshot",
            "Tags": [
                {"Key": "Project", "Value": "xregion"},
                {"Key": "ManagedBy", "Value": "XRegion-Migrate"},
                {"Key": "SourceRegion", "Value": source_region},
                {"Key": "SourceSnapshotId", "Value": src_snap_id},
                {"Key": "InstanceId", "Value": instance_id},
                {"Key": "VolumeId", "Value": volume_id},
                {"Key": "CreatedAt", "Value": str(now)},
                {"Key": "Name", "Value": f"mig-replica-{short_inst}-{now}"}
            ]
        }]
    )
    dest_snap_id = copy_resp["SnapshotId"]
    logger.info("Đã gửi lệnh copy snapshot %s sang %s (ID đích: %s)", src_snap_id, dest_region, dest_snap_id)

    # Chờ snapshot đích completed
    waiter_dest = ec2_dest.get_waiter("snapshot_completed")
    logger.info("Chờ snapshot đích %s tại %s hoàn tất...", dest_snap_id, dest_region)
    waiter_dest.wait(SnapshotIds=[dest_snap_id], WaiterConfig={"Delay": 3, "MaxAttempts": 60})
    logger.info("Snapshot đích %s đã completed!", dest_snap_id)

    return src_snap_id, dest_snap_id


def lambda_handler(event, context):
    logger.info("Nhận sự kiện CreateAndCopySnapshot: %s", json.dumps(event, default=str))
    instance_id = event.get("instance_id")
    volume_id = event.get("source_volume_id") or event.get("volume_id")
    source_region = event.get("source_region", SOURCE_REGION)
    dest_region = event.get("dest_region", DEST_REGION)

    src_snap, dest_snap = create_and_copy_snapshot(instance_id, volume_id, source_region, dest_region)

    event["source_snapshot_id"] = src_snap
    event["dest_snapshot_id"] = dest_snap
    event["snapshot_copy_status"] = "COMPLETED"
    logger.info("Hoàn tất CreateAndCopySnapshot: src=%s, dest=%s", src_snap, dest_snap)
    return event
