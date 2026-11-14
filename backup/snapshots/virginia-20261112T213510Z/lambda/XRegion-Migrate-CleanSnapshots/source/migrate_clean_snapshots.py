"""Step 1: Clean pending snapshots in Sydney and Virginia before migration.
Theo SPEC-SF-08 và SPEC-03.
"""
import json
import logging
import os
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "ap-southeast-2")
DEST_REGION = os.environ.get("DEST_REGION", "us-east-1")


def clean_pending_snapshots(ec2_client, region_name, volume_id=None, instance_id=None):
    """Quét và xóa các snapshot đang ở trạng thái pending."""
    filters = [{"Name": "status", "Values": ["pending"]}]
    if volume_id:
        filters.append({"Name": "volume-id", "Values": [volume_id]})
    
    deleted = []
    try:
        resp = ec2_client.describe_snapshots(Filters=filters, OwnerIds=["self"])
        for snap in resp.get("Snapshots", []):
            snap_id = snap["SnapshotId"]
            logger.info("Phát hiện snapshot pending %s tại %s, tiến hành hủy bỏ...", snap_id, region_name)
            ec2_client.delete_snapshot(SnapshotId=snap_id)
            deleted.append(snap_id)
    except Exception as e:
        logger.warning("Lỗi khi quét/xóa snapshot pending tại %s: %s", region_name, e)
    return deleted


def lambda_handler(event, context):
    logger.info("Nhận sự kiện CleanPendingSnapshots: %s", json.dumps(event, default=str))
    instance_id = event.get("instance_id")
    volume_id = event.get("source_volume_id") or event.get("volume_id")
    source_region = event.get("source_region", SOURCE_REGION)
    dest_region = event.get("dest_region", DEST_REGION)

    ec2_src = boto3.client("ec2", region_name=source_region)
    ec2_dest = boto3.client("ec2", region_name=dest_region)

    cleaned_src = clean_pending_snapshots(ec2_src, source_region, volume_id, instance_id)
    cleaned_dest = clean_pending_snapshots(ec2_dest, dest_region, volume_id, instance_id)

    event["cleaned_source_snapshots"] = cleaned_src
    event["cleaned_dest_snapshots"] = cleaned_dest
    event["clean_snapshots_status"] = "COMPLETED"
    logger.info("Hoàn tất CleanPendingSnapshots: src=%s, dest=%s", cleaned_src, cleaned_dest)
    return event
