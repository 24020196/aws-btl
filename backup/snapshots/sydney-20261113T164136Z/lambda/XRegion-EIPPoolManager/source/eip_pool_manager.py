"""EIP Warm Pool manager theo SPEC-02: giữ chính xác 2 EIP rảnh rỗi, purge FIFO khi vượt ngưỡng.

- EIP rảnh rỗi: không có AssociationId/NetworkInterfaceId/InstanceId và gắn tag Project=xregion.
- Không áp dụng grace period. Chỉ loại trừ EIP đang được một LaunchInstance còn trong
  cửa sổ timeout 300s (SPEC-SF-01) claim, để không phá launch đang chạy.
- Thứ tự FIFO dựa trên tag IdleSince (thời điểm Lambda thấy EIP rảnh lần đầu), dự phòng
  bằng timestamp trong tag Name eip-reserve-{ts}.
- Chỉ ghi audit log vào CloudWatch Logs, không ghi bản ghi audit vào DynamoDB.
"""
import json
import logging
import os
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

POOL_LIMIT = 2  # SPEC-02: bất biến, không cấu hình vượt quá 2
LAUNCH_TIMEOUT_SECONDS = 300  # SPEC-SF-01: timeout của LaunchInstance
PROJECT_TAG = "xregion"
IDLE_TAG = "IdleSince"
RESERVATIONS_TABLE = os.environ.get("RESERVATIONS_TABLE", "XRegion-NetworkReservations")

ec2_client = boto3.client("ec2")
dynamodb = boto3.resource("dynamodb")


def _tags(addr):
    return {t.get("Key"): t.get("Value") for t in addr.get("Tags", []) or []}


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _name_ts(tags):
    name = tags.get("Name", "")
    return _int(name.rsplit("-", 1)[-1]) if name.startswith("eip-reserve-") else 0


def is_associated(addr):
    return bool(addr.get("AssociationId") or addr.get("NetworkInterfaceId") or addr.get("InstanceId"))


def claim_in_flight(tags, now, reservations_table=None):
    """True nếu EIP đang được một LaunchInstance còn trong cửa sổ timeout claim."""
    claimed_by = tags.get("ClaimedBy")
    if not claimed_by or not claimed_by.startswith("arn:aws:states:"):
        return False
    table = reservations_table or dynamodb.Table(RESERVATIONS_TABLE)
    lease = table.get_item(Key={"resource_key": "LEASE#" + claimed_by}).get("Item")
    if not lease:
        return False
    if lease.get("status") == "COMMITTED":
        return False
    return now - _int(lease.get("created_at")) < LAUNCH_TIMEOUT_SECONDS


def classify(addresses, now, reservations_table=None):
    spare, in_use, foreign, in_flight = [], [], [], []
    for addr in addresses:
        tags = _tags(addr)
        item = {
            "allocation_id": addr.get("AllocationId"),
            "public_ip": addr.get("PublicIp"),
            "idle_since": _int(tags.get(IDLE_TAG)) or None,
            "name_ts": _name_ts(tags),
            "claimed_by": tags.get("ClaimedBy"),
        }
        if is_associated(addr):
            in_use.append(item)
        elif tags.get("Project") != PROJECT_TAG:
            foreign.append(item)
        elif claim_in_flight(tags, now, reservations_table):
            in_flight.append(item)
        else:
            spare.append(item)
    return spare, in_use, foreign, in_flight


def stamp_idle_since(spare, now):
    for item in spare:
        if item["idle_since"] is None:
            ec2_client.create_tags(Resources=[item["allocation_id"]],
                                   Tags=[{"Key": IDLE_TAG, "Value": str(now)}])
            item["idle_since"] = now


def fifo_key(item):
    return (item["idle_since"] or 0, item["name_ts"], item["allocation_id"] or "")


def allocate_reserve_eip_with_retry(max_retries=3, base_delay=2):
    last_exception = None
    for attempt in range(1, max_retries + 1):
        try:
            now = int(time.time())
            resp = ec2_client.allocate_address(Domain="vpc", TagSpecifications=[{
                "ResourceType": "elastic-ip",
                "Tags": [
                    {"Key": "Project", "Value": PROJECT_TAG},
                    {"Key": "ManagedBy", "Value": "XRegion-EIPPoolManager"},
                    {"Key": "Name", "Value": f"eip-reserve-{now}"},
                    {"Key": IDLE_TAG, "Value": str(now)},
                ]}])
            logger.info("Cấp phát EIP dự phòng %s (%s)", resp["PublicIp"], resp["AllocationId"])
            return {"allocation_id": resp["AllocationId"], "public_ip": resp["PublicIp"],
                    "idle_since": now, "name_ts": now, "claimed_by": None}
        except Exception as error:  # noqa: BLE001 - retry mọi lỗi allocate
            last_exception = error
            logger.warning("Lỗi cấp phát EIP lần %s: %s", attempt, error)
            if attempt < max_retries:
                time.sleep(base_delay * (2 ** (attempt - 1)))
    raise RuntimeError(f"Cấp phát EIP thất bại sau {max_retries} lần thử: {last_exception}")


def lambda_handler(event, context):
    logger.info("Nhận sự kiện EIP Pool: %s", json.dumps(event, default=str))
    payload = event.get("detail", event) if isinstance(event, dict) else {}
    if not isinstance(payload, dict):
        payload = {}
    dry_run = bool(payload.get("dry_run", False))
    max_retries = int(payload.get("max_retries", 3))
    now = int(time.time())

    addresses = ec2_client.describe_addresses(
        Filters=[{"Name": "domain", "Values": ["vpc"]}]).get("Addresses", [])
    spare, in_use, foreign, in_flight = classify(addresses, now)
    if not dry_run:
        stamp_idle_since(spare, now)
    spare.sort(key=fifo_key)
    logger.info("Pool EIP: spare=%s in_use=%s foreign=%s in_flight=%s",
                [s["public_ip"] for s in spare], len(in_use),
                [f["public_ip"] for f in foreign], [f["public_ip"] for f in in_flight])

    released, allocated = [], []
    if len(spare) > POOL_LIMIT:
        excess = spare[:len(spare) - POOL_LIMIT]
        for item in excess:
            logger.info("FIFO purge EIP %s (%s), idle_since=%s, lý do: Pool %s > %s",
                        item["public_ip"], item["allocation_id"], item["idle_since"],
                        len(spare), POOL_LIMIT)
            if not dry_run:
                ec2_client.release_address(AllocationId=item["allocation_id"])
            released.append(item)
        spare = spare[len(excess):]
        status = "PURGED_TO_LIMIT_DRY_RUN" if dry_run else "PURGED_TO_LIMIT"
    elif len(spare) < POOL_LIMIT:
        deficit = POOL_LIMIT - len(spare)
        if dry_run:
            status = "INSUFFICIENT_DRY_RUN"
        else:
            for _ in range(deficit):
                item = allocate_reserve_eip_with_retry(max_retries=max_retries)
                allocated.append(item)
                spare.append(item)
            status = "REPLENISHED"
    else:
        status = "SUFFICIENT"

    response = {
        "status": status,
        "pool_limit": POOL_LIMIT,
        "spare_count": len(spare),
        "spare_eips": spare,
        "released": released,
        "newly_allocated": allocated,
        "in_flight_claims": in_flight,
        "foreign_unassociated": foreign,
        "associated_count": len(in_use),
        "dry_run": dry_run,
        "timestamp": now,
    }
    logger.info("Kết quả EIP Pool: %s", json.dumps(response, default=str))
    return response
