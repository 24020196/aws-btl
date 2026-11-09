import json
import os
import time
import boto3

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)

def lambda_handler(event, context):
    print("Received SyncDynamoDB event:", json.dumps(event))
    if event.get("mode") == "FAILURE":
        instance_id = event.get("instance_id")
        if not instance_id:
            raise ValueError("Missing instance_id in failure event")
        error = event.get("error") or {}
        dynamodb.update_item(
            TableName="XRegion-Instances",
            Key={"instance_id": {"S": instance_id}},
            UpdateExpression=(
                "SET current_status = :failed, failure_reason = :reason, "
                "failed_nova_id = :nova, failed_volume_id = :volume, "
                "failed_elastic_ip = :eip, failed_allocation_id = :allocation"
            ),
            ConditionExpression="attribute_exists(instance_id)",
            ExpressionAttributeValues={
                ":failed": {"S": "FAILED"},
                ":reason": {"S": str(error.get("Cause") or error.get("Error") or "network provisioning failed")[:1024]},
                ":nova": {"S": event.get("server_id") or ""},
                ":volume": {"S": event.get("cinder_volume_id") or ""},
                ":eip": {"S": event.get("elastic_ip") or ""},
                ":allocation": {"S": event.get("allocation_id") or ""},
            },
        )
        return {"status": "FAILED", "instance_id": instance_id}
    server_id = event.get("server_id") or event.get("nova_id")
    instance_id = event.get("instance_id")
    instance_name = event.get("instance_name") or f"vm-{instance_id}"
    flavor = event.get("flavor") or event.get("flavor_name") or "m1.medium"
    key_id = event.get("key_id") or "xregion-key"
    cinder_vol_id = event.get("cinder_volume_id", "")
    cinder_vol_key = event.get("cinder_volume_key", cinder_vol_id)
    private_ip = event.get("private_ip", "10.0.1.100")
    elastic_ip = event.get("elastic_ip", "Chưa gán")
    # 1-1 Security Group: id trùng với server_id (Nova VM ID)
    sg_id = event.get("security_group_id") or event.get("security_group") or server_id
    now_sec = int(time.time())

    if not server_id:
        raise ValueError("Missing server_id in SyncDynamoDB event")

    # 1. Put Item into XRegion-Nova (Contains 1-1 security_group_id = server_id)
    try:
        print(f"Persisting compute record to XRegion-Nova for Nova [{server_id}], Instance [{instance_id}], SG [{sg_id}]...")
        dynamodb.put_item(
            TableName="XRegion-Nova",
            Item={
                "nova_id": {"S": server_id},
                "instance_id": {"S": instance_id or server_id},
                "instance_name": {"S": instance_name},
                "status": {"S": "ACTIVE"},
                "region": {"S": AWS_REGION},
                "flavor": {"S": flavor},
                "private_ip": {"S": private_ip},
                "elastic_ip": {"S": elastic_ip},
                "volume_id": {"S": cinder_vol_id},
                "key_id": {"S": key_id},
                "security_group_id": {"S": sg_id},
                "created_at": {"N": str(now_sec)}
            }
        )
        print(f"Successfully recorded Nova [{server_id}] with SG [{sg_id}] into XRegion-Nova.")
    except Exception as e:
        print(f"Error saving to XRegion-Nova: {e}")
        raise e

    # 2. Update XRegion-Volumes to IN_USE and attach to instance_id
    if cinder_vol_key:
        try:
            print(f"Updating XRegion-Volumes [{cinder_vol_key}] to IN_USE attached to [{instance_id}]...")
            dynamodb.update_item(
                TableName="XRegion-Volumes",
                Key={"volume_id": {"S": cinder_vol_key}},
                UpdateExpression="SET #st = :in_use, attached_instance_id = :inst",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":in_use": {"S": "IN_USE"},
                    ":inst": {"S": instance_id or server_id}
                }
            )
            print(f"Successfully updated XRegion-Volumes [{cinder_vol_key}].")
        except Exception as e:
            print(f"Notice: updating XRegion-Volumes: {e}")

    # 3. Upsert 1-1 Security Group record into XRegion-SecurityGroups
    try:
        now_ms = str(int(time.time() * 1000))
        short_id = server_id[:8] if len(server_id) >= 8 else server_id
        dynamodb.put_item(
            TableName="XRegion-SecurityGroups",
            Item={
                "group_id": {"S": sg_id},
                "name": {"S": sg_id},
                "description": {"S": f"1-1 Security Group for Nova VM {server_id}"},
                "region": {"S": AWS_REGION},
                "owner": {"S": "system"},
                "inbound_rules": {"S": json.dumps([
                    {"ruleId": f"sgr-{short_id}-ssh", "protocol": "tcp", "fromPort": 22, "toPort": 22, "cidr": "0.0.0.0/0", "description": "SSH", "addedBy": "system"},
                    {"ruleId": f"sgr-{short_id}-icmp", "protocol": "icmp", "fromPort": 0, "toPort": 0, "cidr": "0.0.0.0/0", "description": "ICMP", "addedBy": "system"}
                ])},
                "outbound_rules": {"S": json.dumps([
                    {"ruleId": f"sgr-{short_id}-egress", "protocol": "all", "fromPort": 0, "toPort": 65535, "cidr": "0.0.0.0/0", "description": "All Egress", "addedBy": "system"}
                ])},
                "created_at": {"N": now_ms}
            }
        )
        print(f"Successfully recorded 1-1 Security Group [{sg_id}] into XRegion-SecurityGroups.")
    except Exception as e:
        print(f"Notice saving to XRegion-SecurityGroups: {e}")

    # 4. Update XRegion-Instances with active_nova_id and nova_ids (List)
    if instance_id:
        try:
            print(f"Updating XRegion-Instances [{instance_id}] with active_nova_id=[{server_id}]...")
            inst_resp = dynamodb.get_item(
                TableName="XRegion-Instances",
                Key={"instance_id": {"S": instance_id}}
            )
            item = inst_resp.get("Item", {})
            existing_nova_ids = [n.get("S") for n in item.get("nova_ids", {}).get("L", []) if n.get("S")]
            for old_field in ["active_nova_id", "current_nova_id"]:
                old_val = item.get(old_field, {}).get("S")
                if old_val and old_val not in existing_nova_ids and not old_val.startswith("i-"):
                    existing_nova_ids.append(old_val)
            if server_id not in existing_nova_ids and not server_id.startswith("i-"):
                existing_nova_ids.append(server_id)

            nova_ids_attr = [{"S": nid} for nid in existing_nova_ids]

            dynamodb.update_item(
                TableName="XRegion-Instances",
                Key={"instance_id": {"S": instance_id}},
                UpdateExpression="SET active_nova_id = :nid, nova_ids = :nids, current_status = :st, updated_at = :now REMOVE current_nova_id",
                ExpressionAttributeValues={
                    ":nid": {"S": server_id},
                    ":nids": {"L": nova_ids_attr},
                    ":st": {"S": "RUNNING"},
                    ":now": {"N": str(now_sec)}
                }
            )
            print(f"Successfully updated XRegion-Instances [{instance_id}]: active_nova_id={server_id}, nova_ids={existing_nova_ids}")
        except Exception as e:
            print(f"Notice updating XRegion-Instances: {e}")

    return {
        "status": "SUCCESS",
        "server_id": server_id,
        "nova_id": server_id,
        "instance_id": instance_id,
        "instance_name": instance_name,
        "security_group_id": sg_id,
        "private_ip": private_ip,
        "elastic_ip": elastic_ip
    }
