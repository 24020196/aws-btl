"""Read-only compatibility checks and immutable driver-image build.

This does not install a driver or route production traffic implicitly.
All transport/rollback artifacts live in the OS Temp deployment directory.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path

from control import Deployment, ROOT, ACCOUNT, REGION, HOST
from legacy_cleanup import host_python


def driver_files():
    return {p.name: p.read_text(encoding="utf-8") for p in (ROOT / "storage").glob("*.py")}


def compatibility(x):
    encoded = base64.b64encode(json.dumps(driver_files()).encode()).decode()
    inner = "import base64\nFILES=" + repr(encoded) + "\n" + r'''
import importlib.metadata as m,json,types,sys
files=json.loads(base64.b64decode(FILES))
package=types.ModuleType('storage');package.__path__=[];sys.modules['storage']=package
for filename in ('ebs_backend.py','cinder_ebs.py'):
    name='storage.'+filename[:-3];module=types.ModuleType(name);sys.modules[name]=module
    exec(compile(files[filename],filename,'exec'),module.__dict__)
from oslo_config import cfg
from cinder.volume import configuration
cfg.CONF.register_group(cfg.OptGroup('aws-ebs'))
cfg.CONF([],project='cinder')
config=configuration.Configuration([],config_group='aws-ebs')
candidate=sys.modules['storage.cinder_ebs'].XRegionEbsDriver(configuration=config)
print(json.dumps(dict(cinder=m.version('cinder'),boto3=m.version('boto3'),
    driver=type(candidate).__name__,target=type(candidate.target_driver).__name__)))
'''
    source = "import subprocess,json\nresult=subprocess.check_output(['docker','exec','-i','cinder_volume','python','-'],input=" + repr(inner) + ",text=True)\nprint(result)"
    result = host_python(x, source, "ebs-driver-compatibility", 180)
    x.save("ebs-driver-compatibility.json", result)
    return result


def build_image(x):
    proof = json.loads((x.directory / "ebs-driver-compatibility.json").read_text())
    if proof["cinder"] != "26.3.1.dev1":
        raise ValueError("Build must be revalidated against the recorded live Cinder version")
    files = driver_files()
    files['ebs.filters'] = (ROOT / 'storage/ebs.filters').read_text(encoding='utf-8')
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    encoded = base64.b64encode(json.dumps(files).encode()).decode()
    source = "FILES=" + repr(encoded) + "\nDIGEST=" + repr(digest) + "\n" + r'''
import base64,io,json,subprocess,tarfile
files=json.loads(base64.b64decode(FILES))
base=subprocess.check_output(['docker','inspect','-f','{{.Image}}','cinder_volume'],text=True).strip()
site=subprocess.check_output(['docker','exec','cinder_volume','python','-c','import sysconfig;print(sysconfig.get_paths()["purelib"])'],text=True).strip()
if not base.startswith('sha256:') or not site.startswith('/var/lib/kolla/venv/'):
    raise ValueError('Unexpected immutable base image or Python path')
base_tag='xregion/cinder-volume:base-'+base.split(':')[1][:16]
subprocess.run(['docker','tag',base,base_tag],check=True)
dockerfile='FROM '+base_tag+'\nUSER root\nCOPY storage/ '+site+'/storage/\nCOPY storage/ebs.filters /etc/cinder/rootwrap.d/xregion-ebs.filters\nUSER cinder\n'
archive=io.BytesIO()
with tarfile.open(fileobj=archive,mode='w') as tar:
    for name,text in dict({'Dockerfile':dockerfile},**{'storage/'+k:v for k,v in files.items()}).items():
        data=text.encode();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
        tar.addfile(info,io.BytesIO(data))
tag='xregion/cinder-volume:ebs-'+DIGEST[:16]
build=subprocess.run(['docker','build','--network=none','-t',tag,'-'],input=archive.getvalue(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if build.returncode:
    raise RuntimeError('Driver image build failed: '+build.stderr.decode()[-4000:])
image=subprocess.check_output(['docker','image','inspect','-f','{{.Id}}',tag],text=True).strip()
print(json.dumps(dict(tag=tag,image_id=image,base_image=base,source_sha256=DIGEST)))
'''
    result = host_python(x, source, "ebs-driver-image-build", 300)
    x.save("ebs-driver-image.json", result)
    return result


def scoped_policy(baseline, root_id, kms_key):
    """Constrain the generated baseline, rather than guessing SDK permissions."""
    actions = {a for p in baseline["Policies"] for s in p["Policy"]["Statement"] for a in s["Action"]}
    required = {"ec2:CreateVolume", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume",
                "ec2:ModifyVolume", "ec2:CreateSnapshot", "ec2:DeleteSnapshot"}
    if not required <= actions:
        raise ValueError("Regenerate the Autopilot baseline: required operations are absent")
    volume = f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/*"
    snapshot = f"arn:aws:ec2:{REGION}::snapshot/*"
    instance = f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{HOST}"
    request = {"aws:RequestTag/ManagedBy": "xregion-cinder-ebs-v1", "aws:RequestTag/StorageHostId": HOST,
               "aws:RequestTag/StorageBackend": "aws-ebs"}
    owned = {"ec2:ResourceTag/ManagedBy": "xregion-cinder-ebs-v1", "ec2:ResourceTag/StorageHostId": HOST}
    def statement(sid, verbs, resources, condition=None, effect="Allow"):
        result = dict(Sid=sid, Effect=effect, Action=verbs, Resource=resources)
        if condition: result["Condition"] = condition
        return result
    return {"Version": "2012-10-17", "Statement": [
        statement("Identity", ["sts:GetCallerIdentity"], "*"),
        statement("DescribeSydney", sorted(a for a in actions if a.startswith("ec2:Describe")), "*",
                  {"StringEquals": {"aws:RequestedRegion": REGION}}),
        statement("CreateOwnedEncryptedGp3", ["ec2:CreateVolume"], volume,
                  {"StringEquals": dict(request, **{"ec2:VolumeType": "gp3", "ec2:AvailabilityZone": "ap-southeast-2a"}),
                   "Bool": {"ec2:Encrypted": "true"}}),
        statement("TagOnlyAtCreation", ["ec2:CreateTags"], [volume, snapshot],
                  {"StringEquals": dict(request, **{"ec2:CreateAction": ["CreateVolume", "CreateSnapshot"]})}),
        statement("OwnVolumeLifecycle", ["ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume", "ec2:ModifyVolume"], volume,
                  {"StringEquals": owned}),
        statement("MarkSingleResizeOnce", ["ec2:CreateTags"], volume,
                  {"StringEquals": owned, "ForAllValues:StringEquals": {"aws:TagKeys": ["XRegionResizeTargetGiB"]},
                   "Null": {"ec2:ResourceTag/XRegionResizeTargetGiB": "true", "aws:RequestTag/XRegionResizeTargetGiB": "false"}}),
        statement("AttachOnlyToStorageHost", ["ec2:AttachVolume", "ec2:DetachVolume"], instance),
        statement("SnapshotOwnedSource", ["ec2:CreateSnapshot"], volume, {"StringEquals": owned}),
        statement("CreateOwnedSnapshot", ["ec2:CreateSnapshot"], snapshot, {"StringEquals": request}),
        statement("DeleteOwnedSnapshot", ["ec2:DeleteSnapshot"], snapshot, {"StringEquals": owned}),
        statement("RestoreOwnedSnapshot", ["ec2:CreateVolume"], snapshot, {"StringEquals": owned}),
        statement("NeverMutateRoot", sorted(required | {"ec2:CreateTags", "ec2:DeleteTags"}),
                  f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/{root_id}", effect="Deny"),
        statement("EbsEncryption", ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*"], kms_key,
                  {"StringEquals": {"kms:ViaService": f"ec2.{REGION}.amazonaws.com", "kms:CallerAccount": ACCOUNT}}),
        statement("EbsServiceGrant", ["kms:CreateGrant"], kms_key, {"Bool": {"kms:GrantIsForAWSResource": "true"}}),
    ]}


def install_backend(x):
    """Install a separate service, keeping the legacy service available for drain."""
    image = json.loads((x.directory / "ebs-driver-image.json").read_text())
    role = json.loads((x.directory / "driver-role.json").read_text())
    source = "IMAGE=" + repr(image["image_id"]) + "\nROLE=" + repr(role["role_arn"]) + "\nHOST=" + repr(HOST) + "\n" + r'''
import configparser,json,os,shutil,subprocess,time
from pathlib import Path
def run(*args): return subprocess.check_output(args,text=True).strip()
original=json.loads(run('docker','inspect','cinder_volume'))[0]
old=Path('/etc/kolla/cinder-volume');new=Path('/etc/kolla/cinder-volume-ebs')
if not new.exists():
    shutil.copytree(old,new)
    os.chmod(new,0o700)
config=configparser.ConfigParser(interpolation=None,strict=False)
config.read(old/'cinder.conf')
config['DEFAULT']['enabled_backends']='aws-ebs'
config['DEFAULT']['log_file']='/var/log/kolla/cinder/cinder-volume-ebs.log'
config['DEFAULT']['enable_unsupported_driver']='true'
legacy=dict(config['lvm-1'])
config.remove_section('lvm-1')
config['aws-ebs']={k:v for k,v in legacy.items() if k.startswith(('target_','iscsi_'))}
config['aws-ebs'].update(dict(volume_driver='storage.cinder_ebs.XRegionEbsDriver',
    volume_backend_name='aws-ebs',enable_unsupported_driver='true',target_helper='tgtadm',target_protocol='iscsi',iscsi_iotype='blockio',
    xregion_ebs_host_id=HOST,xregion_ebs_capacity_gib='100',xregion_ebs_max_attached_volumes='25'))
with (new/'cinder.conf').open('w') as out: config.write(out)
os.chmod(new/'cinder.conf',0o600)
aws=new/'xregion-aws-config'
aws.write_text('[profile xregion-ebs]\nrole_arn = '+ROLE+'\ncredential_source = Ec2InstanceMetadata\nregion = ap-southeast-2\n')
os.chmod(aws,0o600)
kolla=json.loads((old/'config.json').read_text())
for item in kolla['config_files']:
    if item['source'].startswith(str(old)+'/'):
        item['source']=item['source'].replace(str(old),str(new),1)
    # Kolla usually uses /var/lib/kolla/config_files; that mount is already switched.
kolla['config_files']=[i for i in kolla['config_files'] if i.get('dest')!='/etc/cinder/xregion-aws-config']
kolla['config_files'].append(dict(source='/var/lib/kolla/config_files/xregion-aws-config',dest='/etc/cinder/xregion-aws-config',owner='cinder',perm='0600'))
(new/'config.json').write_text(json.dumps(kolla,indent=2))
existing=subprocess.run(['docker','inspect','cinder_volume_ebs'],capture_output=True,text=True)
if existing.returncode==0:
    candidate=json.loads(existing.stdout)[0]
    if candidate['Image']!=IMAGE:
        if not any(m['Source']==str(new) and m['Destination']=='/var/lib/kolla/config_files' for m in candidate['Mounts']):
            raise ValueError('Existing sidecar is not owned by this installer')
        subprocess.run(['docker','stop','cinder_volume_ebs'],check=True,stdout=subprocess.PIPE)
        subprocess.run(['docker','rm','cinder_volume_ebs'],check=True,stdout=subprocess.PIPE)
        existing.returncode=1
    else:
        subprocess.run(['docker','restart','cinder_volume_ebs'],check=True,stdout=subprocess.PIPE)
if existing.returncode!=0:
    args=['docker','run','-d','--name','cinder_volume_ebs','--network=host','--ipc='+original['HostConfig']['IpcMode'],
          '--hostname='+original['Config']['Hostname'],'--restart=unless-stopped']
    if original['HostConfig']['Privileged']: args.append('--privileged')
    for env in original['Config']['Env']:
        if env.startswith(('KOLLA_','LANG=','LC_ALL=','TZ=')): args+=['-e',env]
    for mount in original['Mounts']:
        src=mount.get('Name') if mount['Type']=='volume' else mount['Source']
        if mount['Destination']=='/var/lib/kolla/config_files': src=str(new)
        mode=mount['Mode'] or 'rw'
        args+=['-v',src+':'+mount['Destination']+':'+mode]
    args+=[IMAGE]+original['Config']['Cmd']
    subprocess.run(args,check=True,stdout=subprocess.PIPE)
time.sleep(8)
candidate=json.loads(run('docker','inspect','cinder_volume_ebs'))[0]
print(json.dumps(dict(image=candidate['Image'],running=candidate['State']['Running'],
    restart_count=candidate['RestartCount'],config_directory=str(new))))
'''
    result = host_python(x, source, "ebs-backend-install", 180)
    x.save("ebs-backend-install.json", result)
    return result


def canary_volume(x, suffix=''):
    if suffix and (not suffix.isalnum() or len(suffix)>12):
        raise ValueError('Invalid canary suffix')
    source = r'''
import openstack,json,os,time
from pathlib import Path
c=openstack.connect()
t=c.block_storage.find_type('aws-ebs-gp3')
if not t:
    t=c.block_storage.create_type(name='aws-ebs-gp3',extra_specs={'volume_backend_name':'aws-ebs'})
if t.extra_specs.get('volume_backend_name')!='aws-ebs': raise ValueError('Type routes to another backend')
project='d3bf05331973481891385d066d3eba3e'
c=openstack.connect(project_id=project,project_name=None)
name='xregion-ebs-cutover-canary-20261109'
matches=list(c.block_storage.volumes(name=name))
if len(matches)>1: raise ValueError('Duplicate canary volume')
if matches and matches[0].status.startswith('error'):
    v=c.block_storage.get_volume(matches[0].id)
    if v.attachments or v.volume_type!='aws-ebs-gp3' or v.metadata.get('xregion_cutover')!='20261109':
        raise ValueError('Failed canary ownership or attachment changed')
    c.block_storage.delete_volume(v,ignore_missing=False)
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        if c.block_storage.find_volume(v.id) is None: break
        time.sleep(3)
    else: raise TimeoutError('Failed canary deletion not confirmed')
    marker=Path('/var/lib/xregion-ebs-cutover-canary-attempt')
    if marker.read_text().strip()!=name: raise ValueError('Canary marker changed')
    marker.unlink()
    matches=[]
if matches:
    v=matches[0]
else:
    marker=Path('/var/lib/xregion-ebs-cutover-canary-attempt')
    try:
        with marker.open('x') as out: out.write(name+'\n')
    except FileExistsError: raise ValueError('Ambiguous prior create: reconcile before retry')
    v=c.block_storage.create_volume(name=name,size=10,image_id='fd249548-1863-4d30-b809-732108cab057',
        volume_type='aws-ebs-gp3',metadata={'storage_backend':'aws-ebs','xregion_cutover':'20261109'})
print(json.dumps(v.to_dict(),default=str))
'''
    if suffix:
        source=source.replace('xregion-ebs-cutover-canary-20261109','xregion-ebs-cutover-canary-20261109-'+suffix)
        source=source.replace('/var/lib/xregion-ebs-cutover-canary-attempt','/var/lib/xregion-ebs-cutover-canary-attempt-'+suffix)
    result = host_python(x, source, "ebs-canary-volume"+suffix, 180)
    x.save("ebs-canary-volume"+suffix+".json", result)
    return {k: result.get(k) for k in ("id", "status", "size", "volume_type", "project_id", "provider_id")}


def deploy_lambdas(x, stages=None):
    import io, urllib.request, zipfile
    from deploy import package
    from workflows import MANIFEST
    from legacy_cleanup import assert_frozen
    assert_frozen(x)
    client=x.client('lambda')
    template=client.get_function_configuration(FunctionName=MANIFEST['functions']['BootNova'])
    results={}
    for stage in stages or ('CheckPool','AllocateResource','BootNova','SyncDynamoDB','ExtendVolume','DeleteVolume','CinderPoolManager'):
        name=MANIFEST['functions'][stage]
        current=client.get_function(FunctionName=name)
        config=current['Configuration']
        before=x.directory/(name+'-before.json')
        if not before.exists():
            x.save(before.name,current)
            with urllib.request.urlopen(current['Code']['Location'],timeout=30) as response:
                (x.directory/(name+'-before.zip')).write_bytes(response.read())
        code=package(x,stage)
        env=dict(template.get('Environment',{}).get('Variables',{}))
        env.update(config.get('Environment',{}).get('Variables',{}))
        env.update(NETWORK_STAGE=stage,CINDER_URL='http://10.20.10.183:8776/v3',
            GLANCE_URL='http://10.20.10.183:9292/v2',EBS_POOL_ENABLED='true')
        handler=MANIFEST.get('standalone',{}).get(stage,{}).get('handler','network_runtime.lambda_handler')
        kwargs=dict(FunctionName=name,RevisionId=config['RevisionId'],Handler=handler,
            Environment={'Variables':env},Timeout=150)
        if stage in ('AllocateResource','CinderPoolManager','ExtendVolume'):
            kwargs['VpcConfig']={k:template['VpcConfig'][k] for k in ('SubnetIds','SecurityGroupIds')}
        x.call('lambda','update_function_configuration',**kwargs)
        client.get_waiter('function_updated_v2').wait(FunctionName=name,WaiterConfig={'Delay':2,'MaxAttempts':90})
        revision=client.get_function_configuration(FunctionName=name)['RevisionId']
        x.call('lambda','update_function_code',FunctionName=name,ZipFile=code,RevisionId=revision)
        client.get_waiter('function_updated_v2').wait(FunctionName=name,WaiterConfig={'Delay':2,'MaxAttempts':90})
        after=client.get_function(FunctionName=name)
        with urllib.request.urlopen(after['Code']['Location'],timeout=30) as response:
            downloaded=response.read()
        if hashlib.sha256(downloaded).digest()!=hashlib.sha256(code).digest():
            raise ValueError('Lambda code readback differs: '+name)
        results[name]={k:after['Configuration'][k] for k in ('RevisionId','CodeSha256','LastUpdateStatus')}
        x.save('ebs-lambda-deployment.json',results)
        print(stage+' deployed and verified',flush=True)
    return results


def reclaim_failed_preboot(x):
    """Reconcile an actual failed canary with no Nova; keep the failed execution."""
    proof=json.loads((x.directory/'canary-launch-status.json').read_text())
    execution=x.client('stepfunctions').describe_execution(executionArn=proof['executionArn'])
    if execution['status']!='FAILED': raise ValueError('Canary is not conclusively failed')
    instance=json.loads((x.directory/'canary.json').read_text())['instance_id']
    db=x.session.resource('dynamodb')
    owner=db.Table('XRegion-Instances').get_item(Key={'instance_id':instance},ConsistentRead=True)['Item']
    if owner.get('active_nova_id') or owner.get('current_nova_id') or owner.get('launch_execution_arn')!=proof['executionArn']:
        raise ValueError('Canary acquired Nova or changed owner')
    reservations=db.Table('XRegion-NetworkReservations')
    key='LEASE#'+proof['executionArn']
    lease=reservations.get_item(Key={'resource_key':key},ConsistentRead=True).get('Item')
    if not lease: return {'already_reclaimed':True}
    ec2=x.client('ec2')
    try:
        ec2.describe_volumes(VolumeIds=[lease['ebs_volume_id']])
    except ec2.exceptions.ClientError as error:
        if error.response['Error']['Code']!='InvalidVolume.NotFound': raise
    else: raise ValueError('Canary EBS still exists; delete through Cinder first')
    # The Neutron port must be an unused exact port; never infer ownership by name.
    source='PORT='+repr(lease['neutron_port_id'])+'\nVOLUME='+repr(lease['cinder_volume_id'])+'\n'+r'''
import openstack,json
c=openstack.connect()
if c.block_storage.find_volume(VOLUME): raise ValueError('Cinder canary still exists')
p=c.network.find_port(PORT)
if p:
    if p.device_id or p.project_id!='d3bf05331973481891385d066d3eba3e': raise ValueError('Canary port has a consumer or wrong owner')
    c.network.delete_port(p,ignore_missing=False)
    if c.network.find_port(PORT): raise ValueError('Port deletion unconfirmed')
print(json.dumps({'port_absent':True,'cinder_absent':True}))
'''
    host_python(x,source,'failed-preboot-port-cleanup')
    a=ec2.describe_addresses(AllocationIds=[lease['allocation_id']])['Addresses'][0]
    tags={t['Key']:t['Value'] for t in a.get('Tags',[])}
    if a.get('AssociationId') or tags.get('ReservationId')!=lease['reservation_id'] or tags.get('ClaimedBy')!=lease['reservation_id']:
        raise ValueError('Preboot EIP ownership or consumer changed')
    eni='eni-091eaee3e69e3f42d'
    interfaces=ec2.describe_network_interfaces(NetworkInterfaceIds=[eni])['NetworkInterfaces']
    addr=next((p for p in interfaces[0]['PrivateIpAddresses'] if p['PrivateIpAddress']==lease['gateway_private_ip']),None)
    if addr:
        if addr['Primary']: raise ValueError('Primary ENI IP cannot be released')
        x.call('ec2','unassign_private_ip_addresses',NetworkInterfaceId=eni,PrivateIpAddresses=[lease['gateway_private_ip']])
    x.call('ec2','delete_tags',Resources=[lease['allocation_id']],Tags=[t for t in a['Tags'] if t['Key'] in ('ClaimedBy','ClaimedAt','ReservationId')])
    for claim in ('EIP#'+lease['allocation_id'],'PRIVATEIP#'+eni+'#'+lease['gateway_private_ip'],key):
        reservations.delete_item(Key={'resource_key':claim},ConditionExpression='reservation_id=:r',ExpressionAttributeValues={':r':lease['reservation_id']})
    db.Table('XRegion-Volumes').update_item(Key={'volume_id':lease['cinder_volume_key']},
        UpdateExpression='SET #s=:deleted',ConditionExpression='cinder_volume_id=:v AND lease_instance_id=:i',
        ExpressionAttributeNames={'#s':'status'},ExpressionAttributeValues={':deleted':'DELETED',':v':lease['cinder_volume_id'],':i':instance})
    result=dict(instance_id=instance,execution_status='FAILED',resources_absent=True)
    x.save('failed-preboot-cleanup.json',result)
    return result


def resize_once_proof(x):
    source=r'''
import json,openstack,subprocess,time
from pathlib import Path
c=openstack.connect(project_id='d3bf05331973481891385d066d3eba3e',project_name=None)
name='xregion-ebs-resize-once-proof-20261109'
volumes=list(c.block_storage.volumes(name=name))
if len(volumes)>1: raise ValueError('Duplicate resize proof')
marker=Path('/var/lib/xregion-ebs-resize-once-proof-attempt')
if volumes and volumes[0].status=='error':
    failed=c.block_storage.get_volume(volumes[0].id)
    if failed.provider_id or failed.host or failed.attachments or failed.metadata.get('xregion_resize_proof')!='20261109':
        raise ValueError('Reconcile failed resize proof with a physical allocation before retry')
    c.block_storage.delete_volume(failed,ignore_missing=False)
    if c.block_storage.find_volume(failed.id):raise ValueError('Failed unscheduled proof still exists')
    if marker.read_text().strip()!=name:raise ValueError('Proof marker ownership changed')
    marker.unlink();volumes=[]
if not volumes:
    with marker.open('x') as out:out.write(name+'\n')
    v=c.block_storage.create_volume(name=name,size=1,volume_type='aws-ebs-gp3',metadata={'xregion_resize_proof':'20261109'})
else:v=volumes[0]
deadline=time.monotonic()+150
while True:
    v=c.block_storage.get_volume(v.id)
    if v.status.startswith('error'):raise ValueError('Resize proof volume failed: '+v.status)
    if v.status=='available':break
    if time.monotonic()>deadline:raise TimeoutError('Proof create pending')
    time.sleep(2)
if v.size==1:
    with Path(str(marker)+'-extend').open('x') as out:out.write(v.id+'\n')
    c.block_storage.extend_volume(v,size=2)
while True:
    v=c.block_storage.get_volume(v.id)
    if v.status.startswith('error'):raise ValueError('Resize proof failed: '+v.status)
    if v.status=='available' and v.size==2:break
    if time.monotonic()>deadline:raise TimeoutError('Proof extend pending')
    time.sleep(2)
inner="""import boto3,botocore.session,json
from storage.ebs_backend import EbsBackend
s=botocore.session.get_session();s.set_config_variable('config_file','/etc/cinder/xregion-aws-config')
session=boto3.Session(profile_name='xregion-ebs',botocore_session=s)
b=EbsBackend(session.client('ec2',region_name='ap-southeast-2'),account='291634989063',region='ap-southeast-2',host_id='i-056d7f3dd24156234',execute=lambda *a,**kw:None)
record=RECORD
try:b.extend(record,3)
except ValueError as e:
 if 'single resize' not in str(e):raise
 print(json.dumps({'second_resize_refused':True,'size':2,'volume_id':record['id'],'ebs_volume_id':record['provider_id']}))
else:raise ValueError('Second resize was allowed')
""".replace('RECORD',repr(dict(id=v.id,project_id=v.project_id,provider_id=v.provider_id,size=2)))
result=json.loads(subprocess.check_output(['docker','exec','-i','cinder_volume_ebs','python','-'],input=inner,text=True))
print(json.dumps(result))
'''
    result=host_python(x,source,'ebs-resize-once-proof',240)
    disk=x.client('ec2').describe_volumes(VolumeIds=[result['ebs_volume_id']])['Volumes'][0]
    if disk['Size']!=2 or {t['Key']:t['Value'] for t in disk['Tags']}.get('XRegionResizeTargetGiB')!='2':
        raise ValueError('Resize target tag/physical size mismatch')
    x.save('ebs-resize-once-proof.json',result)
    return result


def cleanup_failed_boot(x):
    from legacy_cleanup import invoke_network, remote_delete, PROJECT
    proof=json.loads((x.directory/'canary-launch-status.json').read_text())
    execution=x.client('stepfunctions').describe_execution(executionArn=proof['executionArn'])
    if execution['status']!='FAILED':raise ValueError('Canary execution is not failed')
    iid=json.loads((x.directory/'canary.json').read_text())['instance_id']
    db=x.session.resource('dynamodb')
    owner=db.Table('XRegion-Instances').get_item(Key={'instance_id':iid},ConsistentRead=True)['Item']
    if owner.get('launch_execution_arn')!=proof['executionArn'] or not owner.get('failed_nova_id'):
        raise ValueError('Failed canary owner is not proven')
    nid=owner['failed_nova_id']
    event=invoke_network(x,'Release',dict(instance_id=iid,nova_id=nid,server_id=nid))
    if event.get('reservation_id')!=proof['executionArn']:raise ValueError('Canary mapping owner changed')
    vid=event.get('cinder_volume_id') or event.get('cleanup_volume',{}).get('cinder_volume_id')
    if not vid:raise ValueError('Failed canary volume identity missing')
    if not event.get('network_cleanup_complete'):
        event=invoke_network(x,'Dispatch',event)
    else:event['command_status']='SUCCEEDED'
    import time
    while event.get('command_status')!='SUCCEEDED':
        time.sleep(3);event=invoke_network(x,'CheckCommand',event)
    row=dict(id=nid,project_id=PROJECT,volume_ids=[vid])
    remote_delete(x,'server',row,[dict(id=event['neutron_port_id'],network_id=event['network_id'])])
    event=invoke_network(x,'Release',event)
    expected=json.loads((x.directory/'canary-lease-current.json').read_text())
    if expected['cinder_volume_id']!=vid:raise ValueError('Failed volume changed')
    remote_delete(x,'volume',dict(id=vid,project_id=PROJECT))
    try:x.client('ec2').describe_volumes(VolumeIds=[expected['ebs_volume_id']])
    except x.client('ec2').exceptions.ClientError as error:
        if error.response['Error']['Code']!='InvalidVolume.NotFound':raise
    else:raise ValueError('Failed canary EBS deletion is unconfirmed')
    db.Table('XRegion-Volumes').update_item(Key={'volume_id':expected['cinder_volume_key']},
        UpdateExpression='SET #s=:deleted',ConditionExpression='cinder_volume_id=:v AND lease_instance_id=:i',
        ExpressionAttributeNames={'#s':'status'},ExpressionAttributeValues={':deleted':'DELETED',':v':vid,':i':iid})
    db.Table('XRegion-Instances').update_item(Key={'instance_id':iid},
        UpdateExpression='SET current_status=:terminated, cleanup_complete=:yes',
        ConditionExpression='launch_execution_arn=:r AND failed_nova_id=:n',
        ExpressionAttributeValues={':terminated':'TERMINATED',':yes':True,':r':proof['executionArn'],':n':nid})
    result=dict(instance_id=iid,nova_id=nid,resources_absent=True,launch_execution_status='FAILED')
    x.save('failed-boot-cleanup.json',result)
    return result


def provision_role(x):
    baseline = json.loads((x.directory / "driver-iam-baseline.json").read_text(encoding="utf-8-sig"))
    preflight = json.loads((x.directory / "aws-storage-preflight.json").read_text())
    host = preflight["host"]
    root = next(b["Ebs"]["VolumeId"] for b in host["BlockDeviceMappings"] if b["DeviceName"] == host["RootDeviceName"])
    key_id = x.client("ec2").get_ebs_default_kms_key_id()["KmsKeyId"]
    key = x.client("kms").describe_key(KeyId=key_id)["KeyMetadata"]["Arn"]
    policy = scoped_policy(baseline, root, key)
    findings = x.client("accessanalyzer").validate_policy(policyDocument=json.dumps(policy), policyType="IDENTITY_POLICY")
    x.save("driver-iam-validation.json", findings)
    if any(f["findingType"] == "ERROR" for f in findings["findings"]):
        raise ValueError("IAM policy validation failed")
    x.save("driver-iam-scoped.json", policy)
    profile = x.client("iam").get_instance_profile(InstanceProfileName=host["IamInstanceProfile"]["Arn"].split("/")[-1])["InstanceProfile"]
    if len(profile["Roles"]) != 1:
        raise ValueError("Unexpected host role set")
    source = profile["Roles"][0]
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole", "Principal": {"AWS": source["Arn"]}}]}
    role = "XRegion-CinderEbsRole"
    iam = x.client("iam")
    try:
        existing = iam.get_role(RoleName=role)["Role"]
    except iam.exceptions.NoSuchEntityException:
        existing = x.call("iam", "create_role", RoleName=role, AssumeRolePolicyDocument=json.dumps(trust),
            Description="Private XRegion Cinder backend: owned encrypted EBS only", MaxSessionDuration=3600,
            Tags=[{"Key": "ManagedBy", "Value": "xregion-ebs-cutover"}])["Role"]
    else:
        if {t["Key"]:t["Value"] for t in existing.get("Tags", [])}.get("ManagedBy") != "xregion-ebs-cutover":
            raise ValueError("Refusing to overwrite an independently managed role")
        x.save("driver-role-before.json", existing)
        if existing["AssumeRolePolicyDocument"] != trust:
            raise ValueError("Existing EBS role trust changed")
    x.call("iam", "put_role_policy", RoleName=role, PolicyName="CinderEbsOwnedVolumes", PolicyDocument=json.dumps(policy))
    assume = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole", "Resource": existing["Arn"]}]}
    try:
        previous = iam.get_role_policy(RoleName=source["RoleName"], PolicyName="XRegionAssumeCinderEbsRole")
    except iam.exceptions.NoSuchEntityException:
        previous = {"absent": True}
    x.save("host-assume-role-policy-before.json", previous)
    x.call("iam", "put_role_policy", RoleName=source["RoleName"], PolicyName="XRegionAssumeCinderEbsRole", PolicyDocument=json.dumps(assume))
    readback = iam.get_role_policy(RoleName=role, PolicyName="CinderEbsOwnedVolumes")["PolicyDocument"]
    if readback != policy:
        raise ValueError("Driver role policy readback mismatch")
    x.save("driver-role.json", dict(role_arn=existing["Arn"], host_role=source["Arn"], kms_key=key))
    return {"role_arn": existing["Arn"], "validation_errors": 0}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--directory", required=True)
    p.add_argument("--profile", default="btl")
    p.add_argument("--apply", action="store_true")
    p.add_argument("action", nargs="?", default="compatibility", choices=("compatibility", "build-image", "role", "install", "canary-volume", "lambdas"))
    a = p.parse_args()
    x = Deployment(a.directory, profile=a.profile)
    if a.action in ("build-image", "role", "install", "canary-volume", "lambdas"):
        if not a.apply:
            print("Preview: " + a.action + "; use --apply after reviewing the artifacts")
            return
        result = {"build-image": build_image, "role": provision_role, "install": install_backend, "canary-volume": canary_volume, "lambdas": deploy_lambdas}[a.action](x)
    else:
        result = compatibility(x)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
