# Cinder recovery and asynchronous backend launch

The 2026-11-09 backend request `i-e4a5b07d` failed at the maintenance gate.
No Nova or EIP was allocated for that request. Its FAILED record is retained.

A separate storage check found `/dev/loop0` read-only although its backing
filesystem was writable. The loop service finished at boot +2.509s, before
root remount started at +2.593s and completed at +2.871s. This is consistent
with losetup falling back to a read-only backing-file open during early boot.

## Recovery controls

- Account `291634989063`, profile `btl`, region `ap-southeast-2`.
- Backing file: `/var/lib/cinder/cinder-volumes.img`; existing VG: `cinder-volumes`.
- Stop guests through Nova and confirm libvirt shutoff before storage changes.
- Preserve existing volume, guest, port, EIP and ownership identities.
- Back up LVM metadata, targets, attachments and service configuration.
- The user confirmed an existing snapshot backup and explicitly requested that
  the new snapshot be stopped. Task snapshot `snap-0029cf5bc2a3b8119` was deleted
  while pending; no further snapshot is created. LVM/configuration backups remain.
- Log out only the recorded Cinder iSCSI sessions. Deactivate the existing VG
  without forcing, reattach the same backing file read-write, then verify VG/LV UUIDs.
- Never run pvcreate, vgcreate, mkfs, or replace the backing file in place.
- If a holder remains or metadata cannot be read, stop and investigate.

The checked-in `gateway/attach-cinder-loop` validates a writable file open,
rejects duplicate or read-only loop devices and activates the existing VG.
Its service runs after filesystem remount and before Docker. The Docker
dependency is a dedicated systemd drop-in; no whole-host reboot is required.

## Launch behavior

`POST /api/instances` returns 202 with PENDING. Requested image and size survive
backend restarts. IPs, volume IDs and security-group IDs remain null until
confirmed; no synthetic allocation addresses are generated.

CheckPool admits only the explicitly configured backend test name while
maintenance remains enabled. Allocation requires an exact image match and
checks Cinder's available/bootable state and volume image metadata. BootNova
uses the reserved port plus ConfigDrive, with existing reservation retry guards.
Failure metadata contains a sanitized error code/message and retains resource claims.

The UI follows status changes and announces readiness only after RUNNING.
The original failed execution must not be blindly redriven from its terminal Fail state.

## Evidence and acceptance

Runtime artifacts are outside the repo in OS Temp:
`xregion-cinder-repair-20261109`. Host recovery files are under
`/var/backups/xregion-cinder-repair-20261109` with restricted permissions.
These include operational logs, before/after resource descriptions and rollback
configuration. They must be retained through acceptance and may contain secrets.

Acceptance requires writable Cinder, restored dd with unchanged attachments,
one backend-created Nova whose launch workflow succeeds, and client ping replies
from its actual EIP. Public ICMP permission alone does not prove connectivity.
## Measured outcome so far

- Loop device reattached with RO=0; existing VG UUID preserved.
- dd restored ACTIVE with Nova ID `efdca890-184e-435a-96b3-fe64bcd1d568`,
  volume `c40b4f0c-8e9d-4cd1-9b3c-ebf9537b85c9`, original port/MAC/IP,
  and EIP association `eipassoc-02154720abf389e78` unchanged.
- Restarting the initial Requires-linked loop service also restarted Docker.
  The control plane recovered. The checked-in Docker drop-in now uses Wants
  and ExecStartPre instead; a second loop-service restart left Docker running.
- Fresh test volume `f084bef1-adc6-4038-baa1-cc56fc55fbbc` was confirmed
  available, bootable, 10 GB, with the requested Ubuntu 24.04 image.
- Exactly one new POST returned 202/PENDING for `i-d47acb27`, with null allocation
  addresses and the correct requested image ID.
- Its execution failed before resource claims: AllocateResource was not VPC-attached
  and its new Keystone validation timed out. VPC configuration has now been
  synchronized with BootNova and read back with LastUpdateStatus=Successful.
- The volume remains AVAILABLE; no reservation or Nova exists for this request.
  The failed execution's launch ownership token remains on the main instance.
- No event replay or second POST has been sent. A controlled backend replay must
  first verify terminal failure and absence of claims, conditionally replace the
  old execution ownership token, and preserve the same instance ID.
- 27 focused Java tests, 40 Python tests, JS syntax and UI pending/ready/failure
  checks passed. End-to-end launch and public ping are not yet accepted.
