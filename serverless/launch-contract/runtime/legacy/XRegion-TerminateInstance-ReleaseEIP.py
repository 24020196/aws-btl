import json
import os
import time
import boto3

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
OPENSTACK_PUBLIC_ENI = os.environ.get("OPENSTACK_PUBLIC_ENI", "eni-091eaee3e69e3f42d")

dynamodb = boto3.client("dynamodb", region_name=AWS_REGION)
ec2 = boto3.client("ec2", region_name=AWS_REGION)

def find_instance_ips(server_id, instance_id):
    elastic_ip = ""
    private_ip = ""

    # 1. Tra cứu XRegion-Nova
    if server_id:
        try:
            resp = dynamodb.get_item(
                TableName="XRegion-Nova",
                Key={"nova_id": {"S": server_id}}
            )
            item = resp.get("Item", {})
            elastic_ip = item.get("elastic_ip", {}).get("S", "")
            private_ip = item.get("private_ip", {}).get("S", "")
        except Exception as e:
            print(f"Notice looking up XRegion-Nova: {e}")

    # 2. Tra cứu XRegion-Instances
    if instance_id or server_id:
        inst_key = instance_id or server_id
        try:
            resp = dynamodb.get_item(
                TableName="XRegion-Instances",
                Key={"instance_id": {"S": inst_key}}
            )
            item = resp.get("Item", {})
            if not elastic_ip or elastic_ip == "Chưa gán":
                elastic_ip = item.get("elastic_ip", {}).get("S") or item.get("public_ip", {}).get("S", "")
            if not private_ip:
                private_ip = item.get("private_ip", {}).get("S", "")
        except Exception as e:
            print(f"Notice looking up XRegion-Instances: {e}")

    return elastic_ip, private_ip

def lambda_handler(event, context):
    print("Step 4: ReleaseEIP received event:", json.dumps(event))
    server_id = event.get("server_id") or event.get("nova_id")
    instance_id = event.get("instance_id") or server_id
    elastic_ip = event.get("elastic_ip")
    private_ip = event.get("private_ip")

    if not elastic_ip or elastic_ip == "Chưa gán":
        f_eip, f_priv = find_instance_ips(server_id, instance_id)
        elastic_ip = f_eip
        private_ip = private_ip or f_priv

    print(f"Resolving EIP for instance [{instance_id}], server [{server_id}]: EIP=[{elastic_ip}], PrivateIP=[{private_ip}]")

    # 1. Quét tìm Address trên EC2
    addr_resp = ec2.describe_addresses()
    matched_addr = None

    for addr in addr_resp.get("Addresses", []):
        # Không bao giờ đụng đến NAT gateway hay Horizon IP chính (10.20.1.236)
        if addr.get("PrivateIpAddress") == "10.20.1.236":
            continue

        if elastic_ip and addr.get("PublicIp") == elastic_ip:
            matched_addr = addr
            break
        
        # Kiểm tra qua tag ClaimedBy
        tags = {t.get("Key"): t.get("Value") for t in addr.get("Tags", [])}
        if tags.get("ClaimedBy") in [instance_id, server_id]:
            matched_addr = addr
            break

        # Kiểm tra qua PrivateIp gắn với secondary ENI
        if private_ip and addr.get("PrivateIpAddress") == private_ip and addr.get("NetworkInterfaceId") == OPENSTACK_PUBLIC_ENI:
            matched_addr = addr
            break

    released_ip = ""
    alloc_id = ""

    if matched_addr:
        released_ip = matched_addr.get("PublicIp")
        alloc_id = matched_addr.get("AllocationId")
        assoc_id = matched_addr.get("AssociationId")

        print(f"Found matched Elastic IP [{released_ip}] ({alloc_id})")

        # 1. Gỡ liên kết EIP khỏi ENI nếu đang liên kết
        if assoc_id:
            try:
                print(f"Disassociating EIP association [{assoc_id}]...")
                ec2.disassociate_address(AssociationId=assoc_id)
                print(f"Successfully disassociated EIP [{released_ip}].")
            except Exception as e:
                print(f"Notice disassociating EIP {released_ip}: {e}")

        # 2. Xóa Claim tags để hoàn trả về EIP pool
        try:
            print(f"Clearing Claim tags from EIP [{alloc_id}]...")
            ec2.delete_tags(
                Resources=[alloc_id],
                Tags=[{"Key": "ClaimedBy"}, {"Key": "ClaimedAt"}]
            )
            print(f"Successfully returned EIP [{released_ip}] back to spare pool.")
        except Exception as e:
            print(f"Notice deleting tags on EIP {alloc_id}: {e}")

    # 3. Gỡ secondary private IP khỏi OpenStack Public ENI
    if private_ip and private_ip not in ["10.20.1.236", "10.0.1.100"]:
        try:
            print(f"Unassigning secondary private IP [{private_ip}] from ENI [{OPENSTACK_PUBLIC_ENI}]...")
            ec2.unassign_private_ip_addresses(
                NetworkInterfaceId=OPENSTACK_PUBLIC_ENI,
                PrivateIpAddresses=[private_ip]
            )
            print(f"Successfully unassigned private IP [{private_ip}].")
        except Exception as e:
            print(f"Notice unassigning private IP {private_ip}: {e}")

    return {
        "status": "EIP_RELEASED",
        "server_id": server_id,
        "nova_id": server_id,
        "instance_id": instance_id,
        "elastic_ip": released_ip,
        "allocation_id": alloc_id
    }
