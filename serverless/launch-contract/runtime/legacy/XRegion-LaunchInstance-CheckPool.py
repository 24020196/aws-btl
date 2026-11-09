import json
import os
import boto3

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)
ec2 = boto3.client("ec2", region_name=AWS_REGION)
lambda_client = boto3.client("lambda", region_name=AWS_REGION)

def lambda_handler(event, context):
    print("Received CheckPool event:", json.dumps(event))
    image_id = event.get("image_id", "")
    
    # 1. Check Cinder pool in XRegion-Volumes table
    try:
        resp = dynamodb.scan(
            TableName="XRegion-Volumes",
            FilterExpression="#st = :avail",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":avail": {"S": "AVAILABLE"}}
        )
        cinder_items = resp.get("Items", [])
    except Exception as e:
        print(f"Error querying XRegion-Volumes: {e}")
        cinder_items = []

    # Filter by image_id if matching volumes found
    matching_cinder = []
    for item in cinder_items:
        vol_type = item.get("volume_type", {}).get("S", "")
        item_img = item.get("image_id", {}).get("S", "")
        if "cinder" in vol_type or "cinder" in item.get("volume_id", {}).get("S", ""):
            if not image_id or item_img == image_id:
                matching_cinder.append(item.get("cinder_volume_id", {}).get("S", item.get("volume_id", {}).get("S", "")))

    # If no exact match, allow any available cinder volume
    if not matching_cinder:
        matching_cinder = [it.get("cinder_volume_id", {}).get("S", it.get("volume_id", {}).get("S", "")) for it in cinder_items]

    # 2. Check EIP pool in EC2
    try:
        addr_resp = ec2.describe_addresses()
        spare_eips = [
            a.get("PublicIp") for a in addr_resp.get("Addresses", [])
            if not a.get("NetworkInterfaceId") and not a.get("AssociationId")
        ]
    except Exception as e:
        print(f"Error describing addresses: {e}")
        spare_eips = []

    print(f"Pool check: Cinder count = {len(matching_cinder)}, EIP count = {len(spare_eips)}")

    # Auto-replenish trigger if pool is low
    if len(matching_cinder) == 0:
        try:
            print("Triggering XRegion-CinderPoolManager to replenish...")
            lambda_client.invoke(
                FunctionName="XRegion-CinderPoolManager",
                InvocationType="Event",
                Payload=json.dumps({"trigger": "pool_depleted", "image_id": image_id})
            )
        except Exception as e:
            print(f"Could not trigger CinderPoolManager: {e}")

    if len(spare_eips) == 0:
        try:
            print("Triggering XRegion-EIPPoolManager to replenish...")
            lambda_client.invoke(
                FunctionName="XRegion-EIPPoolManager",
                InvocationType="Event",
                Payload=json.dumps({"trigger": "pool_depleted"})
            )
        except Exception as e:
            print(f"Could not trigger EIPPoolManager: {e}")

    if len(matching_cinder) == 0 or len(spare_eips) == 0:
        raise RuntimeError(f"PoolNotReadyException: Reserve pool replenishing (Cinder: {len(matching_cinder)}, EIP: {len(spare_eips)})")

    return {
        "status": "READY",
        "spare_cinder_count": len(matching_cinder),
        "spare_eip_count": len(spare_eips),
        "image_id": image_id,
        "is_ready": True
    }
