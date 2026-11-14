"""Cross-region snapshot replication Lambda theo SPEC-SF-07 v1.1.0.

Kích hoạt định kỳ mỗi 30 phút (phút 15 và 45) qua EventBridge.
Quét snapshot completed tại Sydney (ap-southeast-2) do XRegion-ScheduledEbsSnapshot tạo ra.
Chống trùng lặp qua tag SourceSnapshotId tại Virginia (us-east-1).
Sao chép sang Virginia và xoay vòng giữ đúng 3 bản gần nhất (FIFO) tại Virginia.
"""
import json
import logging
import os
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "ap-southeast-2")
DESTINATION_REGION = os.environ.get("DESTINATION_REGION", "us-east-1")
SOURCE_MANAGED_BY = "XRegion-ScheduledEbsSnapshot"
COPY_MANAGED_BY = "XRegion-SnapshotCrossRegionCopy"
PROJECT_TAG = "xregion"
SNAPSHOT_RETENTION_LIMIT = 3  # SPEC-SF-07 v1.1.0: Giữ chính xác 3 bản gần nhất tại Virginia


def _tags_to_dict(tags):
    return {t.get("Key"): t.get("Value") for t in (tags or [])}


def purge_excess_destination_snapshots(ec2_dest, volume_id, limit=SNAPSHOT_RETENTION_LIMIT):
    """Xóa các bản snapshot cũ nhất tại vùng đích theo FIFO nếu số lượng snapshot > limit."""
    snaps_resp = ec2_dest.describe_snapshots(
        Filters=[
            {"Name": "tag:VolumeId", "Values": [volume_id]},
            {"Name": "tag:ManagedBy", "Values": [COPY_MANAGED_BY]}
        ],
        OwnerIds=["self"]
    )
    snapshots = snaps_resp.get("Snapshots", [])
    snapshots.sort(key=lambda s: s["StartTime"])
    deleted = []
    if len(snapshots) > limit:
        excess = snapshots[:len(snapshots) - limit]
        for ex in excess:
            snap_id = ex["SnapshotId"]
            logger.info("FIFO Purge Destination Snapshot %s tại %s (Volume %s, StartTime %s), lý do: vượt quá hạn mức %s bản",
                        snap_id, DESTINATION_REGION, volume_id, ex.get("StartTime"), limit)
            ec2_dest.delete_snapshot(SnapshotId=snap_id)
            deleted.append(snap_id)
    return deleted


def copy_snapshot_to_destination(ec2_dest, source_snap, now=None):
    """Gọi copy_snapshot sang vùng đích và gắn đầy đủ tag theo SPEC-SF-07 v1.1.0."""
    if now is None:
        now = int(time.time())

    src_snap_id = source_snap["SnapshotId"]
    tags = _tags_to_dict(source_snap.get("Tags", []))
    instance_id = tags.get("InstanceId", "unknown")
    volume_id = tags.get("VolumeId", source_snap.get("VolumeId", "unknown"))
    short_inst = instance_id[:8] if len(instance_id) >= 8 else instance_id

    desc = f"Cross-region replica of {src_snap_id} from {SOURCE_REGION} for {instance_id} volume {volume_id}"

    dest_tags = [
        {"Key": "Project", "Value": PROJECT_TAG},
        {"Key": "ManagedBy", "Value": COPY_MANAGED_BY},
        {"Key": "SourceRegion", "Value": SOURCE_REGION},
        {"Key": "SourceSnapshotId", "Value": src_snap_id},
        {"Key": "InstanceId", "Value": instance_id},
        {"Key": "VolumeId", "Value": volume_id},
        {"Key": "CreatedAt", "Value": tags.get("CreatedAt", str(now))},
        {"Key": "Name", "Value": f"replica-{short_inst}-{now}"}
    ]

    resp = ec2_dest.copy_snapshot(
        SourceRegion=SOURCE_REGION,
        SourceSnapshotId=src_snap_id,
        Description=desc,
        DestinationRegion=DESTINATION_REGION,
        TagSpecifications=[{
            "ResourceType": "snapshot",
            "Tags": dest_tags
        }]
    )
    new_snap_id = resp["SnapshotId"]
    logger.info("Đã bắt đầu sao chép snapshot %s sang %s với ID mới %s", src_snap_id, DESTINATION_REGION, new_snap_id)
    return new_snap_id, volume_id


def process_cross_region_copy(ec2_src=None, ec2_dest=None):
    """Quét snapshot tại Sydney, lọc bản completed chưa copy, sao chép sang Virginia và xoay vòng FIFO."""
    now = int(time.time())
    if ec2_src is None:
        ec2_src = boto3.client("ec2", region_name=SOURCE_REGION)
    if ec2_dest is None:
        ec2_dest = boto3.client("ec2", region_name=DESTINATION_REGION)

    # 1. Quét snapshot nguồn tại Sydney (completed & do ScheduledEbsSnapshot tạo)
    src_snaps_resp = ec2_src.describe_snapshots(
        Filters=[
            {"Name": "status", "Values": ["completed"]},
            {"Name": "tag:ManagedBy", "Values": [SOURCE_MANAGED_BY]}
        ],
        OwnerIds=["self"]
    )
    src_snapshots = src_snaps_resp.get("Snapshots", [])
    logger.info("Tìm thấy %s snapshot hoàn tất (completed) tại nguồn %s", len(src_snapshots), SOURCE_REGION)

    # 2. Quét snapshot đã sao chép tại Virginia để lấy danh sách SourceSnapshotId
    dest_snaps_resp = ec2_dest.describe_snapshots(
        Filters=[
            {"Name": "tag:ManagedBy", "Values": [COPY_MANAGED_BY]}
        ],
        OwnerIds=["self"]
    )
    existing_dest_snaps = dest_snaps_resp.get("Snapshots", [])
    already_copied_source_ids = set()
    for s in existing_dest_snaps:
        t = _tags_to_dict(s.get("Tags", []))
        if t.get("SourceSnapshotId"):
            already_copied_source_ids.add(t["SourceSnapshotId"])

    logger.info("Đã có %s snapshot nguồn đã được sao chép sang %s từ trước", len(already_copied_source_ids), DESTINATION_REGION)

    results = []
    # 3. Lọc và thực hiện sao chép các snapshot chưa được copy
    for snap in src_snapshots:
        snap_id = snap["SnapshotId"]
        if snap_id in already_copied_source_ids:
            continue

        new_snap_id, volume_id = copy_snapshot_to_destination(ec2_dest, snap, now)
        purged = purge_excess_destination_snapshots(ec2_dest, volume_id, limit=SNAPSHOT_RETENTION_LIMIT)

        results.append({
            "source_snapshot_id": snap_id,
            "destination_snapshot_id": new_snap_id,
            "volume_id": volume_id,
            "purged_snapshots_at_destination": purged
        })

    return {
        "status": "COMPLETED",
        "source_snapshots_found": len(src_snapshots),
        "newly_copied_count": len(results),
        "details": results,
        "timestamp": now
    }


def lambda_handler(event, context):
    logger.info("Bắt đầu thực thi Cross-Region Snapshot Copy: %s", json.dumps(event, default=str))
    res = process_cross_region_copy()
    logger.info("Kết quả Cross-Region Snapshot Copy: %s", json.dumps(res, default=str))
    return res
