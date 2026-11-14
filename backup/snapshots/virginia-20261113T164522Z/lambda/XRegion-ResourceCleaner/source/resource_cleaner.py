"""XRegion-ResourceCleaner (SPEC-02 v1.2.0): FIFO purge for idle EIPs (>2) and EBS/Cinder volumes (>5)."""
import json
import logging
import os
import boto3
import network_runtime as runtime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_IDLE_EIPS = 2
MAX_IDLE_VOLUMES = 5


def _idle_eips(ec2, res_table):
    reserved_eips = set()
    for item in res_table.scan().get("Items", []):
        rk = str(item.get("resource_key", ""))
        if rk.startswith("EIP#"):
            reserved_eips.add(rk[4:])

    idle = []
    for addr in ec2.describe_addresses().get("Addresses", []):
        if addr.get("AssociationId"):
            continue
        alloc_id = addr["AllocationId"]
        if alloc_id in reserved_eips:
            continue
        tags = {t["Key"]: t["Value"] for t in addr.get("Tags", [])}
        if tags.get("Project") != "xregion":
            continue
        if tags.get("ManagedBy") not in ("XRegion-EIPPoolManager", "XRegion-AutoAssignEIP"):
            continue
        if tags.get("ClaimedBy") or tags.get("NovaId") or tags.get("ReservationId"):
            continue
        idle_since = int(tags.get("IdleSince") or 0) if str(tags.get("IdleSince", "")).isdigit() else 0
        idle.append((idle_since, alloc_id, addr.get("PublicIp")))
    idle.sort(key=lambda x: (x[0], x[1]))
    return idle


def _root_volume_ids(ec2, host_id):
    if not host_id:
        return set()
    res = ec2.describe_instances(InstanceIds=[host_id]).get("Reservations", [])
    if not res:
        return set()
    inst = res[0]["Instances"][0]
    root_name = inst.get("RootDeviceName")
    return {
        b["Ebs"]["VolumeId"]
        for b in inst.get("BlockDeviceMappings", [])
        if b.get("DeviceName") == root_name and "Ebs" in b
    }


def _idle_volumes(ec2, host_id):
    protected = _root_volume_ids(ec2, host_id)
    vols = ec2.describe_volumes(Filters=[{"Name": "status", "Values": ["available"]}]).get("Volumes", [])
    idle = []
    for v in vols:
        vid = v["VolumeId"]
        if vid in protected:
            continue
        tags = {t["Key"]: t["Value"] for t in v.get("Tags", [])}
        if tags.get("ManagedBy") not in ("xregion-cinder-ebs-v1", "XRegion-MigrateTarget"):
            continue
        idle.append((v["CreateTime"], vid, tags.get("CinderVolumeId")))
    idle.sort(key=lambda x: (x[0], x[1]))
    return idle


def lambda_handler(event, context):
    runtime.TOKEN = None
    region = os.environ.get("AWS_REGION", "ap-southeast-2")
    host_id = os.environ.get("GATEWAY_HOST_ID", "")
    project = os.environ.get("OS_PROJECT_ID", "d3bf05331973481891385d066d3eba3e")

    ec2 = boto3.client("ec2", region_name=region)
    ddb = boto3.resource("dynamodb", region_name=region)
    res_table = ddb.Table("XRegion-NetworkReservations")

    idle_eips = _idle_eips(ec2, res_table)
    released_eips = []
    if len(idle_eips) > MAX_IDLE_EIPS:
        for idle_since, alloc_id, pub_ip in idle_eips[:len(idle_eips) - MAX_IDLE_EIPS]:
            try:
                ec2.release_address(AllocationId=alloc_id)
                released_eips.append({"allocation_id": alloc_id, "public_ip": pub_ip, "idle_since": idle_since})
            except Exception as e:
                logger.warning("Failed releasing EIP %s: %s", alloc_id, e)

    idle_vols = _idle_volumes(ec2, host_id)
    deleted_vols = []
    if len(idle_vols) > MAX_IDLE_VOLUMES:
        for created_at, vid, cid in idle_vols[:len(idle_vols) - MAX_IDLE_VOLUMES]:
            if cid:
                try:
                    c_vol = runtime.os_api("CINDER", f"/{project}/volumes/{cid}", missing=True)
                    if c_vol:
                        runtime.os_api("CINDER", f"/{project}/volumes/{cid}", "DELETE", missing=True)
                except Exception as e:
                    logger.warning("Cinder delete %s warning: %s", cid, e)
            try:
                ec2.delete_volume(VolumeId=vid)
                deleted_vols.append({"volume_id": vid, "cinder_volume_id": cid, "created_at": str(created_at)})
            except Exception as e:
                logger.warning("Failed deleting EBS volume %s: %s", vid, e)

    summary = {
        "region": region,
        "idle_eips_before": len(idle_eips),
        "released_eips": released_eips,
        "idle_eips_after": len(idle_eips) - len(released_eips),
        "idle_volumes_before": len(idle_vols),
        "deleted_volumes": deleted_vols,
        "idle_volumes_after": len(idle_vols) - len(deleted_vols),
    }
    print(json.dumps(summary, default=str))
    return summary
