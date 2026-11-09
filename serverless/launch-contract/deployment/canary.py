"""Create and inspect only explicitly recorded canary executions."""
import argparse
import json
import time
import uuid

from control import ACCOUNT, REGION, Deployment


def start(x):
    suffix = uuid.uuid4().hex[:8]
    iid = "i-natcanary-" + suffix
    volumes = x.client("dynamodb").scan(TableName="XRegion-Volumes",
        FilterExpression="#s=:s", ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": "AVAILABLE"}})["Items"]
    if not volumes:
        raise RuntimeError("No canary reserve volume")
    request = dict(instance_id=iid, instance_name="xregion-nat-canary-" + suffix,
        size_gb=10, volume_type="gp3", flavor="m1.tiny", image_id=volumes[0]["image_id"]["S"],
        key_id="xregion-nat-canary", username="nat-canary")
    x.call("dynamodb", "put_item", TableName="XRegion-Instances", Item={
        "instance_id": {"S": iid}, "current_status": {"S": "PENDING"},
        "user_id": {"S": "xregion-nat-canary"}}, ConditionExpression="attribute_not_exists(instance_id)")
    result = x.call("stepfunctions", "start_execution",
        stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:LaunchInstance",
        name="xregion-nat-canary-" + suffix, input=json.dumps(request))
    x.save("canary.json", dict(request=request, **result))
    print(result["executionArn"])


def status(x, termination=False):
    record = json.loads((x.directory / ("canary-terminate.json" if termination else "canary.json")).read_text())
    r = x.client("stepfunctions").describe_execution(executionArn=record["executionArn"])
    x.save("canary-terminate-status.json" if termination else "canary-status.json", r)
    print("STATUS", r["status"])
    if r["status"] == "FAILED":
        print(r.get("error"), r.get("cause", "")[:1400])
    if r.get("output"):
        output = json.loads(r["output"])
        print(json.dumps({k: output.get(k) for k in ("nova_id", "guest_private_ip", "gateway_private_ip", "elastic_ip", "status")}))
    if r["status"] == "RUNNING":
        history = x.client("stepfunctions").get_execution_history(executionArn=record["executionArn"], reverseOrder=True, maxResults=5)["events"]
        print([(e["type"], e.get("stateEnteredEventDetails", {}).get("name")) for e in history])


def terminate(x):
    r = json.loads((x.directory / "canary-status.json").read_text())
    if r["status"] != "SUCCEEDED":
        raise ValueError("Canary launch must be reconciled before termination")
    out = json.loads(r["output"])
    result = x.call("stepfunctions", "start_execution",
        stateMachineArn=f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:TerminateInstance",
        name="xregion-nat-canary-terminate-" + uuid.uuid4().hex[:8],
        input=json.dumps({k: out[k] for k in ("instance_id", "nova_id")}))
    x.save("canary-terminate.json", result)
    print(result["executionArn"])


if __name__ == "__main__":
    p = argparse.ArgumentParser();p.add_argument("--directory", required=True)
    p.add_argument("action", choices=("start", "status", "terminate", "terminate-status"))
    a = p.parse_args();x = Deployment(a.directory)
    {"start": start, "status": status, "terminate": terminate,
     "terminate-status": lambda x: status(x, True)}[a.action](x)
