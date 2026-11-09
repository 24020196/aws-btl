#!/usr/bin/env python3
"""Own only xregion interfaces, routes and nftables tables. No arbitrary shell input."""
import argparse
import fcntl
import ipaddress
import json
from pathlib import Path
import subprocess
import time
import uuid

import boto3

CONFIG = Path("/etc/xregion-network/config.json")
STATE = Path("/var/lib/xregion-network")


def run(*args, input=None):
    result = subprocess.run(list(args), input=input, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[:1200]}")
    return result.stdout


def address(value):
    return str(ipaddress.IPv4Address(value))


def read_mappings(config):
    table = boto3.resource("dynamodb", region_name=config["region"]).Table(config["table"])
    result, request = [], dict(IndexName="gateway_host_id-index",
        KeyConditionExpression="gateway_host_id = :host",
        ExpressionAttributeValues={":host": config["host_id"]})
    while True:
        page = table.query(**request)
        result.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        request["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return table, result


def render_nft(mappings):
    active = [m for m in mappings if m["status"] in ("APPLYING", "ACTIVE")]
    incoming, outgoing = [], []
    for m in active:
        front, guest = address(m["gateway_private_ip"]), address(m["guest_private_ip"])
        if ipaddress.ip_address(guest) not in ipaddress.ip_network("192.168.100.0/24"):
            raise ValueError("Guest outside private network")
        incoming.append(f"{front} : {guest}")
        outgoing.append(f"{guest} : {front}")
    elements_in = "elements = { " + ", ".join(incoming) + " };" if incoming else ""
    elements_out = "elements = { " + ", ".join(outgoing) + " };" if outgoing else ""
    return '''table ip xregion_nat {
 map dnat_map { type ipv4_addr : ipv4_addr; %s }
 map snat_map { type ipv4_addr : ipv4_addr; %s }
 chain prerouting { type nat hook prerouting priority dstnat; policy accept;
   iifname "br-ex" dnat to ip daddr map @dnat_map
 }
 chain postrouting { type nat hook postrouting priority srcnat; policy accept;
   oifname "br-ex" snat to ip saddr map @snat_map
 }
}
table inet xregion_filter {
 chain input { type filter hook input priority -10; policy accept;
   iifname "br-xregion" ct state established,related accept
   iifname "br-xregion" ip protocol icmp accept
   iifname "br-xregion" drop
 }
 chain forward { type filter hook forward priority -10; policy accept;
   iifname "br-xregion" ip daddr { 10.20.10.0/24, 169.254.169.254 } drop
   iifname "br-xregion" oifname != "br-ex" drop
   iifname "br-ex" oifname "br-xregion" ct status dnat accept
   iifname "br-ex" oifname "br-xregion" drop
 }
}
''' % (elements_in, elements_out)


def topology(config):
    ovs = ["docker", "exec", "openvswitch_vswitchd", "ovs-vsctl", "--timeout=8"]
    run(*ovs, "--may-exist", "add-br", "br-xregion")
    current = run(*ovs, "get", "open_vswitch", ".", "external_ids:ovn-bridge-mappings").strip().strip('"')
    entries = dict(p.split(":", 1) for p in current.split(",") if ":" in p)
    if entries.get("physnet_nat") not in (None, "br-xregion"):
        raise ValueError("Conflicting physnet_nat mapping")
    entries["physnet_nat"] = "br-xregion"
    run(*ovs, "set", "open_vswitch", ".", "external_ids:ovn-bridge-mappings=" +
        ",".join(f"{k}:{v}" for k, v in sorted(entries.items())))
    run(*ovs, "set", "bridge", "br-ex", "other_config:hwaddr=" + config["eni_mac"])
    for dev in ("br-ex", "br-xregion"):
        run("ip", "link", "set", dev, "up")
    run("ip", "link", "set", "br-ex", "address", config["eni_mac"])
    run("ip", "address", "replace", config["primary_ip"] + "/24", "dev", "br-ex")
    run("ip", "address", "replace", "192.168.100.1/24", "dev", "br-xregion")
    run("ip", "route", "replace", "10.20.1.0/24", "dev", "br-ex", "table", "101")
    run("ip", "route", "replace", "192.168.100.0/24", "dev", "br-xregion", "table", "101")
    run("ip", "route", "replace", "default", "via", "10.20.1.1", "dev", "br-ex", "table", "101")
    rules = json.loads(run("ip", "-j", "rule", "show"))
    if not any(r.get("priority") == 1100 for r in rules):
        run("ip", "rule", "add", "priority", "1100", "from", "192.168.100.0/24", "lookup", "101")
    if not any(r.get("src") in ("10.20.1.0", "10.20.1.0/24") for r in rules):
        run("ip", "rule", "add", "priority", "1101", "from", "10.20.1.0/24", "lookup", "101")
    for key, value in (("net.ipv4.ip_forward", "1"), ("net.ipv4.conf.all.rp_filter", "2"),
                       ("net.ipv4.conf.br-ex.rp_filter", "2"), ("net.ipv4.conf.br-xregion.rp_filter", "2")):
        run("sysctl", "-w", key + "=" + value)


def reconcile(nova_id=None):
    config = json.loads(CONFIG.read_text())
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        topology(config)
        table, rows = read_mappings(config)
        # GSI reads are eventually consistent. Confirm each record with a strong read.
        ids = {m["nova_id"] for m in rows}
        if (STATE / "last-applied.json").exists():
            ids.update(json.loads((STATE / "last-applied.json").read_text()).keys())
        if nova_id:
            ids.add(str(uuid.UUID(nova_id)))
        rows = [table.get_item(Key={"nova_id": n}, ConsistentRead=True).get("Item") for n in ids]
        rows = [m for m in rows if m and m["gateway_host_id"] == config["host_id"]]
        active = [m for m in rows if m["status"] in ("APPLYING", "ACTIVE")]
        for m in active:
            run("ip", "address", "replace", address(m["gateway_private_ip"]) + "/32", "dev", "br-ex")
        existing = json.loads(run("nft", "-j", "list", "tables"))["nftables"]
        tables = {(x["table"]["family"], x["table"]["name"]) for x in existing if "table" in x}
        prefix = "".join(f"delete table {family} {name}\n" for family, name in
                         [("ip", "xregion_nat"), ("inet", "xregion_filter")] if (family, name) in tables)
        rules = prefix + render_nft(rows)
        run("nft", "--check", "-f", "-", input=rules)
        run("nft", "-f", "-", input=rules)
        for m in rows:
            if m["status"] == "DELETING":
                subprocess.run(["ip", "address", "del", address(m["gateway_private_ip"]) + "/32",
                                "dev", "br-ex"], capture_output=True)
                if m.get("applied_status") != "DELETING":
                    for selector, ip in (("-d", m["gateway_private_ip"]), ("-s", m["guest_private_ip"])):
                        result = subprocess.run(["conntrack", "-D", selector, address(ip)],
                                                capture_output=True, text=True, timeout=15)
                        if result.returncode not in (0, 1):
                            raise RuntimeError("Unable to clear mapping conntrack state")
            if m["status"] in ("APPLYING", "ACTIVE", "DELETING"):
                table.update_item(Key={"nova_id": m["nova_id"]},
                    UpdateExpression="SET applied_generation=:g, applied_status=:s",
                    ConditionExpression="generation=:g AND #st=:s",
                    ExpressionAttributeNames={"#st": "status"},
                    ExpressionAttributeValues={":g": m["generation"], ":s": m["status"]})
        (STATE / "last-applied.json").write_text(json.dumps({m["nova_id"]: int(m["generation"]) for m in rows}))
        print(json.dumps(dict(schema_version=1, operation="RECONCILE", status="SUCCEEDED",
                             nova_id=nova_id, mapping_count=len(active), timestamp=int(time.time()))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("APPLY", "REMOVE", "RECONCILE", "VERIFY"))
    parser.add_argument("nova_id", nargs="?")
    args = parser.parse_args()
    if args.operation == "VERIFY":
        cfg = json.loads(CONFIG.read_text())
        table = boto3.resource("dynamodb", region_name=cfg["region"]).Table(cfg["table"])
        m = table.get_item(Key={"nova_id": str(uuid.UUID(args.nova_id))}, ConsistentRead=True)["Item"]
        deadline = time.monotonic() + 480
        while True:
            try:
                run("ping", "-I", "br-xregion", "-c", "2", "-W", "2", address(m["guest_private_ip"]))
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(5)
        print(json.dumps(dict(status="SUCCEEDED", nova_id=args.nova_id, operation="VERIFY")))
    else:
        reconcile(args.nova_id)
