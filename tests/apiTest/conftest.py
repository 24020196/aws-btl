import os
import time
import boto3
import pytest
import requests

API_BASE_URL = os.getenv("XREGION_API_URL", "http://localhost:8080")
AWS_REGION_REA = os.getenv("AWS_REGION_REA", "us-east-1")
AWS_REGION_REB = os.getenv("AWS_REGION_REB", "ap-southeast-2")
AWS_DEFAULT_REGION = os.getenv("AWS_DEFAULT_REGION", AWS_REGION_REB)


@pytest.fixture(scope="session")
def base_url():
    return API_BASE_URL


@pytest.fixture(scope="session")
def dynamodb_resource_rea():
    return boto3.resource("dynamodb", region_name=AWS_REGION_REA)


@pytest.fixture(scope="session")
def dynamodb_resource_reb():
    return boto3.resource("dynamodb", region_name=AWS_REGION_REB)


@pytest.fixture(scope="session")
def instances_table_rea(dynamodb_resource_rea):
    return dynamodb_resource_rea.Table("XRegion-Instances")


@pytest.fixture(scope="session")
def instances_table_reb(dynamodb_resource_reb):
    return dynamodb_resource_reb.Table("XRegion-Instances")


@pytest.fixture(scope="session")
def dynamodb_resource():
    return boto3.resource("dynamodb", region_name=AWS_DEFAULT_REGION)


@pytest.fixture(scope="session")
def instances_table(dynamodb_resource):
    return dynamodb_resource.Table("XRegion-Instances")


def _create_auth_context_for_region(base_url, target_region):
    """Đăng ký tài khoản kiểm thử E2E và chuẩn bị SSH Key, Flavor, Image hợp lệ cho vùng chỉ định."""
    ts = int(time.time() * 1000)
    region_tag = "rea" if target_region == "us-east-1" else "reb"
    username = f"e2e_{region_tag}_{ts}"
    password = "Password123!"

    # 1. Đăng ký tài khoản kiểm thử
    reg_res = requests.post(
        f"{base_url}/api/auth/register",
        json={
            "username": username,
            "password": password,
            "fullName": f"E2E Test User {region_tag.upper()} {ts}",
            "email": f"{username}@test.local",
        },
        timeout=10,
    )
    assert reg_res.status_code == 200, f"Đăng ký thất bại: {reg_res.text}"
    token = reg_res.json()["data"]["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # 2. Lấy Flavor hợp lệ
    flavors_res = requests.get(f"{base_url}/api/flavors", headers=headers, timeout=10)
    assert flavors_res.status_code == 200, f"Lấy flavors thất bại: {flavors_res.text}"
    flavors_data = flavors_res.json().get("data", [])
    flavor = flavors_data[0]["name"] if flavors_data else "m1.small"

    # 3. Lấy Image UUID hợp lệ
    images_res = requests.get(f"{base_url}/api/images", headers=headers, timeout=10)
    assert images_res.status_code == 200, f"Lấy images thất bại: {images_res.text}"
    images_data = images_res.json().get("data", [])
    
    # Ưu tiên tìm CirrOS hoặc Alpine đã đồng bộ trên cả REA & REB
    image_id = "c66c2ab2-68fe-40bb-8f55-d2e5ba1c944d"
    for img in images_data:
        img_id = img.get("id") or img.get("imageId")
        if img_id in ["831dc24b-9d29-4cb6-8154-9de2d0fd268f", "c66c2ab2-68fe-40bb-8f55-d2e5ba1c944d"]:
            image_id = img_id
            break

    # 4. Tạo SSH KeyPair cho user kiểm thử (sẽ tự động Fan-out qua cả 2 vùng theo SPEC-08)
    key_res = requests.post(
        f"{base_url}/api/keys",
        headers=headers,
        json={"name": f"key-{region_tag}-{ts}"},
        timeout=15,
    )
    assert key_res.status_code == 200, f"Tạo SSH Key thất bại: {key_res.text}"
    key_name = key_res.json()["data"]["keyName"]

    return {
        "username": username,
        "headers": headers,
        "token": token,
        "flavor": flavor,
        "image_id": image_id,
        "key_name": key_name,
        "region": target_region,
    }


@pytest.fixture(scope="session")
def auth_context(base_url):
    """Context mặc định (Sydney - REB) để duy trì tương thích ngược."""
    return _create_auth_context_for_region(base_url, AWS_REGION_REB)


@pytest.fixture(scope="session")
def auth_context_rea(base_url):
    """Context kiểm thử dành riêng cho Region A (us-east-1 - N. Virginia)."""
    return _create_auth_context_for_region(base_url, "us-east-1")


@pytest.fixture(scope="session")
def auth_context_reb(base_url):
    """Context kiểm thử dành riêng cho Region B (ap-southeast-2 - Sydney)."""
    return _create_auth_context_for_region(base_url, "ap-southeast-2")


def wait_for_dynamodb_status(
    table,
    instance_id,
    target_statuses,
    fail_statuses=None,
    max_retries=60,
    poll_interval=3.5,
    settle_seconds=3.5,
    step_name="Kiểm tra trạng thái",
):
    """Cơ chế Retry Polling thông minh kết hợp Settling Cooldown:

    1. Chờ DynamoDB XRegion-Instances cập nhật trạng thái thực tế từ hạ tầng với
       max_retries (mặc định 60 lần x 3.5s = 210 giây) và ConsistentRead=True.
    2. Hỗ trợ Fail-Fast nếu gặp trạng thái lỗi (FAILED, ERROR).
    3. [CHỐNG LỖI GỬI API QUÁ SỚM]: Khi vừa đạt trạng thái mục tiêu, tự động dừng
       settle_seconds (mặc định 3.5s) để OpenStack Nova Hypervisor, OVN Network
       và EventBridge ổn định hoàn toàn trước khi caller dispatch action tiếp theo.
    """
    if isinstance(target_statuses, str):
        target_statuses = [target_statuses]
    if fail_statuses is None:
        fail_statuses = ["FAILED", "ERROR"]

    last_status = None
    last_item = None

    print(
        f"\n[{step_name}] Bắt đầu Retry Polling chờ DynamoDB instance_id={instance_id} "
        f"đạt mục tiêu: {target_statuses} (Tối đa {max_retries} lần x {poll_interval}s)..."
    )

    for attempt in range(1, max_retries + 1):
        try:
            response = table.get_item(
                Key={"instance_id": instance_id}, ConsistentRead=True
            )
            item = response.get("Item")
        except Exception as e:
            print(f"  [RETRY {attempt}/{max_retries}] Lỗi kết nối DynamoDB: {e}. Thử lại sau...")
            time.sleep(poll_interval)
            continue

        if item:
            last_item = item
            last_status = item.get("current_status")
            print(
                f"  [RETRY {attempt}/{max_retries}] Instance {instance_id}: "
                f"current_status='{last_status}' (Kỳ vọng: {target_statuses})"
            )

            # 1. Kiểm tra Fail-Fast nếu rơi vào trạng thái lỗi
            if last_status in fail_statuses:
                raise AssertionError(
                    f"Fail-Fast kích hoạt: Máy ảo {instance_id} rơi vào trạng thái lỗi '{last_status}'! "
                    f"Chi tiết DynamoDB Item: {last_item}"
                )

            # 2. Kiểm tra nếu đã đạt trạng thái mục tiêu
            if last_status in target_statuses:
                print(
                    f"  [RETRY THÀNH CÔNG] Instance {instance_id} đã đạt trạng thái '{last_status}' "
                    f"sau {attempt} lần thử!"
                )
                if settle_seconds > 0:
                    print(
                        f"  [COOLDOWN SETTLING] Đang áp dụng thời gian ổn định {settle_seconds}s "
                        f"để Nova Hypervisor & OVN network sẵn sàng tiếp nhận API tiếp theo..."
                    )
                    time.sleep(settle_seconds)
                return item

        else:
            print(f"  [RETRY {attempt}/{max_retries}] Chưa tìm thấy bản ghi {instance_id} trên DynamoDB...")

        time.sleep(poll_interval)

    # Nếu hết chu kỳ retry mà chưa đạt trạng thái
    raise TimeoutError(
        f"Hết thời gian chờ ({max_retries * poll_interval}s): Instance {instance_id} "
        f"dừng lại ở current_status='{last_status}', không đạt mục tiêu: {target_statuses}. "
        f"Bản ghi cuối: {last_item}"
    )
