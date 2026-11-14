"""Dedicated AssignSecurityGroup Lambda for MigrateTargetBoot (SPEC-SF-09 v1.6.0)."""
import json
import time
import uuid
import boto3
import network_runtime as runtime


def _parse_rules(val):
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return list(val) if isinstance(val, list) else []


def _load_source_rules(event):
    in_r = event.get("inbound_rules")
    out_r = event.get("outbound_rules")
    if in_r is not None and out_r is not None:
        return _parse_rules(in_r), _parse_rules(out_r)
    source_region = event.get("source_region")
    source_nova_id = event.get("source_nova_id")
    if source_region and source_nova_id:
        ddb = boto3.resource("dynamodb", region_name=source_region)
        item = ddb.Table("XRegion-SecurityGroups").get_item(Key={"group_id": source_nova_id}).get("Item", {})
        return _parse_rules(runtime.native(item.get("inbound_rules", []))), _parse_rules(runtime.native(item.get("outbound_rules", [])))
    return [], []


def lambda_handler(event, context):
    runtime.TOKEN = None
    action = event.get("action") or "assign_sg"
    if action == "assign_sg":
        inbound, outbound = _load_source_rules(event)
        res = runtime.assign_group(event)
        owner = event.get("username") or event.get("owner") or "admin"
        server_id = res["security_group_id"]
        norm_in = runtime._normalize_launch_rules(inbound, owner)
        norm_out = runtime._normalize_launch_rules(outbound, owner)
        dest_region = event.get("dest_region") or runtime.REGION
        now_sec = int(time.time())
        runtime.DDB.Table("XRegion-SecurityGroups").put_item(Item={
            "group_id": server_id,
            "name": server_id,
            "description": f"1-1 Security Group for Nova VM {server_id}",
            "region": dest_region,
            "instance_id": event.get("instance_id") or server_id,
            "nova_id": server_id,
            "owner": owner,
            "inbound_rules": json.dumps(norm_in),
            "outbound_rules": json.dumps(norm_out),
            "revision": 1,
            "sync_status": "PENDING_SYNC",
            "managed": True,
            "created_at": now_sec,
        })
        res["inbound_rules"] = norm_in
        res["outbound_rules"] = norm_out
        return res
    if action == "delete_sg":
        return runtime.delete_group(event)
    raise ValueError(f"Unsupported TargetAssignSG action: {action}")
