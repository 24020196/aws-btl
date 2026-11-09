# EIP repair and launch failure handling

Profile `btl`, account `291634989063`, region `ap-southeast-2`.
Updated 2026-11-09, Asia/Saigon.

## Applied changes

- Historical VM `abc` is terminated. The current EIP owner is VM `dd`,
  instance `i-33d89d60`, Nova `efdca890-184e-435a-96b3-fe64bcd1d568`.
- Nova and Neutron confirmed its active port and `10.20.1.226` address.
- Registered `10.20.1.226` on `eni-091eaee3e69e3f42d` without reassignment.
- Associated `16.178.34.111` / `eipalloc-06e7654d7aa626490` with that IP.
  Association ID: `eipassoc-02154720abf389e78`.
- Added ICMP type 8, code 0 from `0.0.0.0/0` to `sg-0cd9aa0a1804aba43`.
  Added rule ID: `sgr-0e7324d3db7d63566`. Other rules were preserved.
- AssignSecurityGroup now validates claim ownership and subnet, rejects
  conflicting associations, registers the IP before association, verifies the
  result, and safely handles retries. Nova/Neutron errors propagate.
- LaunchInstance passes `instance_id` to the network task. Network or metadata
  sync failures enter MarkNetworkFailure without reading `network_result`.
- SyncDynamoDB failure mode updates an existing instance to FAILED, retaining
  ownership fields and resource IDs for reconciliation. Its original success
  path is unchanged. Failure does not delete allocated resources.
- Existing `size_gb` contract changes remain in place. No phase1 bundle or IAM
  change was deployed; no VM was created or deleted.

## Verification and outstanding connectivity

ASL validation returned OK. All 23 Python tests passed, using mocked
AWS/OpenStack APIs. `git diff --check` passed.
The Java contract test passed all 3 tests. A direct call of the deployed
AssignSecurityGroup for `dd` returned SECURITY_GROUP_ASSIGNED with no function
error and the existing Neutron SG `65d68240-ebf7-4462-8560-84c59b73227e`.

**Connectivity has not passed acceptance:** the last client ping sent 10 packets
and received 0. Do not interpret successful EIP association or the Lambda result
as proof of guest reachability.

Bounded capture on ens6 showed all 10 client Echo Requests arriving for
`10.20.1.226`, with destination MAC `02:ff:e3:85:1a:d3` (the AWS ENI MAC).
Neutron's guest MAC is `fa:16:3e:39:32:cc`.

Read-only OVS traces with ICMP type 8, code 0 and TTL 64 distinguished the paths:

- Actual ENI destination MAC: datapath output 3, the internal br-ex port;
  no output to the guest tap.
- Guest destination MAC: datapath output 4, `tape6d720fe-b9`, the VM port.

This identifies an additional Layer 2 forwarding mismatch after AWS ingress.
No manual OVS flow, bridge, host route, guest MAC or port-security change was
applied. A further repair must address both ingress MAC delivery and return
traffic, coexist with OVN-managed flows, and survive host/container restart.

## Deployed revisions

- SyncDynamoDB: `618c6f4f-4a97-42f2-b733-7e9fc72dc789`
- LaunchInstance: `b4040160-239c-4f25-b556-ce2863e5e0ab`
- AssignSecurityGroup: `d46bdf29-cd4e-42e5-bacf-6caedcf34054`

Both Lambda packages and the workflow were read back and matched these sources.

## Recovery

Original Lambda packages/configuration, workflow, SG, ENI and EIP state,
deployment results and diagnostic evidence remain in OS Temp:
`C:\Users\tuanl\AppData\Local\Temp\xregion-eip-20261109T001552`.
Keep this backup until acceptance; it contains sensitive configuration.

To undo the network repair, verify current claim and association ownership,
disassociate only `eipassoc-02154720abf389e78`, then unassign only secondary
IP `10.20.1.226`, and remove only added rule `sgr-0e7324d3db7d63566`.
Do not release the EIP or remove any pre-existing address/rule.

For code rollback, restore AssignSecurityGroup first, the original workflow
second, and SyncDynamoDB last. Verify revisions and intervening changes first.
The previous workflow requires no failure mode, so this order remains compatible.
