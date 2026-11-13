import time
import boto3
import requests
from tests.apiTest.conftest import wait_for_dynamodb_status


def _wait_source_cleanup(source_region, source_nova_id, timeout_s=45):
    """Chờ MigrateSourceCleanup cập nhật XRegion-Nova[source_nova_id].status = TERMINATED trước khi fallback."""
    if not source_nova_id:
        return False
    nova_tbl = boto3.resource("dynamodb", region_name=source_region).Table("XRegion-Nova")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        item = nova_tbl.get_item(Key={"nova_id": source_nova_id}, ConsistentRead=True).get("Item") or {}
        if str(item.get("status", "")).upper() == "TERMINATED":
            print(f"[CLEANUP] MigrateSourceCleanup đã hoàn tất cho source_nova_id={source_nova_id} tại {source_region}")
            return True
        time.sleep(3)
    print(f"[CLEANUP] Hết {timeout_s}s chờ MigrateSourceCleanup cho source_nova_id={source_nova_id} tại {source_region}, chạy fallback.")
    return False


def _release_source_region_eip(instances_table, instance_id, source_region, source_nova_id=None):
    """Chỉ fallback giải phóng EIP và NetworkReservation của máy ảo nguồn nếu MigrateSourceCleanup chưa kịp dọn."""
    try:
        if source_nova_id and _wait_source_cleanup(source_region, source_nova_id):
            return
        item = instances_table.get_item(Key={"instance_id": instance_id}, ConsistentRead=True).get("Item") or {}
        launch_arn = item.get("launch_execution_arn")
        if not launch_arn:
            return
        ddb = boto3.resource("dynamodb", region_name=source_region)
        res_tbl = ddb.Table("XRegion-NetworkReservations")
        for r in res_tbl.scan().get("Items", []):
            if r.get("reservation_id") == launch_arn:
                res_tbl.delete_item(Key={"resource_key": r["resource_key"]})
        ec2 = boto3.client("ec2", region_name=source_region)
        for addr in ec2.describe_addresses().get("Addresses", []):
            tags = {t["Key"]: t["Value"] for t in addr.get("Tags", [])}
            if tags.get("ReservationId") == launch_arn:
                if addr.get("AssociationId"):
                    try:
                        ec2.disassociate_address(AssociationId=addr["AssociationId"])
                    except Exception:
                        pass
                del_tags = [{"Key": k} for k in ("ClaimedBy", "NovaId", "ReservationId") if k in tags]
                if del_tags:
                    ec2.delete_tags(Resources=[addr["AllocationId"]], Tags=del_tags)
                print(f"[CLEANUP] Đã giải phóng EIP nguồn {addr['AllocationId']} tại {source_region}")
    except Exception as e:
        print(f"[CLEANUP] Lỗi giải phóng EIP nguồn tại {source_region}: {e}")


def _run_migration_e2e(base_url, instances_table, auth_ctx, source_region, dest_region, scenario_label):
    """Hàm thực thi kịch bản kiểm thử E2E chuyển vùng xuyên vùng (POST /api/migrations/trigger) và theo dõi DynamoDB:

    1. Launch máy ảo mới tại vùng nguồn (source_region), chờ DynamoDB XRegion-Instances -> RUNNING.
    2. Gửi POST /api/migrations/trigger với {"id": instance_id}.
    3. Theo dõi DynamoDB XRegion-Instances:
       - Xác nhận trạng thái chuyển sang MIGRATING (hoặc migration_lock=True).
       - Chờ Step Function MigrateInstance + MigrateTargetBoot hoàn tất -> RUNNING/ACTIVE tại dest_region, migration_lock=False.
    4. Terminate máy ảo sau khi nghiệm thu xong.
    """
    headers = auth_ctx["headers"]
    instance_id = None
    source_nova_id = None
    vm_name = f"mig-e2e-vm-{int(time.time())}"

    try:
        print(f"\n=======================================================")
        print(f"[{scenario_label} - BƯỚC 1] Khởi tạo máy ảo nguồn tại {source_region}: {vm_name}")
        print(f"=======================================================")
        launch_res = requests.post(
            f"{base_url}/api/instances",
            headers=headers,
            json={
                "name": vm_name,
                "region": source_region,
                "flavor": auth_ctx["flavor"],
                "imageId": auth_ctx["image_id"],
                "keyPairName": auth_ctx["key_name"],
                "ebsSizeGb": 1,
            },
            timeout=15,
        )
        assert launch_res.status_code == 202, f"Launch thất bại: {launch_res.status_code} - {launch_res.text}"
        instance_id = launch_res.json()["data"]["id"]
        print(f"[{scenario_label} - BƯỚC 1] Tiếp nhận instance_id={instance_id}")

        item_running = wait_for_dynamodb_status(
            instances_table,
            instance_id,
            target_statuses="RUNNING",
            max_retries=60,
            poll_interval=3.5,
            settle_seconds=3.5,
            step_name=f"[{scenario_label}] BƯỚC 1: Chờ VM nguồn ({source_region}) RUNNING",
        )
        assert item_running["current_status"] == "RUNNING"
        source_nova_id = item_running.get("active_nova_id")

        print(f"\n=======================================================")
        print(f"[{scenario_label} - BƯỚC 2] Gọi POST /api/migrations/trigger cho {instance_id} ({source_region} -> {dest_region})")
        print(f"=======================================================")
        mig_res = requests.post(
            f"{base_url}/api/migrations/trigger",
            headers=headers,
            json={"id": instance_id},
            timeout=30,
        )
        print(f"[POST /api/migrations/trigger] status={mig_res.status_code}, body={mig_res.text}")
        assert mig_res.status_code == 200, f"Trigger migration thất bại: {mig_res.status_code} - {mig_res.text}"
        body = mig_res.json()
        assert body.get("success") is True

        print(f"\n=======================================================")
        print(f"[{scenario_label} - BƯỚC 3] Theo dõi DynamoDB hoàn tất chuyển vùng ({source_region} -> {dest_region})")
        print(f"=======================================================")
        deadline = time.time() + 420
        last_item = None
        saw_migrating = False
        while time.time() < deadline:
            resp = instances_table.get_item(Key={"instance_id": instance_id}, ConsistentRead=True)
            last_item = resp.get("Item") or {}
            st = str(last_item.get("current_status", "")).upper()
            reg = last_item.get("current_region")
            lock = bool(last_item.get("migration_lock", False))
            print(f"[{scenario_label}] Poll DDB: status={st}, region={reg}, migration_lock={lock}")
            if st == "MIGRATING" or lock:
                saw_migrating = True
            assert st != "FAILED", f"Migration thất bại trên DynamoDB: {last_item}"
            if saw_migrating and not lock and reg == source_region and st in ("RUNNING", "ACTIVE"):
                raise AssertionError(f"Migration đã bị rollback về vùng nguồn {source_region}: {last_item}")
            if reg == dest_region and st in ("RUNNING", "ACTIVE") and not lock:
                break
            time.sleep(5)

        assert last_item is not None
        assert last_item.get("current_region") == dest_region, (
            f"Kỳ vọng current_region={dest_region}, nhận được: {last_item}"
        )
        assert str(last_item.get("current_status", "")).upper() in ("RUNNING", "ACTIVE"), (
            f"Kỳ vọng RUNNING/ACTIVE sau migrate, nhận được: {last_item}"
        )
        assert not bool(last_item.get("migration_lock", False)), f"migration_lock chưa được giải phóng: {last_item}"
        print(f"[{scenario_label} THÀNH CÔNG] VM {instance_id} đã chuyển từ {source_region} sang {dest_region} (saw_migrating={saw_migrating})!")
    finally:
        if instance_id:
            print(f"\n[{scenario_label} - DỌN DẸP] Terminate máy ảo {instance_id}")
            _release_source_region_eip(instances_table, instance_id, source_region, source_nova_id=source_nova_id)
            try:
                requests.post(
                    f"{base_url}/api/instances/{instance_id}/actions",
                    headers=headers,
                    json={"action": "TERMINATE"},
                    timeout=10,
                )
                wait_for_dynamodb_status(
                    instances_table,
                    instance_id,
                    target_statuses="TERMINATED",
                    max_retries=40,
                    poll_interval=3.0,
                    settle_seconds=1.0,
                    step_name=f"[{scenario_label}] DỌN DẸP: Chờ {instance_id} TERMINATED",
                )
            except Exception as e:
                print(f"[{scenario_label} - DỌN DẸP] Lỗi terminate {instance_id}: {e}")


def test_migration_rea_to_reb_e2e(base_url, instances_table_rea, auth_context_rea):
    """Kịch bản 1: Chuyển vùng máy ảo từ Region A (us-east-1) sang Region B (ap-southeast-2)."""
    _run_migration_e2e(
        base_url=base_url,
        instances_table=instances_table_rea,
        auth_ctx=auth_context_rea,
        source_region="us-east-1",
        dest_region="ap-southeast-2",
        scenario_label="MIGRATION E2E (A -> B: us-east-1 -> ap-southeast-2)",
    )


def test_migration_reb_to_rea_e2e(base_url, instances_table_reb, auth_context_reb):
    """Kịch bản 2: Chuyển vùng máy ảo từ Region B (ap-southeast-2) sang Region A (us-east-1)."""
    _run_migration_e2e(
        base_url=base_url,
        instances_table=instances_table_reb,
        auth_ctx=auth_context_reb,
        source_region="ap-southeast-2",
        dest_region="us-east-1",
        scenario_label="MIGRATION E2E (B -> A: ap-southeast-2 -> us-east-1)",
    )
