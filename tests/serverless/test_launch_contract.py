import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from unittest import TestCase, mock

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"
VID = "80dbbd15-f606-4f06-8ca0-a24011355b4e"
PROJECT = "d3bf0533-1973-4818-9138-5d066d3eba3e"


class LaunchContractTests(TestCase):
    def setUp(self):
        self.runtime = mock.MagicMock()
        self.runtime.os.environ = {"OS_PROJECT_ID": PROJECT}
        spec = importlib.util.spec_from_file_location("extend_test", ROOT / "XRegion-LaunchInstance-ExtendVolume/extend_volume.py")
        self.h = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"network_runtime": self.runtime}):
            spec.loader.exec_module(self.h)
        self.event = dict(cinder_volume_id=VID, cinder_volume_key="key", instance_id="i-one",
                          reservation_id="exec", image_id="image", size_gb=12, original_size_gb=999)
        self.record = dict(cinder_volume_id=VID, lease_instance_id="i-one", status="ALLOCATED", image_id="image")
        self.runtime.get.side_effect = lambda table, *args: {"launch_execution_arn": "exec"} if table == "XRegion-Instances" else self.record
        self.runtime.lease.return_value = dict(cinder_volume_key="key", cinder_volume_id=VID)
        self.volume = dict(id=VID, size=10, status="available", bootable="true", attachments=[], volume_image_metadata={"image_id": "image"})
        self.runtime.os_api.return_value = {"volume": self.volume}

    def call(self):
        return self.h.lambda_handler(self.event, None)

    def test_post_is_pending_and_uses_size_gb_not_original(self):
        result = self.call()
        self.assertEqual(result["volume_extension"]["status"], "PENDING")
        self.assertEqual(self.runtime.os_api.call_args.args[-1], {"os-extend": {"new_size": 12}})
        updates = self.runtime.DDB.Table.return_value.update_item.call_args_list
        self.assertTrue(any("extend_post_attempted" in c.kwargs["UpdateExpression"] for c in updates))

    def test_confirmed_size_requires_get_and_persists_actual(self):
        self.volume["size"] = 12
        result = self.call()
        self.assertEqual(result["volume_extension"]["status"], "CONFIRMED")
        self.assertEqual(result["instance_id"], "i-one")
        self.assertEqual(self.runtime.os_api.call_count, 1)
        kw = self.runtime.DDB.Table.return_value.update_item.call_args.kwargs
        self.assertEqual(kw["ExpressionAttributeValues"][":u0"], 12)
        self.assertIn("ConditionExpression", kw)

    def test_ambiguous_post_retry_only_polls(self):
        self.record.update(extend_reservation_id="exec", extend_target_gb=12, extend_deadline_at=int(time.time())+50, extend_post_attempted=True)
        self.assertEqual(self.call()["volume_extension"]["status"], "PENDING")
        self.assertEqual(self.runtime.os_api.call_count, 1)

    def test_extending_preserves_deadline(self):
        self.record.update(extend_reservation_id="exec", extend_target_gb=12, extend_deadline_at=int(time.time())+50)
        self.volume["status"] = "extending"
        self.assertEqual(self.call()["volume_extension"]["deadline_at"], self.record["extend_deadline_at"])
        self.assertEqual(self.runtime.os_api.call_count, 1)

    def test_error_extending_is_failure(self):
        self.volume["status"] = "error_extending"
        with self.assertRaisesRegex(RuntimeError, "error_extending"): self.call()

    def test_expired_deadline_never_calls_cinder(self):
        self.record.update(extend_reservation_id="exec", extend_target_gb=12, extend_deadline_at=1)
        with self.assertRaises(TimeoutError): self.call()
        self.runtime.os_api.assert_not_called()

    def test_changed_owner_rejected_before_api(self):
        self.record["lease_instance_id"] = "other"
        with self.assertRaises(ValueError): self.call()
        self.runtime.os_api.assert_not_called()

    def test_wrong_uuid_rejected_before_api(self):
        self.record["cinder_volume_id"] = "other"
        with self.assertRaises(ValueError): self.call()
        self.runtime.os_api.assert_not_called()

    def test_attachment_rejected(self):
        self.volume["attachments"] = [{"server_id": "other"}]
        with self.assertRaises(ValueError): self.call()

    def test_transport_error_propagates(self):
        self.runtime.os_api.side_effect = TimeoutError("transport")
        with self.assertRaises(TimeoutError): self.call()

    def test_database_error_propagates(self):
        self.volume["size"] = 12
        self.runtime.DDB.Table.return_value.update_item.side_effect = [{}, RuntimeError("ddb")]
        with self.assertRaisesRegex(RuntimeError, "ddb"): self.call()
        self.runtime.os_api.assert_called_once()

    def test_post_timeout_does_not_become_success(self):
        self.runtime.os_api.side_effect = [{"volume": self.volume}, TimeoutError("uncertain POST")]
        with self.assertRaisesRegex(TimeoutError, "uncertain POST"): self.call()
        self.assertEqual(self.runtime.os_api.call_count, 2)

    def test_sdk_conditions_do_not_overwrite_update_values(self):
        self.call()
        for call in self.runtime.DDB.Table.return_value.update_item.call_args_list:
            builder = self.h.Attr.eq.__globals__["ConditionExpressionBuilder"]()
            values = builder.build_expression(call.kwargs["ConditionExpression"]).attribute_value_placeholders
            self.assertFalse(set(values) & set(call.kwargs["ExpressionAttributeValues"]))

    def test_conflicting_target_is_rejected(self):
        self.record.update(extend_reservation_id="exec", extend_target_gb=13)
        with self.assertRaises(ValueError): self.call()

    def test_workflow_waits_before_boot_and_keeps_context(self):
        states = json.loads((ROOT / "LaunchInstance.asl.json").read_text())["States"]
        self.assertEqual(states["ExtendVolume"]["Parameters"]["Payload.$"], "$")
        self.assertEqual(states["ExtendVolume"]["Next"], "VolumeExtensionStatus")
        self.assertEqual(states["WaitVolumeExtension"]["Seconds"], 5)
        self.assertEqual(states["VolumeExtensionStatus"]["Choices"][0]["StringEquals"], "CONFIRMED")
