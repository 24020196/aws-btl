"""Security Group sync worker (code only; not deployed).

Reads the desired rules from XRegion-SecurityGroups, resolves the Nova VM through
XRegion-NetworkMappings (nova_id -> neutron_sg_id, neutron_port_id) and reconciles
the Neutron security group attached to that port.

Option B: the stored configuration is the FULL rule set of the guest security
group. After a group is marked managed, the worker creates missing rules and
deletes every extra rule of that group, including provisioning defaults (SSH,
ICMP, default egress). AWS EC2 security groups are never modified here because the
host ENI is shared by every guest.

Safety properties:
- Dry run by default. Live mode needs XREGION_SG_SYNC_LIVE=true.
- Live reconcile only for groups in XREGION_SG_SYNC_MANAGED_ALLOWLIST that are also
  flagged managed=true in DynamoDB; everything else is reported, not applied.
- Revision guard plus a per-group lease: stale, duplicate or concurrent events
  never touch Neutron or overwrite a newer result.
- The rule set is read back after applying; SYNCED requires no missing and no
  extra rule.
"""
import ipaddress
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

import boto3

REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
SGROUP_TABLE = os.environ.get("SECURITY_GROUPS_TABLE", "XRegion-SecurityGroups")
MAPPING_TABLE = os.environ.get("NETWORK_MAPPING_TABLE", "XRegion-NetworkMappings")
INSTANCES_TABLE = os.environ.get("INSTANCES_TABLE", "XRegion-Instances")
NOVA_TABLE = os.environ.get("NOVA_TABLE", "XRegion-Nova")
KEYSTONE_URL = os.environ.get("KEYSTONE_URL", "http://10.20.10.183:5000/v3")
NEUTRON_URL = os.environ.get("NEUTRON_URL", "http://10.20.10.183:9696/v2.0")
OS_USERNAME = os.environ.get("OS_USERNAME", "admin")
OS_PASSWORD = os.environ.get("OS_PASSWORD")
OS_PROJECT_NAME = os.environ.get("OS_PROJECT_NAME", "service")
LIVE = os.environ.get("XREGION_SG_SYNC_LIVE", "false").lower() == "true"
# Danh sach group duoc live-reconcile. Rong = chua nhan quan ly group nao.
ALLOWLIST = {g.strip() for g in os.environ.get("XREGION_SG_SYNC_MANAGED_ALLOWLIST", "").split(",") if g.strip()}
LEASE_MS = int(os.environ.get("XREGION_SG_SYNC_LEASE_MS", "120000"))

SYNCED, FAILED, NOT_APPLICABLE, BLOCKED = "SYNCED", "SYNC_FAILED", "SYNC_NOT_APPLICABLE", "SYNC_BLOCKED"
APPLICABLE_STATES = {"PENDING", "RUNNING", "STOPPED", "STOPPING", "SHELVED", "SHELVED_OFFLOADED", "MIGRATING"}
PROTOCOLS = {"tcp": "tcp", "udp": "udp", "icmp": "icmp", "all": None}


class SyncSkipped(Exception):
    """Event must not be applied (unknown group, stale revision, unsupported state)."""


class SyncBlocked(Exception):
    """Group cannot take ownership of the whole firewall yet (shared group, legacy data)."""


class BusyRetry(Exception):
    """Another worker holds the lease. Must be retried, never reported as success."""


def client(name):
    return boto3.client(name, region_name=REGION)


def plain(value):
    """DynamoDB AttributeValue -> plain python (the low-level client returns typed maps)."""
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, dict):
        if len(value) == 1:
            (tag, inner), = value.items()
            if tag in ("S", "B"):
                return inner
            if tag == "N":
                return int(Decimal(str(inner)))
            if tag == "NULL":
                return None
            if tag == "BOOL":
                # Phai tra bool that: {"BOOL": false} la dict truthy, bool() se coi group la managed.
                return bool(inner)
            if tag == "M":
                return {k: plain(v) for k, v in (inner or {}).items()}
            if tag == "L":
                return [plain(v) for v in (inner or [])]
            if tag == "SS":
                return sorted(inner or [])
            if tag == "NS":
                return sorted(int(v) for v in (inner or []))
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, str):
        return value
    # boto3 tra ve Binary/Decimal/... khong phai dict thuong: chuyen ve gia tri don gian.
    if hasattr(value, "items"):
        return {k: plain(v) for k, v in value.items()}
    return value


def rules_from_json(group, key):
    """Rules are stored as a JSON string in inbound_rules / outbound_rules (camelCase also accepted)."""
    camel = "inboundRules" if key == "inbound_rules" else "outboundRules"
    raw = group.get(key)
    if raw in (None, ""):
        raw = group.get(camel)
    if raw in (None, ""):
        return []
    if isinstance(raw, str):
        parsed = json.loads(raw)
    else:
        parsed = plain(raw)
    if not isinstance(parsed, list):
        raise ValueError(f"{key} must be a JSON array")
    return parsed


def get_item(table, key_name, key_value):
    item = client("dynamodb").get_item(TableName=table, Key={key_name: {"S": str(key_value)}},
                                       ConsistentRead=True).get("Item")
    return plain(item) if item else None


def update_item(table, key_name, key_value, expression, names, values, condition):
    args = dict(TableName=table, Key={key_name: {"S": str(key_value)}},
                UpdateExpression=expression, ConditionExpression=condition)
    if names:
        args["ExpressionAttributeNames"] = names
    if values:
        args["ExpressionAttributeValues"] = values
    client("dynamodb").update_item(**args)
    return True


def normalize_rule(rule, direction):
    """Logical rule -> Neutron security_group_rule. Raises ValueError for unsupported input."""
    protocol = str(rule.get("protocol", "")).lower()
    if protocol not in PROTOCOLS:
        raise ValueError(f"Unsupported protocol: {rule.get('protocol')}")
    cidr = str(rule.get("cidr", "") or "").strip()
    if cidr.startswith("sg-"):
        raise ValueError(f"{direction} rule references another logical group ({cidr}); not supported")
    if not cidr:
        # ip_network("") se thanh 0.0.0.0/0: CIDR thieu khong duoc bien thanh "moi nguon".
        raise ValueError(f"{direction} rule has no CIDR")
    network = ipaddress.ip_network(cidr, strict=False)
    if network.version != 4:
        raise ValueError(f"Only IPv4 is supported: {cidr}")
    neutron_protocol = PROTOCOLS[protocol]
    out = {"direction": "ingress" if direction == "inbound" else "egress",
           "ethertype": "IPv4",
           "remote_ip_prefix": str(network),
           "protocol": neutron_protocol,
           "description": "xregion"}
    if neutron_protocol in ("tcp", "udp"):
        start = int(rule.get("fromPort", 0))
        end = int(rule.get("toPort", 0)) or start
        if not (0 <= start <= end <= 65535):
            raise ValueError(f"Invalid port range {start}-{end}")
        # Port 0 khong phai cong that: chi nhan 0 khi ca hai dau deu 0 (moi cong).
        if start == 0 and end != 0:
            raise ValueError(f"Invalid port range {start}-{end}: port 0 cannot be a lower bound")
        # Luon gui port range: bo qua khi end=65535 se bien 443-65535 thanh moi cong phia Neutron.
        out.update(port_range_min=start, port_range_max=end)
    elif neutron_protocol == "icmp":
        # ICMP: fromPort/toPort la type/code, KHONG phai khoang tang dan:
        # type 8 / code 0 (echo request) phai giu nguyen 8/0, khong duoc thanh 8/8.
        start = int(rule.get("fromPort", 0) or 0)
        end = int(rule.get("toPort", 0) or 0)
        # Ho tro All ICMP tu UI (gui 0-65535 hoac 0-0): khong chi dinh port range min/max
        if start == 0 and end in (0, 65535):
            pass
        elif not (0 <= start <= 255 and 0 <= end <= 255):
            raise ValueError(f"Invalid ICMP type/code range {start}-{end}")
        elif start or end:
            out.update(port_range_min=start, port_range_max=end)
    return out



def rule_signature(rule):
    """Signature so khop rule Neutron, hoac None khi rule khong the so sanh an toan.

    Tra None cho: rule tham chieu group khac, IPv6, va rule chi co mot phia port range.
    None khong bao gio khop voi desired rule, nen rule do luon nam trong to_delete thay vi
    bi coi la "da dung".
    """
    if rule.get("remote_group_id"):
        return None
    ethertype = str(rule.get("ethertype") or "IPv4")
    if ethertype.lower() not in ("ipv4", "4"):
        return None
    protocol = rule.get("protocol")
    protocol = None if protocol in (None, "null", "any", "") else str(protocol).lower()
    if protocol is not None and protocol not in ("tcp", "udp", "icmp"):
        # Protocol so (vd 6) hoac la khac: khong doan, coi la khong so sanh duoc.
        return None
    direction = str(rule.get("direction") or "").lower()
    raw_min, raw_max = rule.get("port_range_min"), rule.get("port_range_max")
    if (raw_min is None) != (raw_max is None):
        return None
    start = int(raw_min or 0)
    end = int(raw_max or 0)
    cidr = str(rule.get("remote_ip_prefix") or "0.0.0.0/0")
    return (direction, "IPv4", protocol, start, end, cidr)


def desired_rules(group):
    """Logical inbound/outbound rules -> Neutron ingress/egress rules."""
    rules = []
    for direction, key in (("inbound", "inbound_rules"), ("outbound", "outbound_rules")):
        for rule in rules_from_json(group, key):
            rules.append(normalize_rule(rule, direction))
    return rules


def plan(security_group, rules):
    """Return (to_create, to_delete) without changing anything.

    Option B: every rule of the managed group that is not in the desired set is
    deleted, so provisioning defaults disappear when the user removes them.

    Rule khong so sanh duoc (signature None: IPv6, remote_group_id, port range mot phia)
    khong bao gio nam trong desired set nen luon bi xoa, khong bi coi la "da dung".
    Desired trung lap chi tao mot lan.
    """
    expected = {rule_signature(r) for r in rules}
    current = security_group.get("security_group_rules", []) or []
    present = {rule_signature(r) for r in current}
    to_create, seen = [], set()
    for rule in rules:
        signature = rule_signature(rule)
        if signature in present or signature in seen:
            continue
        seen.add(signature)
        to_create.append(rule)
    to_delete = [r["id"] for r in current if rule_signature(r) not in expected]
    return to_create, to_delete



# ---------------------------- OpenStack ----------------------------

def keystone_token():
    if not OS_PASSWORD:
        raise RuntimeError("OS_PASSWORD is not configured")
    body = {"auth": {"identity": {"methods": ["password"], "password": {"user": {
        "name": OS_USERNAME, "domain": {"name": "Default"}, "password": OS_PASSWORD}}},
        "scope": {"project": {"name": OS_PROJECT_NAME, "domain": {"name": "Default"}}}}}
    req = urllib.request.Request(f"{KEYSTONE_URL}/auth/tokens", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.headers.get("X-Subject-Token")


def neutron(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(NEUTRON_URL + path, data=data,
                                 headers={"Content-Type": "application/json", "X-Auth-Token": token},
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace") if e.fp else ""
        raise RuntimeError(f"Neutron {method} {path} failed [{e.code}]: {detail}") from e


def apply_rules(security_group_id, rules, token, live, guard=None):
    """Converge the guest security group to the desired rule set (option B).

    guard duoc goi truoc MOI mutation: neu lease/revision da mat thi dung lai truoc khi sua Neutron.
    """
    guard = guard or (lambda: None)
    group = neutron("GET", f"/security-groups/{security_group_id}", token)["security_group"]
    to_create, to_delete = plan(group, rules)
    result = {"security_group_id": security_group_id,
              "created": [rule_signature(r) for r in to_create],
              "deleted": to_delete,
              "applied": False}
    if not live:
        return result
    for rule in to_create:
        guard()
        neutron("POST", "/security-group-rules",
                token, {"security_group_rule": dict(rule, security_group_id=security_group_id)})
    for rule_id in to_delete:
        guard()
        neutron("DELETE", f"/security-group-rules/{rule_id}", token)
    # Doc lai va doi chieu CA HAI chieu truoc khi bao SYNCED: thieu hoac du deu la chua khop.
    actual = neutron("GET", f"/security-groups/{security_group_id}", token)["security_group"]
    actual_rules = {rule_signature(r) for r in actual.get("security_group_rules", [])}
    expected = {rule_signature(r) for r in rules}
    missing = expected - actual_rules
    extra = actual_rules - expected
    if missing or extra:
        raise RuntimeError(f"Neutron did not converge: {len(missing)} missing, {len(extra)} extra")
    result["applied"] = True
    result["verified"] = True
    return result



# ---------------------------- Worker ----------------------------

def resolve(event, live=None):
    """Event + DynamoDB -> mapping to apply. Raises SyncSkipped/SyncBlocked when unsafe."""
    live = LIVE if live is None else live
    group_id = str(event.get("group_id") or "")
    instance_id = str(event.get("instance_id") or "")
    revision = int(event.get("revision") or 0)
    if not group_id or not instance_id or revision <= 0:
        raise ValueError("group_id, instance_id and revision are required")
    group = get_item(SGROUP_TABLE, "group_id", group_id)
    if not group:
        raise SyncSkipped(f"group {group_id} no longer exists")
    if int(group.get("revision") or 0) != revision:
        raise SyncSkipped(f"stale event: group revision {group.get('revision')} != {revision}")
    instance = get_item(INSTANCES_TABLE, "instance_id", instance_id)
    if not instance:
        raise SyncSkipped(f"instance {instance_id} no longer exists")
    description = str(group.get("description") or "")
    linked_instance = str(group.get("instance_id") or "")
    # Liên kết chuẩn là cột instance_id (bản ghi do launch và backend tạo đều ghi).
    # Dữ liệu legacy chưa có cột này thì mới dựa vào câu mô tả cố định của backend.
    belongs = linked_instance == instance_id if linked_instance else description == f"Security group of {instance_id}"
    if not belongs:
        # Group rieng phai tro dung may: chan event dung revision nhung sai may.
        raise SyncSkipped(f"security group {group_id} does not belong to instance {instance_id}")
    owner = str(instance.get("user_id") or "").strip().lower().replace("usr-", "", 1)
    if not owner:
        raise SyncBlocked(f"instance {instance_id} has no user_id, ownership is unknown")
    if owner != str(group.get("owner") or "").strip().lower():
        raise SyncSkipped(f"security group owner does not match instance owner ({instance_id})")
    status = str(instance.get("current_status") or "").upper()
    if status not in APPLICABLE_STATES:
        raise SyncSkipped(f"instance status {status} has no network resources")

    candidates = []
    active_nova = str(instance.get("active_nova_id") or "")
    if active_nova:
        candidates.append(active_nova)
    group_nova = str(group.get("nova_id") or "").strip()
    nova = nova_for_instance(instance, instance_id, group_nova, event.get("nova_id"))
    if nova:
        if str(nova.get("instance_id") or "") != instance_id:
            raise SyncBlocked(f"Nova {nova.get('nova_id')} does not belong to instance {instance_id}")
        mapping = get_item(MAPPING_TABLE, "nova_id", nova["nova_id"])
    elif group_nova:
        mapping = get_item(MAPPING_TABLE, "nova_id", group_nova)
        if mapping and str(mapping.get("instance_id") or "") != instance_id:
            raise SyncBlocked(f"Neutron mapping {group_nova} does not belong to instance {instance_id}")
    else:
        raise SyncSkipped("no Nova record for the instance")
    if not mapping or not mapping.get("neutron_sg_id") or not mapping.get("neutron_port_id"):
        raise SyncSkipped("no Neutron mapping for the Nova VM")
    if str(mapping.get("status") or "").upper() in ("DELETED", "DELETING"):
        raise SyncSkipped("Neutron mapping is being removed")
    # Doi chieu group <-> mapping duoc verify_target lam bang association that tren Neutron port.
    return dict(group=group, instance=instance, instance_id=instance_id, nova=nova, mapping=mapping,
                revision=revision)


def nova_for_instance(instance, instance_id, group_nova=None, event_nova=None):
    """Tim Nova cua may. Uu tien nova_id gan tren Security Group (khi MigrateTargetBoot chua SyncDynamoDB),
    sau do toi active_nova_id, roi event_nova va index instance_id-index.

    Nova ID trong event khong duoc dung lam bang chung: no co the thuoc may khac hoac da bi thay.
    """
    group_nova = str(group_nova or "").strip()
    if group_nova:
        nova = get_item(NOVA_TABLE, "nova_id", group_nova)
        if nova and str(nova.get("instance_id") or "") == instance_id:
            return nova
        return None
    candidates = []
    active = str(instance.get("active_nova_id") or "").strip()
    if active and active not in candidates:
        candidates.append(active)
    if event_nova and str(event_nova).strip() not in candidates:
        # Chi de doi chieu / tra cuu, ket qua van phai qua kiem tra ownership ben duoi.
        candidates.append(str(event_nova).strip())
    for nova_id in candidates:
        nova = get_item(NOVA_TABLE, "nova_id", nova_id)
        if nova and str(nova.get("instance_id") or "") == instance_id:
            return nova
    indexed = query_index(NOVA_TABLE, "instance_id-index", "instance_id", instance_id)
    owned = [n for n in indexed if str(n.get("instance_id") or "") == instance_id]
    if len(owned) > 1:
        # Nhieu Nova cung tro mot may: khong doan cai nao dang giu port.
        raise SyncBlocked(f"instance {instance_id} has {len(owned)} Nova records; cannot pick one safely")
    return owned[0] if owned else None


def query_index(table, index_name, key_name, key_value, max_pages=20):
    """Query index day du; vuot gioi han trang thi bao loi thay vi tra ket qua mot phan."""
    args = dict(TableName=table, IndexName=index_name,
                KeyConditionExpression="#k = :v",
                ExpressionAttributeNames={"#k": key_name},
                ExpressionAttributeValues={":v": {"S": str(key_value)}})
    items, pages = [], 0
    while True:
        page = client("dynamodb").query(**args)
        items.extend(plain(item) for item in page.get("Items", []))
        pages += 1
        last = page.get("LastEvaluatedKey")
        if not last:
            return items
        if pages >= max_pages:
            # Bo qua phan con lai se lam "1 Nova" thanh ket luan sai: phai dung lai.
            raise SyncBlocked(f"{table} index {index_name} for {key_value} needs more than "
                              f"{max_pages} pages; cannot decide which Nova owns the instance")
        args["ExclusiveStartKey"] = last


def verify_target(mapping, instance_id, token):
    """Chung minh SG that su gan cho port cua may va khong duoc chia se.

    Quy uoc cua du an: security_group_id == nova_id (dinh danh logic, cung la TEN cua SG tren
    Neutron), con neutron_sg_id la UUID that. Chi UUID moi duoc dung de sua rule.

    Tra ve neutron_sg_id da xac minh. Moi bat thuong deu chan truoc khi sua rule, vi sua nham mot
    SG dung chung se doi firewall cua may khac (option B xoa MOI rule khong co trong cau hinh).
    """
    sg_id = str(mapping.get("neutron_sg_id") or "").strip()
    port_id = str(mapping.get("neutron_port_id") or "").strip()
    server_id = str(mapping.get("nova_id") or "").strip()
    logical_id = str(mapping.get("security_group_id") or "").strip()
    if not sg_id or not port_id or not server_id:
        raise SyncBlocked("Neutron mapping lacks neutron_sg_id/neutron_port_id/nova_id")
    if logical_id and logical_id != server_id:
        # security_group_id phai trung nova_id; khac nghia la du lieu mapping da bi lech.
        raise SyncBlocked(f"mapping security_group_id {logical_id} does not match nova_id {server_id}")

    port = neutron("GET", f"/ports/{port_id}", token)["port"]
    # Neutron tra security_groups la danh sach UUID, khong phai object.
    attached = {str(item) for item in port.get("security_groups", [])}
    if sg_id not in attached:
        raise SyncBlocked(f"security group {sg_id} is not attached to port {port_id}")
    device_id = str(port.get("device_id") or "").strip()
    if device_id != server_id:
        raise SyncBlocked(f"port {port_id} belongs to device {device_id or 'unbound'}, not Nova {server_id}")

    group = neutron("GET", f"/security-groups/{sg_id}", token)["security_group"]
    if str(group.get("id") or "") != sg_id:
        raise SyncBlocked(f"security group {sg_id} returned {group.get('id')}")
    # SG 1-1 mang ten bang nova_id: ten khac nghia la khong phai SG provisioning cua may nay.
    if str(group.get("name") or "") != server_id:
        raise SyncBlocked(f"security group {sg_id} name {group.get('name')!r} is not Nova {server_id}")

    users = ports_using_group(sg_id, token)
    others = users - {port_id}
    if others:
        raise SyncBlocked(f"security group {sg_id} is used by {len(others)} other port(s)")
    if port_id not in users:
        raise SyncBlocked(f"security group {sg_id} does not list port {port_id}; cannot prove exclusivity")
    return sg_id


MAX_PORT_PAGES = 100


def parse_marker(href):
    """Lay marker tu next link Neutron; tra None neu link khong dung dang mong doi.

    Phai parse query that: '?marker=abc&security_groups=<uuid>' khong duoc lay ca
    'abc&security_groups=...' lam marker, vi trang sau se sai hoac lap vo han.
    """
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(str(href or "")).query,
                                      keep_blank_values=True)
    except ValueError:
        return None
    markers = query.get("marker") or []
    if len(markers) != 1:
        return None
    return markers[0] or None


def ports_using_group(sg_id, token):
    """Liet ke moi port dang gan SG (co phan trang, khong tin danh sach rut gon trong group).

    Khong bao gio coi danh sach mot phan la bang chung: next link hong, marker lap hoac
    vuot gioi han trang deu nem SyncBlocked de verify_target dung truoc khi sua rule.
    """
    port_ids, marker, seen = set(), None, set()
    pages = 0
    while True:
        path = f"/ports?security_groups={urllib.parse.quote(str(sg_id), safe='')}"
        if marker:
            path += f"&marker={urllib.parse.quote(marker, safe='')}"
        payload = neutron("GET", path, token)
        if not isinstance(payload, dict):
            raise SyncBlocked(f"security group {sg_id} port inventory returned {type(payload).__name__}, "
                              "not a JSON object")
        ports = payload.get("ports")
        if not isinstance(ports, list):
            # Thieu "ports" khong phai la "khong con port nao": khong duoc coi la trang cuoi.
            raise SyncBlocked(f"security group {sg_id} port inventory has no port list; "
                              "cannot prove this group is used by one port only")
        pages += 1
        for port in ports:
            if not isinstance(port, dict) or not port.get("id"):
                raise SyncBlocked(f"security group {sg_id} port inventory has an entry without id")
            if sg_id in {str(item) for item in (port.get("security_groups") or [])}:
                port_ids.add(str(port.get("id")))
        links = payload.get("ports_links")
        if links is not None and not isinstance(links, list):
            raise SyncBlocked(f"security group {sg_id} returned malformed ports_links")
        next_links = [link for link in (links or [])
                      if isinstance(link, dict) and str(link.get("rel") or "") == "next"]
        if not next_links:
            return port_ids
        if len(next_links) != 1:
            raise SyncBlocked(f"security group {sg_id} returned {len(next_links)} next links; "
                              "cannot enumerate every port safely")
        marker = parse_marker(next_links[0].get("href"))
        if not marker:
            raise SyncBlocked(f"security group {sg_id} returned a next link without a usable marker")
        if marker in seen:
            raise SyncBlocked(f"security group {sg_id} pagination repeats marker {marker!r}")
        if pages >= MAX_PORT_PAGES:
            raise SyncBlocked(f"security group {sg_id} needs more than {MAX_PORT_PAGES} pages; "
                              "port inventory is incomplete")
        seen.add(marker)


def _lease_still_ours(now):
    # Owner va revision khong du: lease da het han thi worker khac co the da tiep quan.
    return "sync_lease_owner = :owner AND revision = :rev AND sync_lease_until > :now"


def renew_lease(group_id, revision, owner_id):
    """Gia han lease giua cac buoc mutation; that bai nghia la worker khac da tiep quan."""
    if not LIVE:
        return True
    now = int(time.time() * 1000)
    try:
        return update_item(SGROUP_TABLE, "group_id", group_id,
                           "SET sync_lease_until = :u",
                           None,
                           {":u": {"N": str(now + LEASE_MS)}, ":rev": {"N": str(int(revision))},
                            ":owner": {"S": owner_id}, ":now": {"N": str(now)}},
                           _lease_still_ours(now))
    except Exception as e:
        print(f"Lost lease for {group_id}: {e}")
        return False


def ensure_lease(group_id, revision, owner_id):
    if not renew_lease(group_id, revision, owner_id):
        raise SyncSkipped("lease lost or revision changed while reconciling; another worker owns this group")


def release_lease(group_id, revision, owner_id):
    if not LIVE:
        return
    try:
        update_item(SGROUP_TABLE, "group_id", group_id,
                    "SET sync_lease_owner = :empty REMOVE sync_lease_until",
                    None,
                    {":empty": {"S": ""}, ":rev": {"N": str(int(revision))}, ":owner": {"S": owner_id}},
                    "revision = :rev AND sync_lease_owner = :owner")
    except Exception as e:
        # Lease se het han theo thoi gian; khong duoc che lap loi chinh cua lan reconcile.
        print(f"Could not release lease for {group_id}: {e}")



def acquire_lease(group_id, revision, owner_id):
    """Lease per group so two workers never reconcile the same group at once."""
    if not LIVE:
        return True
    now = int(time.time() * 1000)
    try:
        return update_item(SGROUP_TABLE, "group_id", group_id,
                           "SET sync_lease_owner = :o, sync_lease_until = :u, sync_status = :st",
                           None,
                           {":o": {"S": owner_id}, ":u": {"N": str(now + LEASE_MS)},
                            ":st": {"S": "SYNCING"}, ":rev": {"N": str(int(revision))},
                            ":now": {"N": str(now)}},
                           "revision = :rev AND (attribute_not_exists(sync_lease_until) OR sync_lease_until < :now)")
    except Exception as e:
        print(f"Could not acquire lease for {group_id}: {e}")
        return False


def mark(group_id, revision, status, error=None, fields=None, owner_id=None, keep_lease=False):
    """Ghi trang thai chi khi group con dung revision; worker cu khong de ket qua moi.

    keep_lease=True giu lease cua chinh worker nay (worker van dang xu ly) de ket qua duoc
    luu truoc khi nha quyen; release_lease() moi la nguoi tra lease sau cung.
    """
    now = int(time.time() * 1000)
    values = {":st": {"S": status}, ":now": {"N": str(now)}, ":rev": {"N": str(int(revision))}}
    expression = "SET sync_status = :st, sync_checked_at = :now"
    names = None
    if fields:
        for name in fields:
            values[f":{name}"] = fields[name]
        expression += ", " + ", ".join(f"#{k} = :{k}" for k in fields)
        names = {f"#{k}": k for k in fields}
    if error:
        values[":err"] = {"S": error[:1000]}
        expression += ", sync_error = :err"
    if keep_lease:
        if owner_id:
            # Chi ghi khi van la chu lease VA lease con han: worker khac da tiep quan thi khong ghi de.
            # :now da co trong values (sync_checked_at) va dung chung cho dieu kien han lease.
            values[":owner"] = {"S": owner_id}
            condition = _lease_still_ours(now)
        else:
            condition = "revision = :rev"
    elif owner_id:
        # Tien ich cho test/cuoc goi doc lap: ghi xong la tra lease neu van la chu so huu.
        values[":owner"] = {"S": owner_id}
        condition = "revision = :rev AND sync_lease_owner = :owner"
        expression += ", sync_lease_owner = :empty, sync_lease_until = :zero"
        values.update({":empty": {"S": ""}, ":zero": {"N": "0"}})
    else:
        condition = "revision = :rev"
    try:
        return update_item(SGROUP_TABLE, "group_id", group_id,
                           expression, names, values, condition)
    except Exception as e:
        print(f"Could not record {status} for {group_id} revision {revision}: {e}")
        return False



def is_managed(group_id, group):
    """Live reconcile chi khi group da duoc backend danh dau managed VA nam trong allowlist."""
    flag = group.get("managed")
    # Chi nhan bool that: chuoi "false" hay dict {"BOOL": false} khong duoc coi la da cap quyen quan ly.
    return flag is True and ("*" in ALLOWLIST or group_id in ALLOWLIST)


def outcome_log(request_id, outcome, group_id, revision, detail=""):
    """One line per invocation so a future run can prove WHY nothing was applied.

    The handler used to print only on BUSY; SKIPPED and NOT_MANAGED returned silently,
    which is exactly why a failed canary could not be diagnosed from CloudWatch.
    Nothing secret is logged: only ids, revision, live flag and the outcome reason.
    """
    event_id = ""
    if isinstance(detail, dict):
        event_id = str(detail.get("event_id") or "")
    print(f"OUTCOME status={outcome} request_id={request_id} group_id={group_id} "
          f"revision={revision} event_id={event_id} live={LIVE} "
          f"allowlisted={'*' in ALLOWLIST or group_id in ALLOWLIST}")


def lambda_handler(event, context):
    detail = event.get("detail", event) if isinstance(event, dict) else {}
    group_id = str(detail.get("group_id") or "")
    revision = int(detail.get("revision") or 0)
    request_id = str(getattr(context, "aws_request_id", "") or "")
    if not group_id or revision <= 0:
        raise ValueError("security-group.updated event needs group_id and revision")
    owner_id = request_id or f"worker-{time.time_ns()}"
    leased = False
    outcome = None  # (status, state, reason) cua ket qua khong phai APPLIED
    try:
        current = get_item(SGROUP_TABLE, "group_id", group_id)
        if not current:
            raise SyncSkipped(f"group {group_id} no longer exists")
        if int(current.get("revision") or 0) != revision:
            # Event cu: khong chiem lease, khong ghi de ket qua cua revision moi.
            outcome_log(request_id, "STALE", group_id, revision, detail)
            return {"status": "SKIPPED", "group_id": group_id, "revision": revision,
                    "reason": f"stale event: stored revision {current.get('revision')}"}
        if LIVE and not is_managed(group_id, current):
            outcome_log(request_id, "NOT_MANAGED", group_id, revision, detail)
            return {"status": "NOT_MANAGED", "group_id": group_id, "revision": revision,
                    "reason": "group is not in the managed allowlist; nothing was applied"}
        if LIVE and not acquire_lease(group_id, revision, owner_id):
            # BUSY: khong coi la thanh cong. Throw de event duoc retry/redrive thay vi mat yeu cau.
            raise BusyRetry(f"another worker holds the lease for {group_id} revision {revision}")
        leased = LIVE
        resolved = resolve(detail, live=LIVE)
        rules = desired_rules(resolved["group"])
        token = keystone_token()
        target = verify_target(resolved["mapping"], resolved["instance_id"], token)
        result = apply_rules(target, rules, token, LIVE,
                             guard=lambda: ensure_lease(group_id, revision, owner_id) if LIVE else None)
        if LIVE:
            now = int(time.time() * 1000)
            recorded = mark(group_id, revision, SYNCED, owner_id=owner_id, keep_lease=True, fields={
                "applied_revision": {"N": str(revision)},
                "synced_at": {"N": str(now)},
                "rule_count": {"N": str(len(rules))},
                "sync_error": {"S": ""},
                "sync_attempts": {"N": "0"}})
            if not recorded:
                # Sua that bai sau khi Neutron da doi: khong duoc bao APPLIED nhu the da xong.
                raise RuntimeError("applied to Neutron but could not record SYNCED (newer revision won)")
        outcome_log(request_id, "APPLIED" if LIVE else "DRY_RUN", group_id, revision, detail)
        return {"status": "APPLIED" if LIVE else "DRY_RUN", "group_id": group_id,
                "revision": revision, "result": result}
    except BusyRetry as busy:
        # Chua chiem duoc lease nen khong ghi gi; nem lai de event duoc thu lai.
        outcome_log(request_id, "BUSY", group_id, revision, detail)
        print(f"BUSY: {busy}")
        raise
    except SyncBlocked as blocked:
        outcome = ("BLOCKED", BLOCKED, str(blocked))
    except SyncSkipped as skipped:
        outcome = ("SKIPPED", NOT_APPLICABLE, str(skipped))
    except Exception as e:
        outcome = ("FAILED", FAILED, str(e))
        raise
    finally:
        # Ghi ket qua TRUOC khi nha lease: worker khac chi tiep quan khi ket qua da duoc luu.
        if outcome and LIVE:
            mark(group_id, revision, outcome[1], outcome[2],
                 owner_id=owner_id if leased else None, keep_lease=bool(leased))
        if leased:
            release_lease(group_id, revision, owner_id)
    status, state, reason = outcome
    outcome_log(request_id, status, group_id, revision, detail)
    return {"status": status, "group_id": group_id, "revision": revision, "reason": reason}

