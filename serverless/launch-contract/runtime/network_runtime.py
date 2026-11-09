"""Version 1 network contract. Mapping records are keyed ONLY by nova_id."""
import hashlib
import ipaddress
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
HOST = os.environ.get("GATEWAY_HOST_ID", "i-056d7f3dd24156234")
ENI = os.environ.get("OPENSTACK_PUBLIC_ENI", "eni-091eaee3e69e3f42d")
MAP = "XRegion-NetworkMappings"
RES = "XRegion-NetworkReservations"
MODE = "linux_nat_v1"
STORAGE_BACKEND = "aws-ebs"
CINDER_VOLUME_TYPE = "aws-ebs-gp3"
SESSION = boto3.Session(region_name=REGION)
DDB = SESSION.resource("dynamodb")
EC2 = SESSION.client("ec2")
SSM = SESSION.client("ssm")
SERIALIZER = TypeSerializer()
TOKEN = None


class PoolNotReady(RuntimeError):
    pass


class LaunchMaintenance(RuntimeError):
    pass


class StorageUnavailable(RuntimeError):
    pass


def ebs_pool_record(record):
    return (record.get("storage_backend") == STORAGE_BACKEND and
            record.get("cinder_volume_type") == CINDER_VOLUME_TYPE and
            bool(re.fullmatch(r"vol-(?:[0-9a-f]{8}|[0-9a-f]{17})", record.get("ebs_volume_id", ""))))


def validate_ebs_mapping(record, volume):
    if not ebs_pool_record(record) or volume.get("volume_type", volume.get("type")) != CINDER_VOLUME_TYPE or volume.get("provider_id") != record["ebs_volume_id"]:
        raise StorageUnavailable("Cinder/EBS backend mapping mismatch (type=" +
            str(volume.get("volume_type", volume.get("type"))) + ", provider_present=" +
            str(bool(volume.get("provider_id"))) + ")")
    disk = EC2.describe_volumes(VolumeIds=[record["ebs_volume_id"]])["Volumes"][0]
    tags = {t["Key"]: t["Value"] for t in disk.get("Tags", [])}
    if (tags.get("ManagedBy") != "xregion-cinder-ebs-v1" or
            tags.get("CinderVolumeId") != record["cinder_volume_id"] or
            tags.get("StorageBackend") != STORAGE_BACKEND or tags.get("StorageHostId") != HOST or
            disk.get("VolumeType") != "gp3" or not disk.get("Encrypted") or
            disk["Size"] != volume["size"] or
            any(a["InstanceId"] != HOST for a in disk.get("Attachments", []))):
        raise StorageUnavailable("EBS ownership, attachment or size mismatch")
    return disk


def checked_volume(volume_id, image_id):
    project = os.environ.get("OS_PROJECT_ID", "d3bf05331973481891385d066d3eba3e")
    volume = os_api("CINDER", "/" + project + "/volumes/" + volume_id)["volume"]
    if volume.get("status") != "available" or volume.get("attachments") or str(volume.get("bootable")).lower() != "true":
        raise StorageUnavailable("Boot volume is not available and bootable")
    if volume.get("volume_image_metadata", {}).get("image_id") != image_id:
        raise StorageUnavailable("Boot volume image does not match the requested image")
    return volume


def emit(event, operation, status, **fields):
    print(json.dumps(dict(schema_version=1, timestamp=int(time.time()), operation=operation,
        status=status, execution_arn=event.get("execution_arn"), reservation_id=event.get("reservation_id"),
        nova_id=event.get("nova_id"), generation=event.get("generation"),
        ssm_command_id=event.get("ssm_command_id"), **fields), default=str))


def wire(item):
    return {k: SERIALIZER.serialize(v) for k, v in item.items()}


def get(table, key, value):
    return native(DDB.Table(table).get_item(Key={key: value}, ConsistentRead=True).get("Item"))


def native(value):
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    if isinstance(value, dict):
        return {k: native(v) for k, v in value.items()}
    if isinstance(value, list):
        return [native(v) for v in value]
    return value


def update(table, key, value, fields):
    names = {f"#k{i}": k for i, k in enumerate(fields)}
    values = {f":v{i}": v for i, v in enumerate(fields.values())}
    DDB.Table(table).update_item(Key={key: value},
        UpdateExpression="SET " + ",".join(f"#k{i}=:v{i}" for i in range(len(fields))),
        ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def scan(table, **kw):
    out = []
    while True:
        result = DDB.Table(table).scan(**kw)
        out.extend(result.get("Items", []))
        if not result.get("LastEvaluatedKey"):
            return native(out)
        kw["ExclusiveStartKey"] = result["LastEvaluatedKey"]


def os_api(service, path, method="GET", body=None, missing=False):
    global TOKEN
    if not TOKEN:
        payload = {"auth": {"identity": {"methods": ["password"], "password": {"user": {
            "name": os.environ.get("OS_USERNAME", "admin"), "domain": {"name": "Default"},
            "password": os.environ["OS_PASSWORD"]}}}, "scope": {"project": {
                "name": "service", "domain": {"name": "Default"}}}}}
        req = urllib.request.Request(os.environ["KEYSTONE_URL"].rstrip("/") + "/auth/tokens",
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as response:
            project_id = json.loads(response.read())["token"]["project"]["id"]
            if os.environ.get("OS_PROJECT_ID") and project_id != os.environ["OS_PROJECT_ID"]:
                raise ValueError("Keystone project does not match configured Cinder project")
            TOKEN = response.headers["X-Subject-Token"]
    headers = {"Content-Type": "application/json", "X-Auth-Token": TOKEN}
    if service == "CINDER":
        # provider_id is exposed to administrators only from microversion 3.21.
        headers["OpenStack-API-Version"] = "volume 3.42"
    req = urllib.request.Request(os.environ[service + "_URL"].rstrip("/") + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as error:
        if error.code == 404 and missing:
            return None
        raise RuntimeError(f"OpenStack {service} HTTP {error.code} {method}") from None


def lease(event):
    rid = event.get("reservation_id") or event["execution_arn"]
    return get(RES, "resource_key", "LEASE#" + rid)


def mapping(event):
    return get(MAP, "nova_id", str(uuid.UUID(event["nova_id"])))


def carry(event, record):
    result = dict(event)
    for k, v in record.items():
        if k != "resource_key":
            result[k] = v
    return result


def claim_put(key, rid):
    return {"Put": {"TableName": RES, "Item": wire(dict(resource_key=key, reservation_id=rid)),
                    "ConditionExpression": "attribute_not_exists(resource_key)"}}


def admission(event):
    try:
        config = json.loads(SSM.get_parameter(Name=os.environ["LAUNCH_ADMISSION_PARAMETER"])["Parameter"]["Value"])
    except (KeyError, ValueError, ClientError) as error:
        raise LaunchMaintenance("Launch temporarily unavailable; admission configuration unavailable") from error
    if config.get("mode") == "open":
        return
    allowed = config.get("canary") or {}
    if (config.get("mode") == "maintenance" and allowed.get("username") and allowed.get("name") and
            event.get("username") == allowed["username"] and event.get("instance_name") == allowed["name"] and
            event.get("key_id") == allowed.get("key_id")):
        owner = get("XRegion-Instances", "instance_id", event["instance_id"]) or {}
        if owner.get("user_id") == "usr-" + allowed["username"] and owner.get("requested_name") == allowed["name"]:
            return
    raise LaunchMaintenance("Launch temporarily unavailable during NAT maintenance; no resources allocated")


def check_pool(event):
    rid = event.get("reservation_id") or event["execution_arn"]
    admission(event)
    uuid.UUID(event["image_id"])
    size = event.get("size_gb")
    if isinstance(size, bool) or not isinstance(size, int) or size < 1 or event.get("username") is None:
        raise ValueError("Invalid launch request")
    if get(RES, "resource_key", "LEASE#" + rid):
        owner = get("XRegion-Instances", "instance_id", event["instance_id"]) or {}
        if owner.get("launch_execution_arn") != rid:
            raise ValueError("Reservation belongs to another launch")
        return dict(event, reservation_id=rid)
    volumes = scan("XRegion-Volumes", FilterExpression="#s=:s AND image_id=:image",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "AVAILABLE", ":image": event["image_id"]})
    volumes = [v for v in volumes if ebs_pool_record(v)]
    if not volumes:
        raise PoolNotReady("No available reserve volume for the requested image")
    spare = [a for a in EC2.describe_addresses()["Addresses"]
             if not a.get("AssociationId") and
             {t["Key"]: t["Value"] for t in a.get("Tags", [])}.get("Project") == "xregion" and
             not {t["Key"]: t["Value"] for t in a.get("Tags", [])}.get("ClaimedBy") and
             not get(RES, "resource_key", "EIP#" + a["AllocationId"])]
    if not spare:
        raise PoolNotReady("No unclaimed xregion EIP in reserve pool")
    # Do not replace a launch owned by another execution, even if it is still pending.
    DDB.Table("XRegion-Instances").update_item(Key={"instance_id": event["instance_id"]},
        UpdateExpression="SET launch_execution_arn=:e",
        ConditionExpression="attribute_exists(instance_id) AND (attribute_not_exists(launch_execution_arn) OR launch_execution_arn=:e)",
        ExpressionAttributeValues={":e": rid})
    eni = EC2.describe_network_interfaces(NetworkInterfaceIds=[ENI])["NetworkInterfaces"][0]
    host = EC2.describe_instances(InstanceIds=[HOST])["Reservations"][0]["Instances"][0]
    cap = EC2.describe_instance_types(InstanceTypes=[host["InstanceType"]])["InstanceTypes"][0]["NetworkInfo"]["Ipv4AddressesPerInterface"]
    if len(eni["PrivateIpAddresses"]) >= cap:
        raise RuntimeError("Gateway ENI address capacity exhausted")
    return dict(event, reservation_id=rid, network_mode=MODE)


def allocate(event):
    if event.get("diagnostic_only") is True:
        volume = checked_volume(str(uuid.UUID(event["cinder_volume_id"])), event["image_id"])
        record = get("XRegion-Volumes", "volume_id", event["cinder_volume_key"]) or {}
        if record.get("cinder_volume_id") != event["cinder_volume_id"] or record.get("image_id") != event["image_id"]:
            raise ValueError("Diagnostic volume metadata mismatch")
        validate_ebs_mapping(record, volume)
        EC2.describe_addresses()
        return dict(diagnostic_only=True, status="PREFLIGHT_OK", volume_status=volume["status"])
    rid = event["reservation_id"]
    previous = lease(event)
    if previous:
        return carry(event, previous)
    flavors = os_api("NOVA", "/flavors/detail")["flavors"]
    if not any(event["flavor"] in (f["id"], f["name"]) for f in flavors):
        raise ValueError("Unknown Nova flavor")
    key_name = urllib.parse.quote(event["key_id"], safe="")
    os_api("NOVA", "/os-keypairs/" + key_name)
    volumes = scan("XRegion-Volumes", FilterExpression="#s=:s",
        ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": "AVAILABLE"})
    volumes = [v for v in volumes if v.get("image_id") == event.get("image_id") and ebs_pool_record(v)]
    addresses = EC2.describe_addresses()["Addresses"]
    for v in volumes:
        volume = checked_volume(v["cinder_volume_id"], event["image_id"])
        validate_ebs_mapping(v, volume)
        if event["size_gb"] < int(volume.get("volume_image_metadata", {}).get("min_disk", 0)):
            raise ValueError("Requested size is below the image minimum")
        for a in addresses:
            tags = {t["Key"]: t["Value"] for t in a.get("Tags", [])}
            if a.get("AssociationId") or tags.get("Project") != "xregion" or tags.get("ClaimedBy"):
                continue
            record = dict(resource_key="LEASE#" + rid, reservation_id=rid, network_mode=MODE,
                cinder_volume_key=v["volume_id"], cinder_volume_id=v.get("cinder_volume_id", v["volume_id"]),
                original_size_gb=int(volume["size"]), allocation_id=a["AllocationId"],
                elastic_ip=a["PublicIp"], status="RESERVED", created_at=int(time.time()))
            record.update(storage_backend=STORAGE_BACKEND, cinder_volume_type=CINDER_VOLUME_TYPE,
                          ebs_volume_id=v["ebs_volume_id"])
            tx = [claim_put("EIP#" + a["AllocationId"], rid), {"Put": {"TableName": RES,
                "Item": wire(record), "ConditionExpression": "attribute_not_exists(resource_key)"}},
                {"Update": {"TableName": "XRegion-Volumes", "Key": wire({"volume_id": v["volume_id"]}),
                 "UpdateExpression": "SET #s=:allocated, lease_instance_id=:i, leased_at=:t",
                 "ConditionExpression": "#s=:available AND storage_backend=:backend AND ebs_volume_id=:ebs", "ExpressionAttributeNames": {"#s": "status"},
                 "ExpressionAttributeValues": wire({":allocated": "ALLOCATED", ":available": "AVAILABLE",
                    ":i": event["instance_id"], ":t": int(time.time()),
                    ":backend": STORAGE_BACKEND, ":ebs": v["ebs_volume_id"]})}}]
            try:
                SESSION.client("dynamodb").transact_write_items(TransactItems=tx)
            except ClientError as error:
                if error.response["Error"]["Code"] != "TransactionCanceledException":
                    raise
                previous = lease(event)
                if previous:
                    return carry(event, previous)
                continue
            EC2.create_tags(Resources=[a["AllocationId"]], Tags=[
                {"Key": "ReservationId", "Value": rid}, {"Key": "ClaimedBy", "Value": rid}])
            return carry(event, record)
    raise RuntimeError("No unclaimed volume/EIP pair in xregion pools")


def reserve(event):
    r = lease(event)
    if not r:
        raise ValueError("Missing reservation")
    if not r.get("gateway_private_ip"):
        enis = EC2.describe_network_interfaces(Filters=[{"Name": "subnet-id", "Values": [os.environ["PUBLIC_SUBNET_ID"]]}])["NetworkInterfaces"]
        used = {p["PrivateIpAddress"] for e in enis for p in e["PrivateIpAddresses"]}
        old = os_api("NEUTRON", "/ports?network_id=" + os.environ["LEGACY_NETWORK_ID"])["ports"]
        used.update(p["ip_address"] for port in old for p in port["fixed_ips"])
        for suffix in range(10, 255):
            ip = f"10.20.1.{suffix}"
            if ip in used:
                continue
            tx = [claim_put("PRIVATEIP#" + ENI + "#" + ip, r["reservation_id"]),
                {"Update": {"TableName": RES, "Key": wire({"resource_key": r["resource_key"]}),
                 "UpdateExpression": "SET gateway_private_ip=:ip",
                 "ConditionExpression": "attribute_not_exists(gateway_private_ip)",
                 "ExpressionAttributeValues": wire({":ip": ip})}}]
            try:
                SESSION.client("dynamodb").transact_write_items(TransactItems=tx)
                r["gateway_private_ip"] = ip
                break
            except ClientError as error:
                if error.response["Error"]["Code"] != "TransactionCanceledException":
                    raise
                r = lease(event)
                if r.get("gateway_private_ip"):
                    break
        else:
            raise RuntimeError("Gateway private IP pool exhausted")
    owners = EC2.describe_network_interfaces(Filters=[{"Name": "addresses.private-ip-address",
        "Values": [r["gateway_private_ip"]]}])["NetworkInterfaces"]
    if any(e["NetworkInterfaceId"] != ENI for e in owners):
        raise RuntimeError("Reserved IP now belongs to another ENI")
    if not owners:
        EC2.assign_private_ip_addresses(NetworkInterfaceId=ENI,
            PrivateIpAddresses=[r["gateway_private_ip"]], AllowReassignment=False)
    if not r.get("neutron_port_id"):
        name = "xrn-" + hashlib.sha256(r["reservation_id"].encode()).hexdigest()[:24]
        ports = os_api("NEUTRON", "/ports?name=" + name)["ports"]
        if len(ports) > 1:
            raise RuntimeError("Ambiguous reservation port")
        port = ports[0] if ports else os_api("NEUTRON", "/ports", "POST", {"port": {
            "name": name, "network_id": os.environ["NETWORK_ID"],
            "description": r["reservation_id"], "admin_state_up": True}})["port"]
        r.update(neutron_port_id=port["id"], guest_private_ip=port["fixed_ips"][0]["ip_address"],
                 network_id=port["network_id"], subnet_id=port["fixed_ips"][0]["subnet_id"])
        update(RES, "resource_key", r["resource_key"], {k: r[k] for k in
            ("neutron_port_id", "guest_private_ip", "network_id", "subnet_id")})
    return carry(event, r)


def boot(event):
    r = lease(event)
    if not r.get("nova_id"):
        servers = os_api("NOVA", "/servers/detail")["servers"]
        found = [s for s in servers if s.get("metadata", {}).get("xregion_reservation") == r["reservation_id"]]
        if len(found) > 1:
            raise RuntimeError("More than one Nova server for reservation")
        if found:
            r["nova_id"] = found[0]["id"]
        elif r.get("boot_attempted"):
            raise RuntimeError("Ambiguous Nova create; reconcile before retrying")
        else:
            volume = checked_volume(r["cinder_volume_id"], event["image_id"])
            if r.get("storage_backend") == STORAGE_BACKEND:
                validate_ebs_mapping(r, volume)
            receipt = event.get("volume_extension") or {}
            if (receipt.get("status") != "CONFIRMED" or receipt.get("cinder_volume_id") != r["cinder_volume_id"] or
                    volume["size"] < event["size_gb"]):
                raise StorageUnavailable("Requested volume size is not confirmed")
            flavor = event.get("flavor", "m1.medium")
            flavors = os_api("NOVA", "/flavors/detail")["flavors"]
            flavor_id = next(f["id"] for f in flavors if f["name"] == flavor or f["id"] == flavor)
            update(RES, "resource_key", r["resource_key"], {"boot_attempted": True})
            server = os_api("NOVA", "/servers", "POST", {"server": {
                "name": event["instance_name"], "flavorRef": flavor_id, "key_name": event["key_id"],
                "config_drive": True,
                "networks": [{"port": r["neutron_port_id"]}],
                "metadata": {"xregion_reservation": r["reservation_id"]},
                "block_device_mapping_v2": [{"boot_index": 0, "uuid": r["cinder_volume_id"],
                    "source_type": "volume", "destination_type": "volume", "delete_on_termination": False}]}})["server"]
            r["nova_id"] = server["id"]
        update(RES, "resource_key", r["resource_key"], {"nova_id": r["nova_id"]})
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        server = os_api("NOVA", "/servers/" + r["nova_id"])["server"]
        if server["status"] == "ERROR":
            raise RuntimeError("Nova server entered ERROR")
        if server["status"] == "ACTIVE":
            port = os_api("NEUTRON", "/ports/" + r["neutron_port_id"])["port"]
            if port.get("device_id") != r["nova_id"]:
                raise RuntimeError("Reserved port attached to a different server")
            return dict(carry(event, r), server_id=r["nova_id"], private_ip=r["guest_private_ip"])
        time.sleep(3)
    raise TimeoutError("Nova server did not become ACTIVE")


def commit(event):
    r = lease(event)
    nid = str(uuid.UUID(event["nova_id"]))
    fields = ("reservation_id", "guest_private_ip", "gateway_private_ip", "elastic_ip", "allocation_id",
              "neutron_port_id", "network_id", "subnet_id")
    record = {k: r[k] for k in fields}
    record.update(nova_id=nid, network_mode=MODE, gateway_host_id=HOST, eni_id=ENI,
                  status="PROVISIONING", generation=1, created_at=int(time.time()), updated_at=int(time.time()))
    previous = get(MAP, "nova_id", nid)
    if previous:
        if previous["reservation_id"] != r["reservation_id"]:
            raise ValueError("Nova mapping ownership conflict")
        EC2.create_tags(Resources=[r["allocation_id"]], Tags=[{"Key": "ClaimedBy", "Value": nid},
            {"Key": "NovaId", "Value": nid}, {"Key": "ReservationId", "Value": r["reservation_id"]}])
        return carry(event, previous)
    tx = [{"Put": {"TableName": MAP, "Item": wire(record), "ConditionExpression": "attribute_not_exists(nova_id)"}},
          {"Update": {"TableName": RES, "Key": wire({"resource_key": r["resource_key"]}),
                      "UpdateExpression": "SET nova_id=:n, #s=:s",
                      "ExpressionAttributeNames": {"#s": "status"},
                      "ExpressionAttributeValues": wire({":n": nid, ":s": "COMMITTED"})}}]
    SESSION.client("dynamodb").transact_write_items(TransactItems=tx)
    EC2.create_tags(Resources=[r["allocation_id"]], Tags=[{"Key": "ClaimedBy", "Value": nid},
        {"Key": "NovaId", "Value": nid}, {"Key": "ReservationId", "Value": r["reservation_id"]}])
    return carry(event, record)


def assign_group(event):
    m = mapping(event)
    groups = os_api("NEUTRON", "/security-groups?name=" + m["nova_id"])["security_groups"]
    if len(groups) > 1:
        raise ValueError("Ambiguous security group")
    sg = groups[0] if groups else os_api("NEUTRON", "/security-groups", "POST", {
        "security_group": {"name": m["nova_id"], "description": "xregion NAT guest"}})["security_group"]
    for protocol, ports in (("tcp", {"port_range_min": 22, "port_range_max": 22}), ("icmp", {})):
        desired = dict(security_group_id=sg["id"], direction="ingress", ethertype="IPv4",
                       remote_ip_prefix="0.0.0.0/0", protocol=protocol, **ports)
        current = os_api("NEUTRON", "/security-groups/" + sg["id"])["security_group"]["security_group_rules"]
        if not any(all(rule.get(k) == v for k, v in desired.items()) for rule in current):
            os_api("NEUTRON", "/security-group-rules", "POST", {"security_group_rule": desired})
    port = os_api("NEUTRON", "/ports/" + m["neutron_port_id"])["port"]
    ids = sorted(set(port.get("security_groups", []) + [sg["id"]]))
    os_api("NEUTRON", "/ports/" + m["neutron_port_id"], "PUT", {"port": {"security_groups": ids}})
    update(MAP, "nova_id", m["nova_id"], {"neutron_sg_id": sg["id"], "security_group_id": m["nova_id"]})
    return dict(event, neutron_sg_id=sg["id"], security_group_id=m["nova_id"])


def dispatch(event):
    m = mapping(event)
    op = event.get("network_operation", "APPLY")
    if op not in ("APPLY", "REMOVE", "VERIFY"):
        raise ValueError("Unknown network operation")
    claim = get(RES, "resource_key", "EIP#" + m["allocation_id"])
    if not claim or claim["reservation_id"] != m["reservation_id"]:
        raise ValueError("EIP reservation ownership mismatch")
    desired = "DELETING" if op == "REMOVE" else "APPLYING"
    if op != "VERIFY":
        if m["status"] != desired and not (op == "APPLY" and m["status"] == "ACTIVE"):
            update(MAP, "nova_id", m["nova_id"], {"status": desired, "generation": int(m["generation"]) + 1})
            m = mapping(event)
        if op == "APPLY":
            addr = EC2.describe_addresses(AllocationIds=[m["allocation_id"]])["Addresses"][0]
            tags = {t["Key"]: t["Value"] for t in addr.get("Tags", [])}
            if tags.get("ReservationId") != m["reservation_id"] or tags.get("NovaId") != m["nova_id"]:
                raise ValueError("EIP tags do not match Nova reservation")
            if addr.get("AssociationId"):
                if (addr.get("NetworkInterfaceId"), addr.get("PrivateIpAddress")) != (ENI, m["gateway_private_ip"]):
                    raise ValueError("EIP associated to another target")
            else:
                EC2.associate_address(AllocationId=m["allocation_id"], NetworkInterfaceId=ENI,
                    PrivateIpAddress=m["gateway_private_ip"], AllowReassociation=False)
    if m.get("command_operation") == op and m.get("command_generation") == m["generation"]:
        if not m.get("ssm_command_id"):
            raise RuntimeError("Ambiguous SSM dispatch; reconcile command before retry")
        return dict(event, ssm_command_id=m["ssm_command_id"], command_deadline=int(m["command_deadline"]),
                    network_operation=op, command_status="PENDING", generation=int(m["generation"]))
    deadline = int(time.time()) + (660 if op == "VERIFY" else 120)
    update(MAP, "nova_id", m["nova_id"], {"command_operation": op, "command_generation": int(m["generation"]),
           "ssm_command_id": "", "command_deadline": deadline})
    r = SSM.send_command(InstanceIds=[HOST], DocumentName="XRegion-NetworkGateway",
        Parameters={"operation": [op], "novaId": [m["nova_id"]]}, TimeoutSeconds=60,
        CloudWatchOutputConfig={"CloudWatchOutputEnabled": True, "CloudWatchLogGroupName": "/xregion/network/ssm"})
    cid = r["Command"]["CommandId"]
    update(MAP, "nova_id", m["nova_id"], {"ssm_command_id": cid})
    return dict(event, ssm_command_id=cid, command_deadline=deadline,
                command_status="PENDING", network_operation=op, generation=int(m["generation"]))


def check_command(event):
    try:
        r = SSM.get_command_invocation(CommandId=event["ssm_command_id"], InstanceId=HOST)
    except SSM.exceptions.InvocationDoesNotExist:
        if int(time.time()) > event["command_deadline"]:
            raise TimeoutError("Network command deadline exceeded") from None
        return dict(event, command_status="PENDING")
    if r["Status"] in ("Pending", "InProgress", "Delayed"):
        if int(time.time()) > event["command_deadline"]:
            raise TimeoutError("Network command deadline exceeded")
        return dict(event, command_status="RUNNING")
    if r["Status"] != "Success":
        raise RuntimeError("Gateway command " + r["Status"])
    m = mapping(event)
    if event["network_operation"] != "VERIFY" and m.get("applied_generation") != m["generation"]:
        raise RuntimeError("Gateway generation not confirmed")
    return dict(event, command_status="SUCCEEDED")


def verify(event):
    m = mapping(event)
    addr = EC2.describe_addresses(AllocationIds=[m["allocation_id"]])["Addresses"][0]
    if (addr.get("NetworkInterfaceId"), addr.get("PrivateIpAddress")) != (ENI, m["gateway_private_ip"]):
        raise RuntimeError("EIP association verification failed")
    if m.get("applied_generation") != m["generation"]:
        raise RuntimeError("NAT generation mismatch")
    # Verification is asynchronous too; the same polling states are reused.
    return dispatch(dict(event, network_operation="VERIFY"))


def sync(event):
    import legacy
    if event.get("error"):
        current = lease(event) if event.get("reservation_id") else {}
        error = event["error"]
        code = error.get("Error", "ProvisioningError")
        if event.get("network_operation"):
            code = "NetworkTimeout" if code == "TimeoutError" else "NetworkProvisioningError"
        messages = {"LaunchMaintenance": "Launch is unavailable during maintenance",
                    "PoolNotReady": "No matching volume or unclaimed EIP is ready",
                    "StorageUnavailable": "The requested boot volume failed storage validation",
                    "NetworkTimeout": "Network configuration timed out",
                    "NetworkProvisioningError": "Network configuration or verification failed"}
        fields = {
            "current_status": "FAILED", "failure_reason": code,
            "failure_message": messages.get(code, "Provisioning failed; inspect the execution logs"),
            "failed_nova_id": event.get("nova_id", (current or {}).get("nova_id", "")),
            "failed_reservation_id": event.get("reservation_id", "")}
        DDB.Table("XRegion-Instances").update_item(Key={"instance_id": event["instance_id"]},
            UpdateExpression="SET " + ",".join(f"#f{i}=:v{i}" for i in range(len(fields))),
            ExpressionAttributeNames={f"#f{i}": k for i, k in enumerate(fields)},
            ConditionExpression="attribute_exists(instance_id) AND (attribute_not_exists(launch_execution_arn) OR launch_execution_arn=:execution)",
            # CheckPool may fail before assigning an execution; a stale failure must not overwrite a newer launch.
            ExpressionAttributeValues={**{f":v{i}": v for i, v in enumerate(fields.values())},
                                       ":execution": event.get("execution_arn") or event.get("reservation_id", "")})
        return event
    m = mapping(event)
    receipt = event["volume_extension"]
    if receipt.get("status") != "CONFIRMED" or receipt.get("actual_size_gb", 0) < event["size_gb"]:
        raise StorageUnavailable("Confirmed volume size missing at synchronization")
    legacy.lambda_handler(dict(event, server_id=m["nova_id"], private_ip=m["guest_private_ip"],
        elastic_ip=m["elastic_ip"], security_group_id=m["nova_id"]), None)
    storage = {k: event[k] for k in ("storage_backend", "cinder_volume_type", "ebs_volume_id") if k in event}
    DDB.Table("XRegion-Instances").update_item(Key={"instance_id": event["instance_id"]},
        UpdateExpression="SET confirmed_size_gb=:size" + "".join(", " + k + "=:storage" + str(i) for i, k in enumerate(storage)),
        ConditionExpression="launch_execution_arn=:owner",
        ExpressionAttributeValues={":size": receipt["actual_size_gb"], ":owner": event["reservation_id"],
            **{":storage" + str(i): v for i, v in enumerate(storage.values())}})
    update("XRegion-Nova", "nova_id", m["nova_id"], {"network_mode": MODE,
        "gateway_private_ip": m["gateway_private_ip"], "network_mapping_id": m["nova_id"], **storage})
    update(MAP, "nova_id", m["nova_id"], {"status": "ACTIVE", "updated_at": int(time.time())})
    return dict(event, status="SUCCESS", private_ip=m["guest_private_ip"], network_mode=MODE)


CLEANUP_PHASES = ("STARTED", "DISASSOCIATED", "PORT_DELETED", "IP_UNASSIGNED", "TAGS_REMOVING", "TAGS_REMOVED")


def cleanup_checkpoint(m, phase, extra=None):
    previous = m.get("cleanup_phase")
    if previous and CLEANUP_PHASES.index(previous) >= CLEANUP_PHASES.index(phase):
        return
    condition = (Attr("generation").eq(m["generation"]) & Attr("reservation_id").eq(m["reservation_id"])
                 & Attr("status").eq("DELETING") & Attr("applied_generation").eq(m["generation"])
                 & Attr("applied_status").eq("DELETING"))
    if previous:
        condition &= Attr("cleanup_phase").eq(previous) & Attr("cleanup_generation").eq(m["generation"])
    else:
        condition &= Attr("cleanup_phase").not_exists() & Attr("cleanup_generation").not_exists()
    fields = dict(cleanup_phase=phase, cleanup_generation=m["generation"], updated_at=int(time.time()), **(extra or {}))
    DDB.Table(MAP).update_item(Key={"nova_id": m["nova_id"]},
        # boto3's Attr condition builder owns :v0, :v1, ...; update values need a distinct namespace.
        UpdateExpression="SET " + ",".join(f"#f{i}=:u{i}" for i in range(len(fields))),
        ExpressionAttributeNames={f"#f{i}": k for i, k in enumerate(fields)},
        ExpressionAttributeValues={f":u{i}": v for i, v in enumerate(fields.values())},
        ConditionExpression=condition)
    m.update(fields)


def cleanup_owner(m):
    current = mapping(m)
    if (current["generation"], current["reservation_id"], current["status"]) != (
            m["generation"], m["reservation_id"], "DELETING"):
        raise ValueError("Cleanup generation or ownership changed")
    for key in ("EIP#" + m["allocation_id"], "PRIVATEIP#" + ENI + "#" + m["gateway_private_ip"],
                "LEASE#" + m["reservation_id"]):
        claim = get(RES, "resource_key", key)
        if not claim or claim.get("reservation_id") != m["reservation_id"]:
            raise ValueError("Cleanup reservation ownership changed")
    a = EC2.describe_addresses(AllocationIds=[m["allocation_id"]])["Addresses"][0]
    tags = {t["Key"]: t["Value"] for t in a.get("Tags", [])}
    allow_missing = (m.get("cleanup_generation") == m["generation"] and
                     m.get("cleanup_phase") in ("TAGS_REMOVING", "TAGS_REMOVED"))
    for key, expected in (("ReservationId", m["reservation_id"]), ("NovaId", m["nova_id"])):
        if tags.get(key) != expected and not (allow_missing and key not in tags):
            raise ValueError("Refusing cleanup after EIP ownership change")
    if tags.get("ClaimedBy") not in (None, m["nova_id"], m["reservation_id"]):
        raise ValueError("EIP claimed by another owner")
    if a.get("AssociationId") and (a.get("NetworkInterfaceId"), a.get("PrivateIpAddress")) != (ENI, m["gateway_private_ip"]):
        raise ValueError("Refusing to disassociate another target")
    return a


def confirm_absent(check, label):
    for attempt in range(5):
        if not check():
            return
        if attempt < 4:
            time.sleep(2)
    raise TimeoutError(label + " removal not confirmed")


def release(event):
    if event.get("release_operation", "LOAD") == "LOAD":
        nid = event.get("nova_id") or event.get("server_id")
        if not nid and event.get("instance_id"):
            instance = get("XRegion-Instances", "instance_id", event["instance_id"]) or {}
            nid = instance.get("active_nova_id") or instance.get("current_nova_id")
        m = get(MAP, "nova_id", nid) if nid else None
        if not m:
            return dict(event, network_mode="legacy", network_cleanup_complete=False)
        r = get(RES, "resource_key", "LEASE#" + m["reservation_id"]) or {}
        return dict(carry(event, r), **m, server_id=nid, private_ip=m["guest_private_ip"],
                    network_operation="REMOVE", release_operation="FINALIZE", network_cleanup_complete=m["status"] == "DELETED")
    m = mapping(event)
    if ("generation" in event and event["generation"] != m.get("generation")) or ("reservation_id" in event and event["reservation_id"] != m.get("reservation_id")):
        raise ValueError("Stale cleanup generation or reservation")
    if m["status"] == "DELETED":
        return dict(event, cleanup_volume=m.get("cleanup_volume", {}))
    if m.get("cleanup_phase") and m.get("cleanup_generation") != m["generation"]:
        raise ValueError("Stale cleanup checkpoint")
    if m.get("applied_status") != "DELETING" or m.get("applied_generation") != m["generation"]:
        raise RuntimeError("NAT removal is not confirmed")
    if os_api("NOVA", "/servers/" + m["nova_id"], missing=True):
        raise RuntimeError("Nova must be deleted before network release")
    a = cleanup_owner(m)
    volume_context = m.get("cleanup_volume") or {k: event[k] for k in ("cinder_volume_key", "cinder_volume_id") if event.get(k)}
    cleanup_checkpoint(m, "STARTED", {"cleanup_volume": volume_context})
    if a.get("AssociationId"):
        EC2.disassociate_address(AssociationId=a["AssociationId"])
    confirm_absent(lambda: cleanup_owner(m).get("AssociationId"), "EIP association")
    cleanup_checkpoint(m, "DISASSOCIATED")
    data = os_api("NEUTRON", "/ports/" + m["neutron_port_id"], missing=True)
    port = data["port"] if data else None
    if port:
        if port.get("device_id"):
            raise RuntimeError("Port still attached")
        os_api("NEUTRON", "/ports/" + m["neutron_port_id"], "DELETE", missing=True)
    confirm_absent(lambda: os_api("NEUTRON", "/ports/" + m["neutron_port_id"], missing=True), "Neutron port")
    cleanup_checkpoint(m, "PORT_DELETED")
    cleanup_owner(m)
    eni = EC2.describe_network_interfaces(NetworkInterfaceIds=[ENI])["NetworkInterfaces"][0]
    if any(p["PrivateIpAddress"] == m["gateway_private_ip"] and p["Primary"] for p in eni["PrivateIpAddresses"]):
        raise ValueError("Refusing to unassign primary ENI address")
    if any(p["PrivateIpAddress"] == m["gateway_private_ip"] for p in eni["PrivateIpAddresses"]):
        EC2.unassign_private_ip_addresses(NetworkInterfaceId=ENI, PrivateIpAddresses=[m["gateway_private_ip"]])
    confirm_absent(lambda: any(p["PrivateIpAddress"] == m["gateway_private_ip"] for p in
        EC2.describe_network_interfaces(NetworkInterfaceIds=[ENI])["NetworkInterfaces"][0]["PrivateIpAddresses"]), "Frontend IP")
    cleanup_checkpoint(m, "IP_UNASSIGNED")
    cleanup_owner(m)
    cleanup_checkpoint(m, "TAGS_REMOVING")
    a = cleanup_owner(m)
    tags = [t for t in a.get("Tags", []) if t["Key"] in ("ClaimedBy", "ClaimedAt", "NovaId", "ReservationId")]
    if tags:
        EC2.delete_tags(Resources=[m["allocation_id"]], Tags=tags)
    confirm_absent(lambda: [t for t in cleanup_owner(m).get("Tags", []) if t["Key"] in
        ("ClaimedBy", "ClaimedAt", "NovaId", "ReservationId")], "Ownership tags")
    cleanup_checkpoint(m, "TAGS_REMOVED")
    tx = [{"Update": {"TableName": MAP, "Key": wire({"nova_id": m["nova_id"]}),
        "UpdateExpression": "SET #s=:deleted, updated_at=:t",
        "ConditionExpression": "generation=:g AND reservation_id=:r AND #s=:deleting AND cleanup_generation=:g AND cleanup_phase=:phase",
        "ExpressionAttributeNames": {"#s": "status"}, "ExpressionAttributeValues": wire({
            ":deleted": "DELETED", ":t": int(time.time()), ":g": m["generation"], ":r": m["reservation_id"],
            ":deleting": "DELETING", ":phase": "TAGS_REMOVED"})}}]
    for key in ("EIP#" + m["allocation_id"], "PRIVATEIP#" + ENI + "#" + m["gateway_private_ip"],
                "LEASE#" + m["reservation_id"]):
        tx.append({"Delete": {"TableName": RES, "Key": wire({"resource_key": key}),
            "ConditionExpression": "reservation_id=:r",
            "ExpressionAttributeValues": wire({":r": m["reservation_id"]})}})
    SESSION.client("dynamodb").transact_write_items(TransactItems=tx)
    return dict(event, cleanup_volume=volume_context)


def delete_nova(event):
    if event.get("network_mode") != MODE:
        import legacy
        return dict(event, **legacy.lambda_handler(event, None))
    path = "/servers/" + str(uuid.UUID(event["nova_id"]))
    if os_api("NOVA", path, missing=True):
        os_api("NOVA", path, "DELETE", missing=True)
    deadline = time.monotonic() + 70
    while time.monotonic() < deadline:
        if os_api("NOVA", path, missing=True) is None:
            return event
        time.sleep(3)
    raise TimeoutError("Nova deletion not confirmed")


def delete_group(event):
    if event.get("network_mode") != MODE:
        import legacy
        return dict(event, **legacy.lambda_handler(event, None))
    groups = os_api("NEUTRON", "/security-groups?name=" + event["nova_id"])["security_groups"]
    if len(groups) > 1:
        raise ValueError("Ambiguous security group; refusing cleanup")
    for group in groups:
        if event.get("neutron_sg_id") and group["id"] != event["neutron_sg_id"]:
            raise ValueError("Security group identity changed")
        os_api("NEUTRON", "/security-groups/" + group["id"], "DELETE", missing=True)
    DDB.Table("XRegion-SecurityGroups").delete_item(Key={"group_id": event["nova_id"]})
    return event


def legacy_release(event):
    if event.get("network_mode") == MODE or (event.get("nova_id") and mapping(event)):
        raise ValueError("Use Network-Release for NAT mappings")
    import legacy
    return dict(event, **legacy.lambda_handler(event, None))


def term_sync(event):
    receipt = event.get("volume_cleanup", {})
    if receipt.get("status") != "DELETED" or not receipt.get("resources"):
        raise RuntimeError("Volume cleanup incomplete")
    for resource in receipt["resources"]:
        v = get("XRegion-Volumes", "volume_id", resource["key"]) or {}
        actual = v.get("cinder_volume_id") if resource["kind"] == "cinder" else v.get("ebs_volume_id", v.get("volume_id"))
        if actual != resource["id"] or v.get("status") != "DELETED" or event["instance_id"] not in (v.get("attached_instance_id"), v.get("lease_instance_id")):
            raise RuntimeError("Volume cleanup ownership not confirmed")
    if event.get("network_mode") == MODE:
        m = mapping(event)
        if m["status"] != "DELETED":
            raise RuntimeError("Network cleanup incomplete")
        current = get("XRegion-Instances", "instance_id", event["instance_id"]) or {}
        nova = get("XRegion-Nova", "nova_id", event["nova_id"]) or {}
        if current.get("current_status") == "TERMINATED" and nova.get("status") == "TERMINATED":
            return dict(event, status="TERMINATED")
        now = int(time.time() * 1000)
        tx = [{"Update": {"TableName": "XRegion-Instances", "Key": wire({"instance_id": event["instance_id"]}),
            "ConditionExpression": "attribute_exists(instance_id) AND (active_nova_id=:n OR current_nova_id=:n) AND launch_execution_arn=:r",
            "UpdateExpression": "SET current_status=:s, active_nova_id=:empty, terminated_at=:t, migration_lock=:lock REMOVE current_nova_id",
            "ExpressionAttributeValues": wire({":s": "TERMINATED", ":empty": "", ":t": now, ":lock": False,
                ":n": event["nova_id"], ":r": m["reservation_id"]})}},
            {"Update": {"TableName": "XRegion-Nova", "Key": wire({"nova_id": event["nova_id"]}),
             "ConditionExpression": "attribute_exists(nova_id) AND instance_id=:i", "UpdateExpression": "SET #s=:s, terminated_at=:t",
             "ExpressionAttributeNames": {"#s": "status"}, "ExpressionAttributeValues": wire({":s": "TERMINATED", ":t": now, ":i": event["instance_id"]})}}]
        SESSION.client("dynamodb").transact_write_items(TransactItems=tx)
        return dict(event, status="TERMINATED")
    import legacy
    legacy.lambda_handler(event, None)
    return dict(event, status="TERMINATED")


HANDLERS = {"Reserve": reserve, "Commit": commit, "Dispatch": dispatch, "CheckCommand": check_command,
    "Verify": verify, "Release": release, "CheckPool": check_pool, "AllocateResource": allocate,
    "BootNova": boot, "AssignSecurityGroup": assign_group, "SyncDynamoDB": sync,
    "DeleteNova": delete_nova, "DeleteSecurityGroup": delete_group, "ReleaseEIP": legacy_release,
    "TerminateSync": term_sync}


def lambda_handler(event, context):
    global TOKEN
    TOKEN = None
    stage = os.environ["NETWORK_STAGE"]
    if "request" in event:
        event = dict(event["request"], execution_arn=event["execution_arn"])
    emit(event, stage, "STARTED")
    started = time.monotonic()
    try:
        result = HANDLERS[stage](dict(event))
        emit(result, stage, "SUCCEEDED", duration_ms=int((time.monotonic() - started) * 1000))
        return result
    except Exception as error:
        emit(event, stage, "FAILED", error_type=type(error).__name__)
        raise
