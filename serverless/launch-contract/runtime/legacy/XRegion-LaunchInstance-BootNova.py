import json
import os
import time
import urllib.request
import urllib.error

KEYSTONE_URL = os.environ.get("KEYSTONE_URL", "http://10.20.10.183:5000/v3")
NOVA_URL = os.environ.get("NOVA_URL", "http://10.20.10.183:8774/v2.1")
NETWORK_ID = os.environ.get("NETWORK_ID", "77e93c67-be12-4a0c-98f0-64d543833a62")
DEFAULT_AZ = os.environ.get("DEFAULT_AZ", "ap-southeast-2a")
OS_USERNAME = os.environ.get("OS_USERNAME", "admin")
OS_PASSWORD = os.environ["OS_PASSWORD"]
OS_PROJECT_NAME = os.environ.get("OS_PROJECT_NAME", "service")

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

def send_nova_request(url, method="GET", body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
        "OpenStack-API-Version": "compute 2.90"
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            content = resp.read().decode("utf-8")
            return resp.status, json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8")
        print(f"Nova HTTP error [{e.code}] for {method} {url}: {err_msg}")
        raise RuntimeError(f"Nova HTTP error [{e.code}]: {err_msg}")

def get_flavor_id(flavor_name):
    flavor_map = {
        "m1.tiny": "b9f63897-8334-4f3f-9b4a-38adbb5e1448",
        "m1.small": "c178c641-f7da-41d5-841e-f22661ba8887",
        "m1.medium": "47692af8-63e0-4b25-80de-92b9e1ae9c02",
        "m1.large": "cc3372d3-7161-433e-bcd9-a31f898b4ee1"
    }
    if not flavor_name:
        return flavor_map["m1.medium"]
    return flavor_map.get(flavor_name, flavor_map.get(flavor_name.lower(), "47692af8-63e0-4b25-80de-92b9e1ae9c02"))

def ensure_keypair_exists(token, key_name):
    try:
        status, res = send_nova_request(f"{NOVA_URL}/os-keypairs/{key_name}", method="GET", token=token)
        print(f"Keypair [{key_name}] already exists in OpenStack Nova.")
        return key_name
    except Exception:
        print(f"Keypair [{key_name}] not found in OpenStack, attempting auto-import or fallback...")
        try:
            # Create keypair with that name in Nova
            status, res = send_nova_request(f"{NOVA_URL}/os-keypairs", method="POST", body={"keypair": {"name": key_name}}, token=token)
            print(f"Created new SSH keypair [{key_name}] in OpenStack Nova.")
            return key_name
        except Exception as e:
            print(f"Notice: could not create keypair {key_name}, fallback to xregion-key: {e}")
            return "xregion-key"

def lambda_handler(event, context):
    print("Received BootNova event:", json.dumps(event))
    instance_id = event.get("instance_id")
    instance_name = event.get("instance_name") or f"vm-{instance_id}"
    cinder_volume_id = event.get("cinder_volume_id")
    flavor = event.get("flavor") or event.get("flavor_name") or "m1.medium"
    raw_key = event.get("key_id") or event.get("key_name") or "xregion-key"

    if not cinder_volume_id:
        raise ValueError("Missing cinder_volume_id in event payload")

    token, _ = get_keystone_token()
    flavor_id = get_flavor_id(flavor)

    # Ensure keypair exists with non-colliding key_id
    active_key_name = ensure_keypair_exists(token, raw_key)

    server_body = {
        "server": {
            "name": instance_name,
            "flavorRef": flavor_id,
            "block_device_mapping_v2": [
                {
                    "boot_index": 0,
                    "uuid": cinder_volume_id,
                    "source_type": "volume",
                    "destination_type": "volume",
                    "delete_on_termination": False
                }
            ],
            "networks": [{"uuid": NETWORK_ID}],
            "key_name": active_key_name
        }
    }

    print(f"Booting Nova VM [{instance_name}] from Cinder volume [{cinder_volume_id}]...")
    st, resp = send_nova_request(f"{NOVA_URL}/servers", method="POST", body=server_body, token=token)
    server = resp.get("server", {})
    server_id = server.get("id")
    print(f"Nova VM created with ID: {server_id}")

    # Polling for ACTIVE state
    poll_start = time.time()
    current_status = "BUILD"
    private_ip = "10.0.1.100"

    while time.time() - poll_start < 120:
        time.sleep(4)
        try:
            st, get_resp = send_nova_request(f"{NOVA_URL}/servers/{server_id}", method="GET", token=token)
            srv = get_resp.get("server", {})
            current_status = srv.get("status")
            print(f"Nova VM [{server_id}] status: {current_status}")

            if current_status == "ACTIVE":
                # Extract private IP
                addresses = srv.get("addresses", {})
                for net_name, addr_list in addresses.items():
                    for addr_info in addr_list:
                        if addr_info.get("OS-EXT-IPS:type") == "fixed" or addr_info.get("version") == 4:
                            private_ip = addr_info.get("addr")
                            break
                    if private_ip != "10.0.1.100":
                        break
                print(f"Nova VM is ACTIVE! Private IP: {private_ip}")
                break
            elif "ERROR" in current_status:
                raise RuntimeError(f"Nova VM [{server_id}] entered ERROR state: {srv.get('fault', {})}")
        except Exception as e:
            print(f"Polling check error: {e}")

    return {
        "status": current_status,
        "server_id": server_id,
        "nova_id": server_id,
        "instance_id": instance_id,
        "instance_name": instance_name,
        "flavor": flavor,
        "key_id": raw_key,
        "cinder_volume_id": cinder_volume_id,
        "private_ip": private_ip
    }
