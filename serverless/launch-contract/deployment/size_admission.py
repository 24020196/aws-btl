"""Guarded deployment and one 12 GiB canary. All runtime artifacts belong in OS Temp."""
import argparse
import base64
import datetime
import hashlib
import json
import urllib.request
import urllib.error
from pathlib import Path
import time
import subprocess
import ipaddress
from botocore.config import Config

from control import ACCOUNT, REGION, Deployment
from deploy import package
from lifecycle import backend, no_running, canary_status, connectivity, terminate_canary, verify
from workflows import MANIFEST, render

PARAMETER = f"/xregion/{REGION}/launch/admission"
STAGES = ("CheckPool", "AllocateResource", "ExtendVolume", "BootNova", "SyncDynamoDB")


def backend_username():
    session = json.loads((Path.home() / "AppData/Local/Temp/xregion-cinder-repair-20261109/session.json").read_text())
    segment = session["data"]["token"].split(".")[1]
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))["sub"]


def policy():
    return {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": ["ssm:GetParameter"],
        "Resource": f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter{PARAMETER}"}]}


def deploy(x):
    no_running(x)
    baseline = json.loads((x.directory / "preflight.json").read_text())
    if json.loads((x.directory / "storage-preflight.json").read_text())["Status"] != "Success":
        raise RuntimeError("Host preflight has not passed")
    (x.directory / "host-preflight.json").write_bytes((x.directory / "storage-preflight.json").read_bytes())
    l, iam, ssm = x.client("lambda"), x.client("iam"), x.client("ssm")
    try:
        existing = ssm.get_parameter(Name=PARAMETER)
        x.save("admission-before.json", existing)
        if json.loads(existing["Parameter"]["Value"]) != {"mode": "maintenance"}:
            raise RuntimeError("Unexpected admission parameter; reconcile before deploy")
    except ssm.exceptions.ParameterNotFound:
        x.call("ssm", "put_parameter", Name=PARAMETER, Type="String", Value=json.dumps({"mode": "maintenance"}))
    results = {}
    for stage in STAGES:
        no_running(x)
        name = MANIFEST["functions"][stage]
        current = l.get_function(FunctionName=name)
        cfg = current["Configuration"]
        expected = baseline["functions"][name]
        if any(cfg[k] != expected[k] for k in ("RevisionId", "CodeSha256")):
            raise RuntimeError("Intervening change: " + name)
        with urllib.request.urlopen(current["Code"]["Location"], timeout=30) as response:
            (x.directory / (name + "-before.zip")).write_bytes(response.read())
        role = cfg["Role"].rsplit("/", 1)[1]
        grants = policy() if stage == "CheckPool" else None
        if stage == "ExtendVolume":
            grants = {"Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": ["dynamodb:GetItem"], "Resource": [
                    f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/" + t for t in
                    ("XRegion-Instances", "XRegion-Volumes", "XRegion-NetworkReservations")]},
                {"Effect": "Allow", "Action": ["dynamodb:UpdateItem"],
                 "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/XRegion-Volumes"}]}
        if grants:
            pname = "XRegion-LaunchAdmission" if stage == "CheckPool" else "XRegion-ExtendOwnership"
            try:
                x.save(role + "-" + pname + "-before.json", iam.get_role_policy(RoleName=role, PolicyName=pname))
            except iam.exceptions.NoSuchEntityException:
                x.save(role + "-" + pname + "-before.json", {"absent": True})
            x.call("iam", "put_role_policy", RoleName=role, PolicyName=pname, PolicyDocument=json.dumps(grants))
        code = package(x, stage)
        digest = base64.b64encode(hashlib.sha256(code).digest()).decode()
        (x.directory / (name + "-deployed.zip")).write_bytes(code)
        x.call("lambda", "update_function_code", FunctionName=name, RevisionId=cfg["RevisionId"], ZipFile=code)
        l.get_waiter("function_updated_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
        cfg = l.get_function_configuration(FunctionName=name)
        env = dict(cfg.get("Environment", {}).get("Variables", {}))
        env["OS_PROJECT_ID"] = "d3bf05331973481891385d066d3eba3e"
        if stage == "CheckPool":
            env["LAUNCH_ADMISSION_PARAMETER"] = PARAMETER
            env.pop("NETWORK_ALLOWED_INSTANCE_NAME", None)
        x.call("lambda", "update_function_configuration", FunctionName=name, RevisionId=cfg["RevisionId"], Environment={"Variables": env})
        l.get_waiter("function_updated_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
        after = l.get_function(FunctionName=name)
        with urllib.request.urlopen(after["Code"]["Location"], timeout=30) as response:
            assert response.read() == code
        assert after["Configuration"]["CodeSha256"] == digest
        assert after["Configuration"]["Environment"]["Variables"] == env
        x.save(name + "-after.json", after["Configuration"])
        results[name] = {k: after["Configuration"][k] for k in ("CodeSha256", "RevisionId", "LastUpdateStatus")}
        x.save("deployment-result.json", results)
        print(name + " deployed and read back", flush=True)
    arn = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:LaunchInstance"
    workflow = x.client("stepfunctions")
    no_running(x)
    current = workflow.describe_state_machine(stateMachineArn=arn)
    if current["revisionId"] != baseline["workflows"]["LaunchInstance"]:
        raise RuntimeError("Intervening workflow change")
    definition = json.dumps(render("LaunchInstance"))
    validation = workflow.validate_state_machine_definition(definition=definition, type="STANDARD")
    x.save("launch-validation.json", validation)
    if validation["result"] != "OK":
        raise RuntimeError("ASL invalid")
    x.call("stepfunctions", "update_state_machine", stateMachineArn=arn, definition=definition)
    after = workflow.describe_state_machine(stateMachineArn=arn)
    assert json.loads(after["definition"]) == render("LaunchInstance")
    x.save("LaunchInstance-after.json", after)


def probe(x):
    volumes = x.session.resource("dynamodb").Table("XRegion-Volumes")
    items, request = [], {}
    while True:
        page = volumes.scan(**request)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        request["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    candidate = next(i for i in items if i.get("status") == "AVAILABLE" and i.get("image_id") == "fd249548-1863-4d30-b809-732108cab057")
    event = dict(diagnostic_only=True, cinder_volume_id=candidate["cinder_volume_id"],
                 cinder_volume_key=candidate["volume_id"], image_id=candidate["image_id"])
    response = x.call("lambda", "invoke", FunctionName=MANIFEST["functions"]["AllocateResource"], Payload=json.dumps(event).encode())
    payload = json.loads(response["Payload"].read())
    x.save("allocate-probe.json", {"payload": payload, "function_error": response.get("FunctionError")})
    if response.get("FunctionError") or payload.get("status") != "PREFLIGHT_OK":
        raise RuntimeError("Probe failed; inspect artifact")
    print("AllocateResource private API probe passed")


def launch(x):
    marker = x.directory / "backend-launch-attempt.json"
    if marker.exists():
        raise RuntimeError("A canary POST was already attempted; reconcile, never repeat")
    assert json.loads((x.directory / "allocate-probe.json").read_text())["payload"]["status"] == "PREFLIGHT_OK"
    no_running(x)
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=7)))
    name = "ping-test-size-" + now.strftime("%Y%m%d-%H%M%S")
    request = dict(name=name, region=REGION, flavor="m1.tiny", imageId="fd249548-1863-4d30-b809-732108cab057",
                   ebsSizeGb=12, keyPairName="xregion-nat-canary")
    current = json.loads(x.client("ssm").get_parameter(Name=PARAMETER)["Parameter"]["Value"])
    if current != {"mode": "maintenance"}:
        raise RuntimeError("Admission changed")
    admission = {"mode": "maintenance", "canary": {"username": backend_username(), "name": name, "key_id": request["keyPairName"]}}
    x.call("ssm", "put_parameter", Name=PARAMETER, Type="String", Overwrite=True, Value=json.dumps(admission))
    x.save("canary-setup.json", dict(request=request, created_at=now.isoformat(), admission=admission))
    with marker.open("x", encoding="utf-8") as output:
        json.dump({"name": name, "attempted_at": now.isoformat()}, output)
    try:
        status, response = backend("instances", "POST", request)
    except urllib.error.HTTPError as error:
        x.save("backend-launch-rejection.json", {"status": error.code, "response": json.loads(error.read())})
        raise
    x.save("backend-launch-response.json", {"http_status": status, "response": response})
    assert status == 202
    data = response["data"]
    x.save("canary.json", {"instance_id": data["id"], "name": name})
    assert data["status"] == "PENDING" and not data.get("publicIp") and not data.get("volumeId")
    print(json.dumps({"instance_id": data["id"], "name": name, "status": data["status"]}))


def resume_rejected(x):
    setup = json.loads((x.directory / "canary-setup.json").read_text())
    request, name = setup["request"], setup["request"]["name"]
    # A rejected POST may be repeated only after positive evidence it never reached provisioning.
    log = (x.directory / "backend.log").read_text(encoding="utf-8", errors="replace")
    start = log.index("name=" + name)
    rejection = log[start:]
    if "Completed 503 SERVICE_UNAVAILABLE" not in rejection or (x.directory / "canary.json").exists():
        raise RuntimeError("No definitive rejection evidence; reconcile instead")
    table = x.session.resource("dynamodb").Table("XRegion-Instances")
    kwargs = {}
    while True:
        page = table.scan(ConsistentRead=True, **kwargs)
        if any(i.get("requested_name") == name for i in page.get("Items", [])):
            raise RuntimeError("Canary instance already exists")
        if not page.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    no_running(x)
    setup["admission"]["canary"]["username"] = backend_username()
    x.call("ssm", "put_parameter", Name=PARAMETER, Type="String", Overwrite=True, Value=json.dumps(setup["admission"]))
    x.save("canary-setup.json", setup)
    with (x.directory / "backend-launch-retry-attempt.json").open("x", encoding="utf-8") as output:
        json.dump({"name": name, "reason": "prior POST definitively HTTP503; consistent scan found no instance"}, output)
    status, response = backend("instances", "POST", request)
    x.save("backend-launch-response.json", {"http_status": status, "response": response})
    assert status == 202
    data = response["data"]
    x.save("canary.json", {"instance_id": data["id"], "name": name})
    assert data["status"] == "PENDING" and not data.get("publicIp") and not data.get("volumeId")
    print(json.dumps({"instance_id": data["id"], "name": name, "status": data["status"]}))


def finish(x):
    no_running(x)
    verification = json.loads((x.directory / "final-verification.json").read_text())
    if (not all(verification.get(k) is True for k in ("aws_verified", "protected_records_unchanged",
            "pool_managers_unchanged", "pool_targets_unchanged")) or verification.get("backend_status") != "TERMINATED"):
        raise RuntimeError("Lifecycle verification is incomplete; keep maintenance")
    current = json.loads(x.client("ssm").get_parameter(Name=PARAMETER)["Parameter"]["Value"])
    expected = json.loads((x.directory / "canary-setup.json").read_text())["admission"]
    if current not in ({"mode": "maintenance"}, expected):
        raise RuntimeError("Admission was changed by another operator")
    quota = x.client("service-quotas").get_service_quota(ServiceCode="ec2", QuotaCode="L-0263D0A3")["Quota"]
    x.save("quota-current.json", quota)
    # Always remove the canary exception; pending quota must leave admission closed.
    mode = "maintenance"
    if quota["Value"] >= 15:
        addresses = x.client("ec2").describe_addresses()["Addresses"]
        spares = [a for a in addresses if not a.get("AssociationId") and
                  {t["Key"]: t["Value"] for t in a.get("Tags", [])}.get("Project") == "xregion" and
                  not {t["Key"]: t["Value"] for t in a.get("Tags", [])}.get("ClaimedBy")]
        ddb = x.session.resource("dynamodb")
        def scan(table):
            rows, kwargs = [], {}
            while True:
                page = ddb.Table(table).scan(ConsistentRead=True, **kwargs)
                rows.extend(page.get("Items", []))
                if not page.get("LastEvaluatedKey"):
                    return rows
                kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        images, volumes = scan("XRegion-Images"), scan("XRegion-Volumes")
        pool_ready = all(sum(v.get("status") == "AVAILABLE" and v.get("image_id") == i["image_id"]
                             for v in volumes) >= 3 for i in images) and bool(images)
        x.save("pool-readiness.json", {"eip_spares": len(spares), "cinder_pool_ready": pool_ready})
        if len(spares) >= 3 and pool_ready:
            mode = "open"
    x.call("ssm", "put_parameter", Name=PARAMETER, Type="String", Overwrite=True, Value=json.dumps({"mode": mode}))
    after = x.client("ssm").get_parameter(Name=PARAMETER)
    if json.loads(after["Parameter"]["Value"]) != {"mode": mode}:
        raise RuntimeError("Admission readback mismatch")
    x.save("admission-after.json", after)
    print(json.dumps({"admission": mode, "effective_quota": quota["Value"]}))


def replenish(x):
    no_running(x)
    termination = json.loads((x.directory / "canary-terminate-status.json").read_text())
    if termination["status"] != "SUCCEEDED":
        raise RuntimeError("Canary cleanup has not succeeded")
    with (x.directory / "cinder-pool-replenish-attempt.json").open("x", encoding="utf-8") as output:
        json.dump({"requested_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, output)
    x.clients["lambda"] = x.session.client("lambda", config=Config(connect_timeout=5, read_timeout=330,
        retries={"mode": "standard", "total_max_attempts": 1}))
    response = x.call("lambda", "invoke", FunctionName="XRegion-CinderPoolManager", Payload=b"{}")
    payload = json.loads(response["Payload"].read())
    x.save("cinder-pool-replenish.json", {"payload": payload, "function_error": response.get("FunctionError")})
    if response.get("FunctionError") or payload.get("status") != "ALL_SUFFICIENT":
        raise RuntimeError("Pool is not ready; keep maintenance")
    print("Cinder pool replenished using unchanged handler/target")


def measure_connectivity(x):
    launch = json.loads((x.directory / "canary-launch-status.json").read_text())
    if launch["status"] != "SUCCEEDED":
        raise RuntimeError("Canary launch has not succeeded")
    address = str(ipaddress.ip_address(json.loads(launch["output"])["elastic_ip"]))
    result = subprocess.run(["ping", "-n", "10", address], capture_output=True, timeout=55)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    (x.directory / ("client-ping-" + stamp + ".txt")).write_bytes(result.stdout)
    (x.directory / "client-ping.txt").write_bytes(result.stdout)
    if result.returncode:
        raise RuntimeError("Client ping did not pass")
    connectivity(x)


def refresh_admission(x):
    """Deploy the final pre-claim input guard only after the canary has stopped."""
    no_running(x)
    results = json.loads((x.directory / "deployment-result.json").read_text())
    name = MANIFEST["functions"]["CheckPool"]
    client = x.client("lambda")
    current = client.get_function(FunctionName=name)
    cfg = current["Configuration"]
    if any(cfg[k] != results[name][k] for k in ("RevisionId", "CodeSha256")):
        raise RuntimeError("Intervening CheckPool change")
    x.save("check-pool-pre-refresh.json", cfg)
    with urllib.request.urlopen(current["Code"]["Location"], timeout=30) as response:
        (x.directory / "check-pool-pre-refresh.zip").write_bytes(response.read())
    code = package(x, "CheckPool")
    x.call("lambda", "update_function_code", FunctionName=name, RevisionId=cfg["RevisionId"], ZipFile=code)
    client.get_waiter("function_updated_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
    after = client.get_function(FunctionName=name)
    with urllib.request.urlopen(after["Code"]["Location"], timeout=30) as response:
        assert response.read() == code
    x.save(name + "-after.json", after["Configuration"])
    (x.directory / (name + "-deployed.zip")).write_bytes(code)
    results[name] = {k: after["Configuration"][k] for k in ("CodeSha256", "RevisionId", "LastUpdateStatus")}
    x.save("deployment-result.json", results)
    print("Final CheckPool input guard deployed and read back")


def monitor(x):
    admission = json.loads((x.directory / "admission-after.json").read_text())["Parameter"]
    if json.loads(admission["Value"]) != {"mode": "open"}:
        raise RuntimeError("Admission is not open")
    started = datetime.datetime.fromisoformat(admission["LastModifiedDate"])
    deadline = time.monotonic() + 1800
    observations = []
    while True:
        quota = x.client("service-quotas").get_service_quota(ServiceCode="ec2", QuotaCode="L-0263D0A3")["Quota"]["Value"]
        current = json.loads(x.client("ssm").get_parameter(Name=PARAMETER)["Parameter"]["Value"])
        if current != {"mode": "open"}:
            raise RuntimeError("Admission changed during observation; operator reconciliation required")
        failures, recent = [], []
        for name in ("LaunchInstance", "TerminateInstance"):
            for page in x.client("stepfunctions").get_paginator("list_executions").paginate(
                    stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}"):
                stop = False
                for execution in page["executions"]:
                    if execution["startDate"] < started:
                        stop = True
                        break
                    recent.append({"name": execution["name"], "status": execution["status"]})
                    if execution["status"] in ("FAILED", "TIMED_OUT", "ABORTED"):
                        failures.append(execution["executionArn"])
                if stop:
                    break
        pool_errors = []
        for group in ("XRegion-CinderPoolManager", "XRegion-EIPPoolManager"):
            for page in x.client("logs").get_paginator("filter_log_events").paginate(
                    logGroupName="/aws/lambda/" + group, startTime=int(started.timestamp() * 1000)):
                pool_errors.extend({"group": group, "event_id": e["eventId"], "timestamp": e["timestamp"]}
                    for e in page.get("events", []) if "[ERROR]" in e["message"] or "Task timed out" in e["message"])
        observation = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "quota": quota,
                       "executions": recent, "pool_errors": pool_errors}
        observations.append(observation)
        x.save("admission-monitor.json", {"complete": False, "observations": observations})
        if failures or pool_errors or quota < 15:
            x.call("ssm", "put_parameter", Name=PARAMETER, Type="String", Overwrite=True, Value=json.dumps({"mode": "maintenance"}))
            x.save("admission-monitor-failure.json", {"failures": failures, "pool_errors": pool_errors, "quota": quota})
            raise RuntimeError("Observation failed; admission closed")
        print(json.dumps({"minutes_observed": round((datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()/60, 1), **observation}), flush=True)
        if time.monotonic() >= deadline:
            x.save("admission-monitor.json", {"complete": True, "observations": observations})
            return
        time.sleep(min(45, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("action", choices=("deploy", "probe", "launch", "resume-rejected", "status", "connectivity", "terminate", "terminate-status", "replenish", "refresh-admission", "verify", "finish", "monitor"))
    args = parser.parse_args()
    x = Deployment(args.directory)
    actions = {"deploy": deploy, "probe": probe, "launch": launch, "status": canary_status,
               "resume-rejected": resume_rejected,
               "replenish": replenish,
               "monitor": monitor,
               "refresh-admission": refresh_admission,
               "connectivity": measure_connectivity, "terminate": terminate_canary, "verify": verify, "finish": finish,
               "terminate-status": lambda deployment: canary_status(deployment, True)}
    actions[args.action](x)


if __name__ == "__main__":
    main()
