import time
import pytest
import requests


def test_launch_missing_required_fields(base_url, auth_context):
    """Kiểm tra POST /api/instances trả về 400 Bad Request khi thiếu các trường bắt buộc."""
    headers = auth_context["headers"]

    # 1. Thiếu 'name'
    payload_no_name = {
        "region": "ap-southeast-2",
        "flavor": auth_context["flavor"],
        "imageId": auth_context["image_id"],
        "keyPairName": auth_context["key_name"],
    }
    res = requests.post(f"{base_url}/api/instances", headers=headers, json=payload_no_name)
    assert res.status_code == 400, f"Kỳ vọng 400 khi thiếu name, nhận được {res.status_code}"
    assert res.json().get("success") is False

    # 2. Thiếu 'region'
    payload_no_region = {
        "name": f"test-vm-{int(time.time())}",
        "flavor": auth_context["flavor"],
        "imageId": auth_context["image_id"],
    }
    res = requests.post(f"{base_url}/api/instances", headers=headers, json=payload_no_region)
    assert res.status_code == 400, f"Kỳ vọng 400 khi thiếu region, nhận được {res.status_code}"

    # 3. Thiếu 'flavor'
    payload_no_flavor = {
        "name": f"test-vm-{int(time.time())}",
        "region": "ap-southeast-2",
        "imageId": auth_context["image_id"],
    }
    res = requests.post(f"{base_url}/api/instances", headers=headers, json=payload_no_flavor)
    assert res.status_code == 400, f"Kỳ vọng 400 khi thiếu flavor, nhận được {res.status_code}"

    # 4. Thiếu 'imageId'
    payload_no_image = {
        "name": f"test-vm-{int(time.time())}",
        "region": "ap-southeast-2",
        "flavor": auth_context["flavor"],
    }
    res = requests.post(f"{base_url}/api/instances", headers=headers, json=payload_no_image)
    assert res.status_code == 400, f"Kỳ vọng 400 khi thiếu imageId, nhận được {res.status_code}"


def test_launch_invalid_ebs_size(base_url, auth_context):
    """Kiểm tra POST /api/instances trả về 400 khi dung lượng đĩa ebsSizeGb < 1."""
    headers = auth_context["headers"]
    payload = {
        "name": f"test-vm-invalidebs-{int(time.time())}",
        "region": "ap-southeast-2",
        "flavor": auth_context["flavor"],
        "imageId": auth_context["image_id"],
        "ebsSizeGb": 0,
    }
    res = requests.post(f"{base_url}/api/instances", headers=headers, json=payload)
    assert res.status_code == 400, f"Kỳ vọng 400 khi ebsSizeGb <= 0, nhận được {res.status_code}"
    assert res.json().get("success") is False


def test_launch_unauthenticated(base_url):
    """Kiểm tra POST /api/instances bị từ chối 401/403 khi không có Bearer token."""
    res = requests.post(
        f"{base_url}/api/instances",
        json={"name": "unauth-vm", "region": "ap-southeast-2", "flavor": "m1.small", "imageId": "img-1"},
    )
    assert res.status_code in [401, 403], f"Kỳ vọng 401 hoặc 403, nhận được {res.status_code}"


def test_action_unknown_action(base_url, auth_context):
    """Kiểm tra POST /api/instances/{id}/actions trả về 400 khi action không thuộc enum hợp lệ."""
    headers = auth_context["headers"]
    res = requests.post(
        f"{base_url}/api/instances/i-dummy123/actions",
        headers=headers,
        json={"action": "INVALID_ACTION"},
    )
    assert res.status_code in [400, 404], f"Kỳ vọng 400 hoặc 404, nhận được {res.status_code}"


def test_action_empty_payload(base_url, auth_context):
    """Kiểm tra POST /api/instances/{id}/actions trả về 400 khi body rỗng thiếu trường action."""
    headers = auth_context["headers"]
    res = requests.post(
        f"{base_url}/api/instances/i-dummy123/actions",
        headers=headers,
        json={},
    )
    assert res.status_code == 400, f"Kỳ vọng 400 validation error, nhận được {res.status_code}"


def test_action_instance_not_found(base_url, auth_context):
    """Kiểm tra POST /api/instances/{id}/actions trả về 404 Not Found khi instance không tồn tại."""
    headers = auth_context["headers"]
    res = requests.post(
        f"{base_url}/api/instances/i-notfound-99999999/actions",
        headers=headers,
        json={"action": "STOP"},
    )
    assert res.status_code == 404, f"Kỳ vọng 404 Not Found, nhận được {res.status_code}"
    assert res.json().get("success") is False


def test_action_unauthenticated(base_url):
    """Kiểm tra POST /api/instances/{id}/actions bị từ chối 401/403 khi không có token."""
    res = requests.post(
        f"{base_url}/api/instances/i-any/actions",
        json={"action": "STOP"},
    )
    assert res.status_code in [401, 403], f"Kỳ vọng 401 hoặc 403, nhận được {res.status_code}"
