"""Resumable live storage checks; all receipts stay in the deployment Temp directory."""
import base64
import json
import shlex

from legacy_cleanup import assert_frozen, host_python, PROJECT


def assert_maintenance(x):
    from legacy_cleanup import ADMISSION
    from lifecycle import no_running
    if json.loads(x.client("ssm").get_parameter(Name=ADMISSION)["Parameter"]["Value"]).get("mode") != "maintenance":
        raise RuntimeError("Live acceptance requires maintenance")
    no_running(x)


def empty_resize_create(x):
    assert_frozen(x)
    source = "PROJECT=" + repr(PROJECT) + "\n" + r'''
import json, openstack, time
from pathlib import Path
c=openstack.connect(project_id=PROJECT,project_name=None)
name='xregion-empty-resize-recovery-20261109'
marker=Path('/var/lib/cinder/xregion-empty-resize-recovery-20261109.json')
if marker.exists():
    record=json.loads(marker.read_text())
    if not record.get('id'):raise ValueError('Ambiguous create; reconcile by metadata before retry')
    v=c.block_storage.get_volume(record['id'])
else:
    with marker.open('x') as out:json.dump({'attempted':True,'name':name},out)
    v=c.block_storage.create_volume(name=name,size=1,volume_type='aws-ebs-gp3',metadata={'xregion_acceptance':name})
    marker.write_text(json.dumps({'id':v.id,'name':name}))
deadline=time.monotonic()+180
def wait(size):
    while time.monotonic()<deadline:
        v=c.block_storage.get_volume(json.loads(marker.read_text())['id'])
        if v.status.startswith('error'):raise RuntimeError(v.status)
        if v.status=='available' and v.size==size:return v
        time.sleep(2)
    raise TimeoutError('Empty-volume resize not confirmed')
if v.size!=2 and v.status!='extending':
    v=wait(1)
    if v.attachments or v.get('provider_location'):raise ValueError('Expected empty volume without export')
    record=json.loads(marker.read_text())
    if record.get('extend_attempted'):raise ValueError('Ambiguous extend; inspect recorded volume before retry')
    record['extend_attempted']=True;marker.write_text(json.dumps(record))
    c.block_storage.extend_volume(v,size=2)
v=wait(2)
print(json.dumps({'id':v.id,'provider_id':v.provider_id,'size':v.size,'project_id':v.project_id,'empty_extend_passed':True}))
'''
    result = host_python(x, source, "acceptance-empty-resize", 300)
    x.save("acceptance-empty-resize.json", result)
    return result


def resize_retry_after_restart(x):
    assert_frozen(x)
    record = json.loads((x.directory / "acceptance-empty-resize.json").read_text())
    source = "RECORD=" + repr(record) + "\n" + r'''
import json,subprocess
subprocess.run(['docker','restart','cinder_volume_ebs'],check=True,stdout=subprocess.PIPE)
inner="""
import json,subprocess,boto3,botocore.session
from storage.ebs_backend import EbsBackend
from unittest.mock import patch
s=botocore.session.get_session();s.set_config_variable('config_file','/etc/cinder/xregion-aws-config')
session=boto3.Session(profile_name='xregion-ebs',botocore_session=s,region_name='ap-southeast-2')
ec2=session.client('ec2')
def execute(*args,**kwargs):
    return subprocess.check_output(['sudo','cinder-rootwrap','/etc/cinder/rootwrap.conf']+list(args),text=True),''
b=EbsBackend(ec2,account='291634989063',region='ap-southeast-2',host_id='i-056d7f3dd24156234',execute=execute)
record=RECORD
with patch.object(ec2,'modify_volume',side_effect=AssertionError('Unexpected repeated ModifyVolume')) as modify:
    b.extend(record,2)
    try:b.extend(record,3)
    except ValueError as error:
        if 'single resize' not in str(error):raise
    else:raise AssertionError('Second resize accepted after restart')
    print(json.dumps({'same_target_retry':True,'second_target_refused':True,'modify_calls':modify.call_count,'size':2,'id':record['id'],'provider_id':record['provider_id']}))
""".replace('RECORD',repr(RECORD))
print(subprocess.check_output(['docker','exec','-i','cinder_volume_ebs','python','-'],input=inner,text=True))
'''
    result = host_python(x, source, "acceptance-resize-restart-retry", 180)
    x.save("acceptance-resize-restart-retry.json", result)
    return result


def delete_empty_proof(x):
    from legacy_cleanup import remote_delete
    record = json.loads((x.directory / "acceptance-empty-resize.json").read_text())
    remote_delete(x, "volume", dict(id=record["id"], project_id=PROJECT))
    ec2 = x.client("ec2")
    from botocore.exceptions import ClientError
    try:
        ec2.describe_volumes(VolumeIds=[record["provider_id"]])
    except ClientError as error:
        if error.response["Error"]["Code"] != "InvalidVolume.NotFound":
            raise
    else:
        raise RuntimeError("Proof EBS is still present")
    x.save("acceptance-empty-proof-deleted.json", dict(id=record["id"], ebs_id=record["provider_id"], absent=True))


def retire_lvm(x, baseline, manifest):
    from legacy_cleanup import verify
    assert_frozen(x)
    verify(x, baseline, manifest)
    receipt = json.loads((x.directory / "legacy-record-reconciliation.json").read_text())
    if not receipt.get("complete") or receipt.get("manifest_sha256") != manifest["manifest_sha256"]:
        raise ValueError("Record reconciliation has not passed")
    source = "EXPECTED_DROPINS=" + repr(baseline["openstack"]["loop_dropins"]) + "\n" + r'''
import configparser,datetime,hashlib,json,os,shutil,subprocess,time
from pathlib import Path
import openstack
c=openstack.connect()
run=lambda *a:subprocess.check_output(a,text=True).strip()
group='cinder-volumes'; backing=Path('/var/lib/cinder/cinder-volumes.img')
stamp='xregion-ebs-retirement-20261109'
backup=Path('/var/tmp')/stamp
backup.mkdir(mode=0o700,exist_ok=True)
if any('@lvm-1' in (v.host or '') for v in c.block_storage.volumes(all_projects=True,details=True)):
    raise ValueError('LVM API volume still exists')
if group in run('docker','exec','tgtd','tgtadm','--lld','iscsi','--mode','target','--op','show'):
    raise ValueError('LVM iSCSI target remains')
for service in c.block_storage.services():
    if service.binary=='cinder-volume' and service.host.endswith('@lvm-1'):
        c.block_storage.disable_service(service)
for p in Path('/etc/systemd/system/docker.service.d').glob('*.conf'):
    text=p.read_text()
    if 'cinder-loopback' in text or 'attach-cinder-loop' in text:
        if EXPECTED_DROPINS.get(str(p))!=hashlib.sha256(p.read_bytes()).hexdigest():
            raise ValueError('Docker dependency changed since frozen baseline')
        dest=backup/p.name
        if dest.exists() and dest.read_bytes()!=p.read_bytes():raise ValueError('Rollback config already differs')
        shutil.copy2(p,dest)
for name in ('cinder-volume','cinder-volume-ebs','cinder-api','cinder-scheduler','cinder-backup'):
    src=Path('/etc/kolla')/name
    if not (backup/name).exists():shutil.copytree(src,backup/name)
container=subprocess.run(['docker','inspect','cinder_volume'],capture_output=True,text=True)
if container.returncode==0:
    p=backup/'legacy-container-inspect.json'
    if not p.exists():p.write_text(container.stdout);os.chmod(p,0o600)
    subprocess.run(['docker','update','--restart=no','cinder_volume'],check=True,stdout=subprocess.PIPE)
    subprocess.run(['docker','stop','cinder_volume'],check=True,stdout=subprocess.PIPE)
    subprocess.run(['docker','rm','cinder_volume'],check=True,stdout=subprocess.PIPE)
for name in ('cinder-api','cinder-scheduler','cinder-backup','cinder-volume-ebs'):
    p=Path('/etc/kolla')/name/'cinder.conf'
    cfg=configparser.ConfigParser(interpolation=None,strict=False);cfg.read(p)
    cfg['DEFAULT']['default_volume_type']='aws-ebs-gp3'
    if name=='cinder-volume-ebs':cfg['DEFAULT']['enabled_backends']='aws-ebs'
    with p.open('w') as out:cfg.write(out)
    os.chmod(p,0o600)
if backing.exists():
    if backing.is_symlink() or backing.resolve()!=Path('/var/lib/cinder/cinder-volumes.img') or backing.stat().st_nlink!=1:
        raise ValueError('Backing file path is ambiguous')
    loops=json.loads(run('losetup','--json','--output','NAME,BACK-FILE'))['loopdevices']
    matches=[l for l in loops if l['back-file']==str(backing)]
    if len(matches)>1:raise ValueError('Backing loop identity is ambiguous')
    loop=matches[0]['name'] if matches else None
    pvs=json.loads(run('pvs','--reportformat','json','-o','pv_name,vg_name'))['report'][0]['pv']
    selected=[p for p in pvs if p['vg_name']==group]
    if selected:
        if not loop or len(selected)!=1 or selected[0]['pv_name']!=loop:raise ValueError('VG physical ownership changed')
        lvs=json.loads(run('lvs','--reportformat','json','-o','lv_name,vg_name',group))['report'][0]['lv']
        if any(l['lv_name']!='cinder-volumes-pool' for l in lvs):raise ValueError('User LV or unknown LV remains')
        if lvs:subprocess.run(['lvremove','--yes',group+'/cinder-volumes-pool'],check=True,stdout=subprocess.PIPE)
        subprocess.run(['vgremove','--yes',group],check=True,stdout=subprocess.PIPE)
        subprocess.run(['pvremove','--yes',loop],check=True,stdout=subprocess.PIPE)
    if loop:
        if list((Path('/sys/class/block')/Path(loop).name/'holders').iterdir()):raise ValueError('Loop device has holders')
        rows=json.loads(run('lsblk','--json','-o','NAME,MOUNTPOINTS',loop))['blockdevices']
        if any(any(r.get('mountpoints') or []) or r.get('children') for r in rows):raise ValueError('Loop has mounts or children')
        subprocess.run(['losetup','--detach',loop],check=True)
    # losetup detach may complete asynchronously with AUTOCLEAR.
    for attempt in range(15):
        if not any(l['back-file']==str(backing) for l in json.loads(run('losetup','--json','--output','NAME,BACK-FILE'))['loopdevices']):break
        time.sleep(1)
    else:raise ValueError('Backing still attached')
    backing.unlink()
for p in Path('/etc/systemd/system/docker.service.d').glob('*.conf'):
    if str(p) in EXPECTED_DROPINS:
        if hashlib.sha256(p.read_bytes()).hexdigest()!=EXPECTED_DROPINS[str(p)]:raise ValueError('Drop-in changed')
        p.unlink()
unit=Path('/etc/systemd/system/cinder-loopback.service')
if unit.exists():
    shutil.copy2(unit,backup/unit.name)
    subprocess.run(['systemctl','disable','cinder-loopback.service'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    unit.unlink()
subprocess.run(['systemctl','daemon-reload'],check=True)
if 'attach-cinder-loop' in run('systemctl','cat','docker.service') or 'cinder-loopback' in run('systemctl','cat','docker.service'):
    raise ValueError('Docker retains loopback dependency')
print(json.dumps({'retired':True,'backing_absent':not backing.exists(),'config_backup':str(backup),'default_volume_type':'aws-ebs-gp3'}))
'''
    result = host_python(x, source, "acceptance-retire-lvm", 300)
    x.save("acceptance-retire-lvm.json", result)
    return result


def guest_canary_create(x):
    """Supplement workflow receipts with authenticated guest/export recovery proof."""
    assert_maintenance(x)
    source = "PROJECT=" + repr(PROJECT) + "\n" + r'''
import json,openstack,subprocess,time,os
from pathlib import Path
c=openstack.connect(project_id=PROJECT,project_name=None)
directory=Path('/var/tmp/xregion-ebs-guest-proof-20261109');directory.mkdir(mode=0o700,exist_ok=True)
marker=directory/'resources.json'
state=json.loads(marker.read_text()) if marker.exists() else {'name':'xregion-ebs-guest-proof-20261109','attempts':{}}
def save():marker.write_text(json.dumps(state));os.chmod(marker,0o600)
def once(label,create):
    if state.get(label):return state[label]
    if state['attempts'].get(label):raise ValueError('Ambiguous '+label+' create: inspect marker before retry')
    state['attempts'][label]=True;save()
    state[label]=create();save();return state[label]
key=directory/'id_ed25519'
if not key.exists():subprocess.run(['ssh-keygen','-t','ed25519','-N','','-f',str(key)],check=True,stdout=subprocess.PIPE)
once('key',lambda:c.compute.create_keypair(name=state['name'],public_key=Path(str(key)+'.pub').read_text()).name)
once('volume',lambda:c.block_storage.create_volume(name=state['name'],size=10,image_id='fd249548-1863-4d30-b809-732108cab057',volume_type='aws-ebs-gp3',metadata={'xregion_acceptance':state['name']}).id)
deadline=time.monotonic()+360
while True:
    v=c.block_storage.get_volume(state['volume'])
    if v.status.startswith('error'):raise ValueError('Canary volume: '+v.status)
    if v.status=='available':break
    if time.monotonic()>deadline:raise TimeoutError('Canary volume not ready')
    time.sleep(3)
if v.size==10:
    if state.get('extend_attempted'):raise ValueError('Ambiguous extend; inspect existing operation')
    state['extend_attempted']=True;save();c.block_storage.extend_volume(v,size=12)
while True:
    v=c.block_storage.get_volume(state['volume'])
    if v.status.startswith('error'):raise ValueError('Canary extend: '+v.status)
    if v.status=='available' and v.size==12:break
    if time.monotonic()>deadline:raise TimeoutError('Canary extend not ready')
    time.sleep(3)
state['ebs']=v.provider_id;save()
once('sg',lambda:c.network.create_security_group(name=state['name'],description=state['name']).id)
if not state.get('rules'):
    existing=list(c.network.security_group_rules(security_group_id=state['sg']))
    for cidr in ('192.168.100.0/24','10.20.10.183/32'):
        for protocol in ('tcp','icmp'):
            if not any(r.direction=='ingress' and r.remote_ip_prefix==cidr and r.protocol==protocol for r in existing):
                args={'direction':'ingress','ethertype':'IPv4','protocol':protocol,'remote_ip_prefix':cidr,'security_group_id':state['sg']}
                if protocol=='tcp':args.update(port_range_min=22,port_range_max=22)
                c.network.create_security_group_rule(**args)
    state['rules']=True;save()
once('port',lambda:c.network.create_port(name=state['name'],network_id='5b7d6d0c-3cca-45dc-b510-5b672321927f',security_group_ids=[state['sg']]).id)
flavor=c.compute.find_flavor('m1.tiny',ignore_missing=False)
def boot():
    return c.compute.post('/servers',json={'server':{'name':state['name'],'flavorRef':flavor.id,'key_name':state['key'],'config_drive':True,
        'networks':[{'port':state['port']}],'metadata':{'xregion_acceptance':state['name']},
        'block_device_mapping_v2':[{'boot_index':0,'uuid':state['volume'],'source_type':'volume','destination_type':'volume','delete_on_termination':False}]}}).json()['server']['id']
once('server',boot)
s=c.compute.wait_for_server(c.compute.get_server(state['server']),status='ACTIVE',wait=180)
port=c.network.get_port(state['port']);state['guest_ip']=port.fixed_ips[0]['ip_address'];save()
print(json.dumps({k:v for k,v in state.items() if k not in ('attempts','rules')}))
'''
    result = host_python(x, source, "acceptance-guest-create", 600)
    x.save("acceptance-guest-create.json", result)
    return result


def guest_ssh(x, label="before-restart"):
    record = json.loads((x.directory / "acceptance-guest-create.json").read_text())
    guest_script = '''import os,json,subprocess
rows=json.loads(subprocess.check_output(['lsblk','-b','-J','-o','NAME,SIZE,TYPE,MOUNTPOINTS'],text=True))['blockdevices']
def root(row):
    return '/' in (row.get('mountpoints') or []) or any(root(c) for c in row.get('children',[]))
disks=[r for r in rows if r['type']=='disk' and root(r)]
if len(disks)!=1:raise ValueError('Root disk identity is ambiguous')
fs=os.statvfs('/')
print(json.dumps({'disk_bytes':int(disks[0]['size']),'root_bytes':fs.f_blocks*fs.f_frsize}))
'''
    encoded = base64.b64encode(guest_script.encode()).decode()
    command = "cloud-init status --wait >/dev/null; python3 -c " + shlex.quote("import base64;exec(base64.b64decode(" + repr(encoded) + "))")
    source = "RECORD=" + repr(record) + "\nCOMMAND=" + repr(command) + "\n" + r'''
import json,subprocess,time
key='/var/tmp/xregion-ebs-guest-proof-20261109/id_ed25519'
known='/var/tmp/xregion-ebs-guest-proof-20261109/known_hosts'
deadline=time.monotonic()+750
while True:
    try:
        p=subprocess.run(['ssh','-i',key,'-o','BatchMode=yes','-o','ConnectTimeout=30','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+known,
            'ubuntu@'+RECORD['guest_ip'],COMMAND],capture_output=True,text=True,timeout=120)
    except subprocess.TimeoutExpired:
        if time.monotonic()>deadline:raise
        continue
    if p.returncode==0:break
    if time.monotonic()>deadline:raise RuntimeError('Authenticated SSH not ready: '+p.stderr[-500:])
    time.sleep(5)
result=json.loads(p.stdout.strip().splitlines()[-1])
if result['disk_bytes']!=12*1024**3 or result['root_bytes']<10*1024**3:raise ValueError('Guest disk/filesystem does not reflect resize')
ping=subprocess.run(['ping','-c','10',RECORD['guest_ip']],capture_output=True,text=True)
if ping.returncode or '10 received' not in ping.stdout:raise ValueError('Guest ping did not pass')
print(json.dumps(dict(result,authenticated_ssh=True,ping_10_of_10=True,server=RECORD['server'],volume=RECORD['volume'],ebs=RECORD['ebs'])))
'''
    result = host_python(x, source, "acceptance-guest-ssh-" + label, 900)
    x.save("acceptance-guest-ssh-" + label + ".json", result)
    return result


def recover_export(x):
    assert_maintenance(x)
    record = json.loads((x.directory / "acceptance-guest-create.json").read_text())
    source = "RECORD=" + repr(record) + "\nPROJECT=" + repr(PROJECT) + "\n" + r'''
import json,openstack,subprocess,time
c=openstack.connect(project_id=PROJECT,project_name=None)
run=lambda *a:subprocess.check_output(a,text=True)
targets=run('docker','exec','tgtd','tgtadm','--lld','iscsi','--mode','target','--op','show')
if any(line.startswith('Target ') and RECORD['volume'] not in line for line in targets.splitlines()):
    raise ValueError('Another guest export exists; refusing shared target restart')
s=c.compute.get_server(RECORD['server'])
if s.status=='ACTIVE':c.compute.pause_server(s)
c.compute.wait_for_server(s,status='PAUSED',wait=90)
subprocess.run(['docker','restart','tgtd'],check=True,stdout=subprocess.PIPE)
subprocess.run(['docker','restart','cinder_volume_ebs'],check=True,stdout=subprocess.PIPE)
deadline=time.monotonic()+120
while True:
    targets=run('docker','exec','tgtd','tgtadm','--lld','iscsi','--mode','target','--op','show')
    if RECORD['volume'] in targets and 'Backing store path: /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_'+RECORD['ebs'].replace('-','') in targets:break
    if time.monotonic()>deadline:raise TimeoutError('Cinder did not recover the export')
    time.sleep(3)
c.compute.unpause_server(RECORD['server'])
c.compute.wait_for_server(c.compute.get_server(RECORD['server']),status='ACTIVE',wait=90)
print(json.dumps({'export_recovered':True,'server':RECORD['server'],'volume':RECORD['volume'],'ebs':RECORD['ebs']}))
'''
    result = host_python(x, source, "acceptance-export-recovery", 360)
    x.save("acceptance-export-recovery.json", result)
    return result


def delete_guest_canary(x):
    assert_maintenance(x)
    from legacy_cleanup import remote_delete
    record = json.loads((x.directory / "acceptance-guest-create.json").read_text())
    if not json.loads((x.directory / "acceptance-guest-ssh-after-restart.json").read_text()).get("authenticated_ssh"):
        raise ValueError("Guest proof has not passed")
    source = "RECORD=" + repr(record) + "\nPROJECT=" + repr(PROJECT) + "\n" + r'''
import json,openstack
c=openstack.connect(project_id=PROJECT,project_name=None)
port=c.network.get_port(RECORD['port'])
sg=c.network.get_security_group(RECORD['sg'])
if port and (port.name!=RECORD['name'] or port.device_id not in ('',RECORD['server'])):raise ValueError('Canary port ownership changed')
if sg and (sg.name!=RECORD['name'] or sg.description!=RECORD['name']):raise ValueError('Canary group ownership changed')
print(json.dumps({'port':port.to_dict() if port else {'id':RECORD['port'],'network_id':'5b7d6d0c-3cca-45dc-b510-5b672321927f'}}))
'''
    ports = host_python(x, source, "acceptance-guest-cleanup-preflight")["port"]
    remote_delete(x, "server", dict(id=record["server"], project_id=PROJECT, volume_ids=[record["volume"]]), [ports])
    remote_delete(x, "volume", dict(id=record["volume"], project_id=PROJECT))
    source = "RECORD=" + repr(record) + "\nPROJECT=" + repr(PROJECT) + "\n" + r'''
import json,openstack,subprocess
from openstack.exceptions import NotFoundException
c=openstack.connect(project_id=PROJECT,project_name=None)
try:g=c.network.get_security_group(RECORD['sg'])
except NotFoundException:g=None
if g:
    if g.name!=RECORD['name'] or g.description!=RECORD['name']:raise ValueError('Canary group ownership changed')
    if any(g.id in p.security_group_ids for p in c.network.ports()):raise ValueError('Group is shared')
    c.network.delete_security_group(g,ignore_missing=False)
try:k=c.compute.get_keypair(RECORD['key'])
except NotFoundException:k=None
if k:c.compute.delete_keypair(k,ignore_missing=False)
targets=subprocess.check_output(['docker','exec','tgtd','tgtadm','--lld','iscsi','--mode','target','--op','show'],text=True)
if RECORD['volume'] in targets:raise ValueError('Guest target still exists')
print(json.dumps({'canary_cleanup_complete':True,'server':RECORD['server'],'volume':RECORD['volume']}))
'''
    result = host_python(x, source, "acceptance-guest-cleanup-final")
    from botocore.exceptions import ClientError
    try:
        x.client("ec2").describe_volumes(VolumeIds=[record["ebs"]])
    except ClientError as error:
        if error.response["Error"]["Code"] != "InvalidVolume.NotFound":
            raise
    else:
        raise RuntimeError("Guest canary EBS is still present")
    x.save("acceptance-guest-deleted.json", dict(result, ebs=record["ebs"], ebs_absent=True))
    return result


def observe(x, filename="acceptance-observation.json"):
    from collections import Counter
    from control import HOST
    from legacy_cleanup import inventory
    state = inventory(x, "acceptance-inventory-current.json")
    os_state = state["openstack"]
    if os_state["legacy_backing_exists"] or os_state["default_volume_type"] != "aws-ebs-gp3":
        raise RuntimeError("LVM retirement/default type regressed")
    if any(loop["back-file"] == "/var/lib/cinder/cinder-volumes.img" for loop in os_state["loops"]["loopdevices"]):
        raise RuntimeError("Legacy loop reappeared")
    if any(s["host"].endswith("@lvm-1") and s["status"] != "disabled" for s in os_state["services"]):
        raise RuntimeError("LVM scheduler service enabled")
    if not any(s["host"].endswith("@aws-ebs") and s["state"] == "up" and s["status"] == "enabled" for s in os_state["services"]):
        raise RuntimeError("EBS service heartbeat is not up")
    volumes = {v["id"]: v for v in os_state["volumes"]}
    disks = {}
    for disk in state["ebs"]:
        tags = {t["Key"]: t["Value"] for t in disk.get("Tags", [])}
        if tags.get("ManagedBy") != "xregion-cinder-ebs-v1" or tags.get("StorageHostId") != HOST:
            continue
        ident = tags["CinderVolumeId"]
        if ident in disks or ident not in volumes:
            raise RuntimeError("Duplicate/orphan EBS mapping: " + ident)
        volume = volumes[ident]
        if (disk["Size"] != volume["size"] or not disk.get("Encrypted") or disk["VolumeType"] != "gp3" or
                disk["AvailabilityZone"] != state["host"]["Placement"]["AvailabilityZone"] or
                any(a["InstanceId"] != HOST for a in disk.get("Attachments", [])) or
                tags.get("StorageBackend") != "aws-ebs" or disk["VolumeId"] != volume.get("provider_id")):
            raise RuntimeError("Cinder/EBS physical mapping mismatch: " + ident)
        if any(a["State"] == "attached" for a in disk.get("Attachments", [])) and disk["VolumeId"].replace("-", "") not in json.dumps(os_state["blocks"]):
            raise RuntimeError("Attached EBS serial missing on host")
        disks[ident] = disk
    if set(volumes) != set(disks) or any(v.get("volume_type") != "aws-ebs-gp3" for v in volumes.values()):
        raise RuntimeError("Non-EBS Cinder volume or missing physical allocation")
    rows = [r for r in state["tables"]["XRegion-Volumes"] if r.get("storage_backend") == "aws-ebs" and r.get("status") == "AVAILABLE"]
    ids = [r["cinder_volume_id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise RuntimeError("Duplicate pool records for one physical volume")
    for row in rows:
        v = volumes.get(row["cinder_volume_id"], {})
        if (v.get("status") != "available" or v.get("attachments") or
                str(v.get("bootable", v.get("is_bootable"))).lower() != "true" or
                disks[row["cinder_volume_id"]]["VolumeId"] != row.get("ebs_volume_id")):
            raise RuntimeError("Pool AVAILABLE record does not match physical volume")
    counts = dict(Counter(r["image_id"] for r in rows))
    expected = {"fd249548-1863-4d30-b809-732108cab057", "cdcc55f6-59db-40b4-8391-95e2ee8fbaa9", "72e9830a-53ef-4c36-8b5c-fae3b96a3fd0"}
    if set(counts) != expected or any(n != 3 for n in counts.values()):
        raise RuntimeError("Pool is not three AVAILABLE volumes per image")
    roots = [b["Ebs"]["VolumeId"] for b in state["host"]["BlockDeviceMappings"] if b["DeviceName"] == state["host"]["RootDeviceName"]]
    if roots != ["vol-0b788d4555b67eb67"]:
        raise RuntimeError("Root EBS identity changed")
    result = dict(at=state["captured_at"], pool_counts=counts, cinder_count=len(volumes), ebs_count=len(disks),
                  capacity_gib=sum(d["Size"] for d in disks.values()), default_volume_type=os_state["default_volume_type"],
                  root_volume_id=roots[0], orphan_ebs=[], non_ebs_volumes=[], legacy_backing_absent=True)
    x.save(filename, result)
    return result


def enable_pool_schedule(x):
    """Keep reserves replenished after allocation, independently of event ordering."""
    from control import ACCOUNT, REGION
    events = x.client("events")
    name = "XRegion-EbsPoolReconcile"
    arn = f"arn:aws:events:{REGION}:{ACCOUNT}:rule/{name}"
    try:
        before = events.describe_rule(Name=name)
    except events.exceptions.ResourceNotFoundException:
        before = None
    if before:
        tags = events.list_tags_for_resource(ResourceARN=arn)["Tags"]
        if {t["Key"]: t["Value"] for t in tags}.get("ManagedBy") != "xregion-ebs-cutover":
            raise ValueError("Existing pool schedule is not owned by this deployment")
    x.save("acceptance-pool-schedule-before.json", before)
    x.call("events", "put_rule", Name=name, ScheduleExpression="rate(1 minute)", State="ENABLED",
           Description="Reconcile three EBS reserve volumes per active XRegion image",
           Tags=[{"Key": "ManagedBy", "Value": "xregion-ebs-cutover"}])
    name_lambda = "XRegion-CinderPoolManager"
    client = x.client("lambda")
    sid = "XRegionEbsPoolSchedule"
    try:
        policy = json.loads(client.get_policy(FunctionName=name_lambda)["Policy"])
    except client.exceptions.ResourceNotFoundException:
        policy = {"Statement": []}
    statement = next((s for s in policy["Statement"] if s.get("Sid") == sid), None)
    if statement:
        if (statement.get("Principal", {}).get("Service") != "events.amazonaws.com" or
                statement.get("Condition", {}).get("ArnLike", {}).get("AWS:SourceArn") != arn):
            raise ValueError("Pool schedule Lambda permission differs")
    else:
        x.call("lambda", "add_permission", FunctionName=name_lambda, StatementId=sid,
               Action="lambda:InvokeFunction", Principal="events.amazonaws.com", SourceArn=arn, SourceAccount=ACCOUNT)
    response = x.call("events", "put_targets", Rule=name, Targets=[dict(Id="EbsPool", Arn=f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{name_lambda}", Input="{}")])
    if response.get("FailedEntryCount"):
        raise RuntimeError("Pool schedule target failed")
    result = dict(rule=events.describe_rule(Name=name), targets=events.list_targets_by_rule(Rule=name)["Targets"])
    x.save("acceptance-pool-schedule-after.json", result)
    return result


def monitor(x, minutes=30):
    import datetime
    import time
    from control import ACCOUNT, REGION
    from legacy_cleanup import ADMISSION, POOLS
    started = datetime.datetime.now(datetime.timezone.utc)
    deadline = time.monotonic() + minutes * 60
    observations = []
    try:
        while True:
            if json.loads(x.client("ssm").get_parameter(Name=ADMISSION)["Parameter"]["Value"]) != {"mode": "open"}:
                raise RuntimeError("Admission changed during monitoring")
            result = observe(x)
            failures, pool_errors = [], []
            for name in ("LaunchInstance", "TerminateInstance"):
                for page in x.client("stepfunctions").get_paginator("list_executions").paginate(
                        stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"):
                    recent = [e for e in page["executions"] if e["startDate"] >= started]
                    failures.extend(e["executionArn"] for e in recent if e["status"] in ("FAILED", "TIMED_OUT", "ABORTED"))
                    if len(recent) < len(page["executions"]):
                        break
            for name in POOLS:
                for page in x.client("logs").get_paginator("filter_log_events").paginate(
                        logGroupName="/aws/lambda/" + name, startTime=int(started.timestamp() * 1000)):
                    pool_errors.extend(e["eventId"] for e in page.get("events", []) if "[ERROR]" in e["message"] or "Task timed out" in e["message"])
            if failures or pool_errors:
                raise RuntimeError("Lifecycle/pool failure during monitoring")
            result.update(elapsed_seconds=round((datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()),
                          lifecycle_failures=failures, pool_errors=pool_errors)
            observations.append(result)
            complete = time.monotonic() >= deadline
            x.save("acceptance-monitor.json", dict(started_at=started.isoformat(), complete=complete, observations=observations))
            print(json.dumps(result), flush=True)
            if complete:
                return observations
            time.sleep(min(45, max(0, deadline - time.monotonic())))
    except Exception:
        x.call("ssm", "put_parameter", Name=ADMISSION, Type="String", Value=json.dumps({"mode": "maintenance"}), Overwrite=True)
        for name in POOLS:
            x.call("lambda", "put_function_concurrency", FunctionName=name, ReservedConcurrentExecutions=0)
        raise
