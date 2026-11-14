import datetime
import json
import os
import boto3
from botocore.exceptions import ClientError

LOCAL_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
REMOTE_REGION = os.environ.get("REMOTE_REGION", "us-east-1")
GRACE_PERIOD_SECONDS = int(os.environ.get("GRACE_PERIOD_SECONDS", "1800"))  # 30 phút


def get_tag_value(tags, key):
    if not tags:
        return None
    for tag in tags:
        if tag.get("Key") == key:
            return tag.get("Value")
    return None


def is_xregion_managed(tags):
    if not tags:
        return False
    for tag in tags:
        k = tag.get("Key", "")
        v = tag.get("Value", "")
        if k == "Project" and "xregion" in v.lower():
            return True
        if k == "ManagedBy" and "xregion" in v.lower():
            return True
        if k in ("XRegionSnapshot", "XRegionVolumeKey", "XRegionSourceSnapshot"):
            return True
    return False


def get_all_existing_volume_ids(ec2_client):
    """Lấy toàn bộ tập hợp VolumeId hiện có trên vùng địa phương."""
    volume_ids = set()
    paginator = ec2_client.get_paginator("describe_volumes")
    for page in paginator.paginate():
        for vol in page.get("Volumes", []):
            volume_ids.add(vol["VolumeId"])
    return volume_ids


def get_all_existing_snapshot_ids(ec2_client):
    """Lấy toàn bộ tập hợp SnapshotId hiện có do self sở hữu."""
    snapshot_ids = set()
    paginator = ec2_client.get_paginator("describe_snapshots")
    for page in paginator.paginate(OwnerIds=["self"]):
        for snap in page.get("Snapshots", []):
            snapshot_ids.add(snap["SnapshotId"])
    return snapshot_ids


def clean_orphan_volume_snapshots(ec2_local, now, existing_volume_ids):
    """Nhiệm vụ 1:

    Quét snapshot tại Region B có VolumeId tham chiếu không còn tồn tại trên Region B.
    """
    deleted_snapshots = []
    paginator = ec2_local.get_paginator("describe_snapshots")

    print(f"\n--- [NHIỆM VỤ 1] Quét snapshot mồ côi (VolumeId không tồn tại) tại {LOCAL_REGION} ---")
    for page in paginator.paginate(OwnerIds=["self"]):
        for snap in page.get("Snapshots", []):
            snap_id = snap["SnapshotId"]
            vol_id = snap.get("VolumeId")
            start_time = snap.get("StartTime")
            tags = snap.get("Tags", [])

            # 1. Chỉ áp dụng cho snapshot do XRegion quản lý
            if not is_xregion_managed(tags):
                continue

            # 2. Kiểm tra khoảng đệm an toàn 30 phút (Grace Period)
            if start_time:
                age_seconds = (now - start_time).total_seconds()
                if age_seconds < GRACE_PERIOD_SECONDS:
                    print(f"  [SKIP GRACE] Snapshot {snap_id} mới tạo ({int(age_seconds)}s < {GRACE_PERIOD_SECONDS}s), bỏ qua.")
                    continue

            # 3. Kiểm tra sự tồn tại của VolumeId
            if vol_id and vol_id not in existing_volume_ids:
                print(f"  [ORPHAN VOLUME] Snapshot {snap_id} tham chiếu Volume {vol_id} KHÔNG CÒN TỒN TẠI trên {LOCAL_REGION}!")
                try:
                    ec2_local.delete_snapshot(SnapshotId=snap_id)
                    deleted_snapshots.append({
                        "snapshot_id": snap_id,
                        "missing_volume_id": vol_id,
                        "reason": "Volume does not exist in local region"
                    })
                    print(f"  -> Đã xóa thành công snapshot mồ côi: {snap_id}")
                except ClientError as e:
                    print(f"  -> Lỗi khi xóa snapshot {snap_id}: {e}")

    return deleted_snapshots


def clean_orphan_cross_region_snapshots(ec2_local, ec2_remote, now, remote_existing_snapshots):
    """Nhiệm vụ 2:

    Quét snapshot Cross-Region tại chính Region B có SourceSnapshotId ở vùng nguồn đã bị xóa.
    """
    deleted_snapshots = []
    paginator = ec2_local.get_paginator("describe_snapshots")

    print(f"\n--- [NHIỆM VỤ 2] Quét snapshot Cross-Region mồ côi tại chính {LOCAL_REGION} ---")
    for page in paginator.paginate(OwnerIds=["self"]):
        for snap in page.get("Snapshots", []):
            snap_id = snap["SnapshotId"]
            start_time = snap.get("StartTime")
            tags = snap.get("Tags", [])

            # Tìm tag SourceSnapshotId
            source_snap_id = get_tag_value(tags, "SourceSnapshotId")
            if not source_snap_id:
                # Một số bản ghi có thể lưu dưới dạng XRegionSourceSnapshot
                source_snap_id = get_tag_value(tags, "XRegionSourceSnapshot")

            if not source_snap_id:
                continue

            source_region = get_tag_value(tags, "SourceRegion") or REMOTE_REGION

            # 1. Kiểm tra khoảng đệm an toàn 30 phút (Grace Period)
            if start_time:
                age_seconds = (now - start_time).total_seconds()
                if age_seconds < GRACE_PERIOD_SECONDS:
                    print(f"  [SKIP GRACE] Snapshot Cross-Region {snap_id} mới tạo ({int(age_seconds)}s < {GRACE_PERIOD_SECONDS}s), bỏ qua.")
                    continue

            # 2. Đối soát xem SourceSnapshotId có còn tồn tại ở vùng nguồn hay không
            if source_snap_id not in remote_existing_snapshots:
                print(
                    f"  [ORPHAN CROSS-REGION] Snapshot {snap_id} tại {LOCAL_REGION} có SourceSnapshot {source_snap_id} "
                    f"KHÔNG CÒN TỒN TẠI tại vùng nguồn {source_region}!"
                )
                try:
                    ec2_local.delete_snapshot(SnapshotId=snap_id)
                    deleted_snapshots.append({
                        "snapshot_id": snap_id,
                        "missing_source_snapshot_id": source_snap_id,
                        "source_region": source_region,
                        "reason": "Source snapshot does not exist in source region"
                    })
                    print(f"  -> Đã xóa thành công snapshot cross-region mồ côi: {snap_id}")
                except ClientError as e:
                    print(f"  -> Lỗi khi xóa snapshot {snap_id}: {e}")

    return deleted_snapshots


def lambda_handler(event, context):
    print(f"Bắt đầu chu trình dọn dẹp snapshot mồ côi tại {LOCAL_REGION}...")
    now = datetime.datetime.now(datetime.timezone.utc)

    ec2_local = boto3.client("ec2", region_name=LOCAL_REGION)
    ec2_remote = boto3.client("ec2", region_name=REMOTE_REGION)

    # 1. Thu thập dữ liệu đối soát để tránh gọi API lặp lại
    print(f"Thu thập danh sách VolumeId đang tồn tại tại {LOCAL_REGION}...")
    local_volumes = get_all_existing_volume_ids(ec2_local)
    print(f"Tìm thấy {len(local_volumes)} volumes đang hoạt động tại {LOCAL_REGION}.")

    print(f"Thu thập danh sách SnapshotId nguồn đang tồn tại tại {REMOTE_REGION}...")
    remote_snapshots = get_all_existing_snapshot_ids(ec2_remote)
    print(f"Tìm thấy {len(remote_snapshots)} snapshots đang tồn tại tại {REMOTE_REGION}.")

    # 2. Thực thi Nhiệm vụ 1: Dọn snapshot mồ côi volume tại Region B
    deleted_vol_orphans = clean_orphan_volume_snapshots(ec2_local, now, local_volumes)

    # 3. Thực thi Nhiệm vụ 2: Dọn snapshot Cross-Region mồ côi tại chính Region B
    deleted_cr_orphans = clean_orphan_cross_region_snapshots(ec2_local, ec2_remote, now, remote_snapshots)

    summary = {
        "status": "SUCCESS",
        "region": LOCAL_REGION,
        "remote_region": REMOTE_REGION,
        "grace_period_seconds": GRACE_PERIOD_SECONDS,
        "deleted_orphan_volume_count": len(deleted_vol_orphans),
        "deleted_orphan_cross_region_count": len(deleted_cr_orphans),
        "deleted_orphan_volume_snapshots": deleted_vol_orphans,
        "deleted_orphan_cross_region_snapshots": deleted_cr_orphans,
    }

    print("\n=== KẾT QUẢ DỌN DẸP HOÀN TẤT ===")
    print(json.dumps(summary, indent=2, default=str))
    return summary
