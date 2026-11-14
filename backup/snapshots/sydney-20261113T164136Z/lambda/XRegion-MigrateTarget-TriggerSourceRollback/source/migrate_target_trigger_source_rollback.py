"""Dedicated TriggerSourceRollback Lambda for MigrateTargetBoot (SPEC-SF-09 v1.6.0)."""
import json
import logging
import time
import urllib.request
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

logger = logging.getLogger()
logger.setLevel(logging.INFO)

APIGW_ENDPOINTS = {
    "ap-southeast-2": "https://oqp7jmg7je.execute-api.ap-southeast-2.amazonaws.com/prod/events",
    "us-east-1": "https://dawfyj0692.execute-api.us-east-1.amazonaws.com/prod/events",
}


def _sign_and_post(url, region, body_dict):
    session = boto3.Session()
    creds = session.get_credentials().get_frozen_credentials()
    data = json.dumps(body_dict).encode("utf-8")
    req = AWSRequest(method="POST", url=url, data=data, headers={"Content-Type": "application/json"})
    SigV4Auth(creds, "execute-api", region).add_auth(req)
    http_req = urllib.request.Request(url, data=data, headers=dict(req.headers), method="POST")
    with urllib.request.urlopen(http_req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {"status": resp.status}


def lambda_handler(event, context):
    source_region = event["source_region"]
    instance_id = event["instance_id"]
    migration_id = event.get("migration_id")
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    for reg in list(dict.fromkeys([source_region, event.get("dest_region"), "ap-southeast-2", "us-east-1"])):
        if not reg:
            continue
        try:
            ddb = boto3.resource("dynamodb", region_name=reg)
            ddb.Table("XRegion-Instances").update_item(
                Key={"instance_id": instance_id},
                UpdateExpression="SET current_status = :st, migration_lock = :lock, updated_at = :now",
                ExpressionAttributeValues={":st": "STARTING", ":lock": False, ":now": now_iso},
            )
            if migration_id:
                ddb.Table("XRegion-Migrations").update_item(
                    Key={"instance_id": instance_id, "migration_id": migration_id},
                    UpdateExpression="SET #s = :fail, error_message = :err, updated_at = :now",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={
                        ":fail": "FAILED",
                        ":err": json.dumps(event.get("error", {"Error": "TargetBootFailed"})),
                        ":now": now_iso,
                    },
                )
        except Exception as e:
            logger.warning("Rollback DynamoDB update in %s warning: %s", reg, e)

    apigw_body = {
        "source": "xregion.backend.instance",
        "detailType": "instance.lifecycle",
        "detail": {
            "instance_id": instance_id,
            "action": "START",
            "nova_id": event.get("source_nova_id"),
            "region": source_region,
        },
    }
    resp = _sign_and_post(APIGW_ENDPOINTS[source_region], source_region, apigw_body)
    event["source_rollback_dispatched"] = True
    event["source_apigw_response"] = resp
    return event
