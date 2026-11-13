import time
import requests
from tests.apiTest.conftest import wait_for_dynamodb_status


def test_instance_lifecycle_reb_e2e(base_url, instances_table_reb, auth_context_reb):
    """Kịch bản kiểm thử E2E toàn trình vòng đời máy ảo trên Region B (Sydney - ap-southeast-2):

    Quy trình:
    1. Gửi lệnh Launch máy ảo tại Region B (POST /api/instances, region="ap-southeast-2").
    2. Polling DynamoDB XRegion-Instances xác nhận PENDING và chờ Step Function LaunchInstance
       cấp phát boot volume Warm Pool 1GB, khởi tạo Nova instance -> RUNNING.
       Tự động áp dụng Settling Cooldown (3.5s) để OpenStack Nova hypervisor & OVN ổn định.
    3. Gửi lệnh STOP (POST /api/instances/{id}/actions: STOP).
       Chờ Nova tắt máy xong -> STOPPED + Settling Cooldown (3.5s).
    4. Gửi lệnh START (POST /api/instances/{id}/actions: START).
       Chờ Nova bật máy xong -> RUNNING + Settling Cooldown (3.5s).
    5. Gửi lệnh TERMINATE (POST /api/instances/{id}/actions: TERMINATE).
       Chờ Terminate Pipeline giải phóng tài nguyên -> TERMINATED.
    """
    headers = auth_context_reb["headers"]
    instance_id = None
    vm_name = f"reb-e2e-vm-{int(time.time())}"
    target_region = "ap-southeast-2"

    try:
        # =========================================================================
        # BƯỚC 1: KHỞI TẠO MÁY ẢO REGION B (LAUNCH)
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[REGION B - BƯỚC 1] Gửi yêu cầu khởi tạo máy ảo: {vm_name} (ap-southeast-2)")
        print(f"=======================================================")
        launch_payload = {
            "name": vm_name,
            "region": target_region,
            "flavor": auth_context_reb["flavor"],
            "imageId": auth_context_reb["image_id"],
            "keyPairName": auth_context_reb["key_name"],
            "ebsSizeGb": 1,
        }

        launch_res = requests.post(
            f"{base_url}/api/instances",
            headers=headers,
            json=launch_payload,
            timeout=15,
        )

        assert launch_res.status_code == 202, (
            f"Launch thất bại: {launch_res.status_code} - {launch_res.text}"
        )
        instance_data = launch_res.json()["data"]
        instance_id = instance_data["id"]
        assert instance_id.startswith("i-"), f"Mã máy ảo không hợp lệ: {instance_id}"
        print(f"[REGION B - BƯỚC 1] Tiếp nhận yêu cầu: instance_id={instance_id}, HTTP 202 Accepted")

        # 1a. Chờ bản ghi ban đầu xuất hiện ở PENDING
        item_pending = wait_for_dynamodb_status(
            instances_table_reb,
            instance_id,
            target_statuses="PENDING",
            max_retries=10,
            poll_interval=2.0,
            settle_seconds=0,
            step_name="[REGION B] BƯỚC 1a: Xác nhận PENDING",
        )
        assert item_pending["current_status"] == "PENDING"

        # 1b. Dùng Retry Polling thực tế chờ Step Function & Nova cấp phát xong -> RUNNING
        # Kèm Settling Cooldown 3.5s chống lỗi dispatch action tiếp theo quá sớm
        item_running = wait_for_dynamodb_status(
            instances_table_reb,
            instance_id,
            target_statuses="RUNNING",
            max_retries=60,
            poll_interval=3.5,
            settle_seconds=3.5,
            step_name="[REGION B] BƯỚC 1b: Chờ hạ tầng hoàn tất -> RUNNING",
        )
        assert item_running["current_status"] == "RUNNING"
        print(f"[REGION B - BƯỚC 1 THÀNH CÔNG] Máy ảo {instance_id} đã RUNNING và ổn định!")

        # =========================================================================
        # BƯỚC 2: TẮT MÁY (ACTION STOP)
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[REGION B - BƯỚC 2] Gửi yêu cầu tắt máy (POST /api/instances/{instance_id}/actions: STOP)")
        print(f"=======================================================")
        stop_res = requests.post(
            f"{base_url}/api/instances/{instance_id}/actions",
            headers=headers,
            json={"action": "STOP"},
            timeout=10,
        )
        assert stop_res.status_code == 200, f"Gửi lệnh STOP thất bại: {stop_res.text}"
        assert stop_res.json()["data"]["status"] == "STOPPING"
        print(f"[REGION B - BƯỚC 2] Lệnh STOP đã được tiếp nhận, API phản hồi status='STOPPING'")

        # Chờ Nova tắt máy xong -> STOPPED + Settling Cooldown 3.5s
        item_stopped = wait_for_dynamodb_status(
            instances_table_reb,
            instance_id,
            target_statuses="STOPPED",
            max_retries=60,
            poll_interval=3.5,
            settle_seconds=3.5,
            step_name="[REGION B] BƯỚC 2: Chờ hạ tầng tắt máy -> STOPPED",
        )
        assert item_stopped["current_status"] == "STOPPED"
        print(f"[REGION B - BƯỚC 2 THÀNH CÔNG] Máy ảo {instance_id} đã STOPPED và ổn định!")

        # =========================================================================
        # BƯỚC 3: BẬT MÁY (ACTION START)
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[REGION B - BƯỚC 3] Gửi yêu cầu bật máy (POST /api/instances/{instance_id}/actions: START)")
        print(f"=======================================================")
        start_res = requests.post(
            f"{base_url}/api/instances/{instance_id}/actions",
            headers=headers,
            json={"action": "START"},
            timeout=10,
        )
        assert start_res.status_code == 200, f"Gửi lệnh START thất bại: {start_res.text}"
        assert start_res.json()["data"]["status"] == "STARTING"
        print(f"[REGION B - BƯỚC 3] Lệnh START đã được tiếp nhận, API phản hồi status='STARTING'")

        # Chờ Nova bật máy xong -> RUNNING + Settling Cooldown 3.5s
        item_restarted = wait_for_dynamodb_status(
            instances_table_reb,
            instance_id,
            target_statuses="RUNNING",
            max_retries=60,
            poll_interval=3.5,
            settle_seconds=3.5,
            step_name="[REGION B] BƯỚC 3: Chờ hạ tầng bật máy -> RUNNING",
        )
        assert item_restarted["current_status"] == "RUNNING"
        print(f"[REGION B - BƯỚC 3 THÀNH CÔNG] Máy ảo {instance_id} đã RUNNING trở lại!")

        # =========================================================================
        # BƯỚC 4: HỦY MÁY ẢO (ACTION TERMINATE)
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[REGION B - BƯỚC 4] Gửi yêu cầu hủy máy (POST /api/instances/{instance_id}/actions: TERMINATE)")
        print(f"=======================================================")
        term_res = requests.post(
            f"{base_url}/api/instances/{instance_id}/actions",
            headers=headers,
            json={"action": "TERMINATE"},
            timeout=10,
        )
        assert term_res.status_code == 200, f"Gửi lệnh TERMINATE thất bại: {term_res.text}"
        assert term_res.json()["data"]["status"] == "SHUTTING_DOWN"
        print(f"[REGION B - BƯỚC 4] Lệnh TERMINATE đã tiếp nhận, API phản hồi status='SHUTTING_DOWN'")

        # Chờ Terminate Pipeline giải phóng tài nguyên -> TERMINATED
        item_terminated = wait_for_dynamodb_status(
            instances_table_reb,
            instance_id,
            target_statuses="TERMINATED",
            max_retries=60,
            poll_interval=3.5,
            settle_seconds=0,
            step_name="[REGION B] BƯỚC 4: Chờ Terminate Pipeline -> TERMINATED",
        )
        assert item_terminated["current_status"] == "TERMINATED"
        print(f"[REGION B - BƯỚC 4 THÀNH CÔNG] Máy ảo {instance_id} đã TERMINATED hoàn toàn!")

    finally:
        # Cơ chế Fail-Safe Cleanup: nếu kịch bản fail giữa chừng, đảm bảo dọn dẹp máy ảo
        if instance_id:
            try:
                resp = instances_table_reb.get_item(
                    Key={"instance_id": instance_id}, ConsistentRead=True
                )
                curr_status = resp.get("Item", {}).get("current_status")
                if curr_status and curr_status not in ["TERMINATED", "DELETED", "SHUTTING_DOWN"]:
                    print(f"\n[FAIL-SAFE CLEANUP] Dọn dẹp máy ảo {instance_id} ở trạng thái {curr_status}...")
                    requests.post(
                        f"{base_url}/api/instances/{instance_id}/actions",
                        headers=headers,
                        json={"action": "TERMINATE"},
                        timeout=10,
                    )
            except Exception as clean_err:
                print(f"[FAIL-SAFE CLEANUP WARNING] Không thể dọn dẹp máy ảo {instance_id}: {clean_err}")
