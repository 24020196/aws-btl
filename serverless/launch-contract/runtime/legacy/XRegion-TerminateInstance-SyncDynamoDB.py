import json
import os
import time
import boto3

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)

def resolve_all_nova_ids_and_instance(event):
    instance_id = event.get("instance_id")
    server_id = event.get("server_id") or event.get("nova_id")
    
    if not instance_id and server_id and server_id.startswith("i-"):
        instance_id = server_id

    nova_ids = set()
    if event.get("nova_ids") and isinstance(event.get("nova_ids"), list):
        for n in event.get("nova_ids"):
            if n and not str(n).startswith("i-"):
                nova_ids.add(str(n))

    if server_id and not server_id.startswith("i-"):
        nova_ids.add(str(server_id))

    if instance_id:
        try:
            resp = dynamodb.get_item(
                TableName="XRegion-Instances",
                Key={"instance_id": {"S": instance_id}}
            )
            item = resp.get("Item", {})
            curr_id = item.get("current_nova_id", {}).get("S")
            if curr_id and not curr_id.startswith("i-"):
                nova_ids.add(curr_id)
            act_id = item.get("active_nova_id", {}).get("S")
            if act_id and not act_id.startswith("i-"):
                nova_ids.add(act_id)
            n_ids = item.get("nova_ids", {}).get("L", [])
            for entry in n_ids:
                s_val = entry.get("S")
                if s_val and not s_val.startswith("i-"):
                    nova_ids.add(s_val)
        except Exception as e:
            print(f"Notice reading XRegion-Instances: {e}")

        try:
            scan_resp = dynamodb.scan(
                TableName="XRegion-Nova",
                FilterExpression="instance_id = :inst",
                ExpressionAttributeValues={":inst": {"S": instance_id}}
            )
            for it in scan_resp.get("Items", []):
                nid = it.get("nova_id", {}).get("S")
                if nid and not nid.startswith("i-"):
                    nova_ids.add(nid)
        except Exception as e:
            print(f"Notice scanning XRegion-Nova: {e}")

    primary_server_id = list(nova_ids)[0] if nova_ids else (instance_id or "unknown")
    return list(nova_ids), instance_id or primary_server_id, primary_server_id

def lambda_handler(event, context):
    print("Step 5: SyncDynamoDB received event:", json.dumps(event))
    nova_ids, instance_id, primary_server_id = resolve_all_nova_ids_and_instance(event)
    sg_name = event.get("security_group") or instance_id
    now_ms = str(int(time.time() * 1000))

    if not instance_id:
        raise ValueError("Missing instance_id in SyncDynamoDB payload")

    # 1. Cập nhật XRegion-Instances
    try:
        print(f"Updating XRegion-Instances [{instance_id}] to TERMINATED...")
        dynamodb.update_item(
            TableName="XRegion-Instances",
            Key={"instance_id": {"S": instance_id}},
            UpdateExpression="SET current_status = :st, terminated_at = :now, active_nova_id = :empty, elastic_ip = :unassigned, public_ip = :unassigned, migration_lock = :lock REMOVE current_nova_id",
            ExpressionAttributeValues={
                ":st": {"S": "TERMINATED"},
                ":now": {"N": now_ms},
                ":empty": {"S": ""},
                ":unassigned": {"S": "Chưa gán"},
                ":lock": {"BOOL": False}
            }
        )
        print(f"Updated XRegion-Instances [{instance_id}] successfully.")
    except Exception as e:
        print(f"Notice updating XRegion-Instances: {e}")

    # 2. Cập nhật TẤT CẢ các bản ghi XRegion-Nova liên quan
    for nid in nova_ids:
        try:
            print(f"Updating XRegion-Nova [{nid}] to TERMINATED...")
            dynamodb.update_item(
                TableName="XRegion-Nova",
                Key={"nova_id": {"S": nid}},
                UpdateExpression="SET #st = :st, terminated_at = :now",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":st": {"S": "TERMINATED"},
                    ":now": {"N": now_ms}
                }
            )
            print(f"Updated XRegion-Nova [{nid}] successfully.")
        except Exception as e:
            print(f"Notice updating XRegion-Nova: {e}")

    # 3. Đảm bảo bản ghi trong XRegion-SecurityGroups đã được dọn
    if sg_name:
        try:
            dynamodb.delete_item(
                TableName="XRegion-SecurityGroups",
                Key={"group_id": {"S": sg_name}}
            )
            print(f"Verified deletion of XRegion-SecurityGroups [{sg_name}].")
        except Exception as e:
            print(f"Notice cleaning XRegion-SecurityGroups: {e}")

    return {
        "status": "TERMINATED",
        "server_id": primary_server_id,
        "nova_id": primary_server_id,
        "nova_ids": nova_ids,
        "instance_id": instance_id,
        "terminated_at": now_ms
    }
