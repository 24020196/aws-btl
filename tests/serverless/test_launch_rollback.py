import builtins
import importlib.util
import io
import json
from pathlib import Path
import sys
from unittest import mock
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"


def load(path):
    spec = importlib.util.spec_from_file_location("rollback_test_module", ROOT / path)
    module = importlib.util.module_from_spec(spec)
    with mock.patch("boto3.Session"), mock.patch("boto3.client"):
        spec.loader.exec_module(module)
    return module


def test_failure_can_be_recorded_when_legacy_module_is_missing():
    h = load("runtime/network_runtime.py")
    original = builtins.__import__

    def missing(name, *args, **kwargs):
        if name == "legacy":
            raise ModuleNotFoundError("legacy")
        return original(name, *args, **kwargs)

    with mock.patch("builtins.__import__", side_effect=missing):
        h.sync({"instance_id": "i-test", "error": {"Error": "ModuleNotFoundError"}})
    values = h.DDB.Table.return_value.update_item.call_args.kwargs["ExpressionAttributeValues"]
    assert "FAILED" in values.values()
    assert "ModuleNotFoundError" in values.values()


def test_rollback_volume_accepts_failed_launch_without_nova_row():
    h = load("XRegion-TerminateInstance-DeleteVolume/delete_volume.py")
    event = dict(instance_id="i-test", nova_id="nova", reservation_id="exec", cleanup_mode="LAUNCH_ROLLBACK",
                 cinder_volume_key="pool", cinder_volume_id="8f70f149-9f7b-4c27-9471-100271de917d")
    main = dict(launch_execution_arn="exec", current_status="FAILED", failed_nova_id="nova")
    volume = dict(volume_id="pool", lease_instance_id="i-test", extend_reservation_id="exec",
                  cinder_volume_id=event["cinder_volume_id"])
    with mock.patch.object(h, "get", side_effect=lambda table, *args: {
            "XRegion-Instances": main, "XRegion-Nova": None, "XRegion-Volumes": volume}[table]):
        assert h.resources(event) == [{"key": "pool", "kind": "cinder", "id": event["cinder_volume_id"]}]
        main["launch_execution_arn"] = "new-execution"
        with pytest.raises(ValueError, match="ownership changed"):
            h.resources(event)
        main["launch_execution_arn"] = "exec"
        volume["extend_reservation_id"] = "other"
        with pytest.raises(ValueError, match="reservation changed"):
            h.resources(event)


def test_sync_package_contains_both_runtime_and_legacy_without_baseline():
    with mock.patch.object(sys, "path", [str(ROOT / "deployment")] + sys.path):
        import deploy
        with zipfile.ZipFile(io.BytesIO(deploy.package(mock.Mock(), "SyncDynamoDB"))) as archive:
            assert set(archive.namelist()) == {"network_runtime.py", "legacy.py"}
            assert archive.read("legacy.py") == (ROOT / "XRegion-LaunchInstance-SyncDynamoDB/sync_dynamodb.py").read_bytes()


def test_rollback_preserves_original_error_and_never_marks_launch_success():
    states = json.loads((ROOT / "LaunchInstance.asl.json").read_text())["States"]
    assert states["MarkNetworkFailure"]["Next"] == "ChoiceLaunchRollback"
    for name, state in states.items():
        if name.startswith("Rollback") and state["Type"] == "Task":
            assert state["Catch"][0]["ResultPath"] == "$.cleanup_error"
    assert states["RecordRollbackResult"]["Next"] == "ProvisioningFailed"


def test_sync_write_failure_propagates_to_workflow():
    h = load("XRegion-LaunchInstance-SyncDynamoDB/sync_dynamodb.py")
    h.dynamodb.put_item.side_effect = [None, RuntimeError("SG write failed")]
    with pytest.raises(RuntimeError, match="SG write failed"):
        h.lambda_handler(dict(server_id="nova", instance_id="i-test", username="admin"), None)


def test_rollback_completion_requires_confirmed_network_and_volume_deletion():
    h = load("runtime/network_runtime.py")
    event = dict(instance_id="i-test", nova_id="nova", error={"Error": "ModuleNotFoundError"},
                 launch_cleanup_status="COMPLETE", volume_cleanup={"status": "DELETED"})
    with mock.patch.object(h, "mapping", return_value={"status": "APPLYING"}):
        with pytest.raises(RuntimeError, match="not confirmed"):
            h.sync(event)
    h.DDB.Table.return_value.update_item.assert_not_called()


def test_failure_cleanup_keeps_original_failure_reason():
    h = load("runtime/network_runtime.py")
    h.sync(dict(instance_id="i-test", error={"Error": "ModuleNotFoundError"},
                network_operation="REMOVE", cleanup_error={"Error": "AccessDeniedException"},
                launch_cleanup_status="FAILED"))
    fields = h.DDB.Table.return_value.update_item.call_args.kwargs
    values = fields["ExpressionAttributeValues"]
    assert "ModuleNotFoundError" in values.values()
    assert "AccessDeniedException" in values.values()


def test_sync_success_atomic_transact_write_without_legacy():
    h = load("runtime/network_runtime.py")
    nid = "11111111-2222-3333-4444-555555555555"
    m_record = {
        "nova_id": nid,
        "guest_private_ip": "192.168.100.50",
        "gateway_private_ip": "10.20.1.50",
        "elastic_ip": "15.134.59.100"
    }
    event = {
        "instance_id": "i-atomic-test",
        "instance_name": "vm-atomic",
        "nova_id": nid,
        "size_gb": 10,
        "volume_extension": {"status": "CONFIRMED", "actual_size_gb": 10},
        "username": "tuanl",
        "cinder_volume_id": "cvol-123",
        "cinder_volume_key": "cvol-key-123",
        "storage_backend": "aws-ebs",
        "cinder_volume_type": "aws-ebs-gp3",
        "ebs_volume_id": "vol-0123456789abcdef0",
        "reservation_id": "res-123",
        "execution_arn": "arn:aws:states:ap-southeast-2:291634989063:execution:LaunchInstance:test-exec"
    }

    def mock_get(table, key_name, key_val):
        if table == "XRegion-Instances":
            return {"instance_id": "i-atomic-test", "nova_ids": ["old-nova-999"]}
        return None

    with mock.patch.object(h, "mapping", return_value=m_record), \
         mock.patch.object(h, "get", side_effect=mock_get):
        result = h.sync(event)

    assert result["status"] == "SUCCESS"
    assert result["server_id"] == nid
    assert result["network_mode"] == "linux_nat_v1"

    # Verify atomic transact_write_items was called
    tx_client = h.SESSION.client.return_value
    assert tx_client.transact_write_items.call_count == 1
    tx_items = tx_client.transact_write_items.call_args.kwargs["TransactItems"]
    assert len(tx_items) == 5

    # 1. Put XRegion-Nova
    nova_put = next(it["Put"] for it in tx_items if it.get("Put", {}).get("TableName") == "XRegion-Nova")
    assert nova_put["Item"]["nova_id"]["S"] == nid
    assert nova_put["Item"]["status"]["S"] == "ACTIVE"
    assert nova_put["Item"]["network_mode"]["S"] == "linux_nat_v1"

    # 2. Update XRegion-Volumes
    vol_up = next(it["Update"] for it in tx_items if it.get("Update", {}).get("TableName") == "XRegion-Volumes")
    assert vol_up["Key"]["volume_id"]["S"] == "cvol-key-123"
    assert vol_up["ExpressionAttributeValues"][":in_use"]["S"] == "IN_USE"

    # 3. Put XRegion-SecurityGroups
    sg_put = next(it["Put"] for it in tx_items if it.get("Put", {}).get("TableName") == "XRegion-SecurityGroups")
    assert sg_put["Item"]["group_id"]["S"] == nid
    assert sg_put["Item"]["owner"]["S"] == "tuanl"
    assert sg_put["Item"]["sync_status"]["S"] == "PENDING_SYNC"
    assert sg_put["Item"]["revision"]["N"] == "1"

    # 4. Update XRegion-Instances
    inst_up = next(it["Update"] for it in tx_items if it.get("Update", {}).get("TableName") == "XRegion-Instances")
    assert inst_up["Key"]["instance_id"]["S"] == "i-atomic-test"
    assert inst_up["ExpressionAttributeValues"][":st"]["S"] == "RUNNING"
    assert inst_up["ExpressionAttributeValues"][":size"]["N"] == "10"
    nids = [x["S"] for x in inst_up["ExpressionAttributeValues"][":nids"]["L"]]
    assert "old-nova-999" in nids and nid in nids

    # 5. Update XRegion-NetworkMappings
    map_up = next(it["Update"] for it in tx_items if it.get("Update", {}).get("TableName") == "XRegion-NetworkMappings")
    assert map_up["Key"]["nova_id"]["S"] == nid
    assert map_up["ExpressionAttributeValues"][":act"]["S"] == "ACTIVE"


def test_sync_success_rejects_missing_owner():
    h = load("runtime/network_runtime.py")
    m_record = {"nova_id": "11111111-2222-3333-4444-555555555555", "guest_private_ip": "10.0.0.1"}
    event = {
        "instance_id": "i-test",
        "nova_id": "11111111-2222-3333-4444-555555555555",
        "size_gb": 10,
        "volume_extension": {"status": "CONFIRMED", "actual_size_gb": 10}
        # Missing username & owner
    }
    with mock.patch.object(h, "mapping", return_value=m_record):
        with pytest.raises(ValueError, match="Missing username/owner"):
            h.sync(event)


def test_sync_failure_handles_missing_nova_id_safely():
    h = load("runtime/network_runtime.py")
    event = {
        "instance_id": "i-early-fail",
        "error": {"Error": "PoolNotReady"}
        # No nova_id
    }
    result = h.sync(event)
    assert result["error"]["Error"] == "PoolNotReady"
    values = h.DDB.Table.return_value.update_item.call_args.kwargs["ExpressionAttributeValues"]
    assert "FAILED" in values.values()
    assert "PoolNotReady" in values.values()

