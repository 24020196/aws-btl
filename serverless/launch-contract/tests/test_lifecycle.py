import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest import TestCase, mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NID = "11111111-1111-4111-8111-111111111111"
VID = "22222222-2222-4222-8222-222222222222"


def load(path):
    spec = importlib.util.spec_from_file_location("lifecycle_test_" + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    with mock.patch("boto3.Session"):
        spec.loader.exec_module(module)
    return module


def condition_matches(condition, item):
    expression = condition.get_expression()
    op, values = expression["operator"], expression["values"]
    if op == "AND": return all(condition_matches(v, item) for v in values)
    if op == "OR": return any(condition_matches(v, item) for v in values)
    if op == "attribute_exists": return values[0].name in item
    if op == "attribute_not_exists": return values[0].name not in item
    if op == "=": return item.get(values[0].name) == values[1]
    raise AssertionError(op)


class ReleaseTests(TestCase):
    def setUp(self):
        self.h = load(ROOT / "runtime/network_runtime.py")
        self.m = dict(nova_id=NID, reservation_id="launch", allocation_id="eipalloc-test",
            guest_private_ip="192.168.100.10", gateway_private_ip="10.20.1.10", neutron_port_id="port",
            status="DELETING", generation=4, applied_generation=4, applied_status="DELETING")
        self.claims = {"EIP#eipalloc-test": {"reservation_id": "launch"},
            "PRIVATEIP#" + self.h.ENI + "#10.20.1.10": {"reservation_id": "launch"},
            "LEASE#launch": {"reservation_id": "launch"}}
        self.tags = {"ReservationId": "launch", "NovaId": NID, "ClaimedBy": NID, "ClaimedAt": "123", "Project": "xregion"}
        self.associated, self.port, self.ip = True, True, True
        self.failure = None
        self.event = dict(nova_id=NID, instance_id="i-test", reservation_id="launch", generation=4,
            release_operation="FINALIZE", cinder_volume_key="cinder-key", cinder_volume_id=VID)
        self.h.mapping = lambda _: copy.deepcopy(self.m)
        self.h.get = lambda table, key, value: copy.deepcopy(self.claims.get(value))
        self.h.os_api = self.os_api
        self.h.DDB.Table.return_value.update_item.side_effect = self.checkpoint
        self.h.EC2.describe_addresses.side_effect = self.address
        self.h.EC2.describe_network_interfaces.side_effect = lambda **_: {"NetworkInterfaces": [{"PrivateIpAddresses":
            [{"PrivateIpAddress": "10.20.1.253", "Primary": True}] +
            ([{"PrivateIpAddress": "10.20.1.10", "Primary": False}] if self.ip else [])}]}
        self.h.EC2.disassociate_address.side_effect = self.disassociate
        self.h.EC2.unassign_private_ip_addresses.side_effect = self.unassign
        self.h.EC2.delete_tags.side_effect = self.delete_tags
        self.h.SESSION.client.return_value.transact_write_items.side_effect = self.commit
        mock.patch.object(self.h.time, "sleep").start()
        self.addCleanup(mock.patch.stopall)

    def fail_after(self, point):
        if self.failure == point:
            self.failure = None
            raise RuntimeError("injected " + point)

    def address(self, **_):
        address = {"Tags": [{"Key": k, "Value": v} for k, v in self.tags.items()]}
        if self.associated:
            address.update(AssociationId="assoc", NetworkInterfaceId=self.h.ENI, PrivateIpAddress="10.20.1.10")
        return {"Addresses": [address]}

    def checkpoint(self, **kw):
        self.assertTrue(condition_matches(kw["ConditionExpression"], self.m))
        for index, field in enumerate(kw["ExpressionAttributeNames"].values()):
            self.m[field] = copy.deepcopy(kw["ExpressionAttributeValues"][":u" + str(index)])
        self.fail_after("checkpoint_" + self.m["cleanup_phase"])

    def disassociate(self, **_):
        self.associated = False
        self.fail_after("disassociate")

    def unassign(self, **_):
        self.ip = False
        self.fail_after("unassign")

    def delete_tags(self, **kw):
        self.assertEqual(self.m["cleanup_phase"], "TAGS_REMOVING")
        self.assertEqual(len(self.claims), 3)
        for tag in kw["Tags"]:
            self.assertIn("Value", tag)
            if self.tags.get(tag["Key"]) == tag["Value"]:
                del self.tags[tag["Key"]]
        self.fail_after("delete_tags")

    def os_api(self, service, path, method="GET", **_):
        if service == "NOVA": return None
        if method == "DELETE":
            self.port = False
            self.fail_after("delete_port")
            return {}
        return {"port": {"device_id": ""}} if self.port else None

    def commit(self, **kw):
        self.fail_after("before_commit")
        update = kw["TransactItems"][0]["Update"]
        self.assertIn("cleanup_generation=:g", update["ConditionExpression"])
        self.assertEqual(self.m["cleanup_phase"], "TAGS_REMOVED")
        self.assertEqual(len(self.claims), 3)
        self.m["status"] = "DELETED"
        self.claims.clear()
        self.fail_after("after_commit")

    def test_retry_after_every_external_effect_and_checkpoint(self):
        points = ["disassociate", "delete_port", "unassign", "delete_tags", "before_commit", "after_commit"]
        points += ["checkpoint_" + phase for phase in self.h.CLEANUP_PHASES]
        for point in points:
            with self.subTest(point=point):
                self.setUp()
                self.failure = point
                with self.assertRaisesRegex(RuntimeError, "injected"):
                    self.h.release(self.event)
                if self.m["status"] != "DELETED": self.assertEqual(len(self.claims), 3)
                result = self.h.release(self.event)
                self.assertEqual(self.m["status"], "DELETED")
                self.assertFalse(self.claims)
                self.assertEqual(self.tags, {"Project": "xregion"})
                self.assertEqual(result["cleanup_volume"]["cinder_volume_id"], VID)

    def test_missing_tags_without_checkpoint_is_not_ownership(self):
        self.tags = {"Project": "xregion"}
        with self.assertRaisesRegex(ValueError, "ownership change"):
            self.h.release(self.event)
        self.h.EC2.disassociate_address.assert_not_called()

    def test_owner_change_after_partial_cleanup_refuses_retry(self):
        self.failure = "delete_tags"
        with self.assertRaises(RuntimeError): self.h.release(self.event)
        self.tags["NovaId"] = "other"
        with self.assertRaisesRegex(ValueError, "ownership change"): self.h.release(self.event)
        self.assertEqual(len(self.claims), 3)

    def test_stale_generation_and_claim_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Stale"):
            self.h.release(dict(self.event, generation=3))
        self.claims["EIP#eipalloc-test"]["reservation_id"] = "other"
        with self.assertRaisesRegex(ValueError, "reservation ownership"):
            self.h.release(self.event)
        self.h.EC2.disassociate_address.assert_not_called()

    def test_committed_retry_never_touches_reallocated_eip(self):
        self.h.release(self.event)
        self.tags = {"NovaId": "new-owner"}
        count = self.h.EC2.describe_addresses.call_count
        self.h.release(self.event)
        self.assertEqual(self.h.EC2.describe_addresses.call_count, count)
        self.assertEqual(self.tags["NovaId"], "new-owner")

    def test_attached_port_is_never_deleted(self):
        self.h.os_api = mock.Mock(side_effect=[None, {"port": {"device_id": "other-server"}}])
        with self.assertRaisesRegex(RuntimeError, "Port still attached"):
            self.h.release(self.event)
        self.assertEqual([call.args[2] if len(call.args) > 2 else "GET" for call in self.h.os_api.call_args_list], ["GET", "GET"])
        self.h.EC2.unassign_private_ip_addresses.assert_not_called()
        self.assertEqual(len(self.claims), 3)


class DeleteVolumeTests(TestCase):
    def setUp(self):
        self.h = load(ROOT / "XRegion-TerminateInstance-DeleteVolume/delete_volume.py")
        self.record = dict(volume_id="cinder-key", cinder_volume_id=VID, volume_type="cinder",
            status="IN_USE", attached_instance_id="i-test", lease_instance_id="i-test")
        self.main = dict(active_nova_id=NID)
        self.nova = dict(instance_id="i-test", volume_id=VID)
        self.event = dict(instance_id="i-test", nova_id=NID, cinder_volume_key="cinder-key", cinder_volume_id=VID)
        self.h.get = self.get
        self.h.DDB.Table.return_value.update_item.side_effect = self.update
        self.clock = mock.patch.object(self.h.time, "time", return_value=1000).start()
        self.addCleanup(mock.patch.stopall)

    def get(self, table, key, value):
        return copy.deepcopy({"XRegion-Instances": self.main, "XRegion-Nova": self.nova,
                              "XRegion-Volumes": self.record}.get(table))

    def update(self, **kw):
        self.assertEqual(kw["Key"], {"volume_id": "cinder-key"})
        self.assertTrue(condition_matches(kw["ConditionExpression"], self.record))
        self.record["status"] = "DELETED"

    def test_accepted_is_pending_until_authenticated_get_not_found(self):
        self.h.cinder_request = mock.Mock(side_effect=[{"volume": {"status": "available", "attachments": []}}, {},
                                                      {"volume": {"status": "deleting"}}])
        first = self.h.lambda_handler(self.event, None)
        self.assertEqual(first["volume_cleanup"]["status"], "PENDING")
        self.assertEqual(self.record["status"], "IN_USE")
        self.assertTrue(all(c.args[0] == VID for c in self.h.cinder_request.call_args_list))
        self.h.cinder_request = mock.Mock(return_value=None)
        second = self.h.lambda_handler(first, None)
        self.assertEqual(second["volume_cleanup"]["status"], "DELETED")
        self.assertEqual(second["volume_cleanup"]["deadline_at"], 1300)
        self.assertEqual(second["nova_id"], NID)
        self.assertEqual(self.record["status"], "DELETED")

    def test_http_transport_attachment_and_error_deleting_never_mark_deleted(self):
        cases = [RuntimeError("HTTP 403"), TimeoutError("transport"),
                 {"volume": {"attachments": [{"server_id": "other"}], "status": "in-use"}},
                 {"volume": {"attachments": [], "status": "error_deleting"}}]
        for case in cases:
            with self.subTest(case=case):
                self.h.cinder_request = mock.Mock(side_effect=case if isinstance(case, Exception) else None,
                                                  return_value=case if isinstance(case, dict) else None)
                with self.assertRaises((RuntimeError, ValueError, TimeoutError)):
                    self.h.lambda_handler(self.event, None)
                self.h.DDB.Table.return_value.update_item.assert_not_called()

    def test_deadline_is_not_reset_and_no_success_after_timeout(self):
        with self.assertRaisesRegex(TimeoutError, "deadline"):
            self.h.lambda_handler(dict(self.event, volume_cleanup={"deadline_at": 999}), None)
        self.h.DDB.Table.assert_not_called()

    def test_wrong_owner_uuid_or_nova_prevents_storage_calls(self):
        for field, value in [("attached_instance_id", "other"), ("cinder_volume_id", NID)]:
            with self.subTest(field=field), mock.patch.dict(self.record, {field: value}):
                self.h.cinder_request = mock.Mock()
                with self.assertRaises(ValueError): self.h.lambda_handler(self.event, None)
                self.h.cinder_request.assert_not_called()
        self.main["active_nova_id"] = "other"
        with self.assertRaises(ValueError): self.h.lambda_handler(self.event, None)

    def test_dynamodb_failure_propagates_and_is_retryable_after_physical_delete(self):
        self.h.cinder_request = mock.Mock(return_value=None)
        self.h.DDB.Table.return_value.update_item.side_effect = RuntimeError("ddb unavailable")
        with self.assertRaisesRegex(RuntimeError, "ddb unavailable"):
            self.h.lambda_handler(self.event, None)
        self.assertEqual(self.record["status"], "IN_USE")
        self.h.DDB.Table.return_value.update_item.side_effect = self.update
        self.assertEqual(self.h.lambda_handler(self.event, None)["volume_cleanup"]["status"], "DELETED")

    def test_ebs_never_forces_detach_and_rejects_other_attachment(self):
        resource = dict(id="vol-0123")
        self.h.EC2.describe_volumes.return_value = {"Volumes": [{"Attachments": [
            {"InstanceId": "i-ec2", "Device": "/dev/sdf", "State": "attached"}]}]}
        with self.assertRaises(ValueError): self.h.delete_ebs(resource, {"ec2_instance_id": "other"})
        self.h.EC2.detach_volume.assert_not_called()
        self.assertFalse(self.h.delete_ebs(resource, {"ec2_instance_id": "i-ec2"}))
        self.assertIs(self.h.EC2.detach_volume.call_args.kwargs["Force"], False)

    def test_http_404_is_only_absence_after_keystone_authenticated(self):
        import urllib.error
        token = mock.MagicMock()
        token.__enter__.return_value = token
        token.headers = {"X-Subject-Token": "test-token"}
        token.read.return_value = b'{"token":{"project":{"id":"project"}}}'
        missing = urllib.error.HTTPError("https://cinder", 404, "missing", {}, None)
        env = dict(KEYSTONE_URL="https://keystone/v3", CINDER_URL="https://cinder/v3", OS_PASSWORD="test-only")
        with mock.patch.dict(self.h.os.environ, env), mock.patch.object(self.h.urllib.request, "urlopen", side_effect=[token, missing]) as request:
            self.assertIsNone(self.h.cinder_request(VID))
            self.assertTrue(request.call_args.args[0].full_url.endswith("/project/volumes/" + VID))
        self.h.TOKEN = None
        with mock.patch.dict(self.h.os.environ, env), mock.patch.object(self.h.urllib.request, "urlopen", side_effect=missing):
            with self.assertRaises(urllib.error.HTTPError): self.h.cinder_request(VID)


class ContractTests(TestCase):
    def test_pool_inventory_does_not_report_preexisting_guest_volumes_as_new(self):
        sys.path.insert(0, str(ROOT / "deployment"))
        import lifecycle
        text = '  volume-' + VID + ' Vwi-a-tz-- 10g\n' + '  volume-' + NID + ' Vwi-a-tz-- 13g\n{}\n[]'
        self.assertEqual(lifecycle.pool_volume_delta(text, [VID, NID, '33333333-3333-4333-8333-333333333333']),
                         ['33333333-3333-4333-8333-333333333333'])
        with self.assertRaisesRegex(RuntimeError, "Baseline"):
            lifecycle.pool_volume_delta('{}\n[]', [VID])

    def test_canary_launch_never_posts_twice_after_an_ambiguous_attempt(self):
        sys.path.insert(0, str(ROOT / "deployment"))
        import lifecycle
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "backend-launch-attempt.json").write_text('{}')
            with mock.patch.object(lifecycle, "backend") as backend:
                with self.assertRaisesRegex(RuntimeError, "already attempted"):
                    lifecycle.launch_canary(SimpleNamespace(directory=path))
                backend.assert_not_called()

    def test_terminate_recovery_cannot_replay_a_running_execution(self):
        sys.path.insert(0, str(ROOT / "deployment"))
        import lifecycle
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "canary.json").write_text(json.dumps({"instance_id": "i-test"}))
            (path / "canary-terminate-status.json").write_text(json.dumps({"executionArn": "arn:test"}))
            x = SimpleNamespace(directory=path, client=mock.Mock())
            x.client.return_value.describe_execution.return_value = {"status": "RUNNING", "input": '{"instance_id":"i-test"}'}
            with mock.patch.object(lifecycle, "no_running"), mock.patch.object(lifecycle, "backend") as backend:
                with self.assertRaisesRegex(RuntimeError, "terminal failure"):
                    lifecycle.resume_terminate(x)
                backend.assert_not_called()

    def test_confirmed_remove_success_is_reusable_after_its_old_deadline(self):
        h = load(ROOT / "runtime/network_runtime.py")
        h.SSM.get_command_invocation.return_value = {"Status": "Success"}
        event = dict(command_deadline=0, ssm_command_id="completed", network_operation="REMOVE")
        with mock.patch.object(h, "mapping", return_value={"generation": 3, "applied_generation": 3}):
            self.assertEqual(h.check_command(event)["command_status"], "SUCCEEDED")
        with mock.patch.object(h, "mapping", return_value={"generation": 4, "applied_generation": 3}):
            with self.assertRaisesRegex(RuntimeError, "generation"):
                h.check_command(event)

    def test_recovery_after_network_commit_does_not_reacquire_released_claims(self):
        h = load(ROOT / "runtime/network_runtime.py")
        m = dict(nova_id=NID, status="DELETED", reservation_id="launch", guest_private_ip="192.168.100.10",
                 cleanup_volume={"cinder_volume_key": "key", "cinder_volume_id": VID})
        with mock.patch.object(h, "get", side_effect=[m, None]):
            result = h.release(dict(nova_id=NID, instance_id="i-test"))
        self.assertTrue(result["network_cleanup_complete"])
        sys.path.insert(0, str(ROOT / "deployment"))
        from workflows import render
        choice = render("TerminateInstance")["States"]["ChooseNetworkMode"]["Choices"][0]
        self.assertEqual(choice["Next"], "DeleteSecurityGroup")

    def test_real_boto3_condition_serialization_cannot_overwrite_checkpoint_values(self):
        import boto3
        from botocore.stub import Stubber
        h = load(ROOT / "runtime/network_runtime.py")
        resource = boto3.resource("dynamodb", region_name="ap-southeast-2", aws_access_key_id="test", aws_secret_access_key="test")
        h.DDB = resource
        captured = []
        class CapturingStubber(Stubber):
            def _get_response_handler(self, model, params, context, **kwargs):
                captured.append(json.loads(params["body"]))
                return super()._get_response_handler(model, params, context, **kwargs)
        m = dict(nova_id=NID, generation=3, reservation_id="launch")
        with CapturingStubber(resource.meta.client) as stub:
            stub.add_response("update_item", {})
            h.cleanup_checkpoint(m, "STARTED", {"cleanup_volume": {"cinder_volume_id": VID}})
        sent = captured[0]
        self.assertEqual(sent["ExpressionAttributeValues"][":u0"], {"S": "STARTED"})
        self.assertEqual(sent["ExpressionAttributeValues"][":u1"], {"N": "3"})
        self.assertEqual(sent["ExpressionAttributeValues"][":u3"], {"M": {"cinder_volume_id": {"S": VID}}})
        self.assertEqual(sent["ExpressionAttributeValues"][":v0"], {"N": "3"})

    def test_remove_dispatch_carries_the_new_generation_to_finalize(self):
        h = load(ROOT / "runtime/network_runtime.py")
        before = dict(nova_id=NID, allocation_id="eip", reservation_id="launch", status="ACTIVE", generation=2)
        after = dict(before, status="DELETING", generation=3)
        h.SSM.send_command.return_value = {"Command": {"CommandId": "command"}}
        with mock.patch.object(h, "mapping", side_effect=[before, after]), \
             mock.patch.object(h, "get", return_value={"reservation_id": "launch"}), mock.patch.object(h, "update"):
            result = h.dispatch(dict(nova_id=NID, network_operation="REMOVE", generation=2))
        self.assertEqual(result["generation"], 3)

    def test_probe_is_read_only_and_checks_metadata(self):
        h = load(ROOT / "runtime/network_runtime.py")
        event = dict(diagnostic_only=True, cinder_volume_id=VID, cinder_volume_key="key", image_id="image")
        with mock.patch.object(h, "checked_volume", return_value={"status": "available"}), \
             mock.patch.object(h, "get", return_value={"cinder_volume_id": VID, "image_id": "image"}):
            self.assertEqual(h.allocate(event)["status"], "PREFLIGHT_OK")
        h.DDB.Table.assert_not_called()
        h.SESSION.client.return_value.transact_write_items.assert_not_called()
        h.EC2.create_tags.assert_not_called()
        h.EC2.associate_address.assert_not_called()

    def test_sync_requires_volume_receipt_and_does_not_overwrite_new_nova(self):
        h = load(ROOT / "runtime/network_runtime.py")
        with self.assertRaisesRegex(RuntimeError, "Volume cleanup"):
            h.term_sync(dict(instance_id="i-test", network_mode="linux_nat_v1"))
        h.SESSION.client.return_value.transact_write_items.assert_not_called()
        receipt = dict(status="DELETED", resources=[dict(key="key", id=VID, kind="cinder")])
        def read(table, key, value):
            if table == "XRegion-Volumes": return dict(status="DELETED", lease_instance_id="i-test", cinder_volume_id=VID)
            return {}
        with mock.patch.object(h, "get", side_effect=read), mock.patch.object(h, "mapping", return_value=dict(status="DELETED", reservation_id="launch")):
            h.term_sync(dict(instance_id="i-test", nova_id=NID, network_mode="linux_nat_v1", volume_cleanup=receipt))
        tx = h.SESSION.client.return_value.transact_write_items.call_args.kwargs["TransactItems"]
        self.assertIn("active_nova_id=:n", tx[0]["Update"]["ConditionExpression"])
        self.assertIn("launch_execution_arn=:r", tx[0]["Update"]["ConditionExpression"])

    def test_ambiguous_or_wrong_security_group_is_not_deleted(self):
        h = load(ROOT / "runtime/network_runtime.py")
        for groups in [[{"id": "a"}, {"id": "b"}], [{"id": "wrong"}]]:
            with mock.patch.object(h, "os_api", return_value={"security_groups": groups}) as api:
                with self.assertRaises(ValueError):
                    h.delete_group(dict(network_mode="linux_nat_v1", nova_id=NID, neutron_sg_id="expected"))
                self.assertEqual(api.call_count, 1)

    def test_workflow_polls_both_paths_and_only_deleted_can_sync(self):
        sys.path.insert(0, str(ROOT / "deployment"))
        from workflows import render
        states = render("TerminateInstance")["States"]
        for prefix in ("", "Legacy"):
            task = "DeleteVolume" if not prefix else "LegacyDeleteVolume"
            choice = "VolumeDeletionStatus" if not prefix else "LegacyVolumeDeletionStatus"
            wait = "WaitVolumeDeletion" if not prefix else "WaitLegacyVolumeDeletion"
            self.assertEqual(states[task]["Next"], choice)
            self.assertEqual(states[task]["OutputPath"], "$.Payload")
            self.assertEqual(states[choice]["Choices"][0]["StringEquals"], "DELETED")
            self.assertEqual(states[choice]["Default"], wait)
            self.assertEqual(states[wait]["Seconds"], 5)
            self.assertEqual(states[wait]["Next"], task)

    def test_packaging_preserves_legacy_instead_of_wrapping_dispatcher(self):
        sys.path.insert(0, str(ROOT / "deployment"))
        import deploy
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            name = deploy.MANIFEST["functions"]["DeleteSecurityGroup"]
            with zipfile.ZipFile(path / (name + "-before.zip"), "w") as archive:
                archive.writestr("network_runtime.py", "dispatcher = True")
                archive.writestr("legacy.py", "legacy = True")
            (path / (name + "-before.json")).write_text(json.dumps({"Handler": "network_runtime.lambda_handler"}))
            with zipfile.ZipFile(io.BytesIO(deploy.package(SimpleNamespace(directory=path), "DeleteSecurityGroup"))) as archive:
                self.assertEqual(archive.read("legacy.py"), b"legacy = True")
            with zipfile.ZipFile(io.BytesIO(deploy.package(SimpleNamespace(directory=path), "DeleteVolume"))) as archive:
                self.assertEqual(archive.namelist(), ["delete_volume.py"])
