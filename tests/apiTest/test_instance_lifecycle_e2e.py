import time
import requests
from tests.apiTest.conftest import wait_for_dynamodb_status


def test_instance_lifecycle_e2e_with_dynamodb_retry(
    base_url, instances_table, auth_context
):
    """Kịch bản kiểm thử E2E toàn trình vòng đời máy ảo với cơ chế Retry Polling thực tế:

    1. Gửi lệnh Launch (POST /api/instances). 2. Dùng Retry Polling chờ
    DynamoDB cập nhật thực tế từ hạ tầng Step Function:
       PENDING -> CREATING -> RUNNING.
    3. Khi máy đã RUNNING trên DynamoDB, gửi lệnh STOP (POST
    /api/instances/{id}/actions). 4. Dùng Retry Polling chờ DynamoDB cập nhật
    thực tế từ hạ tầng:
       STOPPING -> STOPPED.
    5. Khi máy đã STOPPED trên DynamoDB, gửi lệnh START (POST
    /api/instances/{id}/actions). 6. Dùng Retry Polling chờ DynamoDB cập nhật
    thực tế từ hạ tầng:
       STARTING -> RUNNING.
    7. Khi máy đã RUNNING trên DynamoDB, gửi lệnh TERMINATE (POST
    /api/instances/{id}/actions). 8. Dùng Retry Polling chờ DynamoDB cập nhật
    thực tế từ Terminate Pipeline:
       SHUTTING_DOWN -> TERMINATED.
    """
    headers = auth_context["headers"]
    instance_id = None
    vm_name = f"e2e-vm-{int(time.time())}"

    try:
        # =========================================================================
        # BƯỚC 1: KHỞI TẠO MÁY ẢO (LAUNCH) VÀ CHỜ HẠ TẦNG CẬP NHẬT RUNNING
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[BƯỚC 1] Gửi yêu cầu khởi tạo máy ảo: {vm_name}")
        print(f"=======================================================")
        launch_payload = {
            "name": vm_name,
            "region": "ap-southeast-2",
            "flavor": auth_context["flavor"],
            "imageId": auth_context["image_id"],
            "keyPairName": auth_context["key_name"],
            "ebsSizeGb": 1,
        }

        launch_res = requests.post(
            f"{base_url}/api/instances",
            headers=headers,
            json=launch_payload,
            timeout=15,
        )

        assert launch_res.status_code == 202, f"Launch thất bại: {launch_res.status_code} - {launch_res.text}"
        instance_data = launch_res.json()["data"]
        instance_id = instance_data["id"]
        assert instance_id.startswith("i-"), f"Mã máy ảo không hợp lệ: {instance_id}"
        print(f"[BƯỚC 1] Đã tiếp nhận yêu cầu launch: instance_id={instance_id}, HTTP 202 Accepted")

        # 1a. Chờ bản ghi ban đầu xuất hiện ở PENDING
        item_pending = wait_for_dynamodb_status(
            instances_table,
            instance_id,
            target_statuses="PENDING",
            max_retries=10,
            poll_interval=2.0,
            step_name="BƯỚC 1a: Xác nhận PENDING",
        )
        assert item_pending["current_status"] == "PENDING"

        # 1b. Dùng Retry Polling thực tế chờ Step Function & Nova cấp phát xong -> RUNNING
        item_running = wait_for_dynamodb_status(
            instances_table,
            instance_id,
            target_statuses="RUNNING",
            max_retries=60,
            poll_interval=3.5,
            step_name="BƯỚC 1b: Chờ hạ tầng hoàn tất -> RUNNING",
        )
        assert item_running["current_status"] == "RUNNING"
        print(f"[BƯỚC 1 THÀNH CÔNG] Máy ảo {instance_id} đã thực sự RUNNING trên DynamoDB!")

        # =========================================================================
        # BƯỚC 2: TẮT MÁY (ACTION STOP) VÀ CHỜ HẠ TẦNG CẬP NHẬT STOPPED
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[BƯỚC 2] Gửi yêu cầu tắt máy (POST /api/instances/{instance_id}/actions: STOP)")
        print(f"=======================================================")
        stop_res = requests.post(
            f"{base_url}/api/instances/{instance_id}/actions",
            headers=headers,
            json={"action": "STOP"},
            timeout=10,
        )
        assert stop_res.status_code == 200, f"Gửi lệnh STOP thất bại: {stop_res.text}"
        assert stop_res.json()["data"]["status"] == "STOPPING"
        print(f"[BƯỚC 2] Lệnh STOP đã được tiếp nhận, API phản hồi status='STOPPING'")

        # Dùng Retry Polling thực tế chờ Nova tắt máy xong -> STOPPED
        item_stopped = wait_for_dynamodb_status(
            instances_table,
            instance_id,
            target_statuses="STOPPED",
            max_retries=60,
            poll_interval=3.5,
            step_name="BƯỚC 2: Chờ hạ tầng tắt máy -> STOPPED",
        )
        assert item_stopped["current_status"] == "STOPPED"
        print(f"[BƯỚC 2 THÀNH CÔNG] Máy ảo {instance_id} đã thực sự STOPPED trên DynamoDB!")

        # =========================================================================
        # BƯỚC 3: BẬT MÁY (ACTION START) VÀ CHỜ HẠ TẦNG CẬP NHẬT RUNNING
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[BƯỚC 3] Gửi yêu cầu bật máy (POST /api/instances/{instance_id}/actions: START)")
        print(f"=======================================================")
        start_res = requests.post(
            f"{base_url}/api/instances/{instance_id}/actions",
            headers=headers,
            json={"action": "START"},
            timeout=10,
        )
        assert start_res.status_code == 200, f"Gửi lệnh START thất bại: {start_res.text}"
        assert start_res.json()["data"]["status"] == "STARTING"
        print(f"[BƯỚC 3] Lệnh START đã được tiếp nhận, API phản hồi status='STARTING'")

        # Dùng Retry Polling thực tế chờ Nova bật máy xong -> RUNNING
        item_restarted = wait_for_dynamodb_status(
            instances_table,
            instance_id,
            target_statuses="RUNNING",
            max_retries=60,
            poll_interval=3.5,
            step_name="BƯỚC 3: Chờ hạ tầng bật máy -> RUNNING",
        )
        assert item_restarted["current_status"] == "RUNNING"
        print(f"[BƯỚC 3 THÀNH CÔNG] Máy ảo {instance_id} đã thực sự trở lại trạng thái RUNNING trên DynamoDB!")

        # =========================================================================
        # BƯỚC 4: HỦY MÁY ẢO (ACTION TERMINATE) VÀ CHỜ TERMINATE PIPELINE HOÀN TẤT
        # =========================================================================
        print(f"\n=======================================================")
        print(f"[BƯỚC 4] Gửi yêu cầu hủy máy (POST /api/instances/{instance_id}/actions: TERMINATE)")
        print(f"=======================================================")
        term_res = requests.post(
            f"{base_url}/api/instances/{instance_id}/actions",
            headers=headers,
            json={"action": "TERMINATE"},
            timeout=10,
        )
        assert term_res.status_code == 200, f"Gửi lệnh TERMINATE thất bại: {term_res.text}"
        assert term_res.json()["data"]["status"] == "SHUTTING_DOWN"
        print(f"[BƯỚC 4] Lệnh TERMINATE đã được tiếp nhận, API phản hồi status='SHUTTING_DOWN'")

        # Dùng Retry Polling thực tế chờ Terminate Pipeline giải phóng tài nguyên -> TERMINATED
        item_terminated = wait_for_dynamodb_status(
            instances_table,
            instance_id,
            target_statuses="TERMINATED",
            max_retries=60,
            poll_interval=3.5,
            step_name="BƯỚC 4: Chờ Terminate Pipeline hoàn tất -> TERMINATED",
        )
        assert item_terminated["current_status"] == "TERMINATED"
        print(f"[BƯỚC 4 THÀNH CÔNG] Máy ảo {instance_id} đã hoàn tất dọn dẹp và kết thúc ở TERMINATED!")

    finally:
        # =========================================================================
        # DỌN DẸP BẢO VỆ (TEARDOWN CLEANUP)
        # =========================================================================
        if instance_id:
            try:
                res = instances_table.get_item(Key={"instance_id": instance_id}, ConsistentRead=True)
                current = res.get("Item", {}).get("current_status")
                if current and current not in ["TERMINATED", "SHUTTING_DOWN"]:
                    print(f"\n[TEARDOWN] Gửi lệnh TERMINATE dọn dẹp cho {instance_id} (trạng thái hiện tại: {current})...")
                    requests.post(
                        f"{base_url}/api/instances/{instance_id}/actions",
                        headers=headers,
                        json={"action": "TERMINATE"},
                        timeout=10,
                    )
            except Exception as ex:
                print(f"[TEARDOWN WARN] Lỗi trong quá trình dọn dẹp {instance_id}: {ex}")
