"""Step 5: Sync DynamoDB upon success, or Rollback (restart Sydney instance and clean Virginia) upon failure.
Theo SPEC-SF-08 và SPEC-03.
"""
import json
import logging
import os
import time
import boto3

import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "ap-southeast-2")
DEST_REGION = os.environ.get("DEST_REGION", "us-east-1")
INSTANCES_TABLE = "XRegion-Instances"
MIGRATIONS_TABLE = "XRegion-Migrations"


def sync_dynamodb(event):
    """Cập nhật DynamoDB khi di trú thành công sang Virginia."""
    now = int(time.time())
    instance_id = event["instance_id"]
    dest_vol_id = event.get("dest_volume_id")
    dest_nova_id = event.get("dest_nova_id")
    dest_region = event.get("dest_region", DEST_REGION)
    mig_id = event.get("migration_id", f"mig-{now}")

    ddb = boto3.resource("dynamodb", region_name=SOURCE_REGION)
    inst_table = ddb.Table(INSTANCES_TABLE)
    mig_table = ddb.Table(MIGRATIONS_TABLE)

    # 1. Cập nhật Instance sang Virginia
    inst_table.update_item(
        Key={"instance_id": instance_id},
        UpdateExpression="SET #r = :dest_reg, #s = :running, ebs_volume_id = :vol, nova_id = :nova, updated_at = :now",
        ExpressionAttributeNames={"#r": "region", "#s": "status"},
        ExpressionAttributeValues={
            ":dest_reg": dest_region,
            ":running": "RUNNING",
            ":vol": dest_vol_id,
            ":nova": dest_nova_id,
            ":now": now
        }
    )
    logger.info("Đã cập nhật DynamoDB XRegion-Instances sang region=%s, status=RUNNING", dest_region)

    # 2. Cập nhật Migrations table
    try:
        mig_table.update_item(
            Key={"migration_id": mig_id},
            UpdateExpression="SET #s = :comp, completed_at = :now, progress_percent = :pct",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":comp": "COMPLETED", ":now": now, ":pct": 100}
        )
    except Exception as e:
        logger.warning("Không thể cập nhật XRegion-Migrations: %s", e)

    event["status"] = "COMPLETED"
    event["completed_at"] = now
    return event


def rollback_migration(event):
    """Xử lý rollback khi có lỗi: dọn dẹp Virginia, bật lại Sydney về RUNNING."""
    now = int(time.time())
    logger.warning("Bắt đầu quy trình Rollback di trú: %s", json.dumps(event, default=str))

    instance_id = event.get("instance_id")
    nova_id = event.get("nova_id")
    dest_vol_id = event.get("dest_volume_id")
    dest_snap_id = event.get("dest_snapshot_id")
    mig_id = event.get("migration_id", f"mig-{now}")
    dest_region = event.get("dest_region", DEST_REGION)

    ec2_dest = boto3.client("ec2", region_name=dest_region)

    # 1. Dọn dẹp volume dở dang tại Virginia
    if dest_vol_id:
        try:
            logger.info("Rollback: Xóa volume dở dang %s tại %s", dest_vol_id, dest_region)
            ec2_dest.delete_volume(VolumeId=dest_vol_id)
        except Exception as e:
            logger.warning("Rollback xóa volume lỗi: %s", e)

    # 2. Dọn dẹp snapshot dở dang tại Virginia
    if dest_snap_id:
        try:
            logger.info("Rollback: Xóa snapshot dở dang %s tại %s", dest_snap_id, dest_region)
            ec2_dest.delete_snapshot(SnapshotId=dest_snap_id)
        except Exception as e:
            logger.warning("Rollback xóa snapshot lỗi: %s", e)

    # 3. Bật lại Source VM tại Sydney về RUNNING (os-start)
    if nova_id:
        try:
            logger.info("Rollback: Gửi os-start bật lại Source VM %s tại Sydney", nova_id)
            runtime.os_api("NOVA", f"/servers/{nova_id}/action", "POST", {"os-start": None})
        except Exception as e:
            logger.warning("Rollback gửi os-start lỗi: %s", e)

    # 4. Cập nhật DynamoDB phục hồi trạng thái RUNNING tại Sydney
    ddb = boto3.resource("dynamodb", region_name=SOURCE_REGION)
    inst_table = ddb.Table(INSTANCES_TABLE)
    mig_table = ddb.Table(MIGRATIONS_TABLE)

    if instance_id:
        try:
            inst_table.update_item(
                Key={"instance_id": instance_id},
                UpdateExpression="SET #r = :src_reg, #s = :running, updated_at = :now",
                ExpressionAttributeNames={"#r": "region", "#s": "status"},
                ExpressionAttributeValues={":src_reg": SOURCE_REGION, ":running": "RUNNING", ":now": now}
            )
            logger.info("Rollback: Đã hoàn nguyên instance %s về RUNNING tại %s", instance_id, SOURCE_REGION)
        except Exception as e:
            logger.error("Lỗi hoàn nguyên DynamoDB: %s", e)

    # 5. Ghi nhận Migration FAILED
    try:
        mig_table.update_item(
            Key={"migration_id": mig_id},
            UpdateExpression="SET #s = :failed, failed_at = :now, error_detail = :err",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":failed": "FAILED", ":now": now, ":err": str(event.get("error", "Unknown error"))}
        )
    except Exception as e:
        logger.warning("Không thể ghi nhận FAILED vào XRegion-Migrations: %s", e)

    event["status"] = "ROLLED_BACK"
    event["rollback_at"] = now
    return event


def sync_handler(event, context):
    logger.info("Nhận sự kiện SyncDynamoDB: %s", json.dumps(event, default=str))
    return sync_dynamodb(event)


def rollback_handler(event, context):
    logger.info("Nhận sự kiện RollbackMigration: %s", json.dumps(event, default=str))
    return rollback_migration(event)
