"""Dedicated Worker Lambda for MigrateSourceCleanup Step Function (SPEC-SF-09 v1.6.0)."""
import logging
import os
import time
import boto3
import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    runtime.TOKEN = None
    action = event.get("action")
    payload = dict(event.get("request", event))
    if isinstance(payload.get("detail"), dict):
        payload = dict(payload["detail"])

    source_nova_id = payload.get("source_nova_id") or payload.get("nova_id")
    if source_nova_id:
        payload["nova_id"] = source_nova_id
        payload["server_id"] = source_nova_id

    if action == "load":
        m = runtime.get(runtime.MAP, "nova_id", source_nova_id) if source_nova_id else None
        if not m:
            payload["has_mapping"] = False
            return payload
        r = runtime.get(runtime.RES, "resource_key", "LEASE#" + m["reservation_id"]) or {}
        merged = dict(runtime.carry(payload, r), **m)
        merged["nova_id"] = source_nova_id
        merged["server_id"] = source_nova_id
        merged["network_operation"] = "REMOVE"
        merged["has_mapping"] = (m.get("status") != "DELETED")
        return merged

    if action == "dispatch_nat_remove":
        return runtime.dispatch(dict(payload, network_operation="REMOVE"))

    if action == "check_nat":
        return runtime.check_command(payload)

    if action == "delete_nova":
        if not payload.get("nova_id") and not payload.get("server_id"):
            return payload
        if payload.get("network_mode") != runtime.MODE:
            payload["network_mode"] = runtime.MODE
        return runtime.delete_nova(payload)

    if action == "release_network":
        os.environ["NETWORK_STAGE"] = "Release"
        return runtime.release(dict(payload, release_operation="FINALIZE"))

    if action == "delete_sg":
        if payload.get("network_mode") != runtime.MODE:
            raise ValueError("Unsupported network_mode for cleanup: " + str(payload.get("network_mode")))
        sg_name = source_nova_id or payload.get("nova_id")
        if sg_name:
            groups = runtime.os_api("NEUTRON", "/security-groups?name=" + sg_name)["security_groups"]
            if len(groups) > 1:
                raise ValueError("Ambiguous security group; refusing cleanup")
            for group in groups:
                if payload.get("has_mapping") and payload.get("neutron_sg_id") and group["id"] != payload["neutron_sg_id"]:
                    raise ValueError("Security group identity changed")
                runtime.os_api("NEUTRON", "/security-groups/" + group["id"], "DELETE", missing=True)
        table = runtime.DDB.Table("XRegion-SecurityGroups")
        target_nova_id = payload.get("target_nova_id")
        if sg_name and sg_name != target_nova_id:
            table.delete_item(Key={"group_id": sg_name})
        instance_id = payload.get("instance_id")
        src_region = payload.get("source_region") or runtime.REGION
        if instance_id:
            for record in runtime.scan(
                "XRegion-SecurityGroups",
                FilterExpression="instance_id = :iid",
                ExpressionAttributeValues={":iid": instance_id},
            ):
                gid = record.get("group_id")
                if not gid or gid == target_nova_id:
                    continue
                if record.get("region") == src_region or gid == sg_name:
                    table.delete_item(Key={"group_id": gid})
        return payload

    if action == "delete_volume_and_snapshot":
        project = os.environ.get("OS_PROJECT_ID", "d3bf05331973481891385d066d3eba3e")
        nova_item = runtime.get("XRegion-Nova", "nova_id", source_nova_id) or {}
        cinder_vol_id = nova_item.get("volume_id")
        ebs_vol_id = payload.get("source_volume_id") or nova_item.get("ebs_volume_id")
        ec2 = boto3.client("ec2", region_name=payload.get("source_region") or runtime.REGION)

        cinder_done = not (cinder_vol_id and not str(cinder_vol_id).startswith("vol-"))
        ebs_done = not (ebs_vol_id and str(ebs_vol_id).startswith("vol-"))
        for _ in range(15):
            if not cinder_done:
                try:
                    c_vol = runtime.os_api("CINDER", f"/{project}/volumes/{cinder_vol_id}", missing=True)
                    if not c_vol:
                        cinder_done = True
                    else:
                        c_st = c_vol.get("volume", {}).get("status", "")
                        if c_st not in ("deleting", "error_deleting"):
                            runtime.os_api("CINDER", f"/{project}/volumes/{cinder_vol_id}", "DELETE", missing=True)
                except Exception as e:
                    logger.warning("Cleanup source Cinder volume %s warning: %s", cinder_vol_id, e)
            if not ebs_done:
                try:
                    ec2.describe_volumes(VolumeIds=[ebs_vol_id])
                    try:
                        ec2.delete_volume(VolumeId=ebs_vol_id)
                    except Exception as de:
                        if "InvalidVolume.NotFound" in str(de):
                            ebs_done = True
                        else:
                            logger.warning("Cleanup source EBS volume %s retry: %s", ebs_vol_id, de)
                except Exception as e:
                    if "InvalidVolume.NotFound" in str(e):
                        ebs_done = True
                    else:
                        logger.warning("Describe source EBS volume %s warning: %s", ebs_vol_id, e)
            if cinder_done and ebs_done:
                break
            time.sleep(3)

        try:
            vol_tbl = boto3.resource("dynamodb", region_name=payload.get("source_region") or runtime.REGION).Table("XRegion-Volumes")
            for item in vol_tbl.scan()["Items"]:
                if (cinder_vol_id and item.get("cinder_volume_id") == cinder_vol_id) or (ebs_vol_id and item.get("ebs_volume_id") == ebs_vol_id):
                    vol_tbl.update_item(
                        Key={"volume_id": item["volume_id"]},
                        UpdateExpression="SET #s = :del, updated_at = :now",
                        ExpressionAttributeNames={"#s": "status"},
                        ExpressionAttributeValues={":del": "DELETED", ":now": int(time.time())},
                    )
        except Exception as e:
            logger.warning("Mark source XRegion-Volumes DELETED warning: %s", e)

        snap_id = payload.get("source_snapshot_id")
        if snap_id:
            try:
                ec2.delete_snapshot(SnapshotId=snap_id)
            except Exception as e:
                logger.warning("Cleanup source snapshot %s warning: %s", snap_id, e)

        if source_nova_id:
            now_ms = int(time.time() * 1000)
            for reg in list(dict.fromkeys([payload.get("source_region"), payload.get("dest_region"), "ap-southeast-2", "us-east-1"])):
                if not reg:
                    continue
                try:
                    ddb = boto3.resource("dynamodb", region_name=reg)
                    ddb.Table("XRegion-Nova").update_item(
                        Key={"nova_id": source_nova_id},
                        UpdateExpression="SET #s = :term, terminated_at = :now",
                        ExpressionAttributeNames={"#s": "status"},
                        ExpressionAttributeValues={":term": "TERMINATED", ":now": now_ms},
                    )
                except Exception as e:
                    logger.warning("Mark source nova TERMINATED in %s warning: %s", reg, e)
        payload["source_cleanup_completed"] = True
        return payload

    raise ValueError(f"Unsupported MigrateSourceCleanup action: {action}")
