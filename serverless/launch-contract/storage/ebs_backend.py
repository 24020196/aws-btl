"""One tagged, encrypted EBS device per Cinder volume; no LVM operations.

AWS calls and privileged device operations are injected, allowing tests without
AWS credentials or access to a block device. Ambiguous AWS errors propagate.
"""
import re
import os
import time
import uuid

from botocore.exceptions import ClientError


BACKEND = "aws-ebs"
VOLUME_TYPE = "aws-ebs-gp3"
MANAGED_BY = "xregion-cinder-ebs-v1"
GIB = 1024 ** 3


def volume_uuid(value):
    return str(uuid.UUID(str(value)))


def ebs_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"vol-(?:[0-9a-f]{8}|[0-9a-f]{17})", value):
        raise ValueError("Invalid EBS volume ID")
    return value


class EbsBackend:
    def __init__(self, ec2, *, account, host_id, region, execute, timeout=600,
                 sleep=time.sleep, clock=time.monotonic, exists=os.path.exists):
        if region != "ap-southeast-2" or account != "291634989063":
            raise ValueError("Unexpected storage account or region")
        self.ec2, self.account, self.host_id = ec2, account, host_id
        self.region, self.execute, self.timeout = region, execute, timeout
        self.sleep, self.clock = sleep, clock
        self.exists = exists

    def host(self):
        host = self.ec2.describe_instances(InstanceIds=[self.host_id])["Reservations"][0]["Instances"][0]
        if host["InstanceId"] != self.host_id:
            raise ValueError("Unexpected EC2 storage host")
        return host

    def tags(self, volume):
        return {"ManagedBy": MANAGED_BY, "CinderVolumeId": volume_uuid(volume["id"]),
                "CinderProjectId": str(volume["project_id"]), "StorageBackend": BACKEND,
                "StorageHostId": self.host_id}

    def describe(self, ident):
        try:
            return self.ec2.describe_volumes(VolumeIds=[ebs_id(ident)])["Volumes"][0]
        except ClientError as error:
            if error.response["Error"]["Code"] == "InvalidVolume.NotFound":
                return None
            raise

    def owned(self, volume, disk):
        if disk["AvailabilityZone"] != self.host()["Placement"]["AvailabilityZone"]:
            raise ValueError("EBS is outside the storage host AZ")
        actual = {t["Key"]: t["Value"] for t in disk.get("Tags", [])}
        if any(actual.get(k) != v for k, v in self.tags(volume).items()):
            raise ValueError("EBS ownership mismatch")
        host = self.host()
        root = {b["Ebs"]["VolumeId"] for b in host["BlockDeviceMappings"]
                if b["DeviceName"] == host["RootDeviceName"] and "Ebs" in b}
        if disk["VolumeId"] in root:
            raise ValueError("Root device must never be managed by Cinder")
        if not disk.get("Encrypted") or disk.get("VolumeType") != "gp3":
            raise ValueError("Expected an encrypted gp3 device")
        if any(a["InstanceId"] != self.host_id for a in disk.get("Attachments", [])):
            raise ValueError("EBS is attached to another host")
        return disk

    def find(self, volume):
        ident = volume.get("provider_id")
        if ident:
            disk = self.describe(ident)
            return self.owned(volume, disk) if disk else None
        matches = []
        filters = [{"Name": "tag:" + k, "Values": [v]} for k, v in self.tags(volume).items()]
        for page in self.ec2.get_paginator("describe_volumes").paginate(Filters=filters):
            matches.extend(page["Volumes"])
        if len(matches) > 1:
            raise ValueError("Multiple EBS devices for one Cinder volume")
        return self.owned(volume, matches[0]) if matches else None

    def wait(self, operation, predicate):
        deadline = self.clock() + self.timeout
        while self.clock() < deadline:
            result = predicate()
            if result:
                return result
            self.sleep(2)
        raise TimeoutError(operation + "; reconcile the existing EBS operation before retry")

    def create(self, volume, snapshot_id=None):
        size = volume["size"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 1:
            raise ValueError("Size must be a positive integer GiB")
        disk = self.find(volume)
        if disk is None:
            if volume.get("provider_id"):
                raise ValueError("Mapped EBS device disappeared; refusing replacement")
            # Atomic tags and a stable token cover a lost CreateVolume response.
            options = {"SnapshotId": snapshot_id} if snapshot_id else {}
            disk = self.ec2.create_volume(Size=size, VolumeType="gp3", Encrypted=True,
                AvailabilityZone=self.host()["Placement"]["AvailabilityZone"],
                ClientToken="xregion-" + volume_uuid(volume["id"]),
                TagSpecifications=[{"ResourceType": "volume", "Tags": [
                    {"Key": k, "Value": v} for k, v in self.tags(volume).items()]}], **options)
        disk = self.owned(volume, disk)
        if disk["Size"] < size:
            raise ValueError("Existing EBS device is smaller than the Cinder request")
        ident = disk["VolumeId"]
        self.wait("CreateVolume", lambda: self.ready(volume, ident))
        return {"provider_id": ident}

    def ready(self, volume, ident):
        disk = self.describe(ident)
        if disk:
            self.owned(volume, disk)
            if disk["State"] in ("available", "in-use"):
                return disk
        return None

    def attach(self, volume):
        disk = self.find(volume)
        if disk is None:
            raise ValueError("Cinder has no existing EBS mapping")
        ident = disk["VolumeId"]
        if not disk.get("Attachments"):
            host = self.host()
            used = {b["DeviceName"] for b in host["BlockDeviceMappings"]}
            device = next(("/dev/sd" + c for c in "fghijklmnopqrstuvwxyz"
                           if "/dev/sd" + c not in used), None)
            if device is None:
                raise RuntimeError("No free attachment device name")
            self.ec2.attach_volume(VolumeId=ident, InstanceId=self.host_id, Device=device)

        def attached():
            current = self.describe(ident)
            if current is None:
                return None
            self.owned(volume, current)
            return next((a for a in current.get("Attachments", [])
                         if a["InstanceId"] == self.host_id and a["State"] == "attached"), None)

        attachment = self.wait("AttachVolume", attached)
        # AttachVolume preserves data disks by default. Confirm that property
        # rather than granting the driver permission to modify host attributes.
        if not any(b.get("Ebs", {}).get("VolumeId") == ident and
                   b["Ebs"].get("DeleteOnTermination") is False
                   for b in self.host()["BlockDeviceMappings"]):
            raise RuntimeError("DeleteOnTermination=false was not confirmed")
        return self.wait("Discover EBS NVMe device", lambda: self.device(ident, disk["Size"]))

    def device(self, ident, size):
        ident = ebs_id(ident)
        path = "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_" + ident.replace("-", "")
        if not self.exists(path):
            return None
        # The serial and byte count protect image-copy operations from a stale link.
        try:
            serial, _ = self.execute("lsblk", "--nodeps", "--noheadings", "--output", "SERIAL", path, run_as_root=True)
        except FileNotFoundError:
            return None
        if serial.strip() != ident.replace("-", ""):
            raise ValueError("NVMe serial does not match the mapped EBS ID")
        readonly, _ = self.execute("blockdev", "--getro", path, run_as_root=True)
        if readonly.strip() != "0":
            raise ValueError("EBS block device is read-only")
        count, _ = self.execute("blockdev", "--getsize64", path, run_as_root=True)
        if int(count.strip()) < size * GIB:
            return None
        return path

    def extend(self, volume, target):
        if isinstance(target, bool) or not isinstance(target, int) or target < volume["size"]:
            raise ValueError("EBS shrink is not supported")
        disk = self.find(volume)
        if disk is None:
            raise ValueError("Missing EBS mapping")
        ident = disk["VolumeId"]
        resize_target = {t['Key']: t['Value'] for t in disk.get('Tags', [])}.get('XRegionResizeTargetGiB')
        if resize_target is not None and resize_target != str(target):
            raise ValueError('This volume has already used its single resize')
        if disk["Size"] < target:
            try:
                changes = self.ec2.describe_volumes_modifications(VolumeIds=[ident]).get("VolumesModifications", [])
            except ClientError as error:
                if error.response['Error']['Code'] != 'InvalidVolumeModification.NotFound':
                    raise
                changes = []
            if resize_target is None:
                if changes:
                    # Volumes resized before the durable marker was introduced
                    # are also ineligible for another resize.
                    raise ValueError('Existing EBS modification history: single resize already used')
                # Written before ModifyVolume. IAM permits this tag only when
                # absent; retries may reconcile this target, never choose another.
                self.ec2.create_tags(Resources=[ident],Tags=[{'Key':'XRegionResizeTargetGiB','Value':str(target)}])
            active = [c for c in changes if c["ModificationState"] in ("modifying", "optimizing")]
            if active and any(c["TargetSize"] != target for c in active):
                raise ValueError("Another EBS resize is still in progress")
            if not active:
                self.ec2.modify_volume(VolumeId=ident, Size=target)
        self.wait("ModifyVolume", lambda: self.owned(volume, self.describe(ident))["Size"] >= target)
        self.wait("NVMe resize", lambda: self.device(ident, target))

    def delete(self, volume):
        disk = self.find(volume)
        if disk is None:
            if not volume.get("provider_id"):
                raise ValueError("Unresolved create identity; reconcile before confirming deletion")
            return
        if volume.get("volume_attachment") or volume.get("attachments"):
            raise ValueError("Cinder still has volume attachments")
        ident = disk["VolumeId"]
        for attachment in disk.get("Attachments", []):
            if attachment["State"] != "detaching":
                self.ec2.detach_volume(VolumeId=ident, InstanceId=self.host_id,
                                       Device=attachment["Device"], Force=False)
        self.wait("DetachVolume", lambda: self.detached(volume, ident))
        current = self.describe(ident)
        if current and current["State"] != "deleting":
            self.owned(volume, current)
            self.ec2.delete_volume(VolumeId=ident)
        self.wait("DeleteVolume", lambda: self.describe(ident) is None)

    def detached(self, volume, ident):
        disk = self.describe(ident)
        if disk is None:
            return True
        self.owned(volume, disk)
        return not disk.get("Attachments") and disk["State"] in ("available", "deleting")

    def snapshot_tags(self, snapshot, volume):
        return dict(self.tags(volume), CinderSnapshotId=volume_uuid(snapshot["id"]))

    def snapshot(self, snapshot, volume):
        tags = self.snapshot_tags(snapshot, volume)
        matches = []
        for page in self.ec2.get_paginator("describe_snapshots").paginate(OwnerIds=[self.account],
                Filters=[{"Name": "tag:" + k, "Values": [v]} for k, v in tags.items()]):
            matches.extend(page["Snapshots"])
        if len(matches) > 1:
            raise ValueError("Multiple EBS snapshots for a Cinder snapshot")
        if not matches:
            return None
        found = matches[0]
        actual = {t["Key"]: t["Value"] for t in found.get("Tags", [])}
        if found.get("OwnerId") != self.account or any(actual.get(k) != v for k, v in tags.items()):
            raise ValueError("EBS snapshot ownership mismatch")
        if snapshot.get("provider_id") and snapshot["provider_id"] != found["SnapshotId"]:
            raise ValueError("Cinder snapshot provider_id mismatch")
        return found

    def create_snapshot(self, snapshot, volume, before_post):
        disk = self.find(volume)
        if disk is None:
            raise ValueError("Cannot snapshot an absent EBS device")
        found = self.snapshot(snapshot, volume)
        if found is None:
            # CreateSnapshot has no client token. A durable attempt marker prevents
            # duplicate snapshots after an ambiguous response or driver restart.
            if not before_post(volume_uuid(snapshot["id"])):
                raise RuntimeError("Ambiguous CreateSnapshot; reconcile existing attempt")
            found = self.ec2.create_snapshot(VolumeId=disk["VolumeId"],
                Description="Cinder " + volume_uuid(snapshot["id"]),
                TagSpecifications=[{"ResourceType": "snapshot", "Tags": [
                    {"Key": k, "Value": v} for k, v in self.snapshot_tags(snapshot, volume).items()]}])
        ident = found["SnapshotId"]

        def complete():
            current = self.snapshot(dict(snapshot, provider_id=ident), volume)
            if current and current["State"] == "error":
                raise RuntimeError("EBS snapshot entered error")
            return current if current and current["State"] == "completed" else None

        self.wait("CreateSnapshot", complete)
        return {"provider_id": ident}

    def delete_snapshot(self, snapshot, volume):
        found = self.snapshot(snapshot, volume)
        if found:
            self.ec2.delete_snapshot(SnapshotId=found["SnapshotId"])
            self.wait("DeleteSnapshot", lambda: self.snapshot(snapshot, volume) is None)
