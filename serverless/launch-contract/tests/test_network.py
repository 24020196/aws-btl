import copy
import importlib.util
import json
from pathlib import Path
from unittest import TestCase, mock


ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / name / filename)
    module = importlib.util.module_from_spec(spec)
    with mock.patch("boto3.client"):
        spec.loader.exec_module(module)
    return module


class NetworkTests(TestCase):
    def setUp(self):
        self.h = load("XRegion-LaunchInstance-AssignSecurityGroup", "assign_security_group.py")
        self.ec2 = self.h.ec2_client
        self.event = dict(instance_id="i-1", server_id="nova-1", private_ip="10.20.1.226",
                          allocation_id="eipalloc-1", elastic_ip="16.178.34.111")
        self.eni = dict(NetworkInterfaceId=self.h.OPENSTACK_PUBLIC_ENI, SubnetId="subnet-1",
                        PrivateIpAddresses=[dict(PrivateIpAddress="10.20.1.253", Primary=True)])
        self.registered = copy.deepcopy(self.eni)
        self.registered["PrivateIpAddresses"].append(dict(PrivateIpAddress="10.20.1.226"))
        self.address = dict(PublicIp=self.event["elastic_ip"], Tags=[dict(Key="ClaimedBy", Value="i-1")])
        self.associated = dict(self.address, AssociationId="assoc-1",
                              NetworkInterfaceId=self.h.OPENSTACK_PUBLIC_ENI, PrivateIpAddress="10.20.1.226")
        self.ec2.describe_subnets.return_value = {"Subnets": [{"CidrBlock": "10.20.1.0/24"}]}
        self.ec2.describe_addresses.return_value = {"Addresses": [self.address]}
        self.ec2.describe_network_interfaces.side_effect = lambda **kw: {
            "NetworkInterfaces": [] if "Filters" in kw else [self.registered]}
        self.sleep = mock.patch.object(self.h.time, "sleep").start()
        self.addCleanup(mock.patch.stopall)

    def associations(self, values):
        self.ec2.describe_addresses.side_effect = [{"Addresses": [v]} for v in values]

    def test_registers_ip_before_association(self):
        calls = []
        def eni(**kw):
            if "Filters" in kw:
                return {"NetworkInterfaces": []}
            return {"NetworkInterfaces": [self.registered if calls else self.eni]}
        self.ec2.describe_network_interfaces.side_effect = eni
        self.ec2.assign_private_ip_addresses.side_effect = lambda **kw: calls.append("assign")
        self.ec2.associate_address.side_effect = lambda **kw: calls.append("associate")
        self.associations([self.address, self.address, self.associated])
        self.assertEqual(self.h.ensure_elastic_ip(self.event), "assoc-1")
        self.assertEqual(calls, ["assign", "associate"])
        self.assertFalse(self.ec2.assign_private_ip_addresses.call_args.kwargs["AllowReassignment"])
        self.assertFalse(self.ec2.associate_address.call_args.kwargs["AllowReassociation"])

    def test_registered_ip_not_assigned_again(self):
        self.associations([self.address, self.address, self.associated])
        self.h.ensure_elastic_ip(self.event)
        self.ec2.assign_private_ip_addresses.assert_not_called()

    def test_retry_after_complete_association_does_not_remap(self):
        self.ec2.describe_addresses.return_value = {"Addresses": [self.associated]}
        self.assertEqual(self.h.ensure_elastic_ip(self.event), "assoc-1")
        self.ec2.assign_private_ip_addresses.assert_not_called()
        self.ec2.associate_address.assert_not_called()

    def test_wrong_claim_rejected_before_mutation(self):
        self.address["Tags"] = [{"Key": "ClaimedBy", "Value": "other"}]
        with self.assertRaises(ValueError): self.h.ensure_elastic_ip(self.event)
        self.ec2.assign_private_ip_addresses.assert_not_called()
        self.ec2.associate_address.assert_not_called()

    def test_other_eni_owns_ip(self):
        self.ec2.describe_network_interfaces.side_effect = lambda **kw: {
            "NetworkInterfaces": [dict(NetworkInterfaceId="other")] if "Filters" in kw else [self.eni]}
        with self.assertRaises(ValueError): self.h.ensure_elastic_ip(self.event)
        self.ec2.assign_private_ip_addresses.assert_not_called()

    def test_wrong_association_rejected(self):
        self.associated["PrivateIpAddress"] = "10.20.1.9"
        self.ec2.describe_addresses.return_value = {"Addresses": [self.associated]}
        with self.assertRaises(ValueError): self.h.ensure_elastic_ip(self.event)
        self.ec2.associate_address.assert_not_called()

    def test_subnet_mismatch_rejected(self):
        self.event["private_ip"] = "10.30.1.2"
        with self.assertRaises(ValueError): self.h.ensure_elastic_ip(self.event)

    def test_target_private_ip_has_another_eip(self):
        self.registered["PrivateIpAddresses"][-1]["Association"] = {"PublicIp": "1.2.3.4"}
        with self.assertRaises(ValueError): self.h.ensure_elastic_ip(self.event)
        self.ec2.associate_address.assert_not_called()

    def test_missing_input_rejected(self):
        del self.event["instance_id"]
        with self.assertRaises(ValueError): self.h.lambda_handler(self.event, None)

    def test_assign_failure_propagates(self):
        self.ec2.describe_network_interfaces.side_effect = lambda **kw: {
            "NetworkInterfaces": [] if "Filters" in kw else [self.eni]}
        self.ec2.assign_private_ip_addresses.side_effect = RuntimeError("capacity")
        with self.assertRaisesRegex(RuntimeError, "capacity"): self.h.ensure_elastic_ip(self.event)
        self.ec2.associate_address.assert_not_called()

    def test_registration_timeout_prevents_association(self):
        self.ec2.describe_network_interfaces.side_effect = lambda **kw: {
            "NetworkInterfaces": [] if "Filters" in kw else [self.eni]}
        with self.assertRaises(TimeoutError): self.h.ensure_elastic_ip(self.event)
        self.ec2.associate_address.assert_not_called()

    def test_association_failure_propagates_and_retry_succeeds(self):
        self.ec2.associate_address.side_effect = RuntimeError("associate failed")
        with self.assertRaisesRegex(RuntimeError, "associate failed"): self.h.ensure_elastic_ip(self.event)
        self.ec2.associate_address.side_effect = None
        self.associations([self.address, self.address, self.associated])
        self.h.ensure_elastic_ip(self.event)
        self.ec2.assign_private_ip_addresses.assert_not_called()

    def test_association_timeout(self):
        with self.assertRaises(TimeoutError): self.h.ensure_elastic_ip(self.event)

    def test_nova_assignment_failure_propagates_before_eip(self):
        with mock.patch.object(self.h, "get_keystone_token", return_value=("token", "project")), \
             mock.patch.object(self.h, "get_or_create_1to1_security_group", return_value=("sg-1", "nova-1")), \
             mock.patch.object(self.h, "send_api_request", side_effect=[
                 (200, {"server": {"security_groups": []}}), RuntimeError("Nova error")]):
            with self.assertRaisesRegex(RuntimeError, "Nova error"):
                self.h.lambda_handler(self.event, None)
        self.ec2.associate_address.assert_not_called()

    def test_existing_nova_group_is_not_added_again(self):
        with mock.patch.object(self.h, "get_keystone_token", return_value=("token", "project")), \
             mock.patch.object(self.h, "get_or_create_1to1_security_group", return_value=("sg-1", "nova-1")), \
             mock.patch.object(self.h, "send_api_request", return_value=(200, {
                 "server": {"security_groups": [{"name": "nova-1"}]}})) as api, \
             mock.patch.object(self.h, "ensure_elastic_ip"):
            self.h.lambda_handler(self.event, None)
        self.assertTrue(all(c.kwargs.get("method", "GET") == "GET" for c in api.call_args_list))

    def test_existing_neutron_group_reconciles_missing_rules(self):
        with mock.patch.object(self.h, "send_api_request", side_effect=[
            (200, {"security_groups": [{"id": "sg-1"}]}),
            (200, {"security_group": {"security_group_rules": []}}), (201, {}),
            (200, {"security_group": {"security_group_rules": []}}), (201, {}),
        ]) as api:
            self.assertEqual(self.h.get_or_create_1to1_security_group("token", "nova-1"),
                             ("sg-1", "nova-1"))
        posts = [c for c in api.call_args_list if c.kwargs.get("method") == "POST"]
        self.assertEqual(len(posts), 2)

    def test_neutron_rule_error_propagates(self):
        with mock.patch.object(self.h, "send_api_request", side_effect=[
            (200, {"security_groups": [{"id": "sg-1"}]}),
            (200, {"security_group": {"security_group_rules": []}}), RuntimeError("rule failed"),
        ]):
            with self.assertRaisesRegex(RuntimeError, "rule failed"):
                self.h.get_or_create_1to1_security_group("token", "nova-1")


class FailureTests(TestCase):
    def test_failure_updates_existing_instance_without_ownership_fields(self):
        h = load("XRegion-LaunchInstance-SyncDynamoDB", "sync_dynamodb.py")
        result = h.lambda_handler(dict(mode="FAILURE", instance_id="i-1", server_id="nova-1",
                                      error={"Cause": "EIP failed"}), None)
        self.assertEqual(result["status"], "FAILED")
        update = h.dynamodb.update_item.call_args.kwargs
        self.assertEqual(update["ConditionExpression"], "attribute_exists(instance_id)")
        self.assertEqual(update["ExpressionAttributeValues"][":reason"], {"S": "EIP failed"})
        self.assertNotIn("username", update["UpdateExpression"])
        self.assertNotIn("user_id", update["UpdateExpression"])

    def test_failure_write_error_propagates(self):
        h = load("XRegion-LaunchInstance-SyncDynamoDB", "sync_dynamodb.py")
        h.dynamodb.update_item.side_effect = RuntimeError("write failed")
        with self.assertRaisesRegex(RuntimeError, "write failed"):
            h.lambda_handler(dict(mode="FAILURE", instance_id="i-1"), None)

    def test_workflow_failure_does_not_require_network_result(self):
        states = json.loads((ROOT / "LaunchInstance.asl.json").read_text())["States"]
        for name in ["AssignSecurityGroup", "SyncDynamoDB"]:
            self.assertEqual(states[name]["Catch"][0]["Next"], "MarkNetworkFailure")
        failure = states["MarkNetworkFailure"]
        self.assertEqual(failure["Next"], "ProvisioningFailed")
        self.assertEqual(failure["Catch"][0]["Next"], "ProvisioningFailed")
        self.assertNotIn("network_result", json.dumps(failure))
        self.assertEqual(states["AssignSecurityGroup"]["Parameters"]["Payload.$"], "$")
