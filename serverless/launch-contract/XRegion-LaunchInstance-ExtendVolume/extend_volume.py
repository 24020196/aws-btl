"""Asynchronous extension; GET is the completion proof for one owned boot volume."""
import time
import uuid
from boto3.dynamodb.conditions import Attr
import network_runtime as runtime


def lambda_handler(event, context):
    event = dict(event)
    key, vid = event["cinder_volume_key"], str(uuid.UUID(event["cinder_volume_id"]))
    rid, iid = event["reservation_id"], event["instance_id"]
    target = event["size_gb"]
    if isinstance(target, bool) or not isinstance(target, int) or target < 1:
        raise ValueError("size_gb must be a positive integer")
    owner = runtime.get("XRegion-Instances", "instance_id", iid) or {}
    reservation = runtime.lease(event) or {}
    record = runtime.get("XRegion-Volumes", "volume_id", key) or {}
    if (owner.get("launch_execution_arn") != rid or
            reservation.get("cinder_volume_key") != key or reservation.get("cinder_volume_id") != vid or
            record.get("cinder_volume_id") != vid or record.get("lease_instance_id") != iid or
            record.get("status") != "ALLOCATED" or record.get("image_id") != event["image_id"]):
        raise ValueError("Volume extension ownership mismatch")
    condition = (Attr("cinder_volume_id").eq(vid) & Attr("lease_instance_id").eq(iid) &
                 Attr("status").eq("ALLOCATED") & Attr("image_id").eq(event["image_id"]))
    table = runtime.DDB.Table("XRegion-Volumes")
    generation = record.get("extend_reservation_id")
    if generation and (generation != rid or record.get("extend_target_gb") != target):
        raise ValueError("Conflicting volume extension")
    deadline = record.get("extend_deadline_at")
    if deadline is None:
        deadline = int(time.time()) + 300
        table.update_item(Key={"volume_id": key},
            UpdateExpression="SET extend_reservation_id=:u0, extend_target_gb=:u1, extend_deadline_at=:u2",
            ConditionExpression=condition & Attr("extend_reservation_id").not_exists(),
            ExpressionAttributeValues={":u0": rid, ":u1": target, ":u2": deadline})
    if int(time.time()) >= deadline:
        raise TimeoutError("Volume extension deadline exceeded")
    project = runtime.os.environ["OS_PROJECT_ID"]
    uuid.UUID(project)
    path = "/" + project + "/volumes/" + vid
    volume = runtime.os_api("CINDER", path)["volume"]
    if (volume.get("id") != vid or volume.get("attachments") or
            volume.get("volume_image_metadata", {}).get("image_id") != event["image_id"] or
            str(volume.get("bootable")).lower() != "true"):
        raise ValueError("Cinder volume identity or attachment mismatch")
    state, size = volume.get("status"), volume.get("size")
    if state not in ("available", "extending") or not isinstance(size, int):
        raise RuntimeError("Cinder extension failed: " + str(state))
    if state == "available" and size >= target:
        if record.get("storage_backend") == "aws-ebs":
            runtime.validate_ebs_mapping(record, volume)
        table.update_item(Key={"volume_id": key},
            UpdateExpression="SET size_gb=:u0, extend_status=:u1",
            ConditionExpression=condition & Attr("extend_reservation_id").eq(rid) & Attr("extend_target_gb").eq(target),
            ExpressionAttributeValues={":u0": size, ":u1": "CONFIRMED"})
        return dict(event, volume_extension=dict(status="CONFIRMED", deadline_at=deadline,
                    cinder_volume_key=key, cinder_volume_id=vid, actual_size_gb=size))
    if state == "available" and not record.get("extend_post_attempted"):
        # Persist before POST: a timeout must not cause an unconditional second POST.
        table.update_item(Key={"volume_id": key}, UpdateExpression="SET extend_post_attempted=:u0",
            ConditionExpression=condition & Attr("extend_reservation_id").eq(rid) & Attr("extend_post_attempted").not_exists(),
            ExpressionAttributeValues={":u0": True})
        runtime.os_api("CINDER", path + "/action", "POST", {"os-extend": {"new_size": target}})
    return dict(event, volume_extension=dict(status="PENDING", deadline_at=deadline,
                cinder_volume_key=key, cinder_volume_id=vid, actual_size_gb=size))
