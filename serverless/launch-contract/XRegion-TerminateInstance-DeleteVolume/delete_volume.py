"""Delete only current, owned volumes; completion requires physical absence.

The workflow polls this handler. DynamoDB keys are never storage API identifiers.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config
from botocore.exceptions import ClientError


SESSION = boto3.Session(region_name=os.environ.get("AWS_REGION", "ap-southeast-2"))
DDB = SESSION.resource("dynamodb")
EC2 = SESSION.client("ec2", config=Config(connect_timeout=3, read_timeout=10,
                                         retries={"mode": "standard", "total_max_attempts": 2}))
TOKEN = None
PROJECT = None


def get(table, key, value):
    return DDB.Table(table).get_item(Key={key: value}, ConsistentRead=True).get("Item")


def owned(record, instance_id):
    owners = {record.get(k) for k in ("attached_instance_id", "lease_instance_id") if record.get(k)}
    return owners == {instance_id}


def identity(record):
    if record.get("cinder_volume_id"):
        return "cinder", str(uuid.UUID(record["cinder_volume_id"]))
    actual = record.get("ebs_volume_id") or record.get("volume_id", "")
    if record.get("volume_type") == "cinder" or not re.fullmatch(r"vol-[0-9a-f]+", actual):
        raise ValueError("Volume record has no unambiguous storage identity")
    return "ebs", actual


def resources(event):
    iid, nid = event["instance_id"], event.get("nova_id") or event.get("server_id")
    main = get("XRegion-Instances", "instance_id", iid) or {}
    if not nid or nid not in (main.get("active_nova_id"), main.get("current_nova_id")):
        raise ValueError("Instance Nova ownership changed")
    nova = get("XRegion-Nova", "nova_id", nid) or {}
    if nova.get("instance_id") != iid:
        raise ValueError("Nova does not belong to the terminating instance")
    prior = event.get("volume_cleanup", {}).get("resources")
    context = dict(event.get("cleanup_volume") or {})
    context.update({k: event[k] for k in ("cinder_volume_key", "cinder_volume_id") if event.get(k)})
    if prior:
        records = [get("XRegion-Volumes", "volume_id", r["key"]) for r in prior]
    elif context.get("cinder_volume_key"):
        records = [get("XRegion-Volumes", "volume_id", context["cinder_volume_key"])]
    else:
        records = [r for page in DDB.meta.client.get_paginator("scan").paginate(
            TableName="XRegion-Volumes", ConsistentRead=True,
            FilterExpression="attached_instance_id=:i OR lease_instance_id=:i",
            ExpressionAttributeValues={":i": iid}) for r in page["Items"]]
    references = {v for v in (nova.get("volume_id"), main.get("volume_id"), main.get("cinder_volume_id")) if v}
    out = []
    for record in records:
        if not record or not owned(record, iid):
            raise ValueError("Volume ownership is missing or ambiguous")
        kind, actual = identity(record)
        if actual not in references:
            # Never expand termination to historical generations discovered by a scan.
            if prior or context.get("cinder_volume_key"):
                raise ValueError("Volume is not referenced by the current Nova")
            continue
        if context.get("cinder_volume_id") and kind == "cinder" and actual != context["cinder_volume_id"]:
            raise ValueError("Cinder payload identity mismatch")
        out.append(dict(key=record["volume_id"], kind=kind, id=actual))
    if not out or (prior is not None and out != prior):
        raise ValueError("No exact owned volume set could be confirmed")
    return out


def cinder_request(volume_id, method="GET"):
    global TOKEN, PROJECT
    if not TOKEN:
        payload = {"auth": {"identity": {"methods": ["password"], "password": {"user": {
            "name": os.environ.get("OS_USERNAME", "admin"), "domain": {"name": "Default"},
            "password": os.environ["OS_PASSWORD"]}}}, "scope": {"project": {
                "name": os.environ.get("OS_PROJECT_NAME", "service"), "domain": {"name": "Default"}}}}}
        request = urllib.request.Request(os.environ["KEYSTONE_URL"].rstrip("/") + "/auth/tokens",
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=10) as response:
            TOKEN = response.headers["X-Subject-Token"]
            PROJECT = json.loads(response.read())["token"]["project"]["id"]
        if os.environ.get("OS_PROJECT_ID") and PROJECT != os.environ["OS_PROJECT_ID"]:
            raise ValueError("Unexpected OpenStack project")
    url = os.environ["CINDER_URL"].rstrip("/") + "/" + PROJECT + "/volumes/" + str(uuid.UUID(volume_id))
    request = urllib.request.Request(url, headers={"X-Auth-Token": TOKEN}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            content = response.read()
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(f"Cinder {method} HTTP {error.code}") from None


def delete_cinder(resource):
    data = cinder_request(resource["id"])
    if data is None:
        return True
    volume = data["volume"]
    if volume.get("attachments"):
        raise ValueError("Cinder volume still attached; refusing deletion")
    if volume.get("status") == "error_deleting":
        raise RuntimeError("Cinder volume entered error_deleting")
    if volume.get("status") == "deleting":
        return False
    if volume.get("status") not in ("available", "error"):
        raise RuntimeError("Cinder volume is not ready for deletion")
    cinder_request(resource["id"], "DELETE")
    return cinder_request(resource["id"]) is None


def delete_ebs(resource, record):
    try:
        volume = EC2.describe_volumes(VolumeIds=[resource["id"]])["Volumes"][0]
    except ClientError as error:
        if error.response["Error"]["Code"] == "InvalidVolume.NotFound":
            return True
        raise
    attachments = volume.get("Attachments", [])
    expected = record.get("ec2_instance_id")
    if attachments:
        if not expected or any(a.get("InstanceId") != expected or a.get("Device") in ("/dev/sda1", "/dev/xvda") for a in attachments):
            raise ValueError("EBS attachment ownership is not confirmed")
        for attachment in attachments:
            if attachment.get("State") != "detaching":
                EC2.detach_volume(VolumeId=resource["id"], InstanceId=expected, Device=attachment["Device"], Force=False)
        return False
    if volume["State"] == "deleting":
        return False
    if volume["State"] != "available":
        raise RuntimeError("EBS volume is not ready for deletion")
    EC2.delete_volume(VolumeId=resource["id"])
    return False


def mark_deleted(resource, record, iid):
    if record.get("status") == "DELETED":
        return
    condition = Attr("volume_id").exists()
    for field in ("attached_instance_id", "lease_instance_id"):
        condition &= Attr(field).eq(iid) if record.get(field) else (Attr(field).not_exists() | Attr(field).eq(""))
    field = "cinder_volume_id" if resource["kind"] == "cinder" else ("ebs_volume_id" if record.get("ebs_volume_id") else "volume_id")
    condition &= Attr(field).eq(resource["id"]) & Attr("status").eq(record["status"])
    DDB.Table("XRegion-Volumes").update_item(Key={"volume_id": resource["key"]},
        UpdateExpression="SET #s=:deleted, deleted_at=:t", ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":deleted": "DELETED", ":t": int(time.time())}, ConditionExpression=condition)


def lambda_handler(event, context):
    global TOKEN, PROJECT
    TOKEN = PROJECT = None
    prior = event.get("volume_cleanup") or {}
    deadline = int(prior.get("deadline_at", int(time.time()) + 300))
    if int(time.time()) >= deadline:
        raise TimeoutError("Volume deletion deadline exceeded")
    targets = resources(event)
    complete = True
    for resource in targets:
        if context and context.get_remaining_time_in_millis() < 15000:
            complete = False
            break
        record = get("XRegion-Volumes", "volume_id", resource["key"])
        if not record or not owned(record, event["instance_id"]) or identity(record) != (resource["kind"], resource["id"]):
            raise ValueError("Volume ownership changed before deletion")
        absent = delete_cinder(resource) if resource["kind"] == "cinder" else delete_ebs(resource, record)
        if absent and resource["kind"] == "cinder" and record.get("storage_backend") == "aws-ebs":
            # Cinder owns detach/delete. This Lambda independently verifies physical absence.
            actual = record.get("ebs_volume_id", "")
            if not re.fullmatch(r"vol-(?:[0-9a-f]{8}|[0-9a-f]{17})", actual):
                raise ValueError("Missing EBS receipt for Cinder deletion")
            try:
                EC2.describe_volumes(VolumeIds=[actual])
                absent = False
            except ClientError as error:
                if error.response["Error"]["Code"] != "InvalidVolume.NotFound":
                    raise
        if absent:
            mark_deleted(resource, record, event["instance_id"])
        else:
            complete = False
    if int(time.time()) >= deadline:
        raise TimeoutError("Volume deletion deadline exceeded")
    receipt = dict(status="DELETED" if complete else "PENDING", deadline_at=deadline, resources=targets)
    print(json.dumps(dict(operation="DeleteVolume", status=receipt["status"], instance_id=event["instance_id"])))
    return dict(event, volume_cleanup=receipt)
