# Lifecycle recovery acceptance - 2026-11-09

Times below are Asia/Saigon (UTC+7). Account `291634989063`, profile `btl`, region `ap-southeast-2`.

## Measured result

- Exactly one new backend launch POST created `i-55936365`, named `ping-test-lifecycle-20261109-102154`.
- Launch succeeded at 10:30:24.086; the backend reported RUNNING and the network mapping was ACTIVE.
- Nova: `b0e2605c-726d-4e79-bfd3-fb586b4d4117`; guest `192.168.100.37`; gateway frontend `10.20.1.11`.
- Actual EIP `52.62.141.42`: client ping received 10/10 replies, 0% loss, average 225 ms. TCP 22 returned an OpenSSH banner. Authenticated SSH was not tested.
- Final terminate succeeded at 10:52:19.933; the backend reported TERMINATED.
- Independent authenticated OpenStack reads confirmed Nova, Neutron port, dedicated SG and Cinder volume absent. The Cinder LV was also absent.
- NAT entries, frontend address and reservation claims were removed. The EIP remained allocated to the project, unassociated and without claim tags.
- Protected backend records were unchanged. dd remained ACTIVE with its original volume, port, MAC, IP and EIP association. The old canary remained SHUTOFF with its original boot volume.
- Pool manager code/configuration and EventBridge targets were unchanged. Before/after inventories found no additional retained pool volumes or EIP allocations. Volume comparison uses the initial VG UUID inventory, because the initial CLI volume list was scoped to admin rather than the service project. Maintenance remains enabled and the temporary canary allowlist is closed.

Launch execution:

`arn:aws:states:ap-southeast-2:291634989063:execution:LaunchInstance:d4c526b8-e1a9-b155-4381-4c9137ec5c4d_949f844e-48bd-d2cf-90e7-c4d753c5ee2b`

Final terminate execution:

`arn:aws:states:ap-southeast-2:291634989063:execution:TerminateInstance:e50604c8-d240-3d74-7d8d-7f0a0daa0e67_625605e9-9524-28a6-261c-07cf6c2e9b1a`

## Implemented behavior

- Release has conditional, generation-fenced cleanup checkpoints. Claims remain until the transaction marking the mapping DELETED. Missing ownership tags are accepted only after the durable tag-removal checkpoint with matching claims and generation.
- DeleteTags includes expected values; primary ENI addresses and attached Neutron ports cannot be removed.
- Dispatch carries the current generation into downstream states. CheckCommand accepts a completed, verified REMOVE after its old deadline, while unfinished commands still time out.
- A terminate retry skips already committed network cleanup instead of requiring claims that were correctly released.
- DeleteVolume is a managed standalone artifact. It distinguishes the DynamoDB key from the storage UUID, validates current ownership and attachments, waits for physical absence, and retains the existing owned DELETED record.
- Both terminate paths poll volume cleanup every five seconds with a five-minute deadline. Errors cannot reach successful final synchronization.
- TerminateSync requires a matching volume receipt and uses conditional instance/Nova transactions for NAT instances.
- AllocateResource has a read-only diagnostic path. The original post-VPC-fix probe succeeded against Keystone, Cinder and AWS APIs.
- NetworkLambdaRole gained only GetItem on the main instance table. The source policy includes the same permission.
- Packaging preserves an existing legacy module and refuses to wrap the dispatcher as its own legacy handler. Deployments use explicit stages, revision checks, ZIP/config backups and byte-for-byte readback.

## Failures resolved during acceptance

Three terminate requests were made for the same canary; no second launch POST or additional VM was created.

1. The first terminate failed after Nova deletion and EIP disassociation. boto3's generated condition values (`:v0`, etc.) collided with checkpoint update values. The fix uses a separate update namespace (`:u0`, etc.). A regression test now inspects actual SDK-serialized DynamoDB requests. The exact malformed checkpoint was backed up and repaired conditionally; all ownership claims remained intact.
2. The second terminate failed because CheckCommand rejected the already successful REMOVE using its expired original deadline. The fixed handler reads the command result and validates the applied generation before considering a deadline for a still-running command.
3. The final backend retry completed cleanup and passed independent resource verification. The two FAILED executions and their histories remain available as evidence; neither was redriven from its terminal Fail state.

Guest networking became ready only near the end of the existing VERIFY window during cold boot. Console output and ARP capture identified boot progress, not a reason to open additional firewall rules. No timeout was increased.

## Validation and artifacts

- 65 Python tests pass, including partial-effect recovery, actual boto3 expression serialization, storage identity/ownership, asynchronous volume deletion, pool inventory and duplicate-launch guards.
- 27 focused Java tests pass; both UI JavaScript files pass `node --check`; `git diff --check` passes.
- The canary used 10 GB. Live volume expansion, reboot persistence, authenticated SSH and live termination of a legacy VM were not tested.
- No snapshot was created, no dd filesystem was edited, no Docker/host restart was performed and no admission was opened generally.

Evidence and rollback directory:

`C:\Users\tuanl\AppData\Local\Temp\xregion-lifecycle-20261109-implementation`

Important files: `preflight.json`, `deployment-result.json`, `TerminateInstance-after.json`, `connectivity.json`, `final-verification.json`, `check-pool-admission-after.json`, execution histories, protected-resource before/after records and `operations.jsonl`.

ZIPs, configurations and sessions in OS Temp can contain secrets. Keep them out of the repository. Retain rollback backups through acceptance.

`deployment/lifecycle.py` is the guarded operator tool for this recorded recovery. The artifact directory is a completed run and must not be reused to create another canary. Its launch marker prevents another POST after an ambiguous response; terminate recovery requires a confirmed terminal failure. A future run needs a fresh live baseline and an available probe volume, not the now-deleted test volume from this run.

Rollback code/configuration only after confirming no conflicting execution. Preserve checkpoint and ownership evidence; code rollback cannot restore the intentionally deleted canary volume.
