"""Read-only inventory of Security Group records (dry run).

The report is a proposal only: no DynamoDB write, no cleanup, no firewall change.
Groups are recognised as duplicates through their description ("Security group of <id>")
and owner. Groups with different rule sets are never merged automatically; they need a
manual decision because no rule set can be proven to be the intended one.

Usage (uses credentials of the AWS CLI profile/role, region ap-southeast-2):
    python sg_inventory.py --table XRegion-SecurityGroups
    python sg_inventory.py --snapshot C:/Temp/export.json   # export from AWS CLI
    python sg_inventory.py --table ... --out C:/Temp/sg-report.json
"""
import argparse
import json
import re
from collections import defaultdict

DEFAULT_TABLE = "XRegion-SecurityGroups"
REGION = "ap-southeast-2"
DESCRIPTION = re.compile(r"^Security group of (?P<instance>i-[A-Za-z0-9-]+)$")
# Nhóm hệ thống không có chủ máy: không bao giờ là ứng viên "trùng rác".
SYSTEM_IDS = {"sg-default", "sg-web-public", "sg-ssh-only"}


def plain(value):
    from decimal import Decimal
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def load_from_table(table, profile=None, region=REGION):
    import boto3
    from boto3.dynamodb.types import TypeDeserializer
    deserializer = TypeDeserializer()
    session = boto3.Session(profile_name=profile, region_name=region) if profile else boto3.Session(region_name=region)
    ddb = session.client("dynamodb")
    items, kwargs = [], {"TableName": table, "ConsistentRead": True}
    while True:
        page = ddb.scan(**kwargs)
        # Client cấp thấp trả về {"S": ...}: phải deserialize, nếu không owner/revision đều là dict.
        items.extend({k: plain(deserializer.deserialize(v)) for k, v in item.items()}
                     for item in page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def load_from_snapshot(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh) if path.lower().endswith(".json") else [json.loads(line) for line in fh if line.strip()]
    if isinstance(data, dict):
        data = data.get("Items") or data.get("items") or []
    out = []
    for item in data:
        # Snapshot AWS CLI có thể còn nguyên kiểu {"S": ...}; đổi về chuỗi để so sánh.
        converted = {}
        for key, value in item.items():
            if isinstance(value, dict) and set(value) <= {"S", "N", "BOOL", "NULL"}:
                converted[key] = value.get("S") if "S" in value else value.get("N") or value.get("BOOL")
            else:
                converted[key] = value
        out.append(converted)
    return out


def rules_of(group):
    out = {}
    for key in ("inbound_rules", "outbound_rules"):
        raw = group.get(key)
        if isinstance(raw, str):
            try:
                out[key] = json.loads(raw) if raw else []
            except json.JSONDecodeError:
                out[key] = [{"invalid_json": raw[:100]}]
        else:
            out[key] = raw or []
    return out


def rule_set(group):
    normalized = set()
    for direction, items in rules_of(group).items():
        for rule in items:
            normalized.add((direction, str(rule.get("protocol", "")).lower(),
                            int(rule.get("fromPort", 0) or 0), int(rule.get("toPort", 0) or 0),
                            str(rule.get("cidr", "")).strip()))
    return normalized


def analyze(groups):
    by_instance = defaultdict(list)
    no_owner = []
    orphans = []
    for group in groups:
        group_id = group.get("group_id")
        owner = str(group.get("owner") or "").strip()
        description = str(group.get("description") or "").strip()
        match = DESCRIPTION.match(description)
        if not owner and group_id not in SYSTEM_IDS:
            no_owner.append({"group_id": group_id, "name": group.get("name"), "description": description})
        if match:
            by_instance[match.group("instance")].append(group)
        elif group_id not in SYSTEM_IDS:
            orphans.append({"group_id": group_id, "name": group.get("name"), "description": description,
                            "proposal": "Review manually: description does not identify a single instance"})
    duplicates = []
    for instance_id, items in sorted(by_instance.items()):
        if len(items) < 2:
            continue
        owners = {str(group.get("owner") or "") for group in items}
        identical = len({frozenset(rule_set(group)) for group in items}) == 1 and len(owners) == 1
        duplicates.append({
            "instance_id": instance_id,
            "groups": [{
                "group_id": g.get("group_id"),
                "name": g.get("name"),
                "owner": g.get("owner"),
                "revision": g.get("revision"),
                "applied_revision": g.get("applied_revision"),
                "sync_status": g.get("sync_status"),
                "rule_count": len(rule_set(g)),
            } for g in items],
            "owners": sorted(owners),
            "identical_rules": identical,
            "proposal": ("Candidates for archive after backup: same owner and same rules" if identical else
                         "Manual decision required: groups differ; no group is auto-merged or deleted"),
        })
    single = sum(1 for v in by_instance.values() if len(v) == 1)
    # Phương án B: nhóm có thể nhận quản lý toàn bộ firewall chỉ khi duy nhất, có chủ, chưa có cờ managed.
    manageable = [items[0].get("group_id") for items in by_instance.values()
                  if len(items) == 1 and items[0].get("owner") and not items[0].get("managed")]
    managed = [group.get("group_id") for group in groups if group.get("managed")]
    return {
        "summary": {
            "total_groups": len(groups),
            "instances_with_dedicated_group": len(by_instance),
            "instances_with_single_group": single,
            "instances_with_duplicates": len(duplicates),
            "groups_without_owner": len(no_owner),
            "unrecognised_groups": len(orphans),
            "groups_marked_managed": len(managed),
            "groups_eligible_for_management": len(manageable),
        },
        "duplicates": duplicates,
        "groups_without_owner": no_owner,
        "unrecognised_groups": orphans,
        "eligible_group_ids": sorted(manageable),
        "managed_group_ids": sorted(managed),
        "verification": {
            "scope": "DynamoDB security-group records only",
            "not_verified": [
                "Neutron association cua neutron_sg_id voi neutron_port_id",
                "Ten SG Neutron co bang nova_id hay khong",
                "SG chi duoc dung boi mot port (exclusivity that te)",
                "Cac SG khac dang gan tren cung guest port",
            ],
            "note": "eligible_group_ids la UNG VIEN tu du lieu SG, khong phai da du dieu kien live. "
                    "Worker van fail-closed: verify_target() tu choi khi chua chung minh duoc.",
        },
        "note": "Dry run only: no write, no delete, no firewall change.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only Security Group inventory (dry run)")
    parser.add_argument("--table", default=DEFAULT_TABLE)
    parser.add_argument("--snapshot", help="JSON/JSONL export instead of a live table scan")
    parser.add_argument("--profile")
    parser.add_argument("--region", default=REGION)
    parser.add_argument("--out", help="Write the JSON report here (keep it outside the repository)")
    args = parser.parse_args(argv)
    groups = load_from_snapshot(args.snapshot) if args.snapshot else load_from_table(args.table, args.profile, args.region)
    report = analyze(groups)
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"Report written: {args.out}")
    print(json.dumps(report["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
