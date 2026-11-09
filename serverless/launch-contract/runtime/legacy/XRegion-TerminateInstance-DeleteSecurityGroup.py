import json
import os
import time
import urllib.request
import urllib.error
import urllib.parse
import boto3

KEYSTONE_URL = os.environ.get("KEYSTONE_URL", "http://10.20.10.183:5000/v3")
NOVA_URL = os.environ.get("NOVA_URL", "http://10.20.10.183:8774/v2.1")
NEUTRON_URL = os.environ.get("NEUTRON_URL", "http://10.20.10.183:9696/v2.0")
OS_USERNAME = os.environ.get("OS_USERNAME", "admin")
OS_PASSWORD = os.environ["OS_PASSWORD"]
OS_PROJECT_NAME = os.environ.get("OS_PROJECT_NAME", "service")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")

dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)

def get_keystone_token():
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
        data = json.loads(resp.read().decode("utf-8"))
        project_id = data.get("token", {}).get("project", {}).get("id")
    return token, project_id

def send_api_request(url, method="GET", body=None, token=None, extra_headers=None):
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {
        "Content-Type": "application/json",
        "X-Auth-Token": token
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")
            return resp.status, json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        err_content = e.read().decode("utf-8") if e.fp else ""
        print(f"API HTTP [{e.code}] {url}: {err_content}")
        return e.code, {"error": err_content}

def resolve_all_nova_ids_and_instance(event):
    instance_id = event.get("instance_id")
    server_id = event.get("server_id") or event.get("nova_id")
    
    if not instance_id and server_id and server_id.startswith("i-"):
        instance_id = server_id

    nova_ids = set()

    # Thêm từ payload nếu có
    if event.get("nova_ids") and isinstance(event.get("nova_ids"), list):
        for n in event.get("nova_ids"):
            if n and not n.startswith("i-"):
                nova_ids.add(str(n))

    if server_id and not server_id.startswith("i-"):
        nova_ids.add(str(server_id))

    if instance_id:
        # 1. Tra cứu XRegion-Instances
        try:
            resp = dynamodb.get_item(
                TableName="XRegion-Instances",
                Key={"instance_id": {"S": instance_id}}
            )
            item = resp.get("Item", {})
            curr_id = item.get("current_nova_id", {}).get("S")
            if curr_id and not curr_id.startswith("i-"):
                nova_ids.add(curr_id)
            act_id = item.get("active_nova_id", {}).get("S")
            if act_id and not act_id.startswith("i-"):
                nova_ids.add(act_id)
            n_ids = item.get("nova_ids", {}).get("L", [])
            for entry in n_ids:
                s_val = entry.get("S")
                if s_val and not s_val.startswith("i-"):
                    nova_ids.add(s_val)
        except Exception as e:
            print(f"Notice reading XRegion-Instances: {e}")

        # 2. Quét XRegion-Nova theo instance_id
        try:
            scan_resp = dynamodb.scan(
                TableName="XRegion-Nova",
                FilterExpression="instance_id = :inst",
                ExpressionAttributeValues={":inst": {"S": instance_id}}
            )
            for it in scan_resp.get("Items", []):
                nid = it.get("nova_id", {}).get("S")
                if nid and not nid.startswith("i-"):
                    nova_ids.add(nid)
        except Exception as e:
            print(f"Notice scanning XRegion-Nova: {e}")

    primary_server_id = list(nova_ids)[0] if nova_ids else (instance_id or "unknown")
    return list(nova_ids), instance_id or primary_server_id, primary_server_id

def lambda_handler(event, context):
    print("Step 1: DeleteSecurityGroup received event:", json.dumps(event))
    nova_ids, instance_id, primary_server_id = resolve_all_nova_ids_and_instance(event)
    print(f"Resolved instance_id=[{instance_id}], primary_server_id=[{primary_server_id}], all nova_ids={nova_ids}")

    token, _ = get_keystone_token()
    sg_name = event.get("security_group") or event.get("security_group_id") or instance_id

    # 1. Gỡ Security Group khỏi TẤT CẢ các Nova VM liên quan
    for nid in nova_ids:
        try:
            print(f"Detaching security group [{sg_name}] from Nova VM [{nid}]...")
            body = {"removeSecurityGroup": {"name": sg_name}}
            st, r = send_api_request(
                f"{NOVA_URL}/servers/{nid}/action",
                method="POST",
                body=body,
                token=token,
                extra_headers={"OpenStack-API-Version": "compute 2.90"}
            )
            print(f"Detached SG from [{nid}], status: {st}")
        except Exception as e:
            print(f"Notice detaching SG from [{nid}]: {e}")

    # 2. Xóa Security Group trên OpenStack Neutron
    try:
        search_url = f"{NEUTRON_URL}/security-groups?name={urllib.parse.quote(sg_name)}"
        st, resp = send_api_request(search_url, method="GET", token=token)
        sgs = resp.get("security_groups", [])
        for sg in sgs:
            sg_id = sg.get("id")
            print(f"Deleting Neutron Security Group [{sg_id}] (name={sg_name})...")
            del_st, _ = send_api_request(f"{NEUTRON_URL}/security-groups/{sg_id}", method="DELETE", token=token)
            print(f"Deleted Neutron SG [{sg_id}], status: {del_st}")
    except Exception as e:
        print(f"Notice deleting Neutron SG {sg_name}: {e}")

    # 3. Xóa bản ghi trong DynamoDB XRegion-SecurityGroups
    try:
        dynamodb.delete_item(
            TableName="XRegion-SecurityGroups",
            Key={"group_id": {"S": sg_name}}
        )
        print(f"Deleted Security Group [{sg_name}] from DynamoDB XRegion-SecurityGroups.")
    except Exception as e:
        print(f"Notice deleting from XRegion-SecurityGroups: {e}")

    return {
        "status": "SECURITY_GROUP_DELETED",
        "server_id": primary_server_id,
        "nova_id": primary_server_id,
        "nova_ids": nova_ids,
        "instance_id": instance_id,
        "security_group": sg_name
    }
