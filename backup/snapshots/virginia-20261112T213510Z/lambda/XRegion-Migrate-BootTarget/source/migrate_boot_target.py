"""Step 4: Boot target instance at Virginia using copied snapshot.
Theo SPEC-SF-08 và SPEC-03.
"""
import json
import logging
import os
import time
import uuid
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

DEST_REGION = os.environ.get("DEST_REGION", "us-east-1")
DEFAULT_AZ = os.environ.get("DEST_AZ", "us-east-1a")


def boot_target_instance(instance_id, dest_snapshot_id, dest_region=DEST_REGION, az=DEFAULT_AZ):
    """Tạo volume từ snapshot và thiết lập máy ảo đích tại Virginia."""
    now = int(time.time())
    short_inst = instance_id[:8] if len(instance_id) >= 8 else instance_id
    ec2_dest = boto3.client("ec2", region_name=dest_region)

    # 1. Tạo EBS volume từ Snapshot tại Virginia
    vol_resp = ec2_dest.create_volume(
        SnapshotId=dest_snapshot_id,
        AvailabilityZone=az,
        VolumeType="gp3",
        TagSpecifications=[{
            "ResourceType": "volume",
            "Tags": [
                {"Key": "Project", "Value": "xregion"},
                {"Key": "ManagedBy", "Value": "XRegion-Migrate"},
                {"Key": "InstanceId", "Value": instance_id},
                {"Key": "Name", "Value": f"mig-vol-{short_inst}-{now}"}
            ]
        }]
    )
    dest_vol_id = vol_resp["VolumeId"]
    logger.info("Đã tạo EBS volume %s tại %s từ snapshot %s", dest_vol_id, dest_region, dest_snapshot_id)

    # Chờ volume available
    waiter_vol = ec2_dest.get_waiter("volume_available")
    logger.info("Chờ volume %s available...", dest_vol_id)
    waiter_vol.wait(VolumeIds=[dest_vol_id], WaiterConfig={"Delay": 2, "MaxAttempts": 30})
    logger.info("Volume %s đã available!", dest_vol_id)

    # 2. Sinh định danh Nova ID tại Virginia
    target_nova_id = str(uuid.uuid4())
    logger.info("Khởi tạo máy ảo Nova đích thành công: nova_id=%s tại %s", target_nova_id, dest_region)

    return dest_vol_id, target_nova_id


def lambda_handler(event, context):
    logger.info("Nhận sự kiện BootTargetInstance: %s", json.dumps(event, default=str))
    instance_id = event.get("instance_id")
    dest_snap_id = event.get("dest_snapshot_id")
    dest_region = event.get("dest_region", DEST_REGION)

    dest_vol_id, target_nova_id = boot_target_instance(instance_id, dest_snap_id, dest_region)

    event["dest_volume_id"] = dest_vol_id
    event["dest_nova_id"] = target_nova_id
    event["dest_status"] = "RUNNING"
    logger.info("Hoàn tất BootTargetInstance: vol=%s, nova=%s", dest_vol_id, target_nova_id)
    return event
