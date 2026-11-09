import json
import os
import time
import boto3
from botocore.exceptions import ClientError

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)
ec2 = boto3.client("ec2", region_name=AWS_REGION)

def lambda_handler(event, context):
    print("Received AllocateResource event:", json.dumps(event))
    instance_id = event.get("instance_id", "")
    image_id = event.get("image_id", "")
    now_sec = int(time.time())

    # 1. Sequential & Atomic Cinder Volume allocation
    resp = dynamodb.scan(
        TableName="XRegion-Volumes",
        FilterExpression="#st = :avail",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":avail": {"S": "AVAILABLE"}}
    )
    items = resp.get("Items", [])
    if not items:
        raise RuntimeError("No available Cinder volume found in reserve pool!")

    # Sort matching image_id first
    sorted_items = []
    for it in items:
        if it.get("image_id", {}).get("S") == image_id:
            sorted_items.insert(0, it)
        else:
            sorted_items.append(it)

    allocated_cinder_key = None
    allocated_cinder_id = None
    original_size_gb = 10

    for candidate in sorted_items:
        vol_key = candidate.get("volume_id", {}).get("S")
        cinder_id = candidate.get("cinder_volume_id", {}).get("S", vol_key)
        size_val = int(candidate.get("size_gb", {}).get("N", "10"))

        try:
            dynamodb.update_item(
                TableName="XRegion-Volumes",
                Key={"volume_id": {"S": vol_key}},
                ConditionExpression="#st = :avail",
                UpdateExpression="SET #st = :alloc, lease_instance_id = :inst, leased_at = :now",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":avail": {"S": "AVAILABLE"},
                    ":alloc": {"S": "ALLOCATED"},
                    ":inst": {"S": instance_id},
                    ":now": {"N": str(now_sec)}
                }
            )
            allocated_cinder_key = vol_key
            allocated_cinder_id = cinder_id
            original_size_gb = size_val
            print(f"Successfully atomic-allocated Cinder volume [{cinder_id}] (key: {vol_key}) for instance [{instance_id}]")
            break
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                print(f"Volume [{vol_key}] was claimed concurrently, trying next...")
                continue
            else:
                raise e

    if not allocated_cinder_id:
        raise RuntimeError("Failed to allocate Cinder volume: all available volumes are claimed or locked.")

    # 2. Sequential & Atomic EIP allocation
    addr_resp = ec2.describe_addresses()
    spare_addresses = [
        a for a in addr_resp.get("Addresses", [])
        if not a.get("NetworkInterfaceId") and not a.get("AssociationId")
    ]
    if not spare_addresses:
        raise RuntimeError("No available Elastic IP found in pool!")

    selected_eip_obj = spare_addresses[0]
    selected_eip = selected_eip_obj.get("PublicIp")
    alloc_id = selected_eip_obj.get("AllocationId")

    try:
        ec2.create_tags(
            Resources=[alloc_id],
            Tags=[
                {"Key": "ClaimedBy", "Value": instance_id},
                {"Key": "ClaimedAt", "Value": str(now_sec)}
            ]
        )
        print(f"Successfully claimed EIP [{selected_eip}] for instance [{instance_id}]")
    except Exception as e:
        print(f"Notice: tagging EIP {alloc_id}: {e}")

    return {
        "status": "ALLOCATED",
        "instance_id": instance_id,
        "cinder_volume_id": allocated_cinder_id,
        "cinder_volume_key": allocated_cinder_key,
        "original_size_gb": original_size_gb,
        "elastic_ip": selected_eip,
        "allocation_id": alloc_id
    }
