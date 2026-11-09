# Launch event contract

Deployed to account `291634989063`, region `ap-southeast-2`, with profile `btl`
on 2026-11-09 (Asia/Saigon). Sources were based on the deployed functions and
workflow, not the undeployed `serverless/phase1` candidate.

- The event carries `size_gb`, `image_id` and `username`.
- `ebs_size_gb`, `image_name` and `user` are removed from the launch event.
- `username` is the login name, not a user ID. Ownership remains persisted by
  the backend before the event is sent; no `user_id` is invented or added.
- REST request property `ebsSizeGb` remains supported.
- ExtendVolume uses `size_gb` with the existing 10 GB default. The workflow
  no longer maps `ebs_size_gb`.

## Verification

Run `python -m unittest discover -s serverless/launch-contract/tests -v`
and Maven test `EventBridgeGatewayClientTest`. Python tests mock boto3 and
OpenStack; they do not create resources.

Initial contract validation: 3 Python tests passed; 3 Java tests passed in
`EventBridgeGatewayClientTest` (`BUILD SUCCESS`). `git diff --check` passed.

AWS definition validation returned `OK`. Deployed Lambda ZIP contents and
the deployed state-machine definition were read back and matched these sources.
No VM launch was invoked. Backend deployment/restart was not performed.

Deployment revisions for the initial contract change:

- Lambda: `395fd01f-0a4d-454c-b149-29eda12285f3`
- State machine: `b19f8234-fc6b-4fc2-bcdb-8b2b7f7c07bc`

The subsequent EIP repair updates this workflow further. See
[NETWORK-REPAIR.md](NETWORK-REPAIR.md) for current revisions, verification,
recovery information and the unresolved OpenStack MAC forwarding issue.

## Recovery

Original ZIP, Lambda configuration and state-machine definition are retained in
`C:\Users\tuanl\AppData\Local\Temp\xregion-launch-contract-ddda1208485a402a9ddc78a033ba80bd`.
Keep this directory until acceptance. It contains sensitive configuration and
is not intended for source control.

If the new backend has been released, restore the producer first, then restore
the original workflow definition and Lambda ZIP. Verify the account, current
revisions and any intervening changes before restoring. Historical snapshots
and the phase1 candidate were not modified.
