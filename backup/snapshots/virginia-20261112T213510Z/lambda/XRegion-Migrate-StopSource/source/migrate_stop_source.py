"""Step 2: Stop source Nova instance at Sydney and set status to MIGRATING.
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
DDB_TABLE = "XRegion-Instances"


def stop_source_instance(instance_id, nova_id=None):
    """Gửi os-stop tới Nova Sydney và chờ máy chuyển sang SHUTOFF."""
    ddb = boto3.resource("dynamodb", region_name=SOURCE_REGION)
    table = ddb.Table(DDB_TABLE)

    # 1. Lấy thông tin instance từ DynamoDB nếu chưa có nova_id
    if not nova_id:
        resp = table.get_item(Key={"instance_id": instance_id})
        item = resp.get("Item", {})
        nova_id = item.get("nova_id")
        volume_id = item.get("ebs_volume_id") or item.get("volume_id")
    else:
        volume_id = None

    if not nova_id:
        raise ValueError(f"Không tìm thấy nova_id cho instance {instance_id}")

    # 2. Cập nhật DynamoDB sang MIGRATING
    table.update_item(
        Key={"instance_id": instance_id},
        UpdateExpression="SET #s = :migrating, updated_at = :now",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":migrating": "MIGRATING", ":now": int(time.time())}
    )
    logger.info("Đã đánh dấu instance %s trạng thái MIGRATING trong DynamoDB", instance_id)

    # 3. Gửi lệnh os-stop qua Nova API
    try:
        runtime.os_api("NOVA", f"/servers/{nova_id}/action", "POST", {"os-stop": None})
        logger.info("Đã gửi os-stop tới Nova server %s", nova_id)
    except Exception as e:
        logger.warning("Lỗi gửi os-stop tới Nova: %s (có thể máy đã tắt)", e)

    # 4. Polling chờ server chuyển sang SHUTOFF
    for attempt in range(1, 31):
        try:
            srv = runtime.os_api("NOVA", f"/servers/{nova_id}").get("server", {})
            st = srv.get("status")
            logger.info("Polling Nova server %s status: %s (attempt %s/30)", nova_id, st, attempt)
            if st == "SHUTOFF":
                break
        except Exception as e:
            logger.warning("Lỗi polling Nova status: %s", e)
        time.sleep(2)

    return nova_id, volume_id


def lambda_handler(event, context):
    logger.info("Nhận sự kiện StopSourceInstance: %s", json.dumps(event, default=str))
    instance_id = event.get("instance_id")
    nova_id = event.get("nova_id")

    nova_id, vol_id = stop_source_instance(instance_id, nova_id)

    event["nova_id"] = nova_id
    if vol_id and not event.get("source_volume_id"):
        event["source_volume_id"] = vol_id
    event["source_status"] = "STOPPED"
    logger.info("Hoàn tất StopSourceInstance: nova_id=%s, volume_id=%s", nova_id, event.get("source_volume_id"))
    return event
