"""Read-only lifecycle preflight and narrowly scoped release operations.

Configurations and rollback ZIPs can contain secrets; keep the directory in OS Temp.
This tool never creates or terminates a canary directly in Step Functions.
"""
import argparse
import base64
import datetime
import hashlib
import json
import re
import urllib.request
from pathlib import Path
import ipaddress
import shlex
import socket
import time
import uuid
from boto3.dynamodb.conditions import Attr

from control import ACCOUNT, ENI, REGION, Deployment
from workflows import MANIFEST


STAGES = ("AllocateResource", "Release", "DeleteSecurityGroup", "DeleteVolume", "TerminateSync", "Dispatch", "CheckCommand")
PROTECTED = ("i-33d89d60", "i-d47acb27", "i-e4a5b07d")


def no_running(x):
    for name in MANIFEST["workflows"]:
        arn = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"
        if any(page["executions"] for page in x.client("stepfunctions").get_paginator("list_executions").paginate(
                stateMachineArn=arn, statusFilter="RUNNING")):
            raise RuntimeError("Conflicting running execution: " + name)


def host_evidence(x):
    evidence = json.loads((x.directory / "host-preflight.json").read_text())
    if evidence["Status"] != "Success":
        raise RuntimeError("Host preflight failed")
    text = evidence["StandardOutputContent"]
    text = text[text.index("{"):]
    decoder, objects = json.JSONDecoder(), []
    while text.strip():
        obj, end = decoder.raw_decode(text.lstrip())
        objects.append(obj)
        text = text.lstrip()[end:]
    by_id = {obj["id"]: obj for obj in objects if isinstance(obj, dict) and "id" in obj}
    dd = by_id["efdca890-184e-435a-96b3-fe64bcd1d568"]
    if dd["status"] != "ACTIVE" or dd["volumes_attached"] != [{"id": "c40b4f0c-8e9d-4cd1-9b3c-ebf9537b85c9", "delete_on_termination": False}]:
        raise RuntimeError("Protected dd storage identity changed")
    if by_id["1c2bd72f-a278-4e9a-9921-c3c631c03154"]["status"] != "SHUTOFF":
        raise RuntimeError("Old canary state changed")
    volume = by_id["f084bef1-adc6-4038-baa1-cc56fc55fbbc"]
    if volume["status"] != "available" or volume["attachments"]:
        raise RuntimeError("Probe volume is not available")
    return by_id


def deploy_selected(x, stages=None):
    from deploy import package
    from workflows import render
    baseline = json.loads((x.directory / "preflight.json").read_text())
    host_evidence(x)
    no_running(x)
    role = "XRegion-NetworkLambdaRole"
    policy_name = "XRegion-ReleaseInstanceRead"
    policy = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": ["dynamodb:GetItem"],
        "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/XRegion-Instances"}]}
    before = json.loads((x.directory / "network-role-policies-before.json").read_text())
    if policy_name in before and before[policy_name]["PolicyDocument"] != policy:
        raise RuntimeError("Unexpected existing release policy")
    x.call("iam", "put_role_policy", RoleName=role, PolicyName=policy_name, PolicyDocument=json.dumps(policy))
    simulation = x.client("iam").simulate_principal_policy(PolicySourceArn=f"arn:aws:iam::{ACCOUNT}:role/{role}",
        ActionNames=["dynamodb:GetItem"], ResourceArns=[f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/XRegion-Instances"])
    x.save("release-iam-after.json", simulation)
    if simulation["EvaluationResults"][0]["EvalDecision"] != "allowed":
        raise RuntimeError("Release IAM permission is not allowed")
    result_path = x.directory / "deployment-result.json"
    results = json.loads(result_path.read_text()) if result_path.exists() else {}
    client = x.client("lambda")
    for logical in stages or STAGES:
        no_running(x)
        name = MANIFEST["functions"][logical]
        current = client.get_function_configuration(FunctionName=name)
        expected = results.get(name, baseline["functions"][name])
        if current["RevisionId"] != expected["RevisionId"] or current["CodeSha256"] != expected["CodeSha256"]:
            raise RuntimeError("Intervening Lambda change: " + name)
        handler = MANIFEST.get("standalone", {}).get(logical, {}).get("handler", "network_runtime.lambda_handler")
        if current["Handler"] != handler:
            raise RuntimeError("Unexpected deployed handler: " + name)
        backup = x.directory / (name + "-before.zip")
        if not backup.exists():
            snapshot = client.get_function(FunctionName=name)
            with urllib.request.urlopen(snapshot["Code"]["Location"], timeout=30) as response:
                backup.write_bytes(response.read())
        code = package(x, logical)
        digest = base64.b64encode(hashlib.sha256(code).digest()).decode()
        (x.directory / (name + "-deployed.zip")).write_bytes(code)
        x.call("lambda", "update_function_code", FunctionName=name, ZipFile=code, RevisionId=current["RevisionId"])
        client.get_waiter("function_updated_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
        after = client.get_function(FunctionName=name)
        with urllib.request.urlopen(after["Code"]["Location"], timeout=30) as response:
            readback = response.read()
        if readback != code or after["Configuration"]["CodeSha256"] != digest:
            raise RuntimeError("Lambda readback mismatch: " + name)
        results[name] = {k: after["Configuration"][k] for k in ("CodeSha256", "RevisionId", "LastUpdateStatus")}
        x.save("deployment-result.json", results)
        print(name + " deployed and verified", flush=True)
    name = "TerminateInstance"
    no_running(x)
    arn = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"
    current = x.client("stepfunctions").describe_state_machine(stateMachineArn=arn)
    expected_revisions = {baseline["workflows"][name]}
    own_after = x.directory / (name + "-after.json")
    if own_after.exists():
        expected_revisions.add(json.loads(own_after.read_text())["revisionId"])
    if current["revisionId"] not in expected_revisions and json.loads(current["definition"]) != render(name):
        raise RuntimeError("Intervening workflow change")
    definition = json.dumps(render(name))
    validation = x.client("stepfunctions").validate_state_machine_definition(definition=definition, type="STANDARD")
    x.save("terminate-validation.json", validation)
    if validation["result"] != "OK":
        raise RuntimeError("Invalid termination ASL")
    if json.loads(current["definition"]) != render(name):
        x.call("stepfunctions", "update_state_machine", stateMachineArn=arn, definition=definition)
    after = x.client("stepfunctions").describe_state_machine(stateMachineArn=arn)
    if json.loads(after["definition"]) != render(name):
        raise RuntimeError("Workflow readback mismatch")
    x.save(name + "-after.json", after)
    print("Terminate workflow deployed and verified", flush=True)


def probe(x):
    request = dict(diagnostic_only=True, cinder_volume_key="cinder-f084bef1-adc",
        cinder_volume_id="f084bef1-adc6-4038-baa1-cc56fc55fbbc", image_id="fd249548-1863-4d30-b809-732108cab057")
    response = x.call("lambda", "invoke", FunctionName=MANIFEST["functions"]["AllocateResource"], Payload=json.dumps(request).encode())
    payload = json.loads(response["Payload"].read())
    x.save("allocate-probe.json", dict(payload=payload, function_error=response.get("FunctionError")))
    if response.get("FunctionError") or payload.get("status") != "PREFLIGHT_OK":
        raise RuntimeError("AllocateResource probe failed; inspect the artifact")
    print("AllocateResource: Keystone, Cinder and AWS read-only probe passed")


def backend(path, method="GET", body=None):
    session_path = Path.home() / "AppData/Local/Temp/xregion-cinder-repair-20261109/session.json"
    token = json.loads(session_path.read_text())["data"]["token"]
    request = urllib.request.Request("http://127.0.0.1:8080/api/" + path,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None, method=method)
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.status, json.loads(response.read())


def launch_canary(x):
    current = x.client("lambda").get_function_configuration(FunctionName=MANIFEST["functions"]["CheckPool"])
    if current.get("Environment", {}).get("Variables", {}).get("LAUNCH_ADMISSION_PARAMETER"):
        raise RuntimeError("Use size_admission.py for shared admission; the legacy canary command is retired")
    marker = x.directory / "backend-launch-attempt.json"
    if marker.exists():
        raise RuntimeError("A POST was already attempted; reconcile it instead of creating another VM")
    if json.loads((x.directory / "allocate-probe.json").read_text())["payload"].get("status") != "PREFLIGHT_OK":
        raise RuntimeError("Read-only Lambda probe has not passed")
    no_running(x)
    before_instances = backend("instances")[1]["data"]
    x.save("backend-instances-before.json", before_instances)
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=7)))
    name = "ping-test-lifecycle-" + now.strftime("%Y%m%d-%H%M%S")
    request = dict(name=name, region=REGION, flavor="m1.tiny", imageId="fd249548-1863-4d30-b809-732108cab057",
        ebsSizeGb=10, ebsVolumeType="gp3", keyPairName="xregion-nat-canary")
    function = MANIFEST["functions"]["CheckPool"]
    config = x.client("lambda").get_function_configuration(FunctionName=function)
    env = dict(config["Environment"]["Variables"])
    if env.get("NETWORK_ADMISSION") != "maintenance":
        raise RuntimeError("Maintenance admission unexpectedly changed")
    env.update(NETWORK_ADMISSION="maintenance", NETWORK_ALLOWED_INSTANCE_NAME=name)
    x.call("lambda", "update_function_configuration", FunctionName=function,
        RevisionId=config["RevisionId"], Environment={"Variables": env})
    x.client("lambda").get_waiter("function_updated_v2").wait(FunctionName=function, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
    after = x.client("lambda").get_function_configuration(FunctionName=function)
    if after["Environment"]["Variables"] != env:
        raise RuntimeError("Canary admission readback mismatch")
    x.save("canary-setup.json", dict(request=request, created_at=now.isoformat(), check_pool_revision=after["RevisionId"]))
    with marker.open("x", encoding="utf-8") as output:
        json.dump(dict(name=name, attempted_at=now.isoformat()), output)
    status, response = backend("instances", "POST", request)
    x.save("backend-launch-response.json", dict(http_status=status, response=response))
    if status != 202:
        raise RuntimeError("Unexpected launch response; reconcile the saved response")
    data = response["data"]
    iid = data.get("id") or data.get("instanceId")
    if not iid:
        raise RuntimeError("Response lacks instance identity; reconcile before continuing")
    x.save("canary.json", dict(instance_id=iid, name=name))
    print(json.dumps(dict(instance_id=iid, name=name, http=status, status=data.get("status"))))


def canary_status(x, terminate=False):
    canary = json.loads((x.directory / "canary.json").read_text())
    iid = canary["instance_id"]
    item = x.session.resource("dynamodb").Table("XRegion-Instances").get_item(
        Key={"instance_id": iid}, ConsistentRead=True)["Item"]
    x.save("canary-instance-current.json", item)
    name = "TerminateInstance" if terminate else "LaunchInstance"
    arn = item.get("launch_execution_arn") if not terminate else None
    if not arn:
        created = datetime.datetime.fromisoformat(json.loads((x.directory / "canary-setup.json").read_text())["created_at"])
        machine = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"
        for page in x.client("stepfunctions").get_paginator("list_executions").paginate(stateMachineArn=machine):
            for execution in page["executions"]:
                if execution["startDate"] < created:
                    continue
                detail = x.client("stepfunctions").describe_execution(executionArn=execution["executionArn"])
                if json.loads(detail["input"]).get("instance_id") == iid:
                    arn = execution["executionArn"]
                    break
            if arn:
                break
    if not arn:
        print(json.dumps(dict(instance_id=iid, status="WAITING_FOR_EVENT", current_status=item.get("current_status"))))
        return
    result = x.client("stepfunctions").describe_execution(executionArn=arn)
    label = "canary-terminate-status" if terminate else "canary-launch-status"
    x.save(label + ".json", result)
    history = x.client("stepfunctions").get_execution_history(executionArn=arn, reverseOrder=True, maxResults=15)
    x.save(label + "-history.json", history)
    summary = dict(instance_id=iid, execution_arn=arn, status=result["status"], current_status=item.get("current_status"))
    launch_arn = item.get("launch_execution_arn")
    lease = x.session.resource("dynamodb").Table("XRegion-NetworkReservations").get_item(
        Key={"resource_key": "LEASE#" + launch_arn}, ConsistentRead=True).get("Item") if launch_arn else None
    if lease:
        x.save("canary-lease-current.json", lease)
    nid = item.get("active_nova_id") or (lease or {}).get("nova_id")
    if nid:
        mapping = x.session.resource("dynamodb").Table("XRegion-NetworkMappings").get_item(
            Key={"nova_id": nid}, ConsistentRead=True).get("Item")
        if mapping:
            x.save("canary-mapping-current.json", mapping)
            summary.update(nova_id=nid, mapping_status=mapping["status"], command_operation=mapping.get("command_operation"))
    if result.get("output"):
        out = json.loads(result["output"])
        summary.update({k: out.get(k) for k in ("nova_id", "elastic_ip", "guest_private_ip", "gateway_private_ip")})
    summary["recent_states"] = [e["stateEnteredEventDetails"]["name"] for e in history["events"] if "stateEnteredEventDetails" in e]
    print(json.dumps(summary))


def terminate_canary(x):
    marker = x.directory / "backend-terminate-attempt.json"
    if marker.exists():
        raise RuntimeError("Terminate POST was already attempted; reconcile it")
    launch = json.loads((x.directory / "canary-launch-status.json").read_text())
    if launch["status"] != "SUCCEEDED":
        raise RuntimeError("Canary launch has not succeeded")
    connectivity = json.loads((x.directory / "connectivity.json").read_text())
    if not connectivity.get("ping_10_of_10") or not connectivity.get("tcp_22"):
        raise RuntimeError("Canary connectivity has not been accepted")
    iid = json.loads((x.directory / "canary.json").read_text())["instance_id"]
    out = json.loads(launch["output"])
    if out["instance_id"] != iid or iid in PROTECTED:
        raise RuntimeError("Canary identity mismatch")
    with marker.open("x", encoding="utf-8") as output:
        json.dump(dict(instance_id=iid), output)
    status, response = backend("instances/" + iid + "/actions", "POST", {"action": "TERMINATE"})
    x.save("backend-terminate-response.json", dict(http_status=status, response=response))
    print(json.dumps(dict(instance_id=iid, http=status, operation="TERMINATE")))


def connectivity(x):
    launch = json.loads((x.directory / "canary-launch-status.json").read_text())
    if launch["status"] != "SUCCEEDED":
        raise RuntimeError("Canary launch has not succeeded")
    address = str(ipaddress.ip_address(json.loads(launch["output"])["elastic_ip"]))
    raw = (x.directory / "client-ping.txt").read_bytes()
    ping = raw.decode("utf-16") if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else raw.decode("utf-8-sig")
    import re
    if not re.search(r"Sent\s*=\s*10,\s*Received\s*=\s*10,\s*Lost\s*=\s*0", ping) or address not in ping:
        raise RuntimeError("The saved ten-packet ping did not pass")
    deadline = time.monotonic() + 90
    while True:
        try:
            with socket.create_connection((address, 22), timeout=5) as connection:
                banner = connection.recv(256).decode("ascii", errors="replace").strip()
            if not banner.startswith("SSH-"):
                raise RuntimeError("Port 22 did not return an SSH banner")
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Canary SSH port did not become ready") from None
            time.sleep(3)
    evidence = dict(elastic_ip=address, ping_10_of_10=True, tcp_22=True, ssh_banner=banner, authenticated_ssh=False)
    x.save("connectivity.json", evidence)
    print(json.dumps(evidence))


def repair_canary_checkpoint(x):
    """Repair only the exact malformed checkpoint observed during this canary.

    The original map is retained. This does not reset claims or change resource identity.
    """
    no_running(x)
    canary = json.loads((x.directory / "canary.json").read_text())
    launch = json.loads((x.directory / "canary-launch-status.json").read_text())
    output = json.loads(launch["output"])
    if canary["instance_id"] in PROTECTED or output["instance_id"] != canary["instance_id"]:
        raise RuntimeError("Protected or mismatched instance")
    table = x.session.resource("dynamodb").Table("XRegion-NetworkMappings")
    m = table.get_item(Key={"nova_id": output["nova_id"]}, ConsistentRead=True)["Item"]
    if (m.get("status") != "DELETING" or m.get("cleanup_phase") != m["generation"] or
            m.get("cleanup_generation") != m["reservation_id"] or m.get("cleanup_volume") != m["generation"] or
            m.get("updated_at") != "DELETING" or m.get("applied_generation") != m["generation"]):
        raise RuntimeError("Checkpoint is not the exact known corruption; refusing repair")
    reservations = x.session.resource("dynamodb").Table("XRegion-NetworkReservations")
    for key in ("LEASE#" + m["reservation_id"], "EIP#" + m["allocation_id"], "PRIVATEIP#" + ENI + "#" + m["gateway_private_ip"]):
        claim = reservations.get_item(Key={"resource_key": key}, ConsistentRead=True).get("Item")
        if not claim or claim.get("reservation_id") != m["reservation_id"]:
            raise RuntimeError("Claim ownership changed; refusing checkpoint repair")
    address = x.client("ec2").describe_addresses(AllocationIds=[m["allocation_id"]])["Addresses"][0]
    tags = {t["Key"]: t["Value"] for t in address.get("Tags", [])}
    if address.get("AssociationId") or tags.get("ReservationId") != m["reservation_id"] or tags.get("NovaId") != m["nova_id"]:
        raise RuntimeError("EIP state changed; refusing checkpoint repair")
    x.save("canary-checkpoint-before-repair.json", m)
    condition = (Attr("generation").eq(m["generation"]) & Attr("reservation_id").eq(m["reservation_id"])
        & Attr("cleanup_phase").eq(m["generation"]) & Attr("cleanup_generation").eq(m["reservation_id"])
        & Attr("cleanup_volume").eq(m["generation"]) & Attr("updated_at").eq("DELETING") & Attr("status").eq("DELETING"))
    table.update_item(Key={"nova_id": m["nova_id"]}, UpdateExpression="SET updated_at=:repair_time REMOVE cleanup_phase, cleanup_generation, cleanup_volume",
        ExpressionAttributeValues={":repair_time": int(time.time())}, ConditionExpression=condition)
    repaired = table.get_item(Key={"nova_id": m["nova_id"]}, ConsistentRead=True)["Item"]
    x.save("canary-checkpoint-after-repair.json", repaired)
    x.log("repair_canary_checkpoint", "SUCCEEDED", nova_id=m["nova_id"])
    print("Exact malformed canary checkpoint repaired; all claims and identities retained")


def resume_terminate(x):
    no_running(x)
    previous = json.loads((x.directory / "canary-terminate-status.json").read_text())
    current = x.client("stepfunctions").describe_execution(executionArn=previous["executionArn"])
    canary = json.loads((x.directory / "canary.json").read_text())
    iid = canary["instance_id"]
    if current["status"] != "FAILED" or json.loads(current["input"]).get("instance_id") != iid or iid in PROTECTED:
        raise RuntimeError("Previous terminate is not a reconciled terminal failure")
    suffix = hashlib.sha256(current["executionArn"].encode()).hexdigest()[:16]
    legacy_marker = x.directory / "backend-terminate-resume-attempt.json"
    if legacy_marker.exists() and json.loads(legacy_marker.read_text()).get("previous_execution") == current["executionArn"]:
        raise RuntimeError("A recovery event was already sent for this failed execution")
    marker = x.directory / ("backend-terminate-resume-attempt-" + suffix + ".json")
    with marker.open("x", encoding="utf-8") as output:
        json.dump(dict(instance_id=iid, previous_execution=current["executionArn"]), output)
    x.save("terminate-failure-" + suffix + ".json", current)
    x.save("terminate-failure-" + suffix + "-history.json", json.loads((x.directory / "canary-terminate-status-history.json").read_text()))
    status, response = backend("instances/" + iid + "/actions", "POST", {"action": "TERMINATE"})
    x.save("backend-terminate-resume-response.json", dict(http_status=status, response=response))
    print(json.dumps(dict(instance_id=iid, http=status, operation="RESUME_TERMINATE")))


def inspect_canary(x):
    m = json.loads((x.directory / "canary-mapping-current.json").read_text())
    nid = str(uuid.UUID(m["nova_id"]))
    port = str(uuid.UUID(m["neutron_port_id"]))
    guest = str(ipaddress.ip_address(m["guest_private_ip"]))
    script = """set -eu
. /etc/kolla/admin-openrc.sh
OSC=/home/ssm-user/kolla-venv-2024.2/bin/openstack
"""
    script += f"$OSC server show {shlex.quote(nid)} -f json\n"
    script += f"$OSC port show {shlex.quote(port)} -f json\n"
    script += f"$OSC console log show --lines 130 {shlex.quote(nid)}\n"
    script += f"docker exec nova_libvirt virsh domiflist {shlex.quote(nid)}\n"
    script += f"docker exec nova_libvirt virsh domstats {shlex.quote(nid)} --vcpu --balloon\n"
    script += "free -m\nvmstat 1 3\nps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -n 12\n"
    script += "ip -brief address show br-xregion\nip neigh show dev br-xregion\n"
    script += f"ip route get {shlex.quote(guest)}\n"
    script += "timeout 12 tcpdump -nn -i br-xregion -c 12 'icmp or arp' 2>&1 || test $? = 124\n"
    label = "canary-network-inspection-" + datetime.datetime.now(datetime.timezone.utc).strftime("%H%M%S")
    x.remote(script, label, 120)
    print("Canary console, Neutron port, interface and bounded packet trace saved in OS Temp")


def pool_volume_delta(baseline_text, current_ids):
    # The original CLI volume list was scoped to admin, while the volumes belong to service.
    # The same preflight also captured the complete host VG, which is authoritative for
    # whether these LVM-backed UUIDs existed before this run.
    prefix = baseline_text.split("{", 1)[0]
    existing = set(re.findall(r"\bvolume-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b", prefix))
    # Newer preflights use lvs --reportformat json; only accept actual LV inventory rows.
    decoder, offset = json.JSONDecoder(), 0
    while (offset := baseline_text.find("{", offset)) != -1:
        try:
            document, length = decoder.raw_decode(baseline_text[offset:])
        except ValueError:
            offset += 1
            continue
        offset += length
        if not isinstance(document, dict):
            continue
        for report in document.get("report", []):
            for row in report.get("lv", []):
                name = row.get("lv_name", "")
                if re.fullmatch(r"volume-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", name):
                    existing.add(name[7:])
    if not existing:
        raise RuntimeError("Baseline LVM volume inventory is missing")
    return sorted(set(current_ids) - existing)


def verify(x):
    canary = json.loads((x.directory / "canary.json").read_text())
    launch = json.loads((x.directory / "canary-launch-status.json").read_text())
    terminal = json.loads((x.directory / "canary-terminate-status.json").read_text())
    live = x.client("stepfunctions").describe_execution(executionArn=terminal["executionArn"])
    if launch["status"] != "SUCCEEDED" or live["status"] != "SUCCEEDED":
        raise RuntimeError("Both lifecycle workflows must have succeeded")
    output = json.loads(launch["output"])
    ddb = x.session.resource("dynamodb")
    def read(table, key, value):
        return ddb.Table(table).get_item(Key={key: value}, ConsistentRead=True).get("Item")
    m = read("XRegion-NetworkMappings", "nova_id", output["nova_id"])
    if not m or m["status"] != "DELETED" or m.get("cleanup_phase") != "TAGS_REMOVED" or m.get("cleanup_generation") != m["generation"]:
        raise RuntimeError("Mapping cleanup was not committed")
    instance = read("XRegion-Instances", "instance_id", canary["instance_id"])
    nova = read("XRegion-Nova", "nova_id", m["nova_id"])
    if instance["current_status"] != "TERMINATED" or instance.get("active_nova_id") or instance.get("current_nova_id") or nova["status"] != "TERMINATED":
        raise RuntimeError("Backend termination was not confirmed")
    volume_context = m["cleanup_volume"]
    volume = read("XRegion-Volumes", "volume_id", volume_context["cinder_volume_key"])
    if volume["status"] != "DELETED" or volume["cinder_volume_id"] != volume_context["cinder_volume_id"]:
        raise RuntimeError("Volume tombstone is incorrect")
    if read("XRegion-Volumes", "volume_id", volume_context["cinder_volume_id"]):
        raise RuntimeError("Unexpected phantom record keyed by the Cinder UUID")
    for key in ("LEASE#" + m["reservation_id"], "EIP#" + m["allocation_id"], "PRIVATEIP#" + ENI + "#" + m["gateway_private_ip"]):
        if read("XRegion-NetworkReservations", "resource_key", key):
            raise RuntimeError("Canary reservation remains")
    before_protected = json.loads((x.directory / "protected-instances-before.json").read_text())
    after_protected = {iid: read("XRegion-Instances", "instance_id", iid) for iid in PROTECTED}
    if json.loads(json.dumps(after_protected, default=str)) != before_protected:
        raise RuntimeError("A protected instance record changed")
    x.save("protected-instances-after.json", after_protected)
    before_eni = json.loads((x.directory / "eni-before.json").read_text())["NetworkInterfaces"][0]
    eni = x.client("ec2").describe_network_interfaces(NetworkInterfaceIds=[ENI])["NetworkInterfaces"][0]
    ip_set = lambda row: {(p["PrivateIpAddress"], p["Primary"]) for p in row["PrivateIpAddresses"]}
    if ip_set(eni) != ip_set(before_eni):
        raise RuntimeError("Gateway ENI private addresses differ from baseline")
    x.save("eni-after.json", eni)
    before_addresses = json.loads((x.directory / "addresses-before.json").read_text())["Addresses"]
    addresses = x.client("ec2").describe_addresses()["Addresses"]
    by_allocation = {a["AllocationId"]: a for a in addresses}
    address = by_allocation[m["allocation_id"]]
    tags = {t["Key"]: t["Value"] for t in address.get("Tags", [])}
    if address.get("AssociationId") or any(k in tags for k in ("ClaimedBy", "ClaimedAt", "NovaId", "ReservationId")) or tags.get("Project") != "xregion":
        raise RuntimeError("Canary EIP is not cleanly returned to the pool")
    dd_before = next(a for a in before_addresses if a["AllocationId"] == "eipalloc-06e7654d7aa626490")
    dd_after = by_allocation[dd_before["AllocationId"]]
    if any(dd_after.get(k) != dd_before.get(k) for k in ("AssociationId", "PublicIp", "PrivateIpAddress", "NetworkInterfaceId")):
        raise RuntimeError("dd EIP changed")
    baseline = json.loads((x.directory / "preflight.json").read_text())
    for name in ("XRegion-CinderPoolManager", "XRegion-EIPPoolManager"):
        config = x.client("lambda").get_function_configuration(FunctionName=name)
        if any(config.get(k) != baseline["functions"][name].get(k) for k in baseline["functions"][name]):
            raise RuntimeError("Pool manager configuration changed")
    targets = x.client("events").list_targets_by_rule(Rule="XRegion-InstanceLaunchRule")["Targets"]
    before_targets = json.loads((x.directory / "XRegion-InstanceLaunchRule-targets-before.json").read_text())["Targets"]
    if sorted(targets, key=lambda t: t["Id"]) != sorted(before_targets, key=lambda t: t["Id"]):
        raise RuntimeError("Launch rule targets changed")
    x.save("launch-targets-after.json", targets)
    cfg = json.loads((x.directory / "XRegion-LaunchInstance-AllocateResource-before.json").read_text())["Environment"]["Variables"]
    parameters = dict(nova_url=cfg["NOVA_URL"], neutron_url=cfg["NEUTRON_URL"], cinder_url=cfg["CINDER_URL"],
        keystone_url=cfg["KEYSTONE_URL"], project_id=cfg.get("OS_PROJECT_ID", "d3bf05331973481891385d066d3eba3e"),
        nova_id=m["nova_id"], port_id=m["neutron_port_id"], sg_id=m["neutron_sg_id"],
        volume_id=volume_context["cinder_volume_id"], guest_ip=m["guest_private_ip"], frontend_ip=m["gateway_private_ip"])
    script = "set -eu\n. /etc/kolla/admin-openrc.sh\n/home/ssm-user/kolla-venv-2024.2/bin/python - <<'PY'\n"
    script += "import json,os,subprocess,urllib.request,urllib.error\np=json.loads(" + repr(json.dumps(parameters)) + ")\n"
    script += '''payload={"auth":{"identity":{"methods":["password"],"password":{"user":{"name":os.environ["OS_USERNAME"],"domain":{"name":os.environ.get("OS_USER_DOMAIN_NAME","Default")},"password":os.environ["OS_PASSWORD"]}}},"scope":{"project":{"id":p["project_id"]}}}}
req=urllib.request.Request(p["keystone_url"].rstrip("/")+"/auth/tokens",data=json.dumps(payload).encode(),headers={"Content-Type":"application/json"},method="POST")
with urllib.request.urlopen(req,timeout=10) as response:
    token=response.headers["X-Subject-Token"]
def get(url,missing=False):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={"X-Auth-Token":token}),timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code==404 and missing: return None
        raise
for label,url in (("nova",p["nova_url"].rstrip("/")+"/servers/"+p["nova_id"]),("port",p["neutron_url"].rstrip("/")+"/ports/"+p["port_id"]),("sg",p["neutron_url"].rstrip("/")+"/security-groups/"+p["sg_id"]),("volume",p["cinder_url"].rstrip("/")+"/"+p["project_id"]+"/volumes/"+p["volume_id"])):
    if get(url,True) is not None: raise RuntimeError(label+" still exists")
dd=get(p["nova_url"].rstrip("/")+"/servers/efdca890-184e-435a-96b3-fe64bcd1d568")["server"]
assert dd["status"]=="ACTIVE"
assert [v["id"] for v in dd["os-extended-volumes:volumes_attached"]]==["c40b4f0c-8e9d-4cd1-9b3c-ebf9537b85c9"]
port=get(p["neutron_url"].rstrip("/")+"/ports/e6d720fe-b917-4ab5-983d-5d48b9472c7e")["port"]
assert port["mac_address"]=="fa:16:3e:39:32:cc"
assert [ip["ip_address"] for ip in port["fixed_ips"]]==["10.20.1.226"]
old=get(p["nova_url"].rstrip("/")+"/servers/1c2bd72f-a278-4e9a-9921-c3c631c03154")["server"]
assert old["status"]=="SHUTOFF"
assert [v["id"] for v in old["os-extended-volumes:volumes_attached"]]==["49f6dca2-c82d-4b95-b67f-cf5312613751"]
names=subprocess.check_output(["lvs","--noheadings","-o","lv_name","cinder-volumes"],text=True).split()
assert "volume-"+p["volume_id"] not in names
assert "volume-c40b4f0c-8e9d-4cd1-9b3c-ebf9537b85c9" in names
assert subprocess.check_output(["blockdev","--getro","/dev/loop0"],text=True).strip()=="0"
rules=json.loads(subprocess.check_output(["nft","-j","list","table","ip","xregion_nat"],text=True))
def strings(value):
    if isinstance(value,dict): return [s for v in value.values() for s in strings(v)]
    if isinstance(value,list): return [s for v in value for s in strings(v)]
    return [value] if isinstance(value,str) else []
assert p["guest_ip"] not in strings(rules) and p["frontend_ip"] not in strings(rules)
addresses=json.loads(subprocess.check_output(["ip","-j","address","show","dev","br-ex"],text=True))
locals={a["local"] for row in addresses for a in row["addr_info"]}
assert p["frontend_ip"] not in locals and "10.20.1.253" in locals
volumes=get(p["cinder_url"].rstrip("/")+"/"+p["project_id"]+"/volumes/detail?limit=1000")
assert not any(link.get("rel")=="next" for link in volumes.get("volumes_links",[]))
print(json.dumps(dict(nova_404=True,port_404=True,sg_404=True,volume_404=True,volume_lv_absent=True,nat_removed=True,frontend_removed=True,dd_preserved=True,old_canary_preserved=True,cinder_writable=True,current_volume_ids=[v["id"] for v in volumes["volumes"]])))
PY
'''
    host = json.loads(x.remote(script, "final-host-verification", 120))
    text = json.loads((x.directory / "host-preflight.json").read_text())["StandardOutputContent"]
    new_volume_ids = pool_volume_delta(text, host.pop("current_volume_ids"))
    current = backend("instances/" + canary["instance_id"])[1]["data"]
    if current["status"] != "TERMINATED":
        raise RuntimeError("Backend GET does not confirm termination")
    result = dict(instance_id=canary["instance_id"], nova_id=m["nova_id"], launch_execution=launch["executionArn"],
        terminate_execution=live["executionArn"], aws_verified=True, protected_records_unchanged=True,
        pool_managers_unchanged=True, pool_targets_unchanged=True, backend_status=current["status"],
        new_pool_volume_ids=new_volume_ids,
        new_pool_eip_allocations=len(set(by_allocation)-{a["AllocationId"] for a in before_addresses}), host=host)
    x.save("final-verification.json", result)
    print(json.dumps(result))


def close_admission(x):
    config = x.client("lambda").get_function_configuration(FunctionName=MANIFEST["functions"]["CheckPool"])
    parameter = config.get("Environment", {}).get("Variables", {}).get("LAUNCH_ADMISSION_PARAMETER")
    if parameter:
        # Closing admission must also work while an already admitted workflow is still running.
        x.save("admission-before-close.json", x.client("ssm").get_parameter(Name=parameter))
        x.call("ssm", "put_parameter", Name=parameter, Type="String", Overwrite=True,
               Value=json.dumps({"mode": "maintenance"}))
        after = x.client("ssm").get_parameter(Name=parameter)
        if json.loads(after["Parameter"]["Value"]) != {"mode": "maintenance"}:
            raise RuntimeError("Admission close readback mismatch")
        x.save("admission-after-close.json", after)
        print("Shared admission closed; existing workflows may finish")
        return
    no_running(x)
    if not (x.directory / "final-verification.json").exists():
        raise RuntimeError("Lifecycle verification has not completed")
    function = MANIFEST["functions"]["CheckPool"]
    config = x.client("lambda").get_function_configuration(FunctionName=function)
    env = dict(config["Environment"]["Variables"])
    canary = json.loads((x.directory / "canary.json").read_text())
    if env.get("NETWORK_ADMISSION") != "maintenance" or env.get("NETWORK_ALLOWED_INSTANCE_NAME") not in (None, canary["name"]):
        raise RuntimeError("Admission was changed by another actor")
    env.pop("NETWORK_ALLOWED_INSTANCE_NAME", None)
    x.call("lambda", "update_function_configuration", FunctionName=function, RevisionId=config["RevisionId"], Environment={"Variables": env})
    x.client("lambda").get_waiter("function_updated_v2").wait(FunctionName=function, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
    after = x.client("lambda").get_function_configuration(FunctionName=function)
    if after["Environment"]["Variables"] != env:
        raise RuntimeError("Admission readback mismatch")
    x.save("check-pool-admission-after.json", {k: after[k] for k in ("CodeSha256", "RevisionId", "LastUpdateStatus")})
    print("Maintenance retained; canary allowlist closed")


def preflight(x):
    if (x.directory / "preflight.json").exists():
        raise RuntimeError("Use a new artifact directory; never overwrite the baseline")
    machines = {}
    for name in MANIFEST["workflows"]:
        arn = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"
        current = x.client("stepfunctions").describe_state_machine(stateMachineArn=arn)
        x.save(name + "-before.json", current)
        running = [e for page in x.client("stepfunctions").get_paginator("list_executions").paginate(
            stateMachineArn=arn, statusFilter="RUNNING") for e in page["executions"]]
        if running:
            raise RuntimeError("Conflicting running execution: " + name)
        machines[name] = current["revisionId"]
    inventory = {}
    names = list(MANIFEST["functions"].values()) + ["XRegion-CinderPoolManager", "XRegion-EIPPoolManager"]
    for name in names:
        current = x.client("lambda").get_function(FunctionName=name)
        config = current["Configuration"]
        if config.get("LastUpdateStatus") != "Successful" or config.get("State") != "Active":
            raise RuntimeError("Lambda is not ready: " + name)
        x.save(name + "-before.json", config)
        inventory[name] = {k: config.get(k) for k in ("RevisionId", "CodeSha256", "Handler", "Timeout", "Role", "VpcConfig")}
        if name in [MANIFEST["functions"][s] for s in STAGES]:
            with urllib.request.urlopen(current["Code"]["Location"], timeout=30) as response:
                (x.directory / (name + "-before.zip")).write_bytes(response.read())
    instances = {}
    table = x.session.resource("dynamodb").Table("XRegion-Instances")
    for iid in PROTECTED:
        instances[iid] = table.get_item(Key={"instance_id": iid}, ConsistentRead=True).get("Item")
    if not instances["i-33d89d60"] or instances["i-33d89d60"].get("active_nova_id") != "efdca890-184e-435a-96b3-fe64bcd1d568":
        raise RuntimeError("dd identity changed; reconcile before deployment")
    if not instances["i-d47acb27"] or instances["i-d47acb27"].get("current_status") != "FAILED":
        raise RuntimeError("Old failed request changed; reconcile before deployment")
    x.save("protected-instances-before.json", instances)
    for name in ("XRegion-InstanceLaunchRule",):
        x.save(name + "-before.json", x.client("events").describe_rule(Name=name))
        x.save(name + "-targets-before.json", x.client("events").list_targets_by_rule(Rule=name))
    role = "XRegion-NetworkLambdaRole"
    x.save(role + "-before.json", x.client("iam").get_role(RoleName=role))
    policies = x.client("iam").list_role_policies(RoleName=role)["PolicyNames"]
    x.save("network-role-policies-before.json", {p: x.client("iam").get_role_policy(RoleName=role, PolicyName=p) for p in policies})
    x.save("eni-before.json", x.client("ec2").describe_network_interfaces(NetworkInterfaceIds=[ENI]))
    addresses = x.client("ec2").describe_addresses()
    x.save("addresses-before.json", addresses)
    dd = next((a for a in addresses["Addresses"] if a["AllocationId"] == "eipalloc-06e7654d7aa626490"), {})
    if dd.get("AssociationId") != "eipassoc-02154720abf389e78" or dd.get("PrivateIpAddress") != "10.20.1.226":
        raise RuntimeError("dd EIP identity changed; reconcile before deployment")
    result = dict(account=ACCOUNT, region=REGION, workflows=machines, functions=inventory)
    x.save("preflight.json", result)
    print(json.dumps(dict(account=ACCOUNT, region=REGION, functions=len(inventory), running=0, protected="verified")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--stages", nargs="+", choices=STAGES)
    parser.add_argument("action", choices=("preflight", "host-preflight", "deploy", "probe", "launch", "status", "terminate", "terminate-status", "inspect", "connectivity", "repair-canary-checkpoint", "resume-terminate", "verify", "close-admission"))
    args = parser.parse_args()
    x = Deployment(args.directory)
    if args.action == "preflight":
        preflight(x)
    elif args.action == "deploy":
        deploy_selected(x, args.stages)
    elif args.action == "probe":
        probe(x)
    elif args.action == "launch":
        launch_canary(x)
    elif args.action in ("status", "terminate-status"):
        canary_status(x, args.action == "terminate-status")
    elif args.action == "terminate":
        terminate_canary(x)
    elif args.action == "inspect":
        inspect_canary(x)
    elif args.action == "connectivity":
        connectivity(x)
    elif args.action == "repair-canary-checkpoint":
        repair_canary_checkpoint(x)
    elif args.action == "resume-terminate":
        resume_terminate(x)
    elif args.action == "verify":
        verify(x)
    elif args.action == "close-admission":
        close_admission(x)
    else:
        x.remote("""set -eu
test "$(blockdev --getro /dev/loop0)" = 0
systemctl is-active cinder-loopback.service
vgs --noheadings -o vg_name,vg_uuid,vg_size,vg_free cinder-volumes
lvs --noheadings -o lv_name,lv_attr,lv_size,data_percent,metadata_percent cinder-volumes
. /etc/kolla/admin-openrc.sh
OSC=/home/ssm-user/kolla-venv-2024.2/bin/openstack
$OSC server show efdca890-184e-435a-96b3-fe64bcd1d568 -f json
$OSC server show 1c2bd72f-a278-4e9a-9921-c3c631c03154 -f json
$OSC volume show f084bef1-adc6-4038-baa1-cc56fc55fbbc -f json
$OSC keypair show xregion-nat-canary -f json
$OSC --os-project-name service --os-project-id d3bf05331973481891385d066d3eba3e volume list --long -f json
""", "host-preflight", 120)
        print("Host storage, protected guests, test volume and keypair inspected; evidence saved in OS Temp")


if __name__ == "__main__":
    main()
