"""Step 2 of MigrateInstance: Stop Source Nova VM & mark MIGRATING (SPEC-SF-08 v1.2.0)."""
import json
import logging
import os
import time
import boto3
import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SOURCE_REGION = os.environ.get("SOURCE_REGION", "us-east-1")


def lambda_handler(event, context):
    logger.info("StopSourceInstance input: %s", json.dumps(event, default=str))
    instance_id = event["instance_id"]
    source_region = event.get("source_region") or SOURCE_REGION
    nova_id = event.get("source_nova_id") or event.get("nova_id")
    volume_id = event.get("ebs_volume_id") or event.get("source_volume_id") or event.get("volume_id")

    for reg in dict.fromkeys([source_region, "ap-southeast-2", "us-east-1"]):
        try:
            ddb = boto3.resource("dynamodb", region_name=reg)
            item = ddb.Table("XRegion-Instances").get_item(Key={"instance_id": instance_id}).get("Item") or {}
            if item:
                nova_id = nova_id or item.get("active_nova_id") or item.get("nova_id")
                ebs_id = item.get("ebs_volume_id")
                if ebs_id and str(ebs_id).startswith("vol-"):
                    volume_id = str(ebs_id)
                elif not volume_id:
                    volume_id = item.get("volume_id")
        except Exception:
            pass

    if not nova_id:
        raise ValueError(f"Missing nova_id/active_nova_id for instance {instance_id}")
    if not volume_id:
        raise ValueError(f"Missing source_volume_id for instance {instance_id}")

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for reg in dict.fromkeys([source_region, "ap-southeast-2"]):
        try:
            t = boto3.resource("dynamodb", region_name=reg).Table("XRegion-Instances")
            t.update_item(
                Key={"instance_id": instance_id},
                UpdateExpression="SET current_status = :migrating, updated_at = :now",
                ExpressionAttributeValues={":migrating": "MIGRATING", ":now": now_iso},
            )
        except Exception as e:
            logger.warning("Failed updating MIGRATING in %s: %s", reg, e)

    server_data = runtime.os_api("NOVA", f"/servers/{nova_id}", "GET").get("server", {})
    status = str(server_data.get("status", "")).upper()
    if status not in ("SHUTOFF", "STOPPED"):
        logger.info("Sending os-stop to Nova VM %s (current status=%s)", nova_id, status)
        runtime.os_api("NOVA", f"/servers/{nova_id}/action", "POST", {"os-stop": None})
        for _ in range(30):
            time.sleep(2)
            curr = runtime.os_api("NOVA", f"/servers/{nova_id}", "GET").get("server", {})
            curr_status = str(curr.get("status", "")).upper()
            if curr_status in ("SHUTOFF", "STOPPED"):
                break
            if curr_status == "ERROR":
                raise RuntimeError(f"Nova VM {nova_id} entered ERROR state during stop")
        else:
            raise TimeoutError(f"Timed out waiting for Nova VM {nova_id} to reach SHUTOFF")

    event["source_nova_id"] = nova_id
    event["nova_id"] = nova_id
    event["source_volume_id"] = volume_id
    event["ebs_volume_id"] = volume_id
    event["source_vm_stopped"] = True
    return event