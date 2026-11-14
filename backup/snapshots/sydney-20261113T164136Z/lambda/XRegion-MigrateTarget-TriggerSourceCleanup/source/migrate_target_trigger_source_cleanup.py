"""Dedicated TriggerSourceCleanup Lambda for MigrateTargetBoot (SPEC-SF-09 v1.6.0)."""
import json
import logging
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
    apigw_body = {
        "source": "xregion.migration.target",
        "detailType": "instance.migration.cleanup",
        "detail": {
            "migration_id": event.get("migration_id"),
            "instance_id": event["instance_id"],
            "source_region": source_region,
            "dest_region": event.get("dest_region"),
            "source_nova_id": event.get("source_nova_id"),
            "source_volume_id": event.get("source_volume_id"),
            "source_snapshot_id": event.get("source_snapshot_id"),
        },
    }
    resp = _sign_and_post(APIGW_ENDPOINTS[source_region], source_region, apigw_body)
    event["source_cleanup_dispatched"] = True
    event["source_cleanup_apigw_response"] = resp
    return event
