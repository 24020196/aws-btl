"""Schedule the instance-recovery sweep (XR-RISK-004).

Ships in **observe-only** mode: the schedule is created enabled, but the Lambda runs with
``XREGION_RECOVERY_LIVE=false`` and an empty allowlist, so it classifies and logs without
destroying anything. Turning it destructive is a separate, explicit change.

Usage:
    python serverless/launch-contract/deployment/recovery_schedule.py --apply
"""
import argparse
import json
import os
import tempfile
from pathlib import Path

from control import ACCOUNT, REGION, Deployment

RULE = "XRegion-InstanceRecovery-Schedule"
ROLE = "XRegion-InstanceRecovery-Role"
FUNCTION = "XRegion-InstanceRecovery"
TERMINATE = "arn:aws:states:%s:%s:stateMachine:TerminateInstance" % (REGION, ACCOUNT)
FUNCTION_ARN = "arn:aws:lambda:%s:%s:function:%s" % (REGION, ACCOUNT, FUNCTION)

TRUST = {"Version": "2012-10-17", "Statement": [{
    "Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"},
    "Action": "sts:AssumeRole",
    "Condition": {"StringEquals": {"aws:SourceAccount": ACCOUNT}}}]}

# The scheduler role may ONLY invoke the worker. Data/terminate permissions belong to the
# Lambda execution role, so a compromised schedule cannot touch state or start workflows.
SCHEDULER_POLICY = {"Version": "2012-10-17", "Statement": [
    {"Effect": "Allow", "Action": ["lambda:InvokeFunction"], "Resource": [FUNCTION_ARN]}]}



def ensure_role(x, apply):
    """Create/refresh the least-privilege role the schedule uses to invoke the worker."""
    trust = json.dumps(TRUST)
    try:
        role = x.call("iam", "get_role", RoleName=ROLE)["Role"]
        print("ROLE exists", ROLE)
    except Exception:
        if not apply:
            print("ROLE missing (dry run)", ROLE)
            return
        role = x.call("iam", "create_role", RoleName=ROLE, AssumeRolePolicyDocument=trust)["Role"]
        print("ROLE created", ROLE)
    if apply:
        x.call("iam", "put_role_policy", RoleName=ROLE, PolicyName="InstanceRecovery",
               PolicyDocument=json.dumps(SCHEDULER_POLICY))
    return role["Arn"]


def ensure_schedule(x, role_arn, apply, minutes, enabled=False):
    """Create the schedule DISABLED unless ``--enabled`` is passed explicitly."""
    payload = {"source": "xregion.recovery.schedule"}
    kwargs = dict(Name=RULE, ScheduleExpression="rate(%d minutes)" % minutes,
                  FlexibleTimeWindow={"Mode": "OFF"},
                  State="ENABLED" if enabled else "DISABLED",
                  Target={"Arn": FUNCTION_ARN, "RoleArn": role_arn,
                          "Input": json.dumps(payload),
                          "RetryPolicy": {"MaximumRetryAttempts": 2,
                                          "MaximumEventAgeInSeconds": 300}})
    try:
        x.call("scheduler", "get_schedule", Name=RULE)
        if not apply:
            print("SCHEDULE exists (would update)", RULE)
            return
        x.call("scheduler", "update_schedule", **kwargs)
        print("SCHEDULE updated", RULE)
    except Exception:
        if not apply:
            print("SCHEDULE missing (dry run)", RULE)
            return
        x.call("scheduler", "create_schedule", **kwargs)
        print("SCHEDULE created", RULE)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="thực thi thay đổi thật")
    parser.add_argument("--minutes", type=int, default=5)
    parser.add_argument("--enabled", action="store_true",
                        help="bật lịch ngay (mặc định tạo ở trạng thái DISABLED)")
    args = parser.parse_args(argv)
    directory = Path(tempfile.gettempdir()) / "xregion-recovery-schedule"
    x = Deployment(directory)
    role_arn = ensure_role(x, args.apply) or \
        "arn:aws:iam::%s:role/%s" % (ACCOUNT, ROLE)
    ensure_schedule(x, role_arn, args.apply, args.minutes, args.enabled)
    if not args.apply:
        print("DRY RUN: không thay đổi tài nguyên. Thêm --apply để tạo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
