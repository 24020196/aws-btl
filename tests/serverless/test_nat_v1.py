import importlib.util
import json
from decimal import Decimal
from pathlib import Path
import sys
import types
from unittest import TestCase, mock

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"


def runtime():
    spec = importlib.util.spec_from_file_location("nat_runtime_test", ROOT / "runtime/network_runtime.py")
    module = importlib.util.module_from_spec(spec)
    with mock.patch("boto3.Session"):
        spec.loader.exec_module(module)
    return module


class NatRuntimeTests(TestCase):
    def setUp(self):
        self.h = runtime()
        self.nid = "efdca890-184e-435a-96b3-fe64bcd1d568"

    def test_mapping_commit_has_no_instance_id(self):
        lease = dict(resource_key="LEASE#exec", reservation_id="exec", guest_private_ip="192.168.100.10",
                     gateway_private_ip="10.20.1.10", elastic_ip="1.2.3.4", allocation_id="eip-1",
                     neutron_port_id="port", network_id="net", subnet_id="sub")
        with mock.patch.object(self.h, "lease", return_value=lease), mock.patch.object(self.h, "get", return_value=None):
            self.h.commit(dict(nova_id=self.nid, instance_id="must-not-store"))
        tx = self.h.SESSION.client.return_value.transact_write_items.call_args.kwargs["TransactItems"]
        record = tx[0]["Put"]["Item"]
        self.assertEqual(record["nova_id"], {"S": self.nid})
        self.assertNotIn("instance_id", record)
        self.assertNotIn("instance_id", json.dumps(tx))

    def test_commit_retry_does_not_create_second_mapping(self):
        lease = dict(reservation_id="exec", allocation_id="eip-1", guest_private_ip="192.168.100.10",
                     gateway_private_ip="10.20.1.10", elastic_ip="1.2.3.4", neutron_port_id="p",
                     network_id="n", subnet_id="s")
        with mock.patch.object(self.h, "lease", return_value=lease), \
             mock.patch.object(self.h, "get", return_value=dict(reservation_id="exec", nova_id=self.nid)):
            self.h.commit(dict(nova_id=self.nid))
        self.h.SESSION.client.return_value.transact_write_items.assert_not_called()

    def test_boot_unknown_create_result_never_creates_again(self):
        with mock.patch.object(self.h, "lease", return_value=dict(reservation_id="exec", boot_attempted=True)), \
             mock.patch.object(self.h, "os_api", return_value={"servers": []}) as api:
            with self.assertRaisesRegex(RuntimeError, "Ambiguous Nova create"):
                self.h.boot({})
        self.assertEqual(api.call_count, 1)

    def test_maintenance_rejects_before_any_allocation(self):
        with mock.patch.dict("os.environ", {"NETWORK_ADMISSION": "maintenance"}):
            with self.assertRaisesRegex(RuntimeError, "temporarily unavailable"):
                self.h.check_pool(dict(execution_arn="ordinary-execution"))
        self.h.DDB.Table.assert_not_called()

    def test_invalid_size_is_rejected_before_claims(self):
        with mock.patch.object(self.h, "admission"):
            for size in (True, 0, -1, "12"):
                with self.subTest(size=size), self.assertRaises(ValueError):
                    self.h.check_pool(dict(execution_arn="exec", username="test", image_id=self.nid, size_gb=size))
        self.h.DDB.Table.assert_not_called()

    def test_scoped_backend_test_admission_does_not_open_other_names(self):
        self.h.SSM.get_parameter.return_value = {"Parameter": {"Value": json.dumps({"mode":"maintenance", "canary":{"name":"ping-test-one", "username":"test"}})}}
        with mock.patch.dict("os.environ", {"LAUNCH_ADMISSION_PARAMETER":"/test"}):
            with self.assertRaises(self.h.LaunchMaintenance):
                self.h.admission(dict(instance_name="other", username="test"))
            with mock.patch.object(self.h, "get", return_value={"requested_name":"ping-test-one", "user_id":"usr-test"}):
                self.h.admission(dict(instance_id="i-test", instance_name="ping-test-one", username="test"))

    def test_new_boot_supplies_config_drive_and_reserved_port(self):
        r = dict(resource_key="LEASE#exec", reservation_id="exec", neutron_port_id="p",
                 cinder_volume_id="v", guest_private_ip="192.168.100.10")
        def api(service, path, method="GET", body=None):
            if path == "/servers/detail": return {"servers": []}
            if path == "/flavors/detail": return {"flavors": [{"id": "tiny", "name": "m1.tiny"}]}
            if path == "/servers":
                self.assertIs(body["server"]["config_drive"], True)
                self.assertEqual(body["server"]["networks"], [{"port": "p"}])
                return {"server": {"id": self.nid}}
            if path.startswith("/servers/"): return {"server": {"status": "ACTIVE"}}
            return {"port": {"device_id": self.nid}}
        with mock.patch.object(self.h, "lease", return_value=r), \
             mock.patch.object(self.h, "checked_volume", return_value={"size": 12}), \
             mock.patch.object(self.h, "update"), mock.patch.object(self.h, "os_api", side_effect=api):
            result = self.h.boot(dict(instance_name="test", key_id="key", flavor="m1.tiny", image_id="img", size_gb=12, volume_extension={"status":"CONFIRMED", "cinder_volume_id":"v"}))
        self.assertEqual(result["nova_id"], self.nid)

    def test_wrong_image_is_never_allocated(self):
        with mock.patch.object(self.h, "lease", return_value=None), \
             mock.patch.object(self.h, "scan", return_value=[{"image_id": "other", "volume_id": "v"}]), \
             mock.patch.object(self.h, "checked_volume") as validate:
            self.h.EC2.describe_addresses.return_value = {"Addresses": []}
            with self.assertRaisesRegex(RuntimeError, "No unclaimed"):
                self.h.os_api = mock.MagicMock(side_effect=[{"flavors":[{"id":"tiny", "name":"tiny"}]}, {}])
                self.h.allocate(dict(reservation_id="exec", image_id="requested", flavor="tiny", key_id="key"))
        validate.assert_not_called()
        self.h.SESSION.client.return_value.transact_write_items.assert_not_called()

    def test_real_volume_must_be_available_bootable_and_match_image(self):
        for volume in [{"status": "error", "bootable": "true"},
                       {"status": "available", "bootable": "false"},
                       {"status": "available", "bootable": "true", "volume_image_metadata": {"image_id": "wrong"}}]:
            with self.subTest(volume=volume), mock.patch.object(self.h, "os_api", return_value={"volume": volume}):
                with self.assertRaises(self.h.StorageUnavailable): self.h.checked_volume("v", "requested")

    def test_failure_preserves_owner_and_sanitizes_message(self):
        with mock.patch.dict(sys.modules, {"legacy": mock.MagicMock()}):
            self.h.sync(dict(instance_id="i-test", error={"Error": "LaunchMaintenance", "Cause": "secret-token"}))
        kw = self.h.DDB.Table.return_value.update_item.call_args.kwargs
        self.assertIn("launch_execution_arn=:execution", kw["ConditionExpression"])
        self.assertNotIn("secret-token", json.dumps(kw))
        self.assertNotIn("user_id", kw["ExpressionAttributeNames"].values())
        self.assertIn("LaunchMaintenance", kw["ExpressionAttributeValues"].values())

    def test_wrong_claim_prevents_dispatch(self):
        with mock.patch.object(self.h, "mapping", return_value=dict(allocation_id="eip", reservation_id="owner")), \
             mock.patch.object(self.h, "get", return_value=dict(reservation_id="other")):
            with self.assertRaises(ValueError): self.h.dispatch({})
        self.h.SSM.send_command.assert_not_called()

    def test_remove_retry_reuses_command(self):
        m = dict(nova_id=self.nid, allocation_id="eip", reservation_id="owner", status="DELETING",
                 generation=3, command_generation=3, command_operation="REMOVE", ssm_command_id="command",
                 command_deadline=9999999999)
        with mock.patch.object(self.h, "mapping", return_value=m), \
             mock.patch.object(self.h, "get", return_value=dict(reservation_id="owner")):
            result = self.h.dispatch(dict(network_operation="REMOVE"))
        self.assertEqual(result["ssm_command_id"], "command")
        self.h.SSM.send_command.assert_not_called()

    def test_ambiguous_dispatch_is_not_reissued(self):
        m = dict(nova_id=self.nid, allocation_id="eip", reservation_id="owner", status="DELETING",
                 generation=3, command_generation=3, command_operation="REMOVE", ssm_command_id="")
        with mock.patch.object(self.h, "mapping", return_value=m), \
             mock.patch.object(self.h, "get", return_value=dict(reservation_id="owner")):
            with self.assertRaisesRegex(RuntimeError, "Ambiguous SSM"):
                self.h.dispatch(dict(network_operation="REMOVE"))
        self.h.SSM.send_command.assert_not_called()

    def test_deadline_is_failure_not_success(self):
        self.h.SSM.get_command_invocation.return_value = {"Status": "InProgress"}
        with self.assertRaises(TimeoutError): self.h.check_command(dict(command_deadline=0, ssm_command_id="command"))

    def test_release_requires_confirmed_removal(self):
        with mock.patch.object(self.h, "mapping", return_value=dict(status="DELETING", generation=4)):
            with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                self.h.release(dict(release_operation="FINALIZE"))
        self.h.EC2.disassociate_address.assert_not_called()

    def test_native_numbers_are_json_serializable(self):
        self.assertEqual(json.dumps(self.h.native(dict(generation=Decimal(2)))), '{"generation": 2}')


class RenderingTests(TestCase):
    def test_both_workflows_use_shared_bindings_and_no_missing_context_paths(self):
        sys.path.insert(0, str(ROOT / "deployment"))
        from workflows import render
        for name in ("LaunchInstance", "TerminateInstance"):
            definition = render(name, "123456789012", "test-region")
            self.assertNotIn("291634989063", json.dumps(definition))
            states = definition["States"]
            for state in states.values():
                if "Next" in state:
                    self.assertIn(state["Next"], states)
            self.assertNotIn("$.network_result", json.dumps(definition))

    def test_nft_separates_guest_and_gateway_addresses(self):
        spec = importlib.util.spec_from_file_location("gateway_test", ROOT / "gateway/gateway.py")
        module = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"fcntl": mock.MagicMock()}):
            spec.loader.exec_module(module)
        rules = module.render_nft([dict(status="ACTIVE", gateway_private_ip="10.20.1.10",
                                       guest_private_ip="192.168.100.10")])
        self.assertIn("10.20.1.10 : 192.168.100.10", rules)
        self.assertIn("192.168.100.10 : 10.20.1.10", rules)
        with self.assertRaises(ValueError):
            module.render_nft([dict(status="ACTIVE", gateway_private_ip="10.20.1.10; flush ruleset",
                                    guest_private_ip="192.168.100.10")])
