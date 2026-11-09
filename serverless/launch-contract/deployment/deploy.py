"""Explicit render/validate/diff/deploy/export. No other workflows are modified."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.request
import zipfile

from control import ACCOUNT, REGION, ROOT, Deployment
from workflows import MANIFEST, render


def package(x, logical):
    source = MANIFEST.get("standalone", {}).get(logical)
    data = io.BytesIO()
    name = MANIFEST["functions"][logical]
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as target:
        if source:
            target.writestr(source["handler"].rsplit(".", 1)[0] + ".py", (ROOT / source["source"]).read_bytes())
            if logical in ("ExtendVolume", "CinderPoolManager"):
                target.writestr("network_runtime.py", (ROOT / "runtime/network_runtime.py").read_bytes())
        else:
            target.writestr("network_runtime.py", (ROOT / "runtime/network_runtime.py").read_bytes())
        if logical in MANIFEST["modify"]:
            baseline = x.directory / (name + "-before.zip")
            if not baseline.exists():
                baseline = x.directory / (name + ".zip")
            with zipfile.ZipFile(baseline) as before:
                meta_path = x.directory / (name + "-before.json")
                if not meta_path.exists():
                    meta_path = x.directory / (name + ".json")
                meta = json.loads(meta_path.read_text())
                config = meta.get("Configuration", meta)
                module = "legacy.py" if "legacy.py" in before.namelist() else config["Handler"].rsplit(".", 1)[0] + ".py"
                if module == "network_runtime.py":
                    raise RuntimeError("Cannot wrap the network dispatcher as its own legacy handler")
                source = before.read(module).decode("utf-8")
                source = re.sub(r'os\.environ\.get\(([\"\'])OS_PASSWORD\1,\s*([\"\']).*?\2\)',
                                'os.environ["OS_PASSWORD"]', source)
                target.writestr("legacy.py", source)
    return data.getvalue()


def deploy_functions(x):
    l = x.client("lambda")
    template = json.loads((x.directory / "XRegion-LaunchInstance-BootNova.json").read_text())["Configuration"]
    gateway = json.loads((x.directory / "gateway-resources.json").read_text())
    base = {k: v for k, v in template["Environment"]["Variables"].items()}
    base.update(NEUTRON_URL="http://10.20.10.183:9696/v2.0", CINDER_URL="http://10.20.10.183:8776/v3",
        NETWORK_ID=gateway["NETWORK_ID"],
        PUBLIC_SUBNET_ID="subnet-0c2058b1b74fae060", LEGACY_NETWORK_ID="77e93c67-be12-4a0c-98f0-64d543833a62",
        OPENSTACK_PUBLIC_ENI=MANIFEST["eni_id"], GATEWAY_HOST_ID=MANIFEST["host_id"],
        LAUNCH_ADMISSION_PARAMETER=f"/xregion/{REGION}/launch/admission")
    results = {}
    for logical in MANIFEST["create"] + MANIFEST["modify"] + list(MANIFEST.get("standalone", {})):
        name = MANIFEST["functions"][logical]
        env = dict(base, NETWORK_STAGE=logical)
        code = package(x, logical)
        if logical in MANIFEST["create"]:
            try:
                before = l.get_function_configuration(FunctionName=name)
            except l.exceptions.ResourceNotFoundException:
                x.call("lambda", "create_function", FunctionName=name, Runtime=template["Runtime"],
                    Role=f"arn:aws:iam::{ACCOUNT}:role/XRegion-NetworkLambdaRole",
                    Handler="network_runtime.lambda_handler", Code={"ZipFile": code},
                    Timeout=150, MemorySize=256, Environment={"Variables": env},
                    VpcConfig={k: template["VpcConfig"][k] for k in ("SubnetIds", "SecurityGroupIds")})
                l.get_waiter("function_active_v2").wait(FunctionName=name)
                before = l.get_function_configuration(FunctionName=name)
        else:
            before = l.get_function_configuration(FunctionName=name)
            original = json.loads((x.directory / (name + ".json")).read_text())["Configuration"]
            if before["CodeSha256"] != original["CodeSha256"] and before.get("Handler") != "network_runtime.lambda_handler":
                raise RuntimeError("Intervening Lambda change: " + name)
            env = dict(before.get("Environment", {}).get("Variables", {}), **env)
        config = dict(FunctionName=name, Handler=MANIFEST.get("standalone", {}).get(logical, {}).get("handler", "network_runtime.lambda_handler"),
            Environment={"Variables": env}, Timeout=150, RevisionId=before["RevisionId"])
        if logical == "AllocateResource":
            # Volume validation now calls Keystone/Cinder on the private OpenStack network.
            config["VpcConfig"] = {k: template["VpcConfig"][k] for k in ("SubnetIds", "SecurityGroupIds")}
        x.call("lambda", "update_function_configuration", **config)
        l.get_waiter("function_updated_v2").wait(FunctionName=name)
        revision = l.get_function_configuration(FunctionName=name)["RevisionId"]
        x.call("lambda", "update_function_code", FunctionName=name, ZipFile=code, RevisionId=revision)
        l.get_waiter("function_updated_v2").wait(FunctionName=name)
        after = l.get_function(FunctionName=name)
        with urllib.request.urlopen(after["Code"]["Location"]) as response:
            downloaded = response.read()
        with zipfile.ZipFile(io.BytesIO(downloaded)) as archive:
            standalone = MANIFEST.get("standalone", {}).get(logical)
            module = standalone["handler"].rsplit(".", 1)[0] + ".py" if standalone else "network_runtime.py"
            path = ROOT / standalone["source"] if standalone else ROOT / "runtime/network_runtime.py"
            assert archive.read(module) == path.read_bytes()
        results[name] = {k: after["Configuration"][k] for k in ("RevisionId", "CodeSha256", "LastUpdateStatus")}
        x.save("deployment-result.json", results)
        print(name + " verified", flush=True)


def workflow(x, name, apply=False):
    definition = json.dumps(render(name))
    check = x.call("stepfunctions", "validate_state_machine_definition", definition=definition, type="STANDARD")
    x.save(name + "-validation.json", check)
    if check["result"] != "OK":
        raise RuntimeError("Invalid ASL: " + name)
    before = x.client("stepfunctions").describe_state_machine(
        stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}")
    x.save(name + "-rendered.json", json.loads(definition))
    print(name, "definition_changed", json.loads(before["definition"]) != json.loads(definition), flush=True)
    if apply:
        original = json.loads((x.directory / (name + ".json")).read_text())
        own_after = x.directory / (name + "-after.json")
        revisions = {original["revisionId"]}
        if own_after.exists():
            revisions.add(json.loads(own_after.read_text())["revisionId"])
        if before["revisionId"] not in revisions and json.loads(before["definition"]) != json.loads(definition):
            raise RuntimeError("Intervening workflow change: " + name)
        running = x.client("stepfunctions").list_executions(stateMachineArn=before["stateMachineArn"], statusFilter="RUNNING")["executions"]
        if running:
            raise RuntimeError("Workflow still running: " + name)
        x.call("stepfunctions", "update_state_machine", stateMachineArn=before["stateMachineArn"], definition=definition,
            loggingConfiguration={"level": "ALL", "includeExecutionData": False, "destinations": [{
                "cloudWatchLogsLogGroup": {"logGroupArn": f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/vendedlogs/states/XRegion-{name}:*"}}]})
        after = x.client("stepfunctions").describe_state_machine(stateMachineArn=before["stateMachineArn"])
        assert json.loads(after["definition"]) == json.loads(definition)
        x.save(name + "-after.json", after)


def export(x, name):
    result = x.client("stepfunctions").describe_state_machine(
        stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{name}")
    x.save(name + "-export.json", result)
    assert json.loads(result["definition"]) == render(name)
    x.log("export", "SUCCEEDED", workflow=name,
          definition_sha256=hashlib.sha256(json.dumps(render(name), sort_keys=True).encode()).hexdigest())


def sync_runtime(x):
    from concurrent.futures import ThreadPoolExecutor
    def one(logical):
        name = MANIFEST["functions"][logical]
        client = x.client("lambda")
        before = client.get_function_configuration(FunctionName=name)
        code = package(x, logical)
        x.call("lambda", "update_function_code", FunctionName=name, ZipFile=code, RevisionId=before["RevisionId"])
        client.get_waiter("function_updated_v2").wait(FunctionName=name)
        after = client.get_function_configuration(FunctionName=name)
        print(name + " runtime synced", flush=True)
        return name, {k: after[k] for k in ("RevisionId", "CodeSha256", "LastUpdateStatus")}
    with ThreadPoolExecutor(max_workers=4) as pool:
        result = dict(pool.map(one, MANIFEST["create"] + MANIFEST["modify"] + list(MANIFEST.get("standalone", {}))))
    x.save("deployment-result.json", result)


if __name__ == "__main__":
    p = argparse.ArgumentParser();p.add_argument("--directory", required=True)
    p.add_argument("action", choices=("functions", "sync-runtime", "render", "deploy", "export"))
    p.add_argument("--workflow", choices=MANIFEST["workflows"])
    a = p.parse_args();x = Deployment(a.directory)
    if a.action == "functions":
        deploy_functions(x)
    elif a.action == "sync-runtime":
        sync_runtime(x)
    elif not a.workflow:
        p.error("--workflow is required; no implicit update of other workflows")
    elif a.action == "export":
        export(x, a.workflow)
    else:
        workflow(x, a.workflow, a.action == "deploy")
