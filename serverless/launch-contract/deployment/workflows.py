"""Deterministic ASL rendering with logical Lambda bindings from manifest.json."""
import argparse
import json
from pathlib import Path

MANIFEST = json.loads(Path(__file__).with_name("manifest.json").read_text())


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
            "ChoiceNatCommand": {"Type": "Choice", "Choices": [
                {"And": [{"Variable": "$.command_status", "StringEquals": "SUCCEEDED"},
                         {"Variable": "$.network_operation", "StringEquals": "VERIFY"}], "Next": "SyncDynamoDB"},
                {"Variable": "$.command_status", "StringEquals": "SUCCEEDED", "Next": "VerifyNetwork"}],
                "Default": "WaitNatCommand"},
            "VerifyNetwork": task("Verify", "WaitNatCommand"),
            "SyncDynamoDB": task("SyncDynamoDB", "LaunchSuccess"),
            "LaunchSuccess": {"Type": "Succeed"},
            "MarkNetworkFailure": task("SyncDynamoDB", "ProvisioningFailed", catch="ProvisioningFailed"),
            "ProvisioningFailed": {"Type": "Fail", "Error": "ProvisioningError"}}
        states["CheckPool"]["Parameters"].pop("Payload.$")
        states["CheckPool"]["Retry"].insert(0, {"ErrorEquals": ["PoolNotReady"], "IntervalSeconds": 10,
            "MaxAttempts": 18, "BackoffRate": 1})
        states["CheckPool"]["Parameters"]["Payload"] = {"request.$": "$", "execution_arn.$": "$$.Execution.Id"}
        start = "CheckPool"
    elif name == "TerminateInstance":
        states = {
            "LoadNetworkContext": task("Release", "ChooseNetworkMode", catch="TerminationFailed"),
            "ChooseNetworkMode": {"Type": "Choice", "Choices": [
                {"And": [{"Variable": "$.network_mode", "StringEquals": "linux_nat_v1"},
                         {"Variable": "$.network_cleanup_complete", "BooleanEquals": True}], "Next": "DeleteSecurityGroup"},
                {"Variable": "$.network_mode", "StringEquals": "linux_nat_v1", "Next": "RemoveNatMapping"}], "Default": "LegacyDeleteNova"},
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
            "TerminationFailed": {"Type": "Fail", "Error": "TerminationError"},
            "LegacyDeleteSecurityGroup": task("DeleteSecurityGroup", "LegacyDeleteVolume", catch="TerminationFailed"),
            "LegacyDeleteNova": task("DeleteNova", "LegacyDeleteSecurityGroup", catch="TerminationFailed"),
            "LegacyDeleteVolume": task("DeleteVolume", "LegacyVolumeDeletionStatus", catch="TerminationFailed"),
            "LegacyVolumeDeletionStatus": {"Type": "Choice", "Choices": [
                {"Variable": "$.volume_cleanup.status", "StringEquals": "DELETED", "Next": "LegacyReleaseEIP"}], "Default": "WaitLegacyVolumeDeletion"},
            "WaitLegacyVolumeDeletion": {"Type": "Wait", "Seconds": 5, "Next": "LegacyDeleteVolume"},
            "LegacyReleaseEIP": task("ReleaseEIP", "SyncDynamoDB", catch="TerminationFailed")}
        states["FinalizeNetworkRelease"]["Retry"].append({"ErrorEquals": ["TimeoutError", "TransactionCanceledException", "ConditionalCheckFailedException"],
            "IntervalSeconds": 2, "MaxAttempts": 2, "BackoffRate": 2})
        start = "LoadNetworkContext"
    else:
        raise ValueError("Unknown workflow")
    return dict(Comment="xregion linux-nat-v1 contract 1", StartAt=start, TimeoutSeconds=1800, States=states)


if __name__ == "__main__":
    p = argparse.ArgumentParser();p.add_argument("workflow", choices=MANIFEST["workflows"])
    p.add_argument("--account");p.add_argument("--region")
    a = p.parse_args();print(json.dumps(render(a.workflow, a.account, a.region), indent=2))
