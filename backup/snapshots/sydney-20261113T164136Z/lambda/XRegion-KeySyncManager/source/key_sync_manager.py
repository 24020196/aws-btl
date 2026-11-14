import json
import os
import time
import urllib.request
import urllib.error
import boto3

KEYSTONE_URL = os.environ.get("KEYSTONE_URL", "http://10.20.10.183:5000/v3")
NOVA_URL = os.environ.get("NOVA_URL", "http://10.20.10.183:8774/v2.1")
OS_USERNAME = os.environ.get("OS_USERNAME", "admin")
OS_PASSWORD = os.environ.get("OS_PASSWORD", "12345678")
OS_PROJECT_NAME = os.environ.get("OS_PROJECT_NAME", "service")
DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE", "XRegion-Keys")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")

dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)

# Cached Token
_token_cache = {"token": None, "expires_at": 0}

def get_keystone_token():
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["token"]

    auth_payload = {
        "auth": {
            "identity": {
                "methods": ["password"],
                "password": {
                    "user": {
                        "name": OS_USERNAME,
                        "domain": {"name": "Default"},
                        "password": OS_PASSWORD
                    }
                }
            },
            "scope": {
                "project": {
                    "name": OS_PROJECT_NAME,
                    "domain": {"name": "Default"}
                }
            }
        }
    }
    req = urllib.request.Request(
        f"{KEYSTONE_URL}/auth/tokens",
        data=json.dumps(auth_payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        token = resp.headers.get("X-Subject-Token")

    _token_cache["token"] = token
    _token_cache["expires_at"] = now + 3600
    return token

def import_keypair_to_openstack(key_name, public_key):
    token = get_keystone_token()
    url = f"{NOVA_URL}/os-keypairs"
    payload = {
        "keypair": {
            "name": key_name,
            "public_key": public_key,
            "type": "ssh"
        }
    }
    headers = {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
        "OpenStack-API-Version": "compute 2.90"
    }

    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Successfully imported keypair [{key_name}] into OpenStack Nova")
            return data.get("keypair", {})
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        if e.code == 409:
            print(f"Keypair [{key_name}] already exists in OpenStack Nova (HTTP 409). Continuing...")
            return {"name": key_name}
        print(f"Error importing keypair to OpenStack [{e.code}]: {err_body}")
        raise RuntimeError(f"OpenStack API Error [{e.code}]: {err_body}")

def save_key_to_dynamodb(key_id, public_key, fingerprint, key_type, created_by):
    now_ms = str(int(time.time() * 1000))
    item = {
        "key_id": {"S": key_id},
        "public_key": {"S": public_key},
        "fingerprint": {"S": fingerprint or ""},
        "key_type": {"S": key_type or "RSA 2048"},
        "created_by": {"S": created_by or "admin"},
        "openstack_imported": {"BOOL": True},
        "created_at": {"N": now_ms}
    }
    dynamodb.put_item(
        TableName=DYNAMODB_TABLE,
        Item=item
    )
    print(f"Successfully stored SSH key [PK: {key_id}] in DynamoDB table [{DYNAMODB_TABLE}]")

def lambda_handler(event, context):
    print("Received event:", json.dumps(event))

    # Verify event source
    source = event.get("source", "")
    if source and source != "xregion.backend.key":
        print(f"Skipping event from source [{source}]")
        return {"statusCode": 200, "status": "SKIPPED", "reason": f"Unhandled source {source}"}

    detail = event.get("detail", event)
    key_id = detail.get("key_id") or detail.get("key_name") or detail.get("name")
    public_key = detail.get("public_key")
    fingerprint = detail.get("fingerprint", "")
    key_type = detail.get("key_type", "RSA 2048")
    created_by = detail.get("created_by", "admin")

    # 1. Kiểm tra bắt buộc key_id
    if not key_id or not str(key_id).strip():
        print("Error: Missing 'key_id' parameter")
        return {
            "statusCode": 400,
            "status": "ERROR",
            "error": "Missing 'key_id'. Định danh khóa SSH là bắt buộc.",
            "requires_retry": True
        }

    key_id = str(key_id).strip()

    # 2. Kiểm tra bắt buộc Public Key (Chế độ Import Key)
    if not public_key or not str(public_key).strip():
        print(f"Error: Missing 'public_key' for key [{key_id}]. Rejecting non-import request.")
        return {
            "statusCode": 400,
            "status": "ERROR",
            "error": "Missing 'public_key'. Hệ thống chỉ hỗ trợ chế độ Import Key (yêu cầu Public Key). Vui lòng cung cấp Public Key để thao tác lại.",
            "key_id": key_id,
            "requires_retry": True
        }

    public_key = str(public_key).strip()
    print(f"Processing SSH Key IMPORT: key_id={key_id} (OpenStack & DynamoDB), type={key_type}")

    # 3. Import Public Key to OpenStack Nova using key_id as OpenStack Keypair Name
    os_keypair = import_keypair_to_openstack(key_id, public_key)
    os_fingerprint = os_keypair.get("fingerprint")
    if os_fingerprint:
        fingerprint = os_fingerprint

    # 4. Save into DynamoDB XRegion-Keys (PK = key_id, NO key_name)
    save_key_to_dynamodb(key_id, public_key, fingerprint, key_type, created_by)

    return {
        "statusCode": 200,
        "status": "SUCCESS",
        "action": "IMPORT_KEY",
        "key_id": key_id,
        "fingerprint": fingerprint,
        "openstack_imported": True
    }
