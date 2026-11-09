import ipaddress
import urllib.parse
import json
import os
import time
import urllib.request
import urllib.error
import boto3

KEYSTONE_URL = os.environ.get("KEYSTONE_URL", "http://10.20.10.183:5000/v3")
NOVA_URL = os.environ.get("NOVA_URL", "http://10.20.10.183:8774/v2.1")
NEUTRON_URL = os.environ.get("NEUTRON_URL", "http://10.20.10.183:9696/v2.0")
OS_USERNAME = os.environ.get("OS_USERNAME", "admin")
OS_PASSWORD = os.environ.get("OS_PASSWORD", "12345678")
OS_PROJECT_NAME = os.environ.get("OS_PROJECT_NAME", "service")
OPENSTACK_PUBLIC_ENI = os.environ.get("OPENSTACK_PUBLIC_ENI", "eni-091eaee3e69e3f42d")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")

ec2_client = boto3.client("ec2", region_name=AWS_REGION)

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
        print(f"API Error [{e.code}] {url}: {err_content}")
        raise


def get_or_create_1to1_security_group(token, server_id):
    search_url = f"{NEUTRON_URL}/security-groups?name={urllib.parse.quote(server_id)}"
    _, result = send_api_request(search_url, token=token)
    groups = result.get("security_groups", [])
    if len(groups) > 1:
        raise ValueError("Ambiguous security group name")
    if groups:
        sg_id = groups[0]["id"]
    else:
        _, result = send_api_request(
            f"{NEUTRON_URL}/security-groups", method="POST", token=token,
            body={"security_group": {"name": server_id,
                                     "description": f"1-1 Security Group for Nova VM {server_id}"}})
        sg_id = result["security_group"]["id"]
    # Reconcile rules on every retry, including groups created by an earlier attempt.
    for rule in [
        {"protocol": "tcp", "port_range_min": 22, "port_range_max": 22},
        {"protocol": "icmp"},
    ]:
        desired = dict(rule, security_group_id=sg_id, direction="ingress",
                       ethertype="IPv4", remote_ip_prefix="0.0.0.0/0")
        _, result = send_api_request(f"{NEUTRON_URL}/security-groups/{sg_id}", token=token)
        matches = lambda r: all(r.get(k) == v for k, v in desired.items())
        if any(matches(r) for r in result["security_group"]["security_group_rules"]):
            continue
        try:
            send_api_request(f"{NEUTRON_URL}/security-group-rules", method="POST",
                             token=token, body={"security_group_rule": desired})
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
            _, result = send_api_request(f"{NEUTRON_URL}/security-groups/{sg_id}", token=token)
            if not any(matches(r) for r in result["security_group"]["security_group_rules"]):
                raise
    return sg_id, server_id


def read_address(allocation_id, instance_id, elastic_ip):
    address = ec2_client.describe_addresses(AllocationIds=[allocation_id])["Addresses"][0]
    tags = {t["Key"]: t["Value"] for t in address.get("Tags", [])}
    if tags.get("ClaimedBy") != instance_id:
        raise ValueError("Elastic IP ownership does not match instance_id")
    if address["PublicIp"] != elastic_ip:
        raise ValueError("Elastic IP does not match allocation_id")
    return address


def validate_network(event):
    for key in ("instance_id", "server_id", "private_ip", "elastic_ip", "allocation_id"):
        if not isinstance(event.get(key), str) or not event[key].strip():
            raise ValueError(f"Missing {key} in network event")
    ip = ipaddress.IPv4Address(event["private_ip"])
    eni = ec2_client.describe_network_interfaces(
        NetworkInterfaceIds=[OPENSTACK_PUBLIC_ENI])["NetworkInterfaces"][0]
    subnet = ec2_client.describe_subnets(SubnetIds=[eni["SubnetId"]])["Subnets"][0]
    if ip not in ipaddress.IPv4Network(subnet["CidrBlock"]):
        raise ValueError("Private IP is outside the target ENI subnet")
    address = read_address(event["allocation_id"], event["instance_id"], event["elastic_ip"])
    if address.get("AssociationId") and (
        address.get("NetworkInterfaceId") != OPENSTACK_PUBLIC_ENI
        or address.get("PrivateIpAddress") != str(ip)
    ):
        raise ValueError("Elastic IP is associated with another target")
    for assigned_ip in eni["PrivateIpAddresses"]:
        association = assigned_ip.get("Association", {})
        if (assigned_ip["PrivateIpAddress"] == str(ip) and association
                and association.get("PublicIp") != event["elastic_ip"]):
            raise ValueError("Target private IP already has another Elastic IP")
    owners = ec2_client.describe_network_interfaces(Filters=[{
        "Name": "addresses.private-ip-address", "Values": [str(ip)]}])["NetworkInterfaces"]
    if any(owner["NetworkInterfaceId"] != OPENSTACK_PUBLIC_ENI for owner in owners):
        raise ValueError("Private IP belongs to another ENI")
    return eni


def ensure_elastic_ip(event):
    eni = validate_network(event)
    private_ip = event["private_ip"]
    if not any(p["PrivateIpAddress"] == private_ip for p in eni["PrivateIpAddresses"]):
        ec2_client.assign_private_ip_addresses(NetworkInterfaceId=OPENSTACK_PUBLIC_ENI,
            PrivateIpAddresses=[private_ip], AllowReassignment=False)
    for _ in range(10):
        eni = ec2_client.describe_network_interfaces(
            NetworkInterfaceIds=[OPENSTACK_PUBLIC_ENI])["NetworkInterfaces"][0]
        if any(p["PrivateIpAddress"] == private_ip for p in eni["PrivateIpAddresses"]):
            break
        time.sleep(1)
    else:
        raise TimeoutError("Private IP registration was not confirmed")
    address = read_address(event["allocation_id"], event["instance_id"], event["elastic_ip"])
    if address.get("AssociationId"):
        if (address.get("NetworkInterfaceId"), address.get("PrivateIpAddress")) != (
                OPENSTACK_PUBLIC_ENI, private_ip):
            raise ValueError("Elastic IP association changed during provisioning")
    else:
        ec2_client.associate_address(AllocationId=event["allocation_id"],
            NetworkInterfaceId=OPENSTACK_PUBLIC_ENI, PrivateIpAddress=private_ip,
            AllowReassociation=False)
    for _ in range(10):
        address = read_address(event["allocation_id"], event["instance_id"], event["elastic_ip"])
        if (address.get("AssociationId") and address.get("NetworkInterfaceId") == OPENSTACK_PUBLIC_ENI
                and address.get("PrivateIpAddress") == private_ip):
            return address["AssociationId"]
        if address.get("AssociationId"):
            raise ValueError("Elastic IP was associated with another target")
        time.sleep(1)
    raise TimeoutError("Elastic IP association was not confirmed")


def lambda_handler(event, context):
    event = dict(event)
    event["server_id"] = event.get("server_id") or event.get("nova_id")
    validate_network(event)
    server_id = event["server_id"]
    token, _ = get_keystone_token()
    sg_id, sg_name = get_or_create_1to1_security_group(token, server_id)
    server_url = f"{NOVA_URL}/servers/{server_id}"
    _, result = send_api_request(server_url, token=token)
    if not any(sg.get("name") == sg_name for sg in result["server"].get("security_groups", [])):
        send_api_request(f"{server_url}/action", method="POST", token=token,
            body={"addSecurityGroup": {"name": sg_name}},
            extra_headers={"OpenStack-API-Version": "compute 2.90"})
    for _ in range(10):
        _, result = send_api_request(server_url, token=token)
        if any(sg.get("name") == sg_name for sg in result["server"].get("security_groups", [])):
            break
        time.sleep(1)
    else:
        raise TimeoutError("Nova security group assignment was not confirmed")
    ensure_elastic_ip(event)
    return {"status": "SECURITY_GROUP_ASSIGNED", "server_id": server_id,
            "security_group": sg_name, "security_group_id": sg_name,
            "neutron_sg_id": sg_id, "elastic_ip": event["elastic_ip"],
            "private_ip": event["private_ip"]}

