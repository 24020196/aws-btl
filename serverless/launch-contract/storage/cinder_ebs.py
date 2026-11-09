"""Private Cinder driver: storage.cinder_ebs.XRegionEbsDriver.

Install the storage package into a version-pinned Kolla cinder-volume image.
Live compatibility and target recovery MUST pass before routing any launches.
"""
import socket
from pathlib import Path

import boto3
import botocore.session
from botocore.config import Config
from oslo_config import cfg
from oslo_concurrency import lockutils
from oslo_utils import importutils

from cinder import exception, interface
from cinder.image import image_utils
from cinder.volume import driver, volume_utils

from storage.ebs_backend import EbsBackend, BACKEND, MANAGED_BY, volume_uuid


OPTS = [
    cfg.StrOpt("xregion_ebs_region", default="ap-southeast-2"),
    cfg.StrOpt("xregion_ebs_account", default="291634989063"),
    cfg.StrOpt("xregion_ebs_host_id", required=True),
    cfg.StrOpt("xregion_ebs_profile", default="xregion-ebs"),
    cfg.StrOpt("xregion_ebs_aws_config", default="/etc/cinder/xregion-aws-config"),
    cfg.IntOpt("xregion_ebs_timeout", default=600, min=1),
    cfg.IntOpt("xregion_ebs_capacity_gib", default=0, min=0,
               help="Explicit approved storage budget; zero prevents scheduling."),
    cfg.IntOpt("xregion_ebs_max_attached_volumes", default=0, min=0,
               help="Verified host EBS attachment limit; zero prevents scheduling."),
]


@interface.volumedriver
class XRegionEbsDriver(driver.VolumeDriver):
    VERSION = "0.1.0"
    # Private driver: no upstream CI/support claim.
    SUPPORTED = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.configuration.append_config_values(OPTS)
        self.target_driver = importutils.import_object(
            self.target_mapping[self.configuration.target_helper],
            configuration=self.configuration, executor=self._execute)
        self.backend_name = self.configuration.safe_get("volume_backend_name") or BACKEND
        self._stats = {}

    def do_setup(self, context):
        provider = botocore.session.get_session()
        provider.set_config_variable("config_file", self.configuration.xregion_ebs_aws_config)
        session = boto3.Session(profile_name=self.configuration.xregion_ebs_profile,
                                region_name=self.configuration.xregion_ebs_region,
                                botocore_session=provider)
        identity = session.client("sts").get_caller_identity()
        account = identity["Account"]
        if not identity["Arn"].startswith("arn:aws:sts::291634989063:assumed-role/XRegion-CinderEbsRole/"):
            raise ValueError("The dedicated Cinder EBS role was not assumed")
        self.backend = EbsBackend(session.client("ec2", config=Config(
            connect_timeout=5, read_timeout=20,
            retries={"mode": "standard", "total_max_attempts": 3})),
            account=account, region=self.configuration.xregion_ebs_region,
            host_id=self.configuration.xregion_ebs_host_id, execute=self._execute,
            timeout=self.configuration.xregion_ebs_timeout)
        self.backend.host()

    def check_for_setup_error(self):
        if self.configuration.target_helper != "tgtadm":
            raise exception.InvalidInput(reason="Only the existing tgtadm target is validated by this driver")
        if not self.configuration.xregion_ebs_capacity_gib or not self.configuration.xregion_ebs_max_attached_volumes:
            raise exception.InvalidInput(reason="Set verified capacity and attachment budgets before enabling EBS")

    @staticmethod
    def record(volume):
        # Cinder VersionedObjects are not ordinary dicts.
        return {key: volume.get(key) for key in
                ("id", "project_id", "provider_id", "size", "volume_attachment", "attachments")}

    @lockutils.synchronized("xregion-ebs-create", external=True, lock_path="/var/lib/cinder/xregion-ebs-locks")
    def create_volume(self, volume):
        if volume.get("multiattach"):
            raise exception.InvalidInput(reason="gp3 multiattach is unsupported")
        stats = self.get_volume_stats(refresh=True)
        if not self.backend.find(self.record(volume)) and (
                stats["free_capacity_gb"] < volume["size"] or stats["free_attachment_slots"] < 1):
            raise exception.VolumeBackendAPIException(data="EBS capacity or attachment budget exhausted")
        return self.backend.create(self.record(volume))

    @lockutils.synchronized("xregion-ebs-attach", external=True, lock_path="/var/lib/cinder/xregion-ebs-locks")
    def local_path(self, volume):
        return self.backend.attach(self.record(volume))

    def create_export(self, context, volume, connector):
        info = self.target_driver.create_export(context, volume, self.local_path(volume))
        return {"provider_location": info["location"], "provider_auth": info["auth"]}

    def ensure_export(self, context, volume):
        return self.target_driver.ensure_export(context, volume, self.local_path(volume))

    def remove_export(self, context, volume):
        return self.target_driver.remove_export(context, volume)

    def initialize_connection(self, volume, connector):
        return self.target_driver.initialize_connection(volume, connector)

    def validate_connector(self, connector):
        return self.target_driver.validate_connector(connector)

    def terminate_connection(self, volume, connector, **kwargs):
        self.target_driver.terminate_connection(volume, connector, **kwargs)
        return False

    def delete_volume(self, volume):
        if volume.get("volume_attachment"):
            raise exception.VolumeIsBusy(volume_name=volume["id"])
        # Target helper refuses an in-use export; AWS detach is never forced.
        self.target_driver.remove_export(volume._context, volume)
        self.backend.delete(self.record(volume))

    @lockutils.synchronized("xregion-ebs-resize", external=True, lock_path="/var/lib/cinder/xregion-ebs-locks")
    def extend_volume(self, volume, new_size):
        # Empty volumes have not passed through image-copy/export yet. Attach
        # before waiting for the physical NVMe device to reflect the new size.
        self.local_path(volume)
        self.backend.extend(self.record(volume), new_size)
        self.target_driver.extend_target(volume)

    def copy_image_to_volume(self, context, volume, image_service, image_id, disable_sparse=False):
        image_utils.fetch_to_raw(context, image_service, image_id, self.local_path(volume),
            self.configuration.volume_dd_blocksize, size=volume["size"], disable_sparse=disable_sparse)

    def copy_volume_to_image(self, context, volume, image_service, image_meta):
        volume_utils.upload_volume(context, image_service, image_meta, self.local_path(volume), volume)

    def create_snapshot(self, snapshot):
        return self.backend.create_snapshot(dict(id=snapshot["id"], provider_id=snapshot.get("provider_id")),
                                            self.record(snapshot.volume), self._snapshot_attempt)

    def _snapshot_attempt(self, ident):
        directory = Path("/var/lib/cinder/xregion-ebs-snapshot-attempts")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            with (directory / volume_uuid(ident)).open("x", encoding="utf-8") as out:
                out.write("CreateSnapshot attempted; preserve until reconciled\n")
        except FileExistsError:
            return False
        return True

    def delete_snapshot(self, snapshot):
        self.backend.delete_snapshot(dict(id=snapshot["id"], provider_id=snapshot.get("provider_id")),
                                     self.record(snapshot.volume))

    def create_volume_from_snapshot(self, volume, snapshot):
        found = self.backend.snapshot(dict(id=snapshot["id"], provider_id=snapshot.get("provider_id")),
                                      self.record(snapshot.volume))
        if not found or found["State"] != "completed" or volume["size"] < found["VolumeSize"]:
            raise exception.InvalidInput(reason="Snapshot is not ready or destination is too small")
        return self.backend.create(self.record(volume), snapshot_id=found["SnapshotId"])

    def create_cloned_volume(self, volume, src_vref):
        if src_vref.get("volume_attachment") or volume["size"] < src_vref["size"]:
            raise exception.InvalidInput(reason="Clone source must be detached and fit the destination")
        update = self.create_volume(volume)
        # A source/destination lookup by tags works before provider_id is committed.
        volume_utils.copy_volume(self.local_path(src_vref), self.local_path(volume),
            src_vref["size"] * 1024, self.configuration.volume_dd_blocksize,
            execute=self._execute, sparse=False)
        return update

    def get_pool(self, volume):
        return self.backend_name

    def get_volume_stats(self, refresh=False):
        if refresh or not self._stats:
            disks = []
            for page in self.backend.ec2.get_paginator("describe_volumes").paginate(Filters=[
                    {"Name": "tag:ManagedBy", "Values": [MANAGED_BY]},
                    {"Name": "tag:StorageHostId", "Values": [self.backend.host_id]}]):
                disks.extend(page["Volumes"])
            host = self.backend.host()
            used = sum(d["Size"] for d in disks)
            # Reserve slots for every backend volume, including volumes not yet attached.
            attached_ids = {b["Ebs"]["VolumeId"] for b in host["BlockDeviceMappings"] if "Ebs" in b}
            own_ids = {d["VolumeId"] for d in disks}
            slots = max(0, self.configuration.xregion_ebs_max_attached_volumes - len(attached_ids | own_ids))
            self._stats = dict(volume_backend_name=self.backend_name, vendor_name="XRegion",
                driver_version=self.VERSION, storage_protocol="iSCSI", thin_provisioning_support=False,
                thick_provisioning_support=True, multiattach=False, reserved_percentage=0,
                total_capacity_gb=self.configuration.xregion_ebs_capacity_gib,
                free_capacity_gb=max(0, self.configuration.xregion_ebs_capacity_gib - used) if slots else 0,
                free_attachment_slots=slots, backend_host=socket.gethostname(), sparse_copy_volume=False)
        return self._stats
