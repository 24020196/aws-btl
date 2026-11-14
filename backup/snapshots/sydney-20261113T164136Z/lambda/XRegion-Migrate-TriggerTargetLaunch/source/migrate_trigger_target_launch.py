"""Step 4 of MigrateInstance: Send SigV4 event to target region API Gateway (SPEC-SF-08 v1.2.0)."""
import json
import logging
import os
import urllib.request
from decimal import Decimal
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

logger = logging.getLogger()
logger.setLevel(logging.INFO)

APIGW_ENDPOINTS = {
    "ap-southeast-2": "https://oqp7jmg7je.execute-api.ap-southeast-2.amazonaws.com/prod/events",
    "us-east-1": "https://dawfyj0692.execute-api.us-east-1.amazonaws.com/prod/events",
}


def _native(v):
    if isinstance(v, Decimal):
        return int(v) if v % 1 == 0 else float(v)
    if isinstance(v, list):
        return [_native(x) for x in v]
    if isinstance(v, dict):
        return {k: _native(val) for k, val in v.items()}
    return v


def _sign_and_post(url, region, body_dict):
    session = boto3.Session()
    creds = session.get_credentials().get_frozen_credentials()
    data = json.dumps(body_dict).encode("utf-8")
    req = AWSRequest(method="POST", url=url, data=data, headers={"Content-Type": "application/json"})
    SigV4Auth(creds, "execute-api", region).add_auth(req)
    http_req = urllib.request.Request(url, data=data, headers=dict(req.headers), method="POST")
    with urllib.request.urlopen(http_req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        if resp.status >= 400:
            raise RuntimeError(f"API Gateway returned HTTP {resp.status}: {raw}")
        return json.loads(raw) if raw else {"status": resp.status}


def lambda_handler(event, context):
    instance_id = event["instance_id"]
    source_region = event["source_region"]
    dest_region = event["dest_region"]
    source_nova_id = event.get("source_nova_id") or event.get("nova_id")

    inst = {}
    for reg in dict.fromkeys([source_region, "ap-southeast-2", "us-east-1"]):
        try:
            ddb = boto3.resource("dynamodb", region_name=reg)
            item = _native(ddb.Table("XRegion-Instances").get_item(Key={"instance_id": instance_id}).get("Item", {}))
            if item:
                inst = {**item, **inst}
        except Exception:
            pass

    sg_item = {}
    if source_nova_id:
        for reg in dict.fromkeys([source_region, "ap-southeast-2"]):
            try:
                ddb = boto3.resource("dynamodb", region_name=reg)
                s = _native(ddb.Table("XRegion-SecurityGroups").get_item(Key={"group_id": source_nova_id}).get("Item", {}))
                if s:
                    sg_item = s
                    break
            except Exception:
                pass

    raw_user = event.get("username") or inst.get("username") or inst.get("owner") or inst.get("user_id") or "admin"
    if str(raw_user).startswith("usr-"):
        raw_user = str(raw_user)[4:]

    size_gb = int(event.get("size_gb") or event.get("ebs_size_gb") or inst.get("confirmed_size_gb") or inst.get("requested_size_gb") or inst.get("ebs_size_gb") or 1)
    image_id = event.get("image_id") or inst.get("requested_image_id") or inst.get("image_id") or "831dc24b-9d29-4cb6-8154-9de2d0fd268f"
    key_id = event.get("key_id") or inst.get("requested_key_id") or inst.get("key_id")
    flavor = event.get("flavor") or inst.get("requested_flavor") or inst.get("flavor") or "m1.tiny"
    inst_name = event.get("instance_name") or inst.get("requested_name") or inst.get("instance_name") or instance_id

    detail_payload = {
        "migration_id": event["migration_id"],
        "instance_id": instance_id,
        "instance_name": inst_name,
        "username": raw_user,
        "flavor": flavor,
        "image_id": image_id,
        "key_id": key_id,
        "size_gb": size_gb,
        "ebs_size_gb": size_gb,
        "source_region": source_region,
        "dest_region": dest_region,
        "source_nova_id": source_nova_id,
        "source_volume_id": event.get("source_volume_id"),
        "source_snapshot_id": event.get("source_snapshot_id"),
        "dest_snapshot_id": event.get("dest_snapshot_id"),
        "inbound_rules": event.get("inbound_rules") if event.get("inbound_rules") is not None else sg_item.get("inbound_rules", []),
        "outbound_rules": event.get("outbound_rules") if event.get("outbound_rules") is not None else sg_item.get("outbound_rules", []),
        "execution_arn": event.get("execution_arn"),
    }

    gw_url = APIGW_ENDPOINTS[dest_region]
    apigw_body = {
        "source": "xregion.migration.orchestrator",
        "detailType": "instance.migration.boot",
        "detail": detail_payload,
    }
    resp = _sign_and_post(gw_url, dest_region, apigw_body)
    event["target_launch_dispatched"] = True
    event["target_apigw_response"] = resp
    return event