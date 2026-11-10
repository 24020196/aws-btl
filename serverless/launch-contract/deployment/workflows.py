"""Deterministic ASL rendering with logical Lambda bindings from manifest.json."""
import argparse
import json
from pathlib import Path

MANIFEST = json.loads(Path(__file__).with_name("manifest.json").read_text())


def write_asl(name, account=None, region=None):
    """Ghi bản ASL tĩnh đúng bằng kết quả render() để file kiểm tra trong repo không lệch generator."""
    target = Path(__file__).resolve().parents[1] / (name + ".asl.json")
    target.write_text(json.dumps(render(name, account, region), indent=2) + "\n", encoding="utf-8")
    return target


def render(name, account=None, region=None):
    account, region = account or MANIFEST["account"], region or MANIFEST["region"]
    def task(logical, next_state=None, catch="MarkNetworkFailure", **kwargs):
        state = {"Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
                 "Parameters": {"FunctionName": f"arn:aws:lambda:{region}:{account}:function:" + MANIFEST["functions"][logical], "Payload.$": "$"},
                 "OutputPath": "$.Payload", "Retry": [{"ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"],
                    "IntervalSeconds": 2, "MaxAttempts": 2, "BackoffRate": 2}]}
        if next_state:
            state["Next"] = next_state
        else:
            state["End"] = True
        if catch:
            state["Catch"] = [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": catch}]
        state.update(kwargs)
        return state
    if name == "LaunchInstance":
        states = {
            "CheckPool": task("CheckPool", "AllocateResource"),
            "AllocateResource": task("AllocateResource", "ReserveNetwork"),
            "ReserveNetwork": task("Reserve", "ExtendVolume"),
            "ExtendVolume": task("ExtendVolume", "VolumeExtensionStatus"),
            "VolumeExtensionStatus": {"Type": "Choice", "Choices": [
                {"Variable": "$.volume_extension.status", "StringEquals": "CONFIRMED", "Next": "BootNovaVM"}],
                "Default": "WaitVolumeExtension"},
            "WaitVolumeExtension": {"Type": "Wait", "Seconds": 5, "Next": "ExtendVolume"},
            "BootNovaVM": task("BootNova", "CommitNetworkMapping"),
            "CommitNetworkMapping": task("Commit", "AssignSecurityGroup"),
            "AssignSecurityGroup": task("AssignSecurityGroup", "ApplyNatMapping"),
            "ApplyNatMapping": task("Dispatch", "WaitNatCommand"),
            "WaitNatCommand": {"Type": "Wait", "Seconds": 3, "Next": "CheckNatCommand"},
            "CheckNatCommand": task("CheckCommand", "ChoiceNatCommand"),
            # SPEC-SF-01 1.4.0 / SPEC-04 1.2.0: VerifyNetwork đã bị loại bỏ khỏi launch.
            # APPLY SUCCEEDED (CheckCommand đã xác nhận applied_generation) đi thẳng SyncDynamoDB;
            # launch KHÔNG còn chứng minh reachability ICMP/TCP 22.
            "ChoiceNatCommand": {"Type": "Choice", "Choices": [
                {"Variable": "$.command_status", "StringEquals": "SUCCEEDED", "Next": "SyncDynamoDB"}],
                "Default": "WaitNatCommand"},
            "SyncDynamoDB": task("SyncDynamoDB", "LaunchSuccess"),
            "LaunchSuccess": {"Type": "Succeed"},
            "MarkNetworkFailure": task("SyncDynamoDB", "ProvisioningFailed", catch="ProvisioningFailed"),
            "ProvisioningFailed": {"Type": "Fail", "Error": "ProvisioningError"}}
        states["CheckPool"]["Parameters"].pop("Payload.$")
        states["CheckPool"]["Retry"].insert(0, {"ErrorEquals": ["PoolNotReady"], "IntervalSeconds": 5,
            "MaxAttempts": 5, "BackoffRate": 2})
        states["CheckPool"]["Parameters"]["Payload"] = {"request.$": "$", "execution_arn.$": "$$.Execution.Id"}
        start = "CheckPool"
    elif name == "TerminateInstance":
        # SPEC-SF-02: 100% máy ảo dùng linux_nat_v1; nhánh Legacy (LegacyDeleteNova,
        # LegacyDeleteSecurityGroup, LegacyDeleteVolume, LegacyVolumeDeletionStatus,
        # WaitLegacyVolumeDeletion, LegacyReleaseEIP) bị loại bỏ hoàn toàn khỏi ASL.
        states = {
            "LoadNetworkContext": task("Release", "RemoveNatMapping", catch="TerminationFailed"),
            "RemoveNatMapping": task("Dispatch", "WaitNatCommand", catch="TerminationFailed"),
            "WaitNatCommand": {"Type": "Wait", "Seconds": 3, "Next": "CheckNatCommand"},
            "CheckNatCommand": task("CheckCommand", "ChoiceNatCommand", catch="TerminationFailed"),
            "ChoiceNatCommand": {"Type": "Choice", "Choices": [{"Variable": "$.command_status", "StringEquals": "SUCCEEDED", "Next": "DeleteNovaVM"}], "Default": "WaitNatCommand"},
            "DeleteNovaVM": task("DeleteNova", "FinalizeNetworkRelease", catch="TerminationFailed"),
            "FinalizeNetworkRelease": task("Release", "DeleteSecurityGroup", catch="TerminationFailed"),
            "DeleteSecurityGroup": task("DeleteSecurityGroup", "DeleteVolume", catch="TerminationFailed"),
            "DeleteVolume": task("DeleteVolume", "VolumeDeletionStatus", catch="TerminationFailed"),
            "VolumeDeletionStatus": {"Type": "Choice", "Choices": [
                {"Variable": "$.volume_cleanup.status", "StringEquals": "DELETED", "Next": "SyncDynamoDB"}], "Default": "WaitVolumeDeletion"},
            "WaitVolumeDeletion": {"Type": "Wait", "Seconds": 5, "Next": "DeleteVolume"},
            "SyncDynamoDB": task("TerminateSync", "TerminationSuccess", catch="TerminationFailed"),
            "TerminationSuccess": {"Type": "Succeed"},
            "TerminationFailed": {"Type": "Fail", "Error": "TerminationError"}}
        states["FinalizeNetworkRelease"]["Retry"].append({"ErrorEquals": ["TimeoutError", "TransactionCanceledException", "ConditionalCheckFailedException"],
            "IntervalSeconds": 2, "MaxAttempts": 2, "BackoffRate": 2})
        start = "LoadNetworkContext"
    elif name == "LifecycleInstance":
        # SPEC-SF-06: STOP/START/REBOOT do Step Functions điều phối. DynamoDB chỉ được ghi
        # trạng thái cuối sau khi Nova được quan sát; không còn Lambda ghi ngay sau POST action.
        states = {
            # SPEC-SF-06 §4.1: Lambda nhận mode qua payload; Pass giữ nguyên event và chỉ
            # thêm khoá mode để mỗi Task gọi đúng nhánh xử lý.
            "SetModeLoad": {"Type": "Pass", "Result": "LOAD", "ResultPath": "$.mode", "Next": "LoadInstance"},
            "LoadInstance": task("Lifecycle", "ChoiceLoaded", catch="LifecycleFailed"),
            "ChoiceLoaded": {"Type": "Choice", "Choices": [
                {"Variable": "$.status", "StringEquals": "ALREADY_HANDLED", "Next": "AlreadyHandled"},
                {"Variable": "$.status", "StringEquals": "REJECTED", "Next": "LifecycleRejected"},
                {"Variable": "$.status", "StringEquals": "FAILED", "Next": "LifecycleFailed"},
                {"Variable": "$.already_at_target", "BooleanEquals": True, "Next": "SetModeSync"}],
                "Default": "SetModeDispatch"},
            "SetModeDispatch": {"Type": "Pass", "Result": "DISPATCH", "ResultPath": "$.mode", "Next": "DispatchAction"},
            "DispatchAction": task("Lifecycle", "ChoiceDispatched", catch="LifecycleFailed"),
            "ChoiceDispatched": {"Type": "Choice", "Choices": [
                {"Variable": "$.status", "StringEquals": "REJECTED", "Next": "LifecycleRejected"}],
                "Default": "WaitStatus"},
            "WaitStatus": {"Type": "Wait", "Seconds": 5, "Next": "SetModeStatus"},
            "SetModeStatus": {"Type": "Pass", "Result": "STATUS", "ResultPath": "$.mode", "Next": "CheckStatus"},
            "CheckStatus": task("Lifecycle", "ChoiceStatus", catch="LifecycleFailed"),
            "ChoiceStatus": {"Type": "Choice", "Choices": [
                {"And": [{"Variable": "$.action", "StringEquals": "STOP"},
                         {"Variable": "$.observed_status", "StringEquals": "SHUTOFF"}], "Next": "SetModeSync"},
                {"And": [{"Variable": "$.action", "StringEquals": "STOP"},
                         {"Variable": "$.observed_status", "StringEquals": "STOPPED"}], "Next": "SetModeSync"},
                {"And": [{"Variable": "$.action", "StringEquals": "START"},
                         {"Variable": "$.observed_status", "StringEquals": "ACTIVE"}], "Next": "SetModeSync"},
                {"And": [{"Variable": "$.action", "StringEquals": "REBOOT"},
                         {"Variable": "$.observed_status", "StringEquals": "ACTIVE"},
                         {"Variable": "$.saw_transition", "BooleanEquals": True},
                         {"Variable": "$.task_state", "IsNull": True}], "Next": "SetModeSync"},
                {"And": [{"Variable": "$.action", "StringEquals": "START"},
                         {"Variable": "$.observed_status", "StringEquals": "SHELVED"}],
                 "Next": "LifecycleRejected"},
                {"And": [{"Variable": "$.action", "StringEquals": "START"},
                         {"Variable": "$.observed_status", "StringEquals": "SHELVED_OFFLOADED"}],
                 "Next": "LifecycleRejected"},
                {"Variable": "$.status", "StringEquals": "REJECTED", "Next": "LifecycleRejected"},
                {"Variable": "$.observed_status", "StringEquals": "ERROR", "Next": "LifecycleFailed"}],
                "Default": "WaitStatus"},
            "SetModeSync": {"Type": "Pass", "Result": "SYNC", "ResultPath": "$.mode", "Next": "SyncDynamoDB"},
            "SyncDynamoDB": task("Lifecycle", "LifecycleSucceeded", catch="LifecycleFailed"),
            "LifecycleSucceeded": {"Type": "Succeed"},
            "AlreadyHandled": {"Type": "Succeed"},
            "LifecycleRejected": {"Type": "Fail", "Error": "LifecycleRejected",
                                  "Cause": "Yêu cầu vòng đời vi phạm SPEC-01/SPEC-SF-06"},
            "LifecycleFailed": {"Type": "Fail", "Error": "LifecycleError",
                                "Cause": "Không quan sát được trạng thái Nova mong đợi"}}
        start = "SetModeLoad"
    else:
        raise ValueError("Unknown workflow")
    # SPEC-SF-01/SPEC-SF-02: thời gian timeout tối đa của cả 2 Step Function là 300 giây.
    return dict(Comment="xregion linux-nat-v1 contract 1", StartAt=start, TimeoutSeconds=300, States=states)


if __name__ == "__main__":
    p = argparse.ArgumentParser();p.add_argument("workflow", choices=MANIFEST["workflows"])
    p.add_argument("--account");p.add_argument("--region")
    a = p.parse_args();print(json.dumps(render(a.workflow, a.account, a.region), indent=2))
