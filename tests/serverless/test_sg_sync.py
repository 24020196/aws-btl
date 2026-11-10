import importlib.util
import json
import sys
from pathlib import Path
from unittest import TestCase, mock

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"
sys.path.insert(0, str(ROOT / "deployment"))

INSTANCE = "i-4c0906ee"
NOVA = "efdca890-184e-435a-96b3-fe64bcd1d568"
GROUP = "sg-b6027893d2"
SG_ID = "9d877f8a-204f-4577-a093-d67048a9284f"


def worker(env=None):
    spec = importlib.util.spec_from_file_location(
        "sg_sync_test", ROOT / "XRegion-SyncSecurityGroup" / "sync_security_group.py")
    module = importlib.util.module_from_spec(spec)
    with mock.patch("boto3.client"), mock.patch.dict("os.environ", env or {}, clear=False):
        spec.loader.exec_module(module)
    return module


def logical(protocol, start, end, cidr="0.0.0.0/0"):
    return {"protocol": protocol, "fromPort": start, "toPort": end, "cidr": cidr, "description": ""}


def neutron_rule(direction, protocol, start=None, end=None, cidr="0.0.0.0/0", rule_id="r-1"):
    out = {"id": rule_id, "direction": direction, "ethertype": "IPv4", "protocol": protocol,
           "remote_ip_prefix": cidr, "remote_group_id": None, "description": "provisioned"}
    if start is not None:
        out["port_range_min"] = start
        out["port_range_max"] = end
    return out


class OutcomeLoggingTests(TestCase):
    """A failed canary could not be diagnosed because SKIPPED/NOT_MANAGED were silent."""

    def setUp(self):
        self.w = worker({"XREGION_SG_SYNC_LIVE": "false"})

    def test_outcome_log_names_the_reason_and_correlation_ids(self):
        with mock.patch("builtins.print") as printer:
            self.w.outcome_log("req-1", "STALE", GROUP, 7,
                               {"event_id": "evt-abc", "group_id": GROUP})
        line = printer.call_args[0][0]
        assert "status=STALE" in line and "request_id=req-1" in line
        assert "revision=7" in line and "event_id=evt-abc" in line

    def test_outcome_log_never_prints_secrets(self):
        with mock.patch("builtins.print") as printer:
            self.w.outcome_log("req-2", "APPLIED", GROUP, 9,
                               {"event_id": "evt-x", "public_key": "ssh-rsa SECRET",
                                "OS_PASSWORD": "12345678"})
        line = printer.call_args[0][0]
        assert "12345678" not in line and "SECRET" not in line

    def test_handler_logs_stale_outcome(self):
        stale = {"detail": {"group_id": GROUP, "revision": 3, "event_id": "evt-old"}}
        context = mock.Mock(aws_request_id="req-3")
        with mock.patch.object(self.w, "get_item",
                               return_value={"revision": 9, "managed": False}), \
                mock.patch("builtins.print") as printer:
            result = self.w.lambda_handler(stale, context)
        assert result["status"] == "SKIPPED"
        printed = [str(c[0][0]) for c in printer.call_args_list if c[0]]
        assert any("status=STALE" in line and "req-3" in line for line in printed)


class NormalizationTests(TestCase):
    def setUp(self):
        self.w = worker()

    def test_tcp_rule_becomes_ingress_with_ports(self):
        rule = self.w.normalize_rule(logical("tcp", 443, 443), "inbound")
        self.assertEqual(rule["direction"], "ingress")
        self.assertEqual((rule["port_range_min"], rule["port_range_max"]), (443, 443))

    def test_tcp_range_ending_at_65535_is_not_treated_as_all_ports(self):
        rule = self.w.normalize_rule(logical("tcp", 443, 65535), "inbound")
        self.assertEqual((rule["port_range_min"], rule["port_range_max"]), (443, 65535))

    def test_all_traffic_has_no_protocol_and_keeps_full_range(self):
        rule = self.w.normalize_rule(logical("all", 0, 65535), "outbound")
        self.assertEqual(rule["direction"], "egress")
        self.assertIsNone(rule["protocol"])
        self.assertNotIn("port_range_min", rule)

    def test_rejects_invalid_cidr_port_range_and_group_reference(self):
        for rule in (logical("tcp", 80, 80, "999.1.1.1/0"), logical("tcp", 90, 80),
                     logical("tcp", 80, 80, "sg-default"), logical("icmpv6", 0, 0)):
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                self.w.normalize_rule(rule, "inbound")

    def test_icmp_keeps_type_and_code_instead_of_widening_the_range(self):
        # Echo request = type 8 / code 0. Tang "max(end, start)" tung bien thanh 8/8.
        rule = self.w.normalize_rule(logical("icmp", 8, 0), "inbound")
        self.assertEqual((rule["port_range_min"], rule["port_range_max"]), (8, 0))
        # 0/0 = moi loai ICMP: khong gui cap nao.
        self.assertNotIn("port_range_min", self.w.normalize_rule(logical("icmp", 0, 0), "inbound"))

    def test_rejects_missing_cidr_and_numeric_protocol_ambiguity(self):
        for rule in (logical("tcp", 80, 80, ""), logical("tcp", 80, 80, None)):
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                self.w.normalize_rule(rule, "inbound")
        # Port 0 khong the la can duoi cua mot khoang that.
        with self.assertRaises(ValueError):
            self.w.normalize_rule(logical("tcp", 0, 80), "inbound")

    def test_rules_that_cannot_be_compared_are_never_treated_as_converged(self):
        for rule in (dict(neutron_rule("ingress", "tcp", 80, 80, rule_id="r-v6"), ethertype="IPv6"),
                     dict(neutron_rule("ingress", "tcp", 80, 80, rule_id="r-grp"), remote_group_id="sg-x"),
                     dict(neutron_rule("ingress", "icmp", rule_id="r-icmp"), port_range_min=8),
                     dict(neutron_rule("ingress", "tcp", 80, 80, rule_id="r-6"), protocol="6")):
            with self.subTest(rule=rule):
                self.assertIsNone(self.w.rule_signature(rule))

class PlanTests(TestCase):
    def setUp(self):
        self.w = worker()
        self.rules = self.w.desired_rules({"inboundRules": [logical("tcp", 22, 22), logical("tcp", 80, 80)],
                                           "outboundRules": [logical("all", 0, 65535)]})

    def test_creates_missing_and_removes_every_extra_rule(self):
        # Option B: rule provisioning trung desired thi giu, rule ICMP du bi xoa.
        group = {"security_group_rules": [
            neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh"),
            neutron_rule("ingress", "icmp", rule_id="r-icmp"),
            neutron_rule("egress", None, rule_id="r-egress")]}
        to_create, to_delete = self.w.plan(group, self.rules)

        self.assertEqual([self.w.rule_signature(r) for r in to_create],
                         [("ingress", "IPv4", "tcp", 80, 80, "0.0.0.0/0")])
        self.assertEqual(to_delete, ["r-icmp"])

    def test_removing_ssh_from_configuration_deletes_provisioned_ssh(self):
        rules = self.w.desired_rules({"inboundRules": [logical("tcp", 443, 443)],
                                      "outboundRules": [logical("all", 0, 65535)]})
        group = {"security_group_rules": [
            neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh"),
            neutron_rule("egress", None, rule_id="r-egress")]}
        to_create, to_delete = self.w.plan(group, rules)

        self.assertEqual(to_delete, ["r-ssh"])
        self.assertEqual(len(to_create), 1)

    def test_empty_outbound_removes_default_egress(self):
        rules = self.w.desired_rules({"inboundRules": [logical("tcp", 22, 22)], "outboundRules": []})
        group = {"security_group_rules": [
            neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh"),
            neutron_rule("egress", None, rule_id="r-egress")]}

        _, to_delete = self.w.plan(group, rules)
        self.assertEqual(to_delete, ["r-egress"])

    def test_plan_is_idempotent_after_apply(self):
        group = {"security_group_rules": [
            neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh"),
            neutron_rule("ingress", "tcp", 80, 80, rule_id="r-http"),
            neutron_rule("egress", None, rule_id="r-egress")]}
        to_create, to_delete = self.w.plan(group, self.rules)
        self.assertEqual((to_create, to_delete), ([], []))


class MappingTests(TestCase):
    def setUp(self):
        self.w = worker()

    def test_rules_are_read_from_stored_json_strings(self):
        group = {"inbound_rules": json.dumps([logical("tcp", 22, 22)]), "outbound_rules": "[]"}
        rules = self.w.desired_rules(group)
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["direction"], "ingress")

    def test_low_level_attribute_values_are_deserialized(self):
        item = {"group_id": {"S": GROUP}, "revision": {"N": "6"},
                "inbound_rules": {"S": json.dumps([logical("tcp", 443, 443)])},
                "outbound_rules": {"S": "[]"}}
        plain = self.w.plain(item)
        self.assertEqual(plain["revision"], 6)
        self.assertEqual(self.w.desired_rules(plain)[0]["port_range_min"], 443)


    def test_resolve_uses_mapping_of_active_nova(self):
        self.w.get_item = mock.Mock(side_effect=[
            {"group_id": GROUP, "revision": 6, "description": f"Security group of {INSTANCE}",
             "owner": "lam", "managed": True},
            {"instance_id": INSTANCE, "user_id": "usr-lam", "current_status": "RUNNING",
             "active_nova_id": NOVA},
            {"nova_id": NOVA, "instance_id": INSTANCE},
            {"nova_id": NOVA, "neutron_sg_id": SG_ID, "neutron_port_id": "port-1", "status": "ACTIVE"}])

        resolved = self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})

        self.assertEqual(resolved["mapping"]["neutron_sg_id"], SG_ID)

    def test_stale_revision_is_skipped(self):
        self.w.get_item = mock.Mock(return_value={
            "group_id": GROUP, "revision": 7, "description": f"Security group of {INSTANCE}", "owner": "lam"})
        with self.assertRaises(self.w.SyncSkipped):
            self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})

    def test_group_of_another_instance_is_skipped(self):
        self.w.get_item = mock.Mock(side_effect=[
            {"group_id": GROUP, "revision": 6, "description": "Security group of i-other", "owner": "lam"},
            {"instance_id": INSTANCE, "user_id": "usr-lam", "current_status": "RUNNING"}])
        with self.assertRaises(self.w.SyncSkipped):
            self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})

    def test_instance_without_owner_is_blocked(self):
        self.w.get_item = mock.Mock(side_effect=[
            {"group_id": GROUP, "revision": 6, "description": f"Security group of {INSTANCE}", "owner": "lam"},
            {"instance_id": INSTANCE, "current_status": "RUNNING"}])
        with self.assertRaises(self.w.SyncBlocked):
            self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})

    def test_nova_of_another_instance_is_not_accepted(self):
        self.w.get_item = mock.Mock(side_effect=[
            {"group_id": GROUP, "revision": 6, "description": f"Security group of {INSTANCE}", "owner": "lam"},
            {"instance_id": INSTANCE, "user_id": "usr-lam", "current_status": "RUNNING", "active_nova_id": NOVA},
            {"nova_id": NOVA, "instance_id": "i-someone-else"}])
        self.w.query_index = mock.Mock(return_value=[])
        # Nova cua may khac khong duoc dung: khong co Nova nao thuoc may thi phai bo qua, khong doan.
        with self.assertRaises(self.w.SyncSkipped):
            self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})

    def test_failed_instance_and_missing_mapping_are_skipped(self):
        self.w.get_item = mock.Mock(side_effect=[
            {"group_id": GROUP, "revision": 6, "description": f"Security group of {INSTANCE}", "owner": "lam"},
            {"instance_id": INSTANCE, "user_id": "usr-lam", "current_status": "FAILED", "active_nova_id": NOVA}])
        with self.assertRaises(self.w.SyncSkipped):
            self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})

        self.w.get_item = mock.Mock(side_effect=[
            {"group_id": GROUP, "revision": 6, "description": f"Security group of {INSTANCE}", "owner": "lam"},
            {"instance_id": INSTANCE, "user_id": "usr-lam", "current_status": "RUNNING", "active_nova_id": NOVA},
            {"nova_id": NOVA, "instance_id": INSTANCE},
            None])
        with self.assertRaises(self.w.SyncSkipped):
            self.w.resolve({"group_id": GROUP, "instance_id": INSTANCE, "revision": 6})



class FakeNeutron:
    """Neutron gia lap dung shape API that: port.security_groups la danh sach UUID, group co 'name'.

    Giu trang thai de plan/read-back thay duoc thay doi, thay vi tra kich ban co dinh theo thu tu.
    """

    def __init__(self, case, rules=None, swallow_writes=False, ports=None):
        self.case = case
        self.rules = [dict(rule) for rule in (rules or [])]
        self.calls = []
        self.next_id = 1
        # Mo phong Neutron "nuot" mutation: tra 2xx nhung khong doi rule.
        self.swallow_writes = swallow_writes
        # Port dang gan SG; None = chi port cua may trong mapping.
        self.ports = ports

    def __call__(self, method, path, token, body=None):
        self.calls.append((method, path))
        if path == f"/ports/{self.case.mapping['neutron_port_id']}":
            return {"port": {"id": self.case.mapping["neutron_port_id"], "device_id": NOVA,
                             "security_groups": [SG_ID]}}
        if path == f"/security-groups/{SG_ID}":
            return {"security_group": {"id": SG_ID, "name": NOVA, "security_group_rules": self.rules}}
        if path.startswith("/ports?security_groups="):
            ports = self.ports if self.ports is not None else [
                {"id": self.case.mapping["neutron_port_id"], "security_groups": [SG_ID]}]
            return {"ports": ports, "ports_links": []}
        if method == "POST" and path == "/security-group-rules":
            if self.swallow_writes:
                return {}
            rule = dict(body["security_group_rule"], id=f"r-new-{self.next_id}")
            self.next_id += 1
            self.rules.append(rule)
            return {}
        if method == "DELETE" and path.startswith("/security-group-rules/"):
            if self.swallow_writes:
                return {}
            rule_id = path.rsplit("/", 1)[-1]
            self.rules = [r for r in self.rules if r.get("id") != rule_id]
            return {}
        raise AssertionError(f"unexpected Neutron call {method} {path}")


class WorkerTests(TestCase):
    """End-to-end handler behaviour with mocked DynamoDB and Neutron."""

    def setUp(self):
        self.w = worker({"XREGION_SG_SYNC_MANAGED_ALLOWLIST": GROUP})
        self.w.LIVE = True
        self.w.ALLOWLIST = {GROUP}
        self.w.keystone_token = mock.Mock(return_value="token")
        # Ghi DynamoDB duoc gia lap o day va bi ghi de khi test can ep acquire_lease that bai.
        self.w.update_item = mock.Mock(return_value=True)
        self.group = {"group_id": GROUP, "revision": 6, "description": f"Security group of {INSTANCE}",
                      "owner": "lam", "managed": True,
                      "inbound_rules": json.dumps([logical("tcp", 443, 443)]),
                      "outbound_rules": "[]"}
        self.instance = {"instance_id": INSTANCE, "user_id": "usr-lam", "current_status": "RUNNING",
                         "active_nova_id": NOVA}
        self.nova = {"nova_id": NOVA, "instance_id": INSTANCE}
        # security_group_id trung nova_id theo quy uoc cua du an; neutron_sg_id la UUID that.
        self.mapping = {"nova_id": NOVA, "security_group_id": NOVA, "neutron_sg_id": SG_ID,
                        "neutron_port_id": "port-1", "status": "ACTIVE"}

    def handler(self, extra_get=None):
        # get_item duoc goi lai trong lambda_handler de recheck revision, nen tra theo key thay vi theo thu tu.
        by_key = {GROUP: self.group, INSTANCE: self.instance, NOVA: self.nova}

        def fake_get(table, key_name, key_value):
            if table == self.w.MAPPING_TABLE:
                return self.mapping
            return by_key.get(str(key_value))

        self.w.get_item = mock.Mock(side_effect=fake_get)
        # mark() chay ban that de kiem chung ca cau lenh lan dieu kien ghi; chi ghi lai cac cuoc goi.
        if not getattr(self.w, "_marks_wrapped", False):
            self.w._marks_wrapped = True
            self.w._mark_calls = []
            real_mark = self.w.mark

            def recording_mark(*args, **kwargs):
                self.w._mark_calls.append((args, kwargs))
                return real_mark(*args, **kwargs)

            self.w.mark = recording_mark
        self.marks = self.w._mark_calls
        if getattr(self.w, "neutron", None) is None:
            self.w.neutron = FakeNeutron(self, rules=[])
        return self.w.lambda_handler({"detail": {"group_id": GROUP, "instance_id": INSTANCE,
                                                 "revision": 6}}, mock.Mock(aws_request_id="req-1"))

    def recorded_statuses(self):
        """Trang thai da ghi, theo thu tu thuc te."""
        return [args[2] for args, _ in self.marks]

    def test_dry_run_never_writes_to_neutron_or_dynamodb(self):
        self.w.LIVE = False
        fake = self.w.neutron = FakeNeutron(self, rules=[])

        result = self.handler()

        self.assertEqual(result["status"], "DRY_RUN")
        self.assertTrue(all(method == "GET" for method, _ in fake.calls))
        self.w.update_item.assert_not_called()

    def test_live_run_creates_deletes_and_marks_synced_after_verification(self):
        fake = self.w.neutron = FakeNeutron(self, rules=[
            neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh"),
            neutron_rule("egress", None, rule_id="r-egress")])

        result = self.handler()

        self.assertEqual(result["status"], "APPLIED")
        self.assertTrue(result["result"]["verified"])
        created = [p for m, p in fake.calls if m == "POST"]
        deleted = sorted(p for m, p in fake.calls if m == "DELETE")
        self.assertEqual(created, ["/security-group-rules"])
        self.assertEqual(deleted, ["/security-group-rules/r-egress", "/security-group-rules/r-ssh"])
        # Rule 443 duoc tao that va rule provisioning da bi xoa.
        self.assertEqual([r["port_range_min"] for r in fake.rules], [443])
        self.assertEqual(self.recorded_statuses(), [self.w.SYNCED])

    def test_not_converged_is_failure_and_not_marked_synced(self):
        # Neutron "nuot" mutation: tao/xoa tra 2xx nhung khong doi gi => read-back khong hoi tu.
        self.w.neutron = FakeNeutron(self, rules=[
            neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh")], swallow_writes=True)

        with self.assertRaises(RuntimeError):
            self.handler()

        self.assertEqual(self.recorded_statuses(), [self.w.FAILED])

    def test_not_managed_group_is_not_applied(self):
        self.w.ALLOWLIST = set()
        fake = self.w.neutron = FakeNeutron(self, rules=[])

        result = self.handler()

        self.assertEqual(result["status"], "NOT_MANAGED")
        self.assertEqual(fake.calls, [])

    def test_lease_conflict_does_not_touch_neutron(self):
        self.w.get_item = mock.Mock(return_value=self.group)
        fake = self.w.neutron = FakeNeutron(self, rules=[])
        # Worker khac dang giu lease: acquire_lease that (qua update_item) phai that bai.
        self.w.update_item = mock.Mock(side_effect=RuntimeError("ConditionalCheckFailedException"))

        # BUSY khong duoc bao la thanh cong: phai nem de event duoc thu lai, va khong sua gi.
        with self.assertRaises(self.w.BusyRetry):
            self.w.lambda_handler({"detail": {"group_id": GROUP, "instance_id": INSTANCE,
                                              "revision": 6}}, mock.Mock(aws_request_id="req-2"))

        self.assertEqual(fake.calls, [])

    def test_managed_requires_a_real_boolean(self):
        # {"BOOL": false} phai giai ma thanh False; neu la dict truthy thi group ngoai allowlist van bi sua.
        self.assertFalse(self.w.is_managed(GROUP, {"managed": self.w.plain({"BOOL": False})}))
        self.assertFalse(self.w.is_managed(GROUP, {"managed": "false"}))
        self.assertTrue(self.w.is_managed(GROUP, {"managed": self.w.plain({"BOOL": True})}))

    def test_dry_run_exception_writes_nothing(self):
        self.w.LIVE = False
        self.w.update_item = mock.Mock()
        self.w.get_item = mock.Mock(return_value=self.group)
        self.w.resolve = mock.Mock(side_effect=self.w.SyncBlocked("shared group"))

        result = self.w.lambda_handler({"detail": {"group_id": GROUP, "instance_id": INSTANCE,
                                                   "revision": 6}}, mock.Mock(aws_request_id="req-3"))

        self.assertEqual(result["status"], "BLOCKED")
        # Dry-run phai la zero-write ke ca tren duong loi.
        self.w.update_item.assert_not_called()

    def test_shared_security_group_is_blocked_before_any_rule_change(self):
        # Ban ghi that theo tung bang: instance/nova/mapping deu hop le, chi viec SG dung chung la bat thuong.
        self.w.neutron = FakeNeutron(
            self, rules=[neutron_rule("ingress", "tcp", 22, 22, rule_id="r-ssh")],
            ports=[{"id": "port-1", "security_groups": [SG_ID]},
                   {"id": "port-2", "security_groups": [SG_ID]}])

        result = self.handler()

        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("used by 1 other port", result["reason"])
        # Chi doc; khong co POST/DELETE nao truoc khi bi chan.
        self.assertTrue(all(method == "GET" for method, _ in self.w.neutron.calls))
        self.assertEqual(self.recorded_statuses(), [self.w.BLOCKED])
        # Ket qua BLOCKED phai duoc ghi khi van giu lease, va lease chi duoc tra sau do.
        _, mark_kwargs = self.marks[0]
        self.assertTrue(mark_kwargs["keep_lease"])
        operations = [call.args[3] for call in self.w.update_item.call_args_list]
        self.assertIn("sync_lease_owner = :o", operations[0])          # acquire
        self.assertIn("sync_status = :st", operations[1])              # mark, van giu lease
        self.assertNotIn("sync_lease_owner = :empty", operations[1])
        self.assertIn("sync_lease_owner = :empty", operations[-1])     # release sau cung

    def test_target_must_name_the_nova_and_be_used_by_one_port_only(self):
        base = {"nova_id": NOVA, "security_group_id": NOVA, "neutron_sg_id": SG_ID,
                "neutron_port_id": "port-1"}
        port = {"port": {"id": "port-1", "device_id": NOVA, "security_groups": [SG_ID]}}
        group = {"security_group": {"id": SG_ID, "name": NOVA, "security_group_rules": []}}
        mine = {"ports": [{"id": "port-1", "security_groups": [SG_ID]}], "ports_links": []}

        self.w.neutron = mock.Mock(side_effect=[port, group, mine])
        self.assertEqual(self.w.verify_target(base, INSTANCE, "token"), SG_ID)

        # security_group_id phai trung nova_id theo quy uoc du an.
        with self.assertRaises(self.w.SyncBlocked):
            self.w.verify_target(dict(base, security_group_id="nova-other"), INSTANCE, "token")

        # Port cua Nova khac.
        self.w.neutron = mock.Mock(side_effect=[dict(port, port=dict(port["port"], device_id="nova-x"))])
        with self.assertRaises(self.w.SyncBlocked):
            self.w.verify_target(base, INSTANCE, "token")

        # SG mang ten khac nova_id: khong phai SG 1-1 cua may nay.
        self.w.neutron = mock.Mock(side_effect=[port, dict(group, security_group=dict(
            group["security_group"], name="someone-else"))])
        with self.assertRaises(self.w.SyncBlocked):
            self.w.verify_target(base, INSTANCE, "token")

        # SG dung chung cho port khac.
        self.w.neutron = mock.Mock(side_effect=[
            port, group, {"ports": [{"id": "port-1", "security_groups": [SG_ID]},
                                    {"id": "port-2", "security_groups": [SG_ID]}], "ports_links": []}])
        with self.assertRaises(self.w.SyncBlocked):
            self.w.verify_target(base, INSTANCE, "token")

        # Danh sach port khong thay port cua may: khong chung minh duoc exclusivity.
        self.w.neutron = mock.Mock(side_effect=[port, group, {"ports": [], "ports_links": []}])
        with self.assertRaises(self.w.SyncBlocked):
            self.w.verify_target(base, INSTANCE, "token")

    def test_ports_using_group_follows_marker_pagination(self):
        self.w.neutron = mock.Mock(side_effect=[
            {"ports": [{"id": "port-1", "security_groups": [SG_ID]}],
             "ports_links": [{"rel": "next", "href": f"/v2.0/ports?marker=abc&security_groups={SG_ID}"}]},
            {"ports": [{"id": "port-2", "security_groups": [SG_ID]}], "ports_links": []},
        ])

        # Trang 1 bi bo qua neu dung o do: port-2 se bi coi la ngoai lai hoac bi an.
        self.assertEqual(self.w.ports_using_group(SG_ID, "token"), {"port-1", "port-2"})
        # Request trang hai phai chi mang marker 'abc', khong keo theo '&security_groups=...'.
        requests = [call.args[1] for call in self.w.neutron.call_args_list]
        self.assertEqual(requests, [f"/ports?security_groups={SG_ID}",
                                    f"/ports?security_groups={SG_ID}&marker=abc"])

    def test_fail_closed_when_next_link_is_unusable(self):
        for link in ({"rel": "next", "href": "/v2.0/ports?marker="},
                     {"rel": "next", "href": "/v2.0/ports?security_groups=" + SG_ID},
                     {"rel": "next", "href": "/v2.0/ports?marker=a&marker=b"}):
            with self.subTest(link=link):
                self.w.neutron = mock.Mock(return_value={
                    "ports": [{"id": "port-1", "security_groups": [SG_ID]}],
                    "ports_links": [link]})
                with self.assertRaises(self.w.SyncBlocked):
                    self.w.ports_using_group(SG_ID, "token")

    def test_fail_closed_on_repeated_marker_and_duplicate_next_links(self):
        repeated = {"rel": "next", "href": "/v2.0/ports?marker=abc"}
        self.w.neutron = mock.Mock(return_value={
            "ports": [{"id": "port-1", "security_groups": [SG_ID]}], "ports_links": [repeated]})
        # Marker lap lai: dung han thay vi quay vo han.
        with self.assertRaises(self.w.SyncBlocked):
            self.w.ports_using_group(SG_ID, "token")
        self.assertEqual(self.w.neutron.call_count, 2)

        self.w.neutron = mock.Mock(return_value={
            "ports": [{"id": "port-1", "security_groups": [SG_ID]}],
            "ports_links": [{"rel": "next", "href": "/v2.0/ports?marker=abc"},
                            {"rel": "next", "href": "/v2.0/ports?marker=def"}]})
        with self.assertRaises(self.w.SyncBlocked):
            self.w.ports_using_group(SG_ID, "token")

    def test_fail_closed_when_port_inventory_payload_is_malformed(self):
        for payload in ({}, {"ports": None}, {"ports": {}}, ["not", "a", "dict"],
                        {"ports": [{"security_groups": [SG_ID]}]},
                        {"ports": [], "ports_links": "next"}):
            with self.subTest(payload=payload):
                self.w.neutron = mock.Mock(return_value=payload)
                with self.assertRaises(self.w.SyncBlocked):
                    self.w.ports_using_group(SG_ID, "token")

    def test_lease_expiry_is_part_of_the_renew_and_record_conditions(self):
        self.w.update_item = mock.Mock(return_value=True)
        self.w.renew_lease(GROUP, 6, "req-9")
        renew_call = self.w.update_item.call_args
        # update_item(table, key_name, key_value, expression, names, values, condition)
        values, condition = renew_call.args[5], renew_call.args[6]
        # Chi so owner/revision la chua du: lease het han thi worker khac da co the tiep quan.
        self.assertIn("sync_lease_until > :now", condition)
        self.assertIn(":now", values)

        self.w.update_item.reset_mock()
        self.w.mark(GROUP, 6, self.w.SYNCED, owner_id="req-9", keep_lease=True)
        mark_call = self.w.update_item.call_args
        values, condition = mark_call.args[5], mark_call.args[6]
        self.assertIn("sync_lease_until > :now", condition)
        self.assertIn(":now", values)

    def test_expired_or_stolen_lease_stops_before_mutating_neutron(self):
        self.w.update_item = mock.Mock(side_effect=RuntimeError("ConditionalCheckFailedException"))
        fake = self.w.neutron = FakeNeutron(self, rules=[])

        with self.assertRaises(self.w.BusyRetry):
            self.handler()

        # Khong chiem duoc lease thi khong duoc cham Neutron va khong ghi ket qua.
        self.assertEqual(fake.calls, [])
        self.assertEqual(self.recorded_statuses(), [])

    def test_group_without_managed_flag_is_not_applied(self):
        self.group.pop("managed")
        fake = self.w.neutron = FakeNeutron(self, rules=[])

        result = self.handler()

        self.assertEqual(result["status"], "NOT_MANAGED")
        self.assertEqual(fake.calls, [])

