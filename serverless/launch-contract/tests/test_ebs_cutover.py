import base64
import copy
import importlib.util
import json
from pathlib import Path
import sys
from unittest import TestCase, mock
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deployment"))
import legacy_cleanup as cleanup
import ebs_cutover as cutover

VID = "11111111-1111-4111-8111-111111111111"
NID = "22222222-2222-4222-8222-222222222222"
PID = cleanup.PROJECT
EBS = "vol-1234567890abcdef0"


def baseline():
    return dict(host=dict(InstanceId=cleanup.HOST, RootDeviceName="/dev/sda1",
        BlockDeviceMappings=[dict(DeviceName="/dev/sda1", Ebs={"VolumeId": EBS})]),
        volume_records=[], ebs=[dict(VolumeId=EBS)], openstack=dict(
            lvs={"report": [{"lv": [{"lv_name": "volume-" + VID}]}]},
            volumes=[dict(id=VID, project_id=PID, size=10, attachments=[])],
            servers=[dict(id=NID, project_id=PID, name="dd", attached_volumes=[{"id": VID}])]))


class CleanupTests(TestCase):
    def test_dd_is_included_under_the_new_explicit_scope(self):
        manifest = cleanup.build_manifest(baseline(), [PID])
        self.assertEqual([s["name"] for s in manifest["servers"]], ["dd"])
        self.assertEqual(len(manifest["volumes"]), 1)
        self.assertEqual(manifest["ebs"], [])

    def test_root_is_never_selected_even_if_a_record_references_it(self):
        b = baseline()
        b["volume_records"] = [{"ebs_volume_id": EBS, "lease_instance_id": "i-old"}]
        b["ebs"][0]["Tags"] = [{"Key": "Project", "Value": "xregion"}]
        self.assertEqual(cleanup.build_manifest(b, [PID])["ebs"], [])

    def test_other_project_is_preserved(self):
        self.assertEqual(cleanup.build_manifest(baseline(), ["33333333-3333-4333-8333-333333333333"])["servers"], [])

    def test_host_attachment_alone_never_proves_ebs_ownership(self):
        b = baseline()
        b["ebs"].append(dict(VolumeId="vol-22222222222222222", Attachments=[{"InstanceId": cleanup.HOST}]))
        m = cleanup.build_manifest(b, [PID])
        self.assertEqual(m["ebs"], [])
        self.assertEqual(len(m["preserved_ebs"]), 1)

    def test_manifest_tampering_and_even_rehashed_expansion_rejected(self):
        b = baseline()
        m = cleanup.build_manifest(b, [PID])
        cleanup.validate_manifest(m, b)
        m["volumes"].append(dict(id=NID, project_id=PID, size=10, backend="legacy-lvm", attachments=[]))
        with self.assertRaises(ValueError): cleanup.validate_manifest(m, b)
        m["manifest_sha256"] = cleanup.digest({k:v for k,v in m.items() if k != "manifest_sha256"})
        with self.assertRaisesRegex(ValueError, "expands"):
            cleanup.validate_manifest(m, b)

    def test_r01_remove_orphan_network_resumes_when_mapping_already_deleted(self):
        x = mock.MagicMock()
        table = mock.MagicMock()
        x.session.resource.return_value.Table.return_value = table
        table.get_item.return_value = {'Item': {'nova_id': 'srv-1', 'status': 'DELETED'}}
        server = {'id': 'srv-1'}
        ports = []
        with mock.patch("legacy_cleanup.remote_delete") as mock_del:
            cleanup.remove_orphan_network(x, server, ports)
            mock_del.assert_called_once_with(x, "server", server, ports)
        x.save.assert_called_once()
        self.assertEqual(x.save.call_args[0][0], 'legacy-orphan-network-srv-1.json')
        self.assertEqual(x.save.call_args[0][1]['status'], 'ALREADY_DELETED')

    def test_r02_safe_lvs_recognizes_vg_absence(self):
        import subprocess
        with mock.patch("subprocess.run") as mock_run:
            mock_proc = mock.MagicMock()
            mock_proc.returncode = 5
            mock_proc.stdout = '{"report": []}'
            mock_proc.stderr = '  Volume group "cinder-volumes" not found\n  Cannot process volume group cinder-volumes'
            mock_run.return_value = mock_proc
            exec_globals = {"subprocess": subprocess, "json": json}
            exec("import json, subprocess\n" + cleanup.HOST_INVENTORY[cleanup.HOST_INVENTORY.find("def safe_lvs"):cleanup.HOST_INVENTORY.find("result = dict")], exec_globals)
            res = exec_globals["safe_lvs"]()
            self.assertEqual(res, {"report": []})

    def test_r02_safe_lvs_raises_on_permission_or_other_errors(self):
        import subprocess
        with mock.patch("subprocess.run") as mock_run:
            mock_proc = mock.MagicMock()
            mock_proc.returncode = 1
            mock_proc.stdout = ""
            mock_proc.stderr = "Permission denied"
            mock_proc.args = ['lvs']
            mock_run.return_value = mock_proc
            exec_globals = {"subprocess": subprocess, "json": json}
            exec("import json, subprocess\n" + cleanup.HOST_INVENTORY[cleanup.HOST_INVENTORY.find("def safe_lvs"):cleanup.HOST_INVENTORY.find("result = dict")], exec_globals)
            with self.assertRaises(subprocess.CalledProcessError):
                exec_globals["safe_lvs"]()

    def test_r02_verify_checks_domains_and_lvs_and_ports(self):
        b = baseline()
        b["openstack"]["ports"] = [{"id": "port-1", "device_id": NID}]
        m = cleanup.build_manifest(b, [PID])
        x = mock.MagicMock()
        x.directory = Path(".")
        with mock.patch("legacy_cleanup.inventory") as mock_inv:
            mock_inv.return_value = dict(
                openstack=dict(servers=[], volumes=[], lvs={"report": []}, domains=[NID], ports=[]),
                ebs=[]
            )
            with self.assertRaisesRegex(RuntimeError, "Legacy resources remain"):
                cleanup.verify(x, b, m)

    def test_ambiguous_storage_blocks_deletion(self):
        b = baseline()
        b["openstack"]["servers"][0]["attached_volumes"] = [{"id": NID}]
        m = cleanup.build_manifest(b, [PID])
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            cleanup.validate_manifest(m, b)

    def test_compressed_ssm_inventory_does_not_truncate_json(self):
        expected = {"padding": "x" * 100000}
        reply = "XRJSON:" + base64.b64encode(zlib.compress(json.dumps(expected).encode())).decode()
        operator = mock.MagicMock()
        operator.remote.return_value = reply
        self.assertEqual(cleanup.host_python(operator, "print('{}')", "test"), expected)
        operator.remote.return_value = '{"truncated'
        with self.assertRaises(ValueError): cleanup.host_python(operator, "print('{}')", "test")

    def test_missing_maintenance_prevents_any_cleanup(self):
        x = mock.MagicMock()
        x.client.return_value.get_parameter.return_value = {"Parameter": {"Value": '{"mode":"open"}'}}
        b = baseline(); m = cleanup.build_manifest(b, [PID])
        with self.assertRaisesRegex(RuntimeError, "maintenance"):
            cleanup.apply_cleanup(x, b, m, {})
        x.call.assert_not_called()
        x.remote.assert_not_called()

    def test_backup_waiver_does_not_bypass_canary_gate(self):
        x = mock.MagicMock()
        x.client.return_value.describe_execution.return_value = {"status": "RUNNING"}
        with mock.patch.object(cleanup, "assert_frozen"), self.assertRaisesRegex(ValueError, "canary"):
            cleanup.require_receipts(x, cleanup.build_manifest(baseline(), [PID]),
                {"canary": {"launch_execution": "launch", "terminate_execution": "terminate"}})
        x.client.return_value.describe_snapshots.assert_not_called()
        x.call.assert_not_called()


class PoolTests(TestCase):
    def setUp(self):
        self.runtime = mock.MagicMock()
        self.runtime.CINDER_VOLUME_TYPE = "aws-ebs-gp3"
        self.runtime.STORAGE_BACKEND = "aws-ebs"
        self.runtime.StorageUnavailable = type("StorageUnavailable", (Exception,), {})
        spec = importlib.util.spec_from_file_location("ebs_pool_test", ROOT / "XRegion-CinderPoolManager/cinder_pool_manager.py")
        self.pool = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"network_runtime": self.runtime}): spec.loader.exec_module(self.pool)

    def test_pool_is_paused_until_explicitly_enabled(self):
        with mock.patch.dict("os.environ", {"EBS_POOL_ENABLED": "false"}):
            self.assertEqual(self.pool.lambda_handler({}, None)["status"], "PAUSED")
        self.runtime.os_api.assert_not_called()

    def test_lvm_volume_can_never_become_ebs_reserve(self):
        with self.assertRaises(ValueError):
            self.pool.validate_pool_volume({"type": "__DEFAULT__", "volume_image_metadata": {"image_id": VID}}, VID)
        self.runtime.validate_ebs_mapping.assert_not_called()

    def test_ambiguous_create_never_posts_a_second_time(self):
        table = mock.MagicMock()
        self.runtime.os_api.return_value = {"volumes": []}
        request = dict(volume_id="request", request_id=NID, image_id=VID, size_gb=10, post_attempted=True)
        self.assertFalse(self.pool.reconcile(table, PID, request))
        self.assertEqual(self.runtime.os_api.call_count, 1)
        table.update_item.assert_not_called()

    def test_create_requests_explicit_ebs_type_and_persists_before_post(self):
        table = mock.MagicMock()
        def api(service, path, method="GET", body=None):
            if method == "GET": return {"volumes": []}
            self.assertEqual(body["volume"]["volume_type"], "aws-ebs-gp3")
            self.assertIn("post_attempted", table.update_item.call_args.kwargs["UpdateExpression"])
            return {"volume": {"id": NID, "status": "creating"}}
        self.runtime.os_api.side_effect = api
        self.assertFalse(self.pool.reconcile(table, PID, dict(volume_id="request", request_id=NID, image_id=VID, size_gb=10)))

    def test_r04_stale_available_rows_are_marked_stale_and_not_counted(self):
        table = mock.MagicMock()
        self.runtime.DDB.Table.return_value = table
        def os_api_side_effect(service, path, method="GET", body=None, missing=False):
            if service == "GLANCE":
                return {"images": [{"id": VID, "min_disk": 10}]}
            if method == "POST":
                return {"volume": {"id": VID, "status": "creating"}}
            if service == "CINDER" and "cinder-stale-1" in path:
                return None
            return {"volumes": []}
        self.runtime.os_api.side_effect = os_api_side_effect
        rows = [{'volume_id': 'EBS-POOL#vol-1', 'status': 'AVAILABLE', 'cinder_volume_id': 'cinder-stale-1'}]
        self.runtime.scan.return_value = rows
        with mock.patch.dict("os.environ", {"EBS_POOL_ENABLED": "true", "OS_PROJECT_ID": PID}):
            res = self.pool.lambda_handler({}, None)
        self.assertEqual(rows[0]['status'], 'STALE')
        table.update_item.assert_called()

    def test_r04_ec2_transient_error_retains_slot_and_never_posts_refill(self):
        import botocore.exceptions
        table = mock.MagicMock()
        self.runtime.DDB.Table.return_value = table
        def os_api_side_effect(service, path, method="GET", body=None, missing=False):
            if service == "GLANCE":
                return {"images": [{"id": VID, "min_disk": 10}]}
            if service == "CINDER" and "cinder-live-1" in path:
                return {"volume": {"id": "cinder-live-1", "volume_type": "aws-ebs-gp3", "type": "aws-ebs-gp3",
                                   "status": "available", "bootable": "true", "size": 10,
                                   "provider_id": "vol-1234567890abcdef0",
                                   "volume_image_metadata": {"image_id": VID}}}
            return {"volumes": []}
        self.runtime.os_api.side_effect = os_api_side_effect
        rows = [
            {'volume_id': 'EBS-POOL#vol-1', 'status': 'AVAILABLE', 'cinder_volume_id': 'cinder-live-1'},
            {'volume_id': 'EBS-POOL#vol-2', 'status': 'AVAILABLE', 'cinder_volume_id': 'cinder-live-1'},
            {'volume_id': 'EBS-POOL#vol-3', 'status': 'AVAILABLE', 'cinder_volume_id': 'cinder-live-1'}
        ]
        self.runtime.scan.return_value = rows
        self.runtime.validate_ebs_mapping.side_effect = botocore.exceptions.EndpointConnectionError(endpoint_url="https://ec2.ap-southeast-2.amazonaws.com")
        with mock.patch.dict("os.environ", {"EBS_POOL_ENABLED": "true", "OS_PROJECT_ID": PID}):
            res = self.pool.lambda_handler({}, None)
        for r in rows:
            self.assertEqual(r['status'], 'AVAILABLE')
        table.update_item.assert_not_called()
        self.assertEqual(res["requests"], [])

    def test_r04_race_allocated_skips_without_error(self):
        from botocore.exceptions import ClientError
        table = mock.MagicMock()
        self.runtime.DDB.Table.return_value = table
        def os_api_side_effect(service, path, method="GET", body=None, missing=False):
            if service == "GLANCE":
                return {"images": [{"id": VID, "min_disk": 10}]}
            if service == "CINDER" and "cinder-stale-1" in path:
                return None
            if method == "POST":
                return {"volume": {"id": VID, "status": "creating"}}
            return {"volumes": []}
        self.runtime.os_api.side_effect = os_api_side_effect
        rows = [{'volume_id': 'EBS-POOL#vol-1', 'status': 'AVAILABLE', 'cinder_volume_id': 'cinder-stale-1'}]
        self.runtime.scan.return_value = rows
        def update_item_side_effect(**kwargs):
            if kwargs.get("Key", {}).get("volume_id") == "EBS-POOL#vol-1":
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
            return {}
        table.update_item.side_effect = update_item_side_effect
        with mock.patch.dict("os.environ", {"EBS_POOL_ENABLED": "true", "OS_PROJECT_ID": PID}):
            res = self.pool.lambda_handler({}, None)
        self.assertEqual(rows[0]['status'], 'STALE')


class PolicyTests(TestCase):
    def test_scoping_keeps_root_deny_tag_restrictions_and_single_instance(self):
        actions = ["ec2:CreateVolume", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume",
                   "ec2:ModifyVolume", "ec2:ModifyInstanceAttribute", "ec2:CreateSnapshot", "ec2:DeleteSnapshot", "ec2:DescribeVolumes"]
        generated = {"Policies": [{"Policy": {"Statement": [{"Action": actions}]}}]}
        policy = cutover.scoped_policy(generated, EBS, "arn:aws:kms:ap-southeast-2:291634989063:key/key")
        by_sid = {s["Sid"]:s for s in policy["Statement"]}
        self.assertEqual(by_sid["NeverMutateRoot"]["Effect"], "Deny")
        self.assertTrue(by_sid["NeverMutateRoot"]["Resource"].endswith(EBS))
        self.assertTrue(by_sid["AttachOnlyToStorageHost"]["Resource"].endswith(cleanup.HOST))
        self.assertEqual(by_sid["CreateOwnedEncryptedGp3"]["Condition"]["Bool"], {"ec2:Encrypted": "true"})
        self.assertNotIn("ec2:*", json.dumps(policy))
