"""Dedicated Network Lambda for MigrateTargetBoot (SPEC-SF-09 v1.6.0)."""
import os
import time
import urllib.parse
import network_runtime as runtime

STAGE_MAP = {
    "reserve": runtime.reserve,
    "commit": runtime.commit,
    "dispatch_nat": runtime.dispatch,
    "check_nat": runtime.check_command,
    "verify_network": runtime.verify,
    "rollback_nat": runtime.release,
    "release_eip": runtime.release,
}


def _allocate_or_pick_eip(rid, ebs_vol_id, cinder_vol_id, cinder_vol_key, size_gb):
    previous = runtime.get(runtime.RES, "resource_key", "LEASE#" + rid)
    if previous:
        return previous
    addresses = runtime.EC2.describe_addresses()["Addresses"]
    chosen = None
    for a in addresses:
        tags = {t["Key"]: t["Value"] for t in a.get("Tags", [])}
        if (not a.get("AssociationId") and tags.get("Project") == "xregion"
                and not tags.get("ClaimedBy")
                and not runtime.get(runtime.RES, "resource_key", "EIP#" + a["AllocationId"])):
            chosen = a
            break
    if not chosen:
        alloc = runtime.EC2.allocate_address(Domain="vpc")
        alloc_id = alloc["AllocationId"]
        runtime.EC2.create_tags(Resources=[alloc_id], Tags=[
            {"Key": "Project", "Value": "xregion"},
            {"Key": "ManagedBy", "Value": "XRegion-EIPPoolManager"},
            {"Key": "Name", "Value": f"eip-mig-{int(time.time())}"},
        ])
        chosen = {"AllocationId": alloc_id, "PublicIp": alloc["PublicIp"]}

    record = dict(
        resource_key="LEASE#" + rid,
        reservation_id=rid,
        network_mode=runtime.MODE,
        cinder_volume_key=cinder_vol_key or f"MIG#{cinder_vol_id}",
        cinder_volume_id=cinder_vol_id,
        original_size_gb=int(size_gb),
        allocation_id=chosen["AllocationId"],
        elastic_ip=chosen["PublicIp"],
        status="RESERVED",
        created_at=int(time.time()),
        storage_backend=runtime.STORAGE_BACKEND,
        cinder_volume_type=runtime.CINDER_VOLUME_TYPE,
        ebs_volume_id=ebs_vol_id,
    )
    tx = [
        runtime.claim_put("EIP#" + chosen["AllocationId"], rid),
        {"Put": {"TableName": runtime.RES, "Item": runtime.wire(record),
                 "ConditionExpression": "attribute_not_exists(resource_key)"}},
    ]
    runtime.SESSION.client("dynamodb").transact_write_items(TransactItems=tx)
    runtime.EC2.create_tags(Resources=[chosen["AllocationId"]], Tags=[
        {"Key": "ReservationId", "Value": rid},
        {"Key": "ClaimedBy", "Value": rid},
    ])
    return record


def _rollback_release_lease_pre_commit(event):
    rid = event.get("reservation_id") or event.get("execution_arn")
    if not rid:
        return event
    r = runtime.get(runtime.RES, "resource_key", "LEASE#" + rid)
    if not r:
        return event
    port_id = r.get("neutron_port_id")
    if port_id:
        try:
            data = runtime.os_api("NEUTRON", "/ports/" + port_id, missing=True)
            if data and data.get("port") and not data["port"].get("device_id"):
                runtime.os_api("NEUTRON", "/ports/" + port_id, "DELETE", missing=True)
        except Exception:
            pass
    gw_ip = r.get("gateway_private_ip")
    if gw_ip:
        try:
            eni = runtime.EC2.describe_network_interfaces(NetworkInterfaceIds=[runtime.ENI])["NetworkInterfaces"][0]
            if any(p["PrivateIpAddress"] == gw_ip and not p.get("Primary") for p in eni["PrivateIpAddresses"]):
                runtime.EC2.unassign_private_ip_addresses(NetworkInterfaceId=runtime.ENI, PrivateIpAddresses=[gw_ip])
        except Exception:
            pass
    alloc_id = r.get("allocation_id")
    if alloc_id:
        try:
            addr = runtime.EC2.describe_addresses(AllocationIds=[alloc_id])["Addresses"][0]
            if addr.get("AssociationId") and addr.get("NetworkInterfaceId") == runtime.ENI and addr.get("PrivateIpAddress") == gw_ip:
                runtime.EC2.disassociate_address(AssociationId=addr["AssociationId"])
            tags = [{"Key": k} for k in ("ClaimedBy", "ClaimedAt", "NovaId", "ReservationId")
                    if any(t["Key"] == k for t in addr.get("Tags", []))]
            if tags:
                runtime.EC2.delete_tags(Resources=[alloc_id], Tags=tags)
        except Exception:
            pass
    for key in ("LEASE#" + rid, "EIP#" + str(alloc_id or ""), "PRIVATEIP#" + runtime.ENI + "#" + str(gw_ip or "")):
        if key.endswith("#"):
            continue
        try:
            runtime.DDB.Table(runtime.RES).delete_item(Key={"resource_key": key})
        except Exception:
            pass
    return dict(event, pre_commit_lease_released=True)


def lambda_handler(event, context):
    runtime.TOKEN = None
    action = event.get("action")
    if action == "rollback_release_lease":
        return _rollback_release_lease_pre_commit(event)
    if action == "check_mapping_committed":
        nid = event.get("nova_id") or event.get("target_nova_id")
        m = runtime.get(runtime.MAP, "nova_id", nid) if nid else None
        committed = bool(m and m.get("applied_status") in ("ACTIVE", "APPLYING", "DELETING"))
        return dict(event, network_committed=committed)
    if action not in STAGE_MAP:
        raise ValueError(f"Unsupported TargetNetwork action: {action}")
    if action == "reserve":
        rid = event.get("execution_arn") or event.get("reservation_id")
        if not rid:
            raise ValueError("Missing execution_arn for MigrateTargetBoot reservation")
        event["reservation_id"] = rid
        event["size_gb"] = max(1, int(event.get("size_gb") or event.get("ebs_size_gb") or 1))
        event["image_id"] = event.get("image_id") or "831dc24b-9d29-4cb6-8154-9de2d0fd268f"
        event["flavor"] = event.get("flavor") or "m1.tiny"
        key_id = event.get("key_id")
        if not key_id:
            raise ValueError("Missing key_id for target Nova boot")
        runtime.os_api("NOVA", "/os-keypairs/" + urllib.parse.quote(str(key_id), safe=""))
        flavors = runtime.os_api("NOVA", "/flavors/detail")["flavors"]
        if not any(event["flavor"] in (f["id"], f["name"]) for f in flavors):
            raise ValueError("Unknown Nova flavor: " + str(event["flavor"]))

        lease_rec = _allocate_or_pick_eip(
            rid,
            event["ebs_volume_id"],
            event["cinder_volume_id"],
            event.get("cinder_volume_key"),
            event["size_gb"],
        )
        event = runtime.carry(event, lease_rec)
    if action in ("rollback_nat", "release_eip"):
        os.environ["NETWORK_STAGE"] = "Release"
    return STAGE_MAP[action](event)
