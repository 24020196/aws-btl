"""Read-only inventory by default; deletion consumes a fenced UUID manifest.

No name-prefix deletion, replay of failed executions, force detach, or fabricated
DynamoDB ownership. Live apply requires an EBS canary receipt. The operator has
explicitly waived backup verification and accepted legacy data loss for this run.
Artifacts belong exclusively in the caller's OS Temp directory (Deployment).
"""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
import zlib

from botocore.exceptions import ClientError
from control import ACCOUNT, REGION, HOST, Deployment


POOLS = ("XRegion-CinderPoolManager", "XRegion-EIPPoolManager")
ADMISSION = f"/xregion/{REGION}/launch/admission"
PROJECT = "d3bf05331973481891385d066d3eba3e"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def uid(value):
    return str(uuid.UUID(str(value)))


def project(value):
    return uuid.UUID(str(value)).hex


def build_manifest(baseline, project_ids):
    projects = {project(p) for p in project_ids}
    host = baseline["host"]
    if host["InstanceId"] != HOST:
        raise ValueError("Unexpected storage host")
    roots = {b["Ebs"]["VolumeId"] for b in host["BlockDeviceMappings"]
             if b["DeviceName"] == host["RootDeviceName"] and "Ebs" in b}
    if len(roots) != 1:
        raise ValueError("Root volume identity is ambiguous")
    lv_ids = {uid(v["lv_name"][7:]) for report in baseline["openstack"]["lvs"].get("report", [])
              for v in report.get("lv", []) if re.fullmatch(r"volume-[0-9a-f-]{36}", v["lv_name"])}
    volumes = []
    for v in baseline["openstack"]["volumes"]:
        tenant = v.get("project_id") or v.get("os-vol-tenant-attr:tenant_id")
        if tenant and project(tenant) in projects and uid(v["id"]) in lv_ids:
            volumes.append(dict(id=uid(v["id"]), project_id=project(tenant), size=v["size"],
                                backend="legacy-lvm", attachments=v.get("attachments", [])))
    known_volumes = {v["id"] for v in volumes}
    servers = []
    unresolved = []
    for s in baseline["openstack"]["servers"]:
        tenant = s.get("project_id")
        if not tenant or project(tenant) not in projects:
            continue
        attached = {uid(v["id"]) for v in s.get("attached_volumes", [])}
        if attached and attached <= known_volumes:
            servers.append(dict(id=uid(s["id"]), project_id=project(tenant), name=s["name"],
                                volume_ids=sorted(attached)))
        else:
            unresolved.append(dict(kind="nova", id=s["id"], reason="Missing or mixed storage ownership"))
    # EBS disks require an explicit legacy reference in DynamoDB, not merely an attachment to HOST.
    references = {r.get("ebs_volume_id") or r.get("volume_id") for r in baseline["volume_records"]
                  if r.get("storage_backend") != "aws-ebs" and
                  (r.get("attached_instance_id") or r.get("lease_instance_id"))}
    disks, unknown = [], []
    for d in baseline["ebs"]:
        ident = d["VolumeId"]
        if ident in roots:
            continue
        tags = {t["Key"]: t["Value"] for t in d.get("Tags", [])}
        if (ident in references and tags.get("Project", "").lower() == "xregion" and
                all(a["InstanceId"] == HOST for a in d.get("Attachments", []))):
            disks.append(dict(id=ident, attachments=d.get("Attachments", []), tags=tags))
        elif any(a["InstanceId"] == HOST for a in d.get("Attachments", [])):
            unknown.append(dict(id=ident, reason="No exact legacy ownership proof; preserve"))
    result = dict(schema_version=1, account=ACCOUNT, region=REGION, host_id=HOST,
                  baseline_sha256=digest(baseline), root_volume_id=next(iter(roots)),
                  project_ids=sorted(projects), servers=servers, volumes=volumes, ebs=disks,
                  unresolved=unresolved, preserved_ebs=unknown)
    result["manifest_sha256"] = digest(result)
    return result


def validate_manifest(manifest, baseline):
    unsigned = {k: v for k, v in manifest.items() if k != "manifest_sha256"}
    if manifest.get("manifest_sha256") != digest(unsigned) or manifest.get("baseline_sha256") != digest(baseline):
        raise ValueError("Manifest/baseline hash mismatch")
    if manifest != build_manifest(baseline, manifest["project_ids"]):
        raise ValueError("Manifest expands beyond the inventoried legacy resource set")
    if manifest["unresolved"]:
        raise ValueError("Resolve ambiguous Nova/storage ownership before deletion")
    if any(v["id"] == manifest["root_volume_id"] for v in manifest["ebs"]):
        raise ValueError("Root EBS cannot be selected")


HOST_INVENTORY = r'''
import json, subprocess
import openstack
from pathlib import Path
import hashlib
c = openstack.connect()
def command(*args):
    return subprocess.check_output(args, text=True)
def safe_lvs():
    proc = subprocess.run(['lvs','--reportformat','json','-o','lv_name,lv_uuid,lv_size,vg_name','cinder-volumes'],
                          capture_output=True, text=True)
    if proc.returncode == 0:
        return json.loads(proc.stdout)
    err = (proc.stderr or "") + (proc.stdout or "")
    if proc.returncode == 5 and ("Volume group \"cinder-volumes\" not found" in err or "Cannot process volume group cinder-volumes" in err):
        return {"report": []}
    raise subprocess.CalledProcessError(proc.returncode, proc.args, output=proc.stdout, stderr=proc.stderr)
result = dict(servers=[s.to_dict() for s in c.compute.servers(all_projects=True)],
              volumes=[v.to_dict() for v in c.block_storage.volumes(details=True, all_projects=True)],
              ports=[p.to_dict() for p in c.network.ports()],
              lvs=safe_lvs(),
              domains=command('docker','exec','nova_libvirt','virsh','list','--all','--uuid').split(),
              loops=json.loads(command('losetup','--json','--output','NAME,BACK-FILE,RO')),
              blocks=json.loads(command('lsblk','--json','-o','NAME,SERIAL,SIZE,RO,MOUNTPOINTS')),
              loop_dropins={str(p):hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in Path('/etc/systemd/system/docker.service.d').glob('*.conf')
                  if 'cinder-loopback' in p.read_text() or 'attach-cinder-loop' in p.read_text()})
print(json.dumps(result, default=str))
'''


def host_python(x, source, label, timeout=180):
    script = "set -eu\n. /etc/kolla/admin-openrc.sh\n/home/ssm-user/kolla-venv-2024.2/bin/python - <<'XREGION_PY'\n"
    encoded = base64.b64encode(source.encode()).decode()
    # SSM truncates inline stdout around 24 KB. Compress before transport and
    # reject oversized replies instead of parsing an incomplete inventory.
    wrapper = """import base64,contextlib,io,zlib
buffer=io.StringIO()
with contextlib.redirect_stdout(buffer):
    exec(compile(base64.b64decode(SOURCE),'<xregion-host>','exec'),{})
result=base64.b64encode(zlib.compress(buffer.getvalue().encode())).decode()
if len(result)>22000: raise RuntimeError('Inventory exceeds bounded SSM reply; split collection')
print('XRJSON:'+result)
"""
    output = x.remote(script + "SOURCE=" + repr(encoded) + "\n" + wrapper + "\nXREGION_PY\n", label, timeout)
    if not output.strip().startswith("XRJSON:"):
        raise ValueError("Missing bounded host JSON response")
    return json.loads(zlib.decompress(base64.b64decode(output.strip()[7:])))


def inventory(x, filename="legacy-baseline.json"):
    if filename == "legacy-baseline.json" and (x.directory / filename).exists():
        raise RuntimeError("Baseline already exists; use a fresh artifact directory, not a completed run")
    ec2 = x.client("ec2")
    host = ec2.describe_instances(InstanceIds=[HOST])["Reservations"][0]["Instances"][0]
    disks = []
    for page in ec2.get_paginator("describe_volumes").paginate():
        disks.extend(page["Volumes"])
    tables = {}
    for table in ("XRegion-Volumes", "XRegion-Instances", "XRegion-Nova", "XRegion-NetworkMappings", "XRegion-NetworkReservations"):
        rows = []
        for page in x.session.resource("dynamodb").Table(table).meta.client.get_paginator("scan").paginate(TableName=table, ConsistentRead=True):
            rows.extend(page["Items"])
        tables[table] = rows
    # Resource paginator yields native DynamoDB values; normalize Decimal in artifact serialization.
    baseline = dict(captured_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    host=host, ebs=disks, volume_records=tables["XRegion-Volumes"], tables=tables,
                    openstack=host_python(x, HOST_INVENTORY, "legacy-inventory", 300))
    # A round trip gives the same representation as the saved JSON used by hashes.
    baseline = json.loads(json.dumps(baseline, default=str))
    x.save(filename, baseline)
    return baseline


def freeze(x):
    path = x.directory / "legacy-freeze-before.json"
    if not path.exists():
        old = x.client("ssm").get_parameter(Name=ADMISSION)
        before = dict(admission=old, pools={})
        for name in POOLS:
            before["pools"][name] = x.client("lambda").get_function_concurrency(FunctionName=name)
        x.save(path.name, before)
    x.call("ssm", "put_parameter", Name=ADMISSION, Type="String", Value=json.dumps({"mode": "maintenance"}), Overwrite=True)
    for name in POOLS:
        x.call("lambda", "put_function_concurrency", FunctionName=name, ReservedConcurrentExecutions=0)
    assert_frozen(x)


def assert_frozen(x):
    if json.loads(x.client("ssm").get_parameter(Name=ADMISSION)["Parameter"]["Value"]).get("mode") != "maintenance":
        raise RuntimeError("Launch admission is not in maintenance")
    for name in POOLS:
        if x.client("lambda").get_function_concurrency(FunctionName=name).get("ReservedConcurrentExecutions") != 0:
            raise RuntimeError("Pool manager is not frozen: " + name)
    for name in ("LaunchInstance", "TerminateInstance"):
        arn = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"
        for page in x.client("stepfunctions").get_paginator("list_executions").paginate(stateMachineArn=arn, statusFilter="RUNNING"):
            if page["executions"]:
                raise RuntimeError("Wait for running lifecycle executions before cleanup")


def require_receipts(x, manifest, receipts):
    assert_frozen(x)
    launch = x.client("stepfunctions").describe_execution(executionArn=receipts["canary"]["launch_execution"])
    terminate = x.client("stepfunctions").describe_execution(executionArn=receipts["canary"]["terminate_execution"])
    if launch["status"] != "SUCCEEDED" or terminate["status"] != "SUCCEEDED":
        raise ValueError("EBS canary lifecycle has not passed")
    output = json.loads(launch["output"])
    if output.get("storage_backend") != "aws-ebs" or output.get("volume_extension", {}).get("actual_size_gb") != 12:
        raise ValueError("Canary did not prove a 12 GiB EBS boot volume")
    if not receipts["canary"].get("connectivity_verified"):
        raise ValueError("Canary connectivity receipt is missing")


HOST_DELETE = r'''
import json, time
import openstack
from openstack.exceptions import NotFoundException
c = openstack.connect()
def get(proxy, kind, ident):
    try:
        return getattr(proxy, 'get_' + kind)(ident)
    except NotFoundException:
        return None
def absent(proxy, kind, ident):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if get(proxy, kind, ident) is None:
            return
        time.sleep(3)
    raise TimeoutError(kind + ' deletion was not confirmed')
row = REQUEST['resource']
kind = REQUEST['kind']
if kind == 'server':
    current = get(c.compute, 'server', row['id'])
    if current:
        if current.project_id.replace('-', '') != row['project_id']:
            raise ValueError('Nova project ownership changed')
        attached = sorted(v['id'] for v in current.attached_volumes)
        if attached != row['volume_ids']:
            raise ValueError('Nova volume attachments changed')
        if current.status == 'ACTIVE':
            c.compute.stop_server(current)
            c.compute.wait_for_server(current, status='SHUTOFF', wait=180)
        c.compute.delete_server(current, ignore_missing=True, force=False)
        absent(c.compute, 'server', row['id'])
    for old in REQUEST['ports']:
        port = get(c.network, 'port', old['id'])
        if port:
            if port.device_id not in ('', row['id']) or port.network_id != old['network_id']:
                raise ValueError('Neutron port ownership changed')
            c.network.delete_port(port, ignore_missing=True)
            absent(c.network, 'port', port.id)
    for group in c.network.security_groups(name=row['id']):
        if group.name != row['id'] or group.project_id.replace('-', '') != row['project_id']:
            raise ValueError('Security group ownership mismatch')
        if any(group.id in p.security_group_ids for p in c.network.ports()):
            raise ValueError('Security group is still shared by a port')
        c.network.delete_security_group(group, ignore_missing=True)
        absent(c.network, 'security_group', group.id)
elif kind == 'volume':
    current = get(c.block_storage, 'volume', row['id'])
    if current:
        tenant = current.project_id or current.to_dict().get('os-vol-tenant-attr:tenant_id')
        if tenant.replace('-', '') != row['project_id'] or current.attachments:
            raise ValueError('Cinder ownership changed or volume is still attached')
        if current.status != 'deleting':
            c.block_storage.delete_volume(current, ignore_missing=True, cascade=False)
        absent(c.block_storage, 'volume', row['id'])
else:
    raise ValueError('Unknown cleanup resource type')
print(json.dumps(dict(id=row['id'], kind=kind, absent=True)))
'''


def remote_delete(x, kind, row, ports=()):
    payload = base64.b64encode(json.dumps(dict(kind=kind, resource=row, ports=list(ports))).encode()).decode()
    source = "import base64\nREQUEST=json.loads(base64.b64decode('" + payload + "'))\n"
    return host_python(x, "import json\n" + source + HOST_DELETE, "legacy-delete-" + kind + "-" + row["id"], 600)


def checkpoint(x, state, kind, ident):
    state.setdefault(kind, {})[ident] = dict(absent=True, at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    x.save("legacy-cleanup-checkpoints.json", state)


def invoke_network(x, stage, event):
    from workflows import MANIFEST
    response=x.call('lambda','invoke',FunctionName=MANIFEST['functions'][stage],Payload=json.dumps(event).encode())
    result=json.loads(response['Payload'].read())
    if response.get('FunctionError'):
        raise RuntimeError(stage+': '+str(result.get('errorMessage','Lambda failed')))
    return result


def remove_orphan_network(x, server, ports):
    """Use real mapping/claims, without manufacturing an Instances owner."""
    # Check if network mapping is already absent or DELETED in live DynamoDB with ConsistentRead
    table = x.session.resource("dynamodb").Table("XRegion-NetworkMappings")
    resp = table.get_item(Key={"nova_id": server["id"]}, ConsistentRead=True)
    mapping = resp.get("Item")
    if not mapping or mapping.get("status") == "DELETED":
        remote_delete(x, "server", server, ports)
        x.save("legacy-orphan-network-" + server["id"] + ".json", {"status": "ALREADY_DELETED", "nova_id": server["id"]})
        return
    if mapping.get("cleanup_phase") == "TAGS_REMOVED":
        # Finalize the transaction to delete the mapping record and release claims
        result = invoke_network(x, "Release", dict(nova_id=server["id"], server_id=server["id"],
                                                   cleanup_phase="TAGS_REMOVED", network_operation="REMOVE",
                                                   release_operation="FINALIZE"))
        remote_delete(x, "server", server, ports)
        x.save("legacy-orphan-network-" + server["id"] + ".json", result)
        return
    event = invoke_network(x, "Release", dict(nova_id=server["id"], server_id=server["id"]))
    if event.get("network_cleanup_complete") or event.get("status") == "TERMINATED":
        remote_delete(x, "server", server, ports)
        x.save("legacy-orphan-network-" + server["id"] + ".json", event)
        return
    event = invoke_network(x, "Dispatch", event)
    while event.get("command_status") != "SUCCEEDED":
        time.sleep(3)
        event = invoke_network(x, "CheckCommand", event)
    remote_delete(x, "server", server, ports)
    result = invoke_network(x, "Release", event)
    x.save("legacy-orphan-network-" + server["id"] + ".json", result)


def release_legacy_address(x, server, baseline):
    """A legacy EIP is returned to the pool only with exact owner/IP evidence."""
    rows=[r for r in baseline['tables']['XRegion-Nova'] if r.get('nova_id')==server['id']]
    for row in rows:
        ip=row.get('elastic_ip')
        if not ip: continue
        candidates=[a for a in json.loads((x.directory/'legacy-eip-baseline.json').read_text()) if a.get('PublicIp')==ip]
        if len(candidates)!=1: raise ValueError('Legacy EIP inventory is missing or ambiguous')
        old=candidates[0]
        if old.get('NetworkInterfaceId')!='eni-091eaee3e69e3f42d' or old.get('PrivateIpAddress')!=row.get('private_ip'):
            raise ValueError('Legacy EIP association does not match Nova record')
        ec2=x.client('ec2')
        current=ec2.describe_addresses(AllocationIds=[old['AllocationId']])['Addresses'][0]
        tags={t['Key']:t['Value'] for t in current.get('Tags',[])}
        if tags.get('Project')!='xregion' or tags.get('ClaimedBy') not in (None,row['instance_id'],server['id']):
            raise ValueError('Legacy EIP ownership changed')
        if current.get('AssociationId'):
            if (current.get('NetworkInterfaceId'),current.get('PrivateIpAddress'))!=(old['NetworkInterfaceId'],old['PrivateIpAddress']):
                raise ValueError('Legacy EIP has another consumer')
            x.call('ec2','disassociate_address',AssociationId=current['AssociationId'])
        deadline=time.monotonic()+60
        while ec2.describe_addresses(AllocationIds=[old['AllocationId']])['Addresses'][0].get('AssociationId'):
            if time.monotonic()>deadline: raise TimeoutError('Legacy EIP disassociation not confirmed')
            time.sleep(2)
        eni=ec2.describe_network_interfaces(NetworkInterfaceIds=[old['NetworkInterfaceId']])['NetworkInterfaces'][0]
        entry=next((p for p in eni['PrivateIpAddresses'] if p['PrivateIpAddress']==old['PrivateIpAddress']),None)
        if entry:
            if entry['Primary']: raise ValueError('Refusing primary ENI address')
            x.call('ec2','unassign_private_ip_addresses',NetworkInterfaceId=old['NetworkInterfaceId'],PrivateIpAddresses=[old['PrivateIpAddress']])
        owned=[t for t in current.get('Tags',[]) if t['Key'] in ('ClaimedBy','ClaimedAt','NovaId','ReservationId')]
        if owned: x.call('ec2','delete_tags',Resources=[old['AllocationId']],Tags=owned)


def apply_cleanup(x, baseline, manifest, receipts):
    validate_manifest(manifest, baseline)
    require_receipts(x, manifest, receipts)
    path = x.directory / "legacy-cleanup-checkpoints.json"
    state = json.loads(path.read_text()) if path.exists() else {}
    # Existing network mappings require the fenced termination workflow rather than
    # bypassing its generation/claim checks through raw Neutron/AWS API calls.
    mappings = {m["nova_id"]: m for m in baseline["tables"]["XRegion-NetworkMappings"]}
    instances = baseline["tables"]["XRegion-Instances"]
    for server in manifest["servers"]:
        assert_frozen(x)
        mapping = mappings.get(server["id"])
        # Check if already processed in checkpoint
        if state.get("server", {}).get(server["id"]):
            continue
        if mapping and mapping.get("status") != "DELETED":
            owners = [r for r in instances if server["id"] in (r.get("active_nova_id"), r.get("current_nova_id"))]
            if not owners:
                ports=[p for p in baseline['openstack']['ports'] if p.get('device_id')==server['id']]
                remove_orphan_network(x,server,ports)
                checkpoint(x,state,'server',server['id'])
                continue
            if len(owners) != 1:
                raise ValueError("Cannot resolve the exact owning instance for a NAT VM")
            name = "legacy-cleanup-" + manifest["manifest_sha256"][:12] + "-" + server["id"]
            arn = f"arn:aws:states:{REGION}:{ACCOUNT}:execution:TerminateInstance:{name}"
            try:
                execution = x.client("stepfunctions").describe_execution(executionArn=arn)
            except x.client("stepfunctions").exceptions.ExecutionDoesNotExist:
                execution = x.call("stepfunctions", "start_execution",
                    stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:TerminateInstance", name=name,
                    input=json.dumps(dict(instance_id=owners[0]["instance_id"], nova_id=server["id"],
                                          server_id=server["id"], action="TERMINATE")))
            if execution.get("status") != "SUCCEEDED":
                # Resume the operator after the execution ends. Never redrive a failed run.
                x.save("legacy-active-termination.json", dict(execution_arn=arn, nova_id=server["id"]))
                raise RuntimeError("Wait for the recorded termination; inspect failure before retrying")
        else:
            ports = [p for p in baseline["openstack"]["ports"] if p.get("device_id") == server["id"]]
            remote_delete(x, "server", server, ports)
            release_legacy_address(x,server,baseline)
        checkpoint(x, state, "server", server["id"])
    for volume in manifest["volumes"]:
        assert_frozen(x)
        remote_delete(x, "volume", volume)
        checkpoint(x, state, "volume", volume["id"])
    for disk in manifest["ebs"]:
        assert_frozen(x)
        delete_legacy_ebs(x, manifest, disk)
        checkpoint(x, state, "ebs", disk["id"])
    x.save("legacy-cleanup-api-result.json", dict(manifest_sha256=manifest["manifest_sha256"], api_resources_absent=True,
                                                host_retirement_pending=True, dynamodb_reconciliation_pending=True))


def verify(x, baseline, manifest):
    validate_manifest(manifest, baseline)
    current = inventory(x, "legacy-current.json")
    servers = {s["id"] for s in current["openstack"]["servers"]}
    volumes = {v["id"] for v in current["openstack"]["volumes"]}
    disks = {d["VolumeId"] for d in current["ebs"]}
    domains = set(current["openstack"].get("domains", []))
    remaining_lvs = set()
    for report in current["openstack"].get("lvs", {}).get("report", []):
        for lv in report.get("lv", []):
            lv_name = lv.get("lv_name", "")
            if lv_name.startswith("volume-"):
                remaining_lvs.add(lv_name[7:])
    ports = {p.get("id") for p in current["openstack"].get("ports", [])}
    legacy_ports = {p["id"] for p in baseline["openstack"].get("ports", [])
                    if p.get("device_id") in {s["id"] for s in manifest["servers"]}}
    remaining = dict(servers=[s["id"] for s in manifest["servers"] if s["id"] in servers],
                     volumes=[v["id"] for v in manifest["volumes"] if v["id"] in volumes],
                     ebs=[d["id"] for d in manifest["ebs"] if d["id"] in disks],
                     domains=[s["id"] for s in manifest["servers"] if s["id"] in domains],
                     lvs=[v["id"] for v in manifest["volumes"] if v["id"] in remaining_lvs],
                     ports=[pid for pid in legacy_ports if pid in ports])
    x.save("legacy-verification.json", remaining)
    if any(remaining.values()):
        raise RuntimeError("Legacy resources remain; inspect legacy-verification.json")
    return remaining


def delete_legacy_ebs(x, manifest, selected):
    ec2 = x.client("ec2")
    ident = selected["id"]
    if ident == manifest["root_volume_id"] or not re.fullmatch(r"vol-(?:[0-9a-f]{8}|[0-9a-f]{17})", ident):
        raise ValueError("Root or invalid EBS ID")
    def current():
        try:
            return ec2.describe_volumes(VolumeIds=[ident])["Volumes"][0]
        except ClientError as error:
            if error.response["Error"]["Code"] == "InvalidVolume.NotFound":
                return None
            raise
    disk = current()
    if disk is None:
        return
    if {t["Key"]:t["Value"] for t in disk.get("Tags", [])} != selected["tags"]:
        raise ValueError("Legacy EBS ownership tags changed")
    for attachment in disk.get("Attachments", []):
        if attachment["InstanceId"] != HOST or attachment not in selected["attachments"]:
            raise ValueError("Legacy EBS attachment ownership changed")
        serial = ident.replace("-", "")
        source = r'''
import json, pathlib, subprocess
ident = SERIAL
path = pathlib.Path('/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_' + ident)
if not path.exists():
    raise ValueError('Mapped EBS block device is absent')
real = path.resolve()
if subprocess.check_output(['lsblk','-dn','-o','SERIAL',str(real)],text=True).strip() != ident:
    raise ValueError('EBS serial mismatch')
rows=json.loads(subprocess.check_output(['lsblk','--json','-o','NAME,MOUNTPOINTS',str(real)],text=True))['blockdevices']
def check(row):
    if any(row.get('mountpoints') or []):
        raise ValueError('EBS device or partition is mounted')
    if list((pathlib.Path('/sys/class/block') / row['name'] / 'holders').iterdir()):
        raise ValueError('EBS block device still has holders')
    for child in row.get('children',[]): check(child)
for row in rows: check(row)
print(json.dumps({'serial_verified':True,'no_consumers':True}))
'''
        host_python(x, "SERIAL=" + repr(serial) + "\n" + source, "legacy-ebs-consumers-" + ident)
        x.call("ec2", "detach_volume", VolumeId=ident, InstanceId=HOST, Device=attachment["Device"], Force=False)
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        disk = current()
        if disk is None:
            return
        if not disk.get("Attachments") and disk["State"] == "available":
            x.call("ec2", "delete_volume", VolumeId=ident)
            break
        time.sleep(3)
    else:
        raise TimeoutError("Legacy EBS detach not confirmed")
    while time.monotonic() < deadline:
        if current() is None:
            return
        time.sleep(3)
    raise TimeoutError("Legacy EBS deletion not confirmed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--profile", default="btl")
    parser.add_argument("--project-id", action="append")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("action", nargs="?", default="inventory", choices=("inventory", "freeze", "validate", "cleanup", "verify"))
    args = parser.parse_args()
    x = Deployment(args.directory, profile=args.profile)
    if args.action == "freeze":
        if not args.apply:
            print("Preview: close admission and set both pool managers' concurrency to zero")
            return
        freeze(x)
    elif args.action == "inventory":
        baseline = inventory(x)
        result = build_manifest(baseline, args.project_id or [PROJECT])
        x.save("legacy-manifest.json", result)
        print(json.dumps({k: len(result[k]) for k in ("servers", "volumes", "ebs", "unresolved", "preserved_ebs")}))
    else:
        baseline = json.loads((x.directory / "legacy-baseline.json").read_text())
        manifest = json.loads((x.directory / "legacy-manifest.json").read_text())
        validate_manifest(manifest, baseline)
        if args.action == "verify":
            verify(x, baseline, manifest)
        elif args.action == "cleanup" and not args.apply:
            print(json.dumps(manifest, indent=2))
        else:
            receipts = json.loads((x.directory / "storage-acceptance.json").read_text())
            if args.action == "cleanup":
                apply_cleanup(x, baseline, manifest, receipts)
            else:
                require_receipts(x, manifest, receipts)
                print("Manifest and live prerequisites passed; no resources deleted")


if __name__ == "__main__":
    main()
