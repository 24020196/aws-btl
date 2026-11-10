import copy
import sys
from pathlib import Path
from unittest import TestCase, mock

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"
sys.path.insert(0, str(ROOT))
from storage.ebs_backend import EbsBackend, GIB


VID = "11111111-1111-4111-8111-111111111111"
EBS = "vol-1234567890abcdef0"
ROOT_DISK = "vol-00000000000000000"
HOST = "i-056d7f3dd24156234"


class EbsBackendTests(TestCase):
    def setUp(self):
        self.ec2 = mock.MagicMock()
        self.volume = dict(id=VID, project_id="service-project", size=10, provider_id=EBS)
        self.host = dict(InstanceId=HOST, Placement={"AvailabilityZone": "ap-southeast-2a"},
            RootDeviceName="/dev/sda1", BlockDeviceMappings=[
                {"DeviceName": "/dev/sda1", "Ebs": {"VolumeId": ROOT_DISK}},
                {"DeviceName": "/dev/sdf", "Ebs": {"VolumeId": EBS, "DeleteOnTermination": False}}])
        self.ec2.describe_instances.return_value = {"Reservations": [{"Instances": [self.host]}]}
        self.execute = mock.MagicMock(side_effect=self.command)
        self.time = 0
        self.backend = EbsBackend(self.ec2, account="291634989063", host_id=HOST,
            region="ap-southeast-2", execute=self.execute, timeout=3,
            clock=lambda: self.time, sleep=self.sleep, exists=lambda path: True)
        self.disk = dict(VolumeId=EBS, VolumeType="gp3", Encrypted=True, Size=10,
            State="available", AvailabilityZone="ap-southeast-2a", Attachments=[],
            Tags=[{"Key": k, "Value": v} for k, v in self.backend.tags(self.volume).items()])
        self.ec2.describe_volumes.side_effect = lambda **kw: {"Volumes": [copy.deepcopy(self.disk)]}

    def sleep(self, seconds):
        self.time += seconds

    def command(self, *args, **kwargs):
        if args[0] == "lsblk": return EBS.replace("-", "") + "\n", ""
        if args[1] == "--getro": return "0\n", ""
        return str(self.disk["Size"] * GIB), ""

    def test_foreign_account_or_region_rejected(self):
        for account, region in [("wrong", "ap-southeast-2"), ("291634989063", "us-east-1")]:
            with self.assertRaises(ValueError):
                EbsBackend(self.ec2, account=account, region=region, host_id=HOST, execute=self.execute)

    def test_existing_volume_is_never_created_again(self):
        self.assertEqual(self.backend.create(self.volume), {"provider_id": EBS})
        self.ec2.create_volume.assert_not_called()

    def test_lost_create_response_reconciles_exact_tags(self):
        self.volume["provider_id"] = None
        self.ec2.get_paginator.return_value.paginate.return_value = [{"Volumes": [self.disk]}]
        self.assertEqual(self.backend.create(self.volume), {"provider_id": EBS})
        self.ec2.create_volume.assert_not_called()

    def test_create_uses_atomic_tags_encryption_and_stable_token(self):
        self.volume["provider_id"] = None
        self.ec2.get_paginator.return_value.paginate.return_value = [{"Volumes": []}]
        self.ec2.create_volume.return_value = self.disk
        self.backend.create(self.volume)
        kwargs = self.ec2.create_volume.call_args.kwargs
        self.assertTrue(kwargs["Encrypted"])
        self.assertEqual(kwargs["ClientToken"], "xregion-" + VID)
        self.assertEqual(kwargs["AvailabilityZone"], "ap-southeast-2a")
        self.assertEqual(kwargs["TagSpecifications"][0]["ResourceType"], "volume")

    def test_duplicate_mapping_is_rejected(self):
        self.volume["provider_id"] = None
        self.ec2.get_paginator.return_value.paginate.return_value = [{"Volumes": [self.disk, self.disk]}]
        with self.assertRaisesRegex(ValueError, "Multiple"):
            self.backend.find(self.volume)

    def test_foreign_tags_az_plaintext_and_other_attachment_rejected(self):
        changes = [dict(Tags=[]), dict(AvailabilityZone="ap-southeast-2b"), dict(Encrypted=False),
                   dict(Attachments=[{"InstanceId": "i-other"}])]
        for fields in changes:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.backend.owned(self.volume, dict(self.disk, **fields))

    def test_root_is_rejected_even_with_driver_tags(self):
        with self.assertRaisesRegex(ValueError, "Root"):
            self.backend.owned(self.volume, dict(self.disk, VolumeId=ROOT_DISK))

    def test_serial_mismatch_rejected_before_any_write(self):
        self.execute.side_effect = lambda *a, **k: ("volwrong", "")
        with self.assertRaisesRegex(ValueError, "serial"):
            self.backend.device(EBS, 10)
        self.assertEqual(self.execute.call_count, 1)

    def test_readonly_device_rejected(self):
        self.execute.side_effect = lambda *a, **k: (EBS.replace("-", ""), "") if a[0] == "lsblk" else ("1", "")
        with self.assertRaisesRegex(ValueError, "read-only"):
            self.backend.device(EBS, 10)

    def test_missing_or_small_device_not_ready(self):
        self.backend.exists = lambda path: False
        self.assertIsNone(self.backend.device(EBS, 10))
        self.backend.exists = lambda path: True
        self.assertIsNone(self.backend.device(EBS, 12))

    def test_size_boolean_and_shrink_rejected(self):
        for size in (True, 0, -1, "10"):
            with self.subTest(size=size), self.assertRaises(ValueError):
                self.backend.create(dict(self.volume, size=size))
        with self.assertRaises(ValueError): self.backend.extend(self.volume, 9)
        self.ec2.modify_volume.assert_not_called()

    def test_resize_retry_does_not_issue_duplicate_modify(self):
        self.disk['Tags'].append({'Key':'XRegionResizeTargetGiB','Value':'12'})
        self.ec2.describe_volumes_modifications.return_value = {"VolumesModifications": [
            {"ModificationState": "modifying", "TargetSize": 12}]}
        with self.assertRaises(TimeoutError): self.backend.extend(self.volume, 12)
        self.ec2.modify_volume.assert_not_called()

    def test_first_resize_with_no_modification_history(self):
        self.ec2.describe_volumes_modifications.side_effect = ClientError(
            {'Error': {'Code': 'InvalidVolumeModification.NotFound'}}, 'DescribeVolumesModifications')
        def resize(**kwargs): self.disk['Size'] = kwargs['Size']
        self.ec2.modify_volume.side_effect = resize
        self.backend.extend(self.volume, 12)
        self.ec2.modify_volume.assert_called_once_with(VolumeId=EBS, Size=12)
        self.ec2.create_tags.assert_called_once_with(Resources=[EBS],Tags=[{'Key':'XRegionResizeTargetGiB','Value':'12'}])

    def test_second_resize_rejected_after_restart_even_when_first_completed(self):
        self.disk['Size']=12
        self.volume['size']=12
        self.disk['Tags'].append({'Key':'XRegionResizeTargetGiB','Value':'12'})
        with self.assertRaisesRegex(ValueError,'single resize'):
            self.backend.extend(self.volume,14)
        self.ec2.modify_volume.assert_not_called()
        self.ec2.create_tags.assert_not_called()

    def test_resize_conflict_rejected(self):
        self.ec2.describe_volumes_modifications.return_value = {"VolumesModifications": [
            {"ModificationState": "optimizing", "TargetSize": 13}]}
        with self.assertRaises(ValueError): self.backend.extend(self.volume, 12)
        self.ec2.modify_volume.assert_not_called()

    def test_access_denied_is_not_absence(self):
        self.ec2.describe_volumes.side_effect = ClientError({"Error": {"Code": "UnauthorizedOperation", "Message": "denied"}}, "DescribeVolumes")
        with self.assertRaises(ClientError): self.backend.describe(EBS)

    def test_delete_refuses_cinder_attachment(self):
        with self.assertRaises(ValueError): self.backend.delete(dict(self.volume, volume_attachment=[{"id": "a"}]))
        self.ec2.detach_volume.assert_not_called()
        self.ec2.delete_volume.assert_not_called()

    def test_delete_requires_not_found_not_accepted(self):
        with self.assertRaises(TimeoutError): self.backend.delete(self.volume)
        self.ec2.delete_volume.assert_called_once_with(VolumeId=EBS)

    def test_foreign_attached_volume_never_detached(self):
        self.disk["Attachments"] = [{"InstanceId": "i-other", "State": "attached", "Device": "/dev/sdf"}]
        with self.assertRaises(ValueError): self.backend.delete(self.volume)
        self.ec2.detach_volume.assert_not_called()
