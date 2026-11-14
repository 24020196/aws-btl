"""Scheduled EBS Snapshot Lambda theo SPEC-SF-07.

Kích hoạt định kỳ mỗi 30 phút (phút 00 và 30) qua EventBridge Rule XRegion-ScheduledEbsSnapshotRule.
Quét danh sách máy ảo ACTIVE từ Nova API trên host Sydney, lấy volume đính kèm,
gọi Cinder lấy provider_id (EBS vol-xxxx), tạo AWS snapshot và xoay vòng giữ đúng 3 snapshot gần nhất (FIFO).
"""
import json
import logging
import os
import time
import uuid

import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MANAGED_BY = "XRegion-ScheduledEbsSnapshot"
PROJECT_TAG = "xregion"
SNAPSHOT_RETENTION_LIMIT = 3  # SPEC-SF-07: Giữ chính xác 3 bản snapshot gần nhất


def purge_excess_snapshots(ec2_client, volume_id, limit=SNAPSHOT_RETENTION_LIMIT):
    """Xóa các bản snapshot cũ nhất theo FIFO nếu số lượng snapshot > limit."""
    snaps_resp = ec2_client.describe_snapshots(
        Filters=[
            {"Name": "volume-id", "Values": [volume_id]},
            {"Name": "tag:ManagedBy", "Values": [MANAGED_BY]}
        ],
        OwnerIds=["self"]
    )
    snapshots = snaps_resp.get("Snapshots", [])
    # Sắp xếp theo StartTime tăng dần (bản cũ nhất đứng đầu)
    snapshots.sort(key=lambda s: s["StartTime"])
    deleted = []
    if len(snapshots) > limit:
        excess = snapshots[:len(snapshots) - limit]
        for ex in excess:
            snap_id = ex["SnapshotId"]
            logger.info("FIFO Purge Snapshot %s (Volume %s, StartTime %s), lý do: vượt quá hạn mức %s bản",
                        snap_id, volume_id, ex.get("StartTime"), limit)
            ec2_client.delete_snapshot(SnapshotId=snap_id)
            deleted.append(snap_id)
    return deleted


def create_snapshot_for_volume(ec2_client, server_id, volume_id, now=None):
    """Chụp snapshot cho một EBS volume với đầy đủ tag chuẩn theo SPEC-SF-07."""
    if now is None:
        now = int(time.time())
    desc = f"Scheduled 30m snapshot for instance {server_id} volume {volume_id}"
    short_srv = server_id[:8] if len(server_id) >= 8 else server_id
    resp = ec2_client.create_snapshot(
        VolumeId=volume_id,
        Description=desc,
        TagSpecifications=[{
            "ResourceType": "snapshot",
            "Tags": [
                {"Key": "Project", "Value": PROJECT_TAG},
                {"Key": "ManagedBy", "Value": MANAGED_BY},
                {"Key": "InstanceId", "Value": server_id},
                {"Key": "VolumeId", "Value": volume_id},
                {"Key": "CreatedAt", "Value": str(now)},
                {"Key": "Name", "Value": f"snapshot-{short_srv}-{now}"}
            ]
        }]
    )
    snap_id = resp["SnapshotId"]
    logger.info("Đã tạo snapshot %s cho instance %s (Volume %s)", snap_id, server_id, volume_id)
    return snap_id


def process_scheduled_snapshots(context=None):
    """Quét Nova API và thực hiện chụp snapshot cho toàn bộ volume của các máy ảo ACTIVE."""
    now = int(time.time())
    project = str(uuid.UUID(os.environ["OS_PROJECT_ID"])).replace("-", "")

    # 1. Truy vấn toàn bộ server ACTIVE từ Nova API
    servers_resp = runtime.os_api("NOVA", "/servers/detail?status=ACTIVE")
    active_servers = servers_resp.get("servers", [])
    logger.info("Tìm thấy %s máy ảo ACTIVE trên Nova", len(active_servers))

    results = []
    ec2_client = runtime.EC2

    for srv in active_servers:
        srv_id = srv["id"]
        # Lấy danh sách volume attachments của server
        attach_resp = runtime.os_api("NOVA", f"/servers/{srv_id}/os-volume_attachments")
        attachments = attach_resp.get("volumeAttachments", [])

        for att in attachments:
            cinder_vol_id = att.get("volumeId")
            if not cinder_vol_id:
                continue

            # Lấy thông tin chi tiết từ Cinder để tìm AWS EBS provider_id
            cinder_vol = runtime.os_api("CINDER", f"/{project}/volumes/{cinder_vol_id}").get("volume", {})
            ebs_vol_id = cinder_vol.get("provider_id")

            if not ebs_vol_id or not ebs_vol_id.startswith("vol-"):
                logger.warning("Không tìm thấy AWS EBS provider_id hợp lệ cho Cinder volume %s", cinder_vol_id)
                continue

            # 2. Tạo Snapshot
            snap_id = create_snapshot_for_volume(ec2_client, srv_id, ebs_vol_id, now)

            # 3. Xoay vòng giữ đúng 3 snapshot gần nhất
            purged = purge_excess_snapshots(ec2_client, ebs_vol_id, limit=SNAPSHOT_RETENTION_LIMIT)

            results.append({
                "server_id": srv_id,
                "cinder_volume_id": cinder_vol_id,
                "ebs_volume_id": ebs_vol_id,
                "created_snapshot_id": snap_id,
                "purged_snapshots": purged
            })

    return {
        "status": "COMPLETED",
        "active_servers_count": len(active_servers),
        "snapshots_processed": len(results),
        "details": results,
        "timestamp": now
    }


def lambda_handler(event, context):
    logger.info("Bắt đầu thực thi Scheduled EBS Snapshot: %s", json.dumps(event, default=str))
    res = process_scheduled_snapshots(context)
    logger.info("Kết quả Scheduled EBS Snapshot: %s", json.dumps(res, default=str))
    return res
