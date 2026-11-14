"""Dedicated SyncDynamoDB Lambda for MigrateTargetBoot (SPEC-SF-09 v1.6.0)."""
import json
import logging
import uuid
import time
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)



ROUTE53_HOSTED_ZONE_ID = "Z06312743V4JPQHUPYQDW"
ROUTE53_DOMAIN = "xregion-iaas.online"
ROUTE53_TTL = 60


def instance_dns_name(instance_id):
    return f"{instance_id}.{ROUTE53_DOMAIN}" if instance_id else ""


def upsert_instance_dns(instance_id, public_ip, max_retries=2):
    if not instance_id or not public_ip or str(public_ip).strip() in ("", "Chưa gán", "None"):
        return None
    fqdn = instance_dns_name(instance_id)
    r53 = boto3.client("route53")
    for attempt in range(1, max_retries + 2):
        try:
            r53.change_resource_record_sets(
                HostedZoneId=ROUTE53_HOSTED_ZONE_ID,
                ChangeBatch={
                    "Comment": f"Upsert A record for {instance_id}",
                    "Changes": [{
                        "Action": "UPSERT",
                        "ResourceRecordSet": {
                            "Name": fqdn + ".",
                            "Type": "A",
                            "TTL": ROUTE53_TTL,
                            "ResourceRecords": [{"Value": str(public_ip).strip()}],
                        },
                    }],
                },
            )
            return fqdn
        except Exception as err:
            print(f"Route53 UPSERT {fqdn} attempt {attempt} failed: {err}")
            if attempt <= max_retries:
                time.sleep(1)
    return None


def delete_instance_dns(instance_id, max_retries=2):
    if not instance_id:
        return
    fqdn = instance_dns_name(instance_id) + "."
    r53 = boto3.client("route53")
    for attempt in range(1, max_retries + 2):
        try:
            resp = r53.list_resource_record_sets(
                HostedZoneId=ROUTE53_HOSTED_ZONE_ID,
                StartRecordName=fqdn,
                StartRecordType="A",
                MaxItems="1",
            )
            rrs = resp.get("ResourceRecordSets", [])
            if not rrs or rrs[0].get("Name") != fqdn or rrs[0].get("Type") != "A":
                return
            r53.change_resource_record_sets(
                HostedZoneId=ROUTE53_HOSTED_ZONE_ID,
                ChangeBatch={
                    "Comment": f"Delete A record for {instance_id}",
                    "Changes": [{
                        "Action": "DELETE",
                        "ResourceRecordSet": rrs[0],
                    }],
                },
            )
            return
        except Exception as err:
            print(f"Route53 DELETE {fqdn} attempt {attempt} failed: {err}")
            if attempt <= max_retries:
                time.sleep(1)


def lambda_handler(event, context):
    instance_id = event["instance_id"]
    migration_id = event["migration_id"]
    source_region = event.get("source_region", "ap-southeast-2")
    dest_region = event["dest_region"]
    target_nova_id = event.get("target_nova_id") or event.get("nova_id")
    target_volume_id = event.get("ebs_volume_id") or event.get("target_volume_id") or event.get("volume_id")
    target_eip = event.get("elastic_ip") or event.get("public_ip") or event.get("eip")
    private_ip = event.get("guest_private_ip") or event.get("private_ip")
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    now_sec = int(time.time())

    regions = list(dict.fromkeys([dest_region, source_region, "ap-southeast-2", "us-east-1"]))
    for reg in regions:
        try:
            ddb = boto3.resource("dynamodb", region_name=reg)
            if target_nova_id:
                ddb.Table("XRegion-Nova").put_item(Item={
                    "nova_id": target_nova_id,
                    "instance_id": instance_id,
                    "instance_name": event.get("instance_name", instance_id),
                    "region": dest_region,
                    "flavor": event.get("flavor", "m1.tiny"),
                    "status": "ACTIVE",
                    "volume_id": event.get("cinder_volume_id") or target_volume_id,
                    "ebs_volume_id": target_volume_id,
                    "elastic_ip": target_eip,
                    "public_ip": target_eip,
                    "public_dns": instance_dns_name(instance_id),
                    "private_ip": private_ip,
                    "key_id": event.get("key_id"),
                    "security_group_id": target_nova_id,
                    "created_at": now_sec,
                    "updated_at": now_iso,
                })

            inst_tbl = ddb.Table("XRegion-Instances")
            cur = inst_tbl.get_item(Key={"instance_id": instance_id}).get("Item") or {}
            nova_ids = [str(n) for n in (cur.get("nova_ids") or []) if n]
            if target_nova_id and target_nova_id not in nova_ids:
                nova_ids.append(target_nova_id)

            update_expr = "SET current_region = :reg, requested_region = :reg, current_status = :run, active_nova_id = :nova, nova_ids = :nids, public_dns = :pdns, migration_lock = :lock, last_migration_timestamp = :ts, updated_at = :now"
            expr_vals = {
                ":reg": dest_region,
                ":run": "RUNNING",
                ":nova": target_nova_id,
                ":nids": nova_ids,
                ":pdns": instance_dns_name(instance_id),
                ":lock": False,
                ":ts": now_sec,
                ":now": now_iso,
            }
            if target_volume_id:
                update_expr += ", ebs_volume_id = :vol"
                expr_vals[":vol"] = target_volume_id
            if target_eip:
                update_expr += ", elastic_ip = :ip, public_ip = :ip"
                expr_vals[":ip"] = target_eip
            if private_ip:
                update_expr += ", private_ip = :pip"
                expr_vals[":pip"] = private_ip

            inst_tbl.update_item(
                Key={"instance_id": instance_id},
                UpdateExpression=update_expr,
                ExpressionAttributeValues=expr_vals,
            )

            cinder_vid = event.get("cinder_volume_id")
            cinder_vkey = event.get("cinder_volume_key") or (f"MIG#{cinder_vid}" if cinder_vid else target_volume_id)
            if cinder_vkey and (cinder_vid or target_volume_id):
                vol_item = {
                    "volume_id": cinder_vkey,
                    "attached_instance_id": instance_id,
                    "storage_backend": "aws-ebs",
                    "cinder_volume_type": "aws-ebs-gp3",
                    "status": "IN_USE",
                    "region": dest_region,
                    "updated_at": now_iso,
                }
                if cinder_vid:
                    vol_item["cinder_volume_id"] = cinder_vid
                if target_volume_id:
                    vol_item["ebs_volume_id"] = target_volume_id
                ddb.Table("XRegion-Volumes").put_item(Item=vol_item)

            ddb.Table("XRegion-Migrations").update_item(
                Key={"instance_id": instance_id, "migration_id": migration_id},
                UpdateExpression="SET #s = :comp, copy_progress = :pct, completed_at = :now, updated_at = :now",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":comp": "COMPLETED", ":pct": 100, ":now": now_iso},
            )
        except Exception as e:
            logger.warning("SyncDynamoDB in %s warning: %s", reg, e)

    upsert_instance_dns(instance_id, target_eip)

    if target_nova_id:
        try:
            owner = event.get("username") or event.get("owner") or "admin"
            sg_payload = {
                "detail": {
                    "event_id": "evt-sg-mig-" + str(uuid.uuid4())[:8],
                    "group_id": target_nova_id,
                    "instance_id": instance_id,
                    "nova_id": target_nova_id,
                    "revision": 1,
                    "requested_by": owner,
                    "timestamp": int(time.time() * 1000),
                }
            }
            boto3.client("lambda", region_name=dest_region).invoke(
                FunctionName="XRegion-SyncSecurityGroup",
                InvocationType="RequestResponse",
                Payload=json.dumps(sg_payload).encode("utf-8"),
            )
        except Exception as e:
            logger.warning("Post-SyncDynamoDB XRegion-SyncSecurityGroup warning: %s", e)

    event["migration_target_synced"] = True
    return event
