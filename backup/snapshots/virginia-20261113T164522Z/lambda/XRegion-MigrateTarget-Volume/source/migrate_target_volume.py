"""Dedicated Volume Lambda for MigrateTargetBoot (SPEC-SF-09 v1.6.0)."""
import json
import logging
import os
import boto3
import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _cinder_ebs_host(project):
    services = runtime.os_api("CINDER", f"/{project}/os-services?binary=cinder-volume").get("services", [])
    for svc in services:
        host = svc.get("host", "")
        if "aws-ebs" in host and svc.get("state") == "up":
            return host
    for svc in services:
        host = svc.get("host", "")
        if "aws-ebs" in host:
            return host
    return "ip-10-20-10-183@aws-ebs#aws-ebs"


def lambda_handler(event, context):
    runtime.TOKEN = None
    action = event.get("action") or "create_volume_from_snapshot"
    payload = dict(event.get("request", event))
    if isinstance(payload.get("detail"), dict):
        payload = dict(payload["detail"])
    if event.get("execution_arn") and "execution_arn" not in payload:
        payload["execution_arn"] = event["execution_arn"]

    dest_region = payload.get("dest_region") or os.environ.get("AWS_REGION")
    ec2 = boto3.client("ec2", region_name=dest_region)
    project = os.environ.get("OS_PROJECT_ID", "d3bf05331973481891385d066d3eba3e")

    if action == "create_volume_from_snapshot":
        snap_id = payload["dest_snapshot_id"]
        instance_id = payload["instance_id"]
        size_gb = max(1, int(payload.get("size_gb") or payload.get("ebs_size_gb") or 1))
        payload["size_gb"] = size_gb
        payload["ebs_size_gb"] = size_gb

        host_id = os.environ["GATEWAY_HOST_ID"]
        host_az = ec2.describe_instances(InstanceIds=[host_id])["Reservations"][0]["Instances"][0]["Placement"]["AvailabilityZone"]

        vol = ec2.create_volume(
            SnapshotId=snap_id,
            AvailabilityZone=host_az,
            Size=size_gb,
            VolumeType="gp3",
            Encrypted=True,
            TagSpecifications=[{
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "Project", "Value": "xregion"},
                    {"Key": "ManagedBy", "Value": "xregion-cinder-ebs-v1"},
                    {"Key": "StorageBackend", "Value": "aws-ebs"},
                    {"Key": "StorageHostId", "Value": host_id},
                    {"Key": "CinderProjectId", "Value": project},
                    {"Key": "InstanceId", "Value": instance_id},
                    {"Key": "MigrationId", "Value": payload.get("migration_id", "")},
                ],
            }],
        )
        payload["target_volume_id"] = vol["VolumeId"]
        payload["ebs_volume_id"] = vol["VolumeId"]
        payload["volume_id"] = vol["VolumeId"]
        payload["target_volume_status"] = "creating"
        return payload

    if action == "check_target_volume":
        vol_id = payload["target_volume_id"]
        resp = ec2.describe_volumes(VolumeIds=[vol_id])
        ebs_state = resp["Volumes"][0]["State"]
        if ebs_state == "error":
            raise RuntimeError(f"Target EBS volume {vol_id} failed with state=error")
        if ebs_state != "available":
            payload["target_volume_status"] = ebs_state
            return payload

        cid = payload.get("cinder_volume_id")
        if not cid:
            cinder_host = _cinder_ebs_host(project)
            image_id = payload.get("image_id") or "831dc24b-9d29-4cb6-8154-9de2d0fd268f"
            managed = runtime.os_api("CINDER", f"/{project}/manageable_volumes", "POST", {
                "volume": {
                    "host": cinder_host,
                    "ref": {"source-id": vol_id},
                    "name": f"xregion-mig-{payload.get('instance_id')}-{payload.get('migration_id', '')}",
                    "volume_type": "aws-ebs-gp3",
                    "bootable": True,
                    "metadata": {
                        "image_id": image_id,
                        "xregion_migration_id": str(payload.get("migration_id", "")),
                        "storage_backend": "aws-ebs",
                    },
                }
            })["volume"]
            cid = managed["id"]
            ec2.create_tags(Resources=[vol_id], Tags=[{"Key": "CinderVolumeId", "Value": cid}])
            payload["cinder_volume_id"] = cid
            payload["cinder_volume_key"] = f"MIG#{cid}"
            payload["storage_backend"] = "aws-ebs"
            payload["cinder_volume_type"] = "aws-ebs-gp3"

        c_vol = runtime.os_api("CINDER", f"/{project}/volumes/{cid}")["volume"]
        c_state = c_vol.get("status", "")
        if str(c_state).startswith("error"):
            raise RuntimeError(f"Target Cinder volume {cid} failed with status={c_state}")
        if c_state != "available":
            payload["target_volume_status"] = c_state
            return payload

        if str(c_vol.get("bootable")).lower() != "true":
            runtime.os_api("CINDER", f"/{project}/volumes/{cid}/action", "POST", {"os-set_bootable": {"bootable": True}})
        image_id = payload.get("image_id") or "831dc24b-9d29-4cb6-8154-9de2d0fd268f"
        if c_vol.get("volume_image_metadata", {}).get("image_id") != image_id:
            runtime.os_api("CINDER", f"/{project}/volumes/{cid}/action", "POST", {
                "os-set_image_metadata": {"metadata": {"image_id": image_id}}
            })

        payload["target_volume_status"] = "available"
        payload["volume_extension"] = {
            "status": "CONFIRMED",
            "cinder_volume_id": cid,
            "actual_size_gb": int(c_vol.get("size") or payload.get("size_gb") or 1),
        }
        return payload

    if action == "delete_target_volume":
        cid = payload.get("cinder_volume_id")
        if cid and not str(cid).startswith("EBS-POOL#"):
            c_vol = runtime.os_api("CINDER", f"/{project}/volumes/{cid}", missing=True)
            c_st = (c_vol or {}).get("volume", {}).get("status", "")
            if c_vol and c_st not in ("deleting", "error_deleting"):
                try:
                    runtime.os_api("CINDER", f"/{project}/volumes/{cid}", "DELETE", missing=True)
                except Exception as e:
                    logger.warning("Cinder volume %s delete warning (status=%s): %s", cid, c_st, e)

        vol_id = payload.get("target_volume_id") or payload.get("ebs_volume_id") or payload.get("volume_id")
        if not vol_id or not str(vol_id).startswith("vol-"):
            payload["volume_cleanup_status"] = "DELETED"
            return payload
        try:
            resp = ec2.describe_volumes(VolumeIds=[vol_id])
            state = resp["Volumes"][0]["State"]
            if state == "in-use":
                ec2.detach_volume(VolumeId=vol_id, Force=True)
                payload["volume_cleanup_status"] = "DETACHING"
                return payload
            if state != "deleting":
                ec2.delete_volume(VolumeId=vol_id)
            payload["volume_cleanup_status"] = "DELETING"
            return payload
        except ec2.exceptions.ClientError as e:
            if "InvalidVolume.NotFound" in str(e):
                payload["volume_cleanup_status"] = "DELETED"
                return payload
            raise

    if action == "delete_dest_snapshot":
        snap_id = payload.get("dest_snapshot_id")
        if snap_id:
            try:
                ec2.delete_snapshot(SnapshotId=snap_id)
            except Exception as e:
                logger.warning("Failed deleting dest snapshot %s: %s", snap_id, e)
        return payload

    raise ValueError(f"Unsupported TargetVolume action: {action}")
