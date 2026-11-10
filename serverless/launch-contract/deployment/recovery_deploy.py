"""Deploy ONLY the instance-recovery Lambda (observe mode by default).

Scope: one function and one IAM role. It does not touch launch, terminate, network or any
other function, so it cannot regress the working UI flows.

Observe-first gate:
  * Lambda is created with XREGION_RECOVERY_LIVE=false and an empty allowlist;
  * the execution role has NO states:StartExecution unless ``--allow-cleanup`` is passed.

Usage:
    python serverless/launch-contract/deployment/recovery_deploy.py            # dry run
    python serverless/launch-contract/deployment/recovery_deploy.py --apply    # observe only
"""
import argparse
import io
import json
import tempfile
import zipfile
from pathlib import Path

from control import ACCOUNT, REGION, ROOT, Deployment

FUNCTION = "XRegion-InstanceRecovery"
ROLE = "XRegion-InstanceRecovery-ExecutionRole"
SOURCE = "XRegion-InstanceRecovery/recovery_worker.py"
POLICY_FILE = "XRegion-InstanceRecovery/recovery_policy.py"
TERMINATE = "arn:aws:states:%s:%s:stateMachine:TerminateInstance" % (REGION, ACCOUNT)
# Variables copied from an existing OpenStack-facing Lambda: same cluster, same endpoints.
CARRIED = ("KEYSTONE_URL", "NEUTRON_URL", "NOVA_URL", "OS_USERNAME", "OS_PASSWORD",
           "OS_PROJECT_NAME")
SOURCE_OF_ENV = "XRegion-TerminateInstance-DeleteNova"

TRUST = {"Version": "2012-10-17", "Statement": [{
    "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"}]}


def execution_policy(allow_cleanup):
    """Least privilege. StartExecution is only granted once cleanup is approved."""
    statements = [
        {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream",
                                       "logs:PutLogEvents"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem"],
         "Resource": ["arn:aws:dynamodb:%s:%s:table/XRegion-Instances" % (REGION, ACCOUNT),
                      "arn:aws:dynamodb:%s:%s:table/XRegion-Nova" % (REGION, ACCOUNT)]},
        # Reading execution status is what lets the UI ever hear CLEANUP_DONE.
        {"Effect": "Allow", "Action": ["states:DescribeExecution"],
         "Resource": ["arn:aws:states:%s:%s:execution:TerminateInstance:*" % (REGION, ACCOUNT)]},
        # Required because the function runs inside the VPC to reach OpenStack.
        {"Effect": "Allow", "Action": ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces",
                                       "ec2:DeleteNetworkInterface"], "Resource": "*"},
    ]
    if allow_cleanup:
        statements.append({"Effect": "Allow", "Action": ["states:StartExecution"],
                           "Resource": [TERMINATE]})
    return {"Version": "2012-10-17", "Statement": statements}


def package():
    """Zip the worker plus its sibling policy module, as Lambda loads them."""
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as target:
        target.writestr("recovery_worker.py", (ROOT / SOURCE).read_bytes())
        target.writestr("recovery_policy.py", (ROOT / POLICY_FILE).read_bytes())
    return data.getvalue()


def ensure_role(x, apply, allow_cleanup):
    try:
        role = x.call("iam", "get_role", RoleName=ROLE)["Role"]
        print("ROLE exists", ROLE)
    except Exception:
        if not apply:
            print("ROLE missing (dry run)", ROLE)
            return "arn:aws:iam::%s:role/%s" % (ACCOUNT, ROLE)
        role = x.call("iam", "create_role", RoleName=ROLE,
                      AssumeRolePolicyDocument=json.dumps(TRUST))["Role"]
        print("ROLE created", ROLE)
    if apply:
        x.call("iam", "put_role_policy", RoleName=ROLE, PolicyName="InstanceRecovery",
               PolicyDocument=json.dumps(execution_policy(allow_cleanup)))
        print("POLICY applied cleanup=%s" % allow_cleanup)
    return role["Arn"]


def current_network(x):
    """Match the VPC placement of the Lambda whose environment we copy."""
    config = x.call("lambda", "get_function_configuration", FunctionName=SOURCE_OF_ENV)
    vpc = config.get("VpcConfig") or {}
    return {k: vpc[k] for k in ("SubnetIds", "SecurityGroupIds") if vpc.get(k)}


def environment(x):
    """Copy the OpenStack connection variables; recovery runs observe-only."""
    source = x.call("lambda", "get_function_configuration",
                    FunctionName=SOURCE_OF_ENV)["Environment"]["Variables"]
    env = {name: source[name] for name in CARRIED if name in source}
    env.update({
        "XREGION_RECOVERY_LIVE": "false",
        "XREGION_RECOVERY_ALLOWLIST": "",
        "XREGION_RECOVERY_MIN_AGE_S": "1800",
        "XREGION_RECOVERY_MIN_OBSERVATIONS": "3",
        "XREGION_RECOVERY_MAX_DELETE": "1",
        "XREGION_RECOVERY_SCAN_LIMIT": "200",
        "XREGION_TERMINATE_STATE_MACHINE": TERMINATE,
    })
    return env


def deploy_function(x, role_arn, apply):
    code = package()
    print("PACKAGE bytes=%d (worker + policy)" % len(code))
    try:
        current = x.call("lambda", "get_function_configuration", FunctionName=FUNCTION)
        exists = True
    except Exception:
        current, exists = None, False
    if not apply:
        print("FUNCTION would %s" % ("update" if exists else "create"), FUNCTION)
        return None
    env = environment(x)
    if exists:
        x.call("lambda", "update_function_configuration", FunctionName=FUNCTION,
               Environment={"Variables": env}, Timeout=300, MemorySize=256,
               Handler="recovery_worker.lambda_handler", RevisionId=current["RevisionId"])
    else:
        x.call("lambda", "create_function", FunctionName=FUNCTION, Runtime="python3.12",
               Role=role_arn, Handler="recovery_worker.lambda_handler",
               Code={"ZipFile": code}, Timeout=300, MemorySize=256,
               Environment={"Variables": env}, VpcConfig=current_network(x))
    revision = x.call("lambda", "get_function_configuration",
                      FunctionName=FUNCTION)["RevisionId"]
    x.call("lambda", "update_function_code", FunctionName=FUNCTION, ZipFile=code,
           RevisionId=revision)
    final = x.call("lambda", "get_function_configuration", FunctionName=FUNCTION)
    variables = final["Environment"]["Variables"]
    print("FUNCTION deployed code=%s live=%s allowlist=%r" % (
        final["CodeSha256"][:12], variables.get("XREGION_RECOVERY_LIVE"),
        variables.get("XREGION_RECOVERY_ALLOWLIST")))
    return final


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--allow-cleanup", action="store_true",
                        help="cấp quyền StartExecution (chỉ khi đã nghiệm thu cleanup)")
    args = parser.parse_args(argv)
    x = Deployment(Path(tempfile.gettempdir()) / "xregion-recovery-deploy")
    role_arn = ensure_role(x, args.apply, args.allow_cleanup)
    deploy_function(x, role_arn, args.apply)
    if not args.apply:
        print("DRY RUN: chưa thay đổi tài nguyên.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

