# EBS 1:1 cutover — execution record

## Authorization and boundaries

The user approved the complete plan and deletion of all old XRegion Nova VMs,
including dd and the old canary, all old Cinder volumes/pool, and independently
owned legacy EBS data disks. Preserve the EC2 host, root EBS, OpenStack control
plane, Glance images, shared infrastructure and backups. New Cinder volumes use
one encrypted gp3 EBS each; target three reserve volumes per image.

The user confirmed an existing 80 GiB root snapshot, requested no new backup
snapshot, and explicitly accepted loss of data created after 09:58 UTC+7 on
2026-11-09 (including ac and vv). This supersedes earlier dd/canary protection
for this cleanup only; ordinary lifecycle guards must remain enabled.

Latest instruction: `ko cần quan tâm bản backup`. Backup verification is waived;
do not restore a temporary disk or create a new snapshot. Existing snapshots stay
preserved. This does not waive the EBS canary or exact ownership checks.

Resize constraint: each volume may grow once in its lifetime. Before ModifyVolume,
the driver records immutable target tag `XRegionResizeTargetGiB`; IAM permits that
tag only when absent. Retrying the same target reconciles the original resize;
another target is refused, including after service restart. A host lock serializes
resize. This policy must be deployed and proved before reopening admission.

## Verified live preflight

- Account `291634989063`, profile `btl`, IAM user `lam`, Sydney `ap-southeast-2`.
- Sandbox hides credentials and blocks network; STS succeeds outside sandbox.
  Do not infer that the profile is missing from the sandbox error alone.
- Host `i-056d7f3dd24156234`, `t3a.xlarge`, AZ `ap-southeast-2a`.
- Only attached EBS: root `vol-0b788d4555b67eb67`. Historical eight extra disks
  are absent; do not select them from historical inventory.
- Snapshot `snap-07eee45b762f32f44`: completed, 80 GiB, created
  2026-11-09T02:58:13.760Z (09:58 UTC+7). A completed snapshot has not yet
  been independently restored/read to verify the Cinder backing file.
- Actual Cinder is `26.3.1.dev1`, image
  `quay.io/openstack.kolla/cinder-volume:2025.1-ubuntu-noble`, backend `lvm-1`.
  The original report's 2024.1 assumption is stale.
- Host root filesystem: 77 GiB, 57 GiB used, 20 GiB available at preflight.
- Inventory: 4 Nova VMs, 12 Cinder volumes in the old VG; no selected legacy
  independent EBS, no ambiguous selected Nova, no unidentified attached EBS.

| Nova name | Nova UUID |
| --- | --- |
| vv | 21879968-9210-4cb7-a3f7-f156c89f8af7 |
| ac | 95939681-7313-4df0-b1c6-5d03e1bc9eaa |
| old canary | 1c2bd72f-a278-4e9a-9921-c3c631c03154 |
| dd | efdca890-184e-435a-96b3-fe64bcd1d568 |

## Artifacts and current status

Runtime artifacts: `%TEMP%/xregion-ebs-cutover-20261109`.
Keep this directory through acceptance; it contains deployment/rollback evidence
and may contain sensitive configuration. No ZIP/payload scratch belongs in repo.

`legacy-baseline.json` and `legacy-manifest.json` describe the actual resource set.
`storage-host-compatibility.json` records image/version/mounts. The IAM baseline
was generated with iam-policy-autopilot 0.4.0; it needs resource/tag scoping and
validation before deployment. Baseline generation does not prove deployability.

Live execution update:

- 113 Python tests pass. Driver constructor/target ABI verified with actual Cinder.
- Dedicated assume role and scoped EBS policy installed, validated and read back.
  Driver no longer needs ModifyInstanceAttribute; it confirms data attachment
  DeleteOnTermination=false rather than changing EC2 host attributes.
- Separate `cinder_volume_ebs` deployed, service/driver initialized and scheduler
  reports backend `aws-ebs`: budget 100 GiB, 24 free data attachment slots before
  canary. Existing `cinder_volume` remains available for legacy deletion.
- Admission is now maintenance; both pool managers have reserved concurrency 0.
  Frozen live inventory is under the `live` child artifact directory: 4 Nova VMs,
  12 legacy Cinder volumes, no unresolved selected resources.
- Seven Lambda functions deployed and ZIP hashes read back: CheckPool,
  AllocateResource, BootNova, SyncDynamoDB, ExtendVolume, DeleteVolume, PoolManager.
- Two failed EBS canary volumes were deleted through Cinder. Third create under
  test: `1d5c6f68-003a-49aa-8256-345a88847f4a`. Earlier failures exposed IAM host
  attribute and rootwrap read-only filter requirements; both source fixes deployed.
- No legacy VM/volume has been deleted. Canary boot/extend/connectivity/terminate,
  full cleanup, retirement, reopening and 30 minute monitoring remain outstanding.

## Continuation gates

1. Finish driver/operator tests and verify against the actual Cinder interpreter.
2. Validate scoped IAM, attachment limits, gp3 quotas and Sydney cost estimate.
3. Backup verification waived by the user; preserve existing snapshots.
4. Freeze admission and both pool managers, drain executions; preserve prior config.
5. Deploy backend alongside LVM temporarily, then prove the new EBS canary lifecycle.
6. Only after EBS canary evidence, apply the exact legacy manifest with checkpoints.
7. Confirm physical absence, reconcile tombstones/claims, retire loopback dependency
   and backing file after holders/user LVs are absent.
8. Replenish three EBS reserves per image, reopen admission, observe 30 minutes.

The cleanup operator's validation must not be bypassed by setting arbitrary success
flags. Never substitute historical canary evidence for an EBS-backed canary.
