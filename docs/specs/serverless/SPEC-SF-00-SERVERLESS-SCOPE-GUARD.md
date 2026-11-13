# SPEC-SF-00: Quy Chế Quản Trị Serverless & Step Functions (Serverless Scope Guard)

> **Phiên bản**: `1.2.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Tài liệu cha**: [SPEC-00: Agent Scope Guard](../SPEC-00-AGENT-SCOPE-GUARD.md)

---

## 1. Mục Đích & Nguyên Tắc Tối Cao (Master Serverless Mandate)

Tài liệu này mở rộng [SPEC-00: Agent Scope Guard](../SPEC-00-AGENT-SCOPE-GUARD.md) áp dụng riêng biệt và nghiêm ngặt cho toàn bộ phân hệ **AWS Serverless**, bao gồm:
- Các máy trạng thái AWS Step Functions: `LaunchInstance.asl.json`, `TerminateInstance.asl.json`.
- Các hàm AWS Lambda Python: `XRegion-LaunchInstance-*`, `XRegion-TerminateInstance-*`, `XRegion-CinderPoolManager`, `XRegion-InstanceRecovery`, `XRegion-SyncSecurityGroup`, `XRegion-Network-*`.
- Hàng đợi SQS FIFO, EventBridge Bus và Rules, SSM Run Command scripts.

> [!IMPORTANT]
> ### QUY TẮC BẤT BIẾN: ZERO-SPECULATION TRÊN HẠ TẦNG SERVERLESS
> 1. **Cấm tự ý thêm bớt State**: Tuyệt đối không được thêm hoặc bớt bất kỳ State nào trong Step Functions ASL ngoài các sơ đồ đã được phê duyệt.
> 2. **Cấm phá vỡ Payload Contract**: Mọi Task Lambda phải nhận và trả về đúng Schema JSON đã định nghĩa trong Spec. Bất kỳ trường nào thiếu hoặc sai kiểu phải fail-fast ngay lập tức.
> 3. **Cấm tự ý tăng giảm Retry & Timeout**: Số lần Retry, BackoffRate và TimeoutSeconds là các thông số bất biến đã được tính toán đồng bộ với SLA hệ thống.
> 4. **Cấm tự ý chạy lệnh phá hủy ngoài Live Mode**: Mọi thao tác hủy diệt (Delete VM, Delete Volume, Release IP) trong Lambda Recovery phải tuân thủ nghiêm ngặt cờ `XREGION_RECOVERY_LIVE=true` và danh sách allowlist.

---

## 2. Giao Thức Tạm Ngưng Serverless (Pause Protocol for Serverless)

Nếu trong quá trình triển khai, kiểm thử hoặc tối ưu hóa mà phát hiện:
- Một mã lỗi Lambda mới chưa có trong khối `Retry` hoặc `Catch` của Step Function.
- Cần bổ sung tham số mới vào Payload giữa 2 Task.
- Cơ chế đồng bộ hoặc bồi hoàn chưa bao quát một trường hợp biên (Edge Case) mới.

Agent **BẮT BUỘC PHẢI TẠM NGƯNG NGAY LẬP TỨC (PAUSE)**:
1. Thông báo rõ ràng cho kỹ sư trưởng/người dùng về điểm khuyết thiếu trong Spec Serverless.
2. Đợi người dùng cập nhật và phê duyệt tài liệu Spec (tăng version SemVer).
3. Tuyệt đối không tự ý "vá tạm" mã nguồn Lambda hoặc file ASL trước khi Spec được duyệt.

---

## 3. Danh Mục Đặc Tả Serverless Trực Thuộc

| Mã Tài Liệu | Tên Tài Liệu Phân Hệ | Phạm Vi Quản Lý | Phiên Bản |
| :--- | :--- | :--- | :--- |
| **`SPEC-SF-01`** | [Launch Pipeline Step Function](SPEC-SF-01-LAUNCH-PIPELINE.md) | `LaunchInstance.asl.json`, CheckPool, BootNova, ExtendVolume, VerifyNetwork, SyncDynamoDB | `1.0.0` |
| **`SPEC-SF-02`** | [Terminate Pipeline Step Function](SPEC-SF-02-TERMINATE-PIPELINE.md) | `TerminateInstance.asl.json`, Gỡ NAT nftables, Xóa Compute/Storage, Hard Delete DDB | `1.1.0` |
| **`SPEC-SF-03`** | [Cinder Warm Pool Manager](SPEC-SF-03-POOL-MANAGER.md) | `XRegion-CinderPoolManager`, Giới hạn Pool <= 2, Lock nguyên tử `EBS-POOL-LOCK` | `1.0.0` |
| **`SPEC-SF-04`** | [Instance Fault Recovery](SPEC-SF-04-INSTANCE-RECOVERY.md) | `XRegion-InstanceRecovery`, Quét lỗi bền vững (>=3 sweeps, >=30m), Xử lý tuần tự | `1.0.0` |
| **`SPEC-SF-05`** | [Security Group Synchronizer](SPEC-SF-05-SECURITY-GROUP-SYNC.md) | `XRegion-SyncSecurityGroup`, Khóa lạc quan `revision`, Đồng bộ Neutron SG | `1.0.0` |
| **`SPEC-SF-06`** | [Lifecycle Pipeline Step Function](SPEC-SF-06-LIFECYCLE-PIPELINE.md) | `LifecycleInstance.asl.json`, `XRegion-InstanceLifecycle`, STOP/START/REBOOT observe-before-write | `1.0.0` |
| **`SPEC-SF-08`** | [Migration Pipeline Step Function](SPEC-SF-08-MIGRATION-PIPELINE.md) | `MigrateInstance`, snapshot/copy polling, `TriggerTargetLaunch`, Compensating Rollback | `1.2.0` |
| **`SPEC-SF-09`** | [Migrate Target Boot Step Function](SPEC-SF-09-MIGRATE-TARGET-BOOT.md) | `MigrateTargetBoot`, boot Nova VM từ `dest_snapshot_id` theo cơ chế `LaunchInstance`, giữ nguyên SG rules, Rollback 2 tầng | `1.2.0` |

---

## 4. Bảng Kiểm Tra Trước Khi Triển Khai (Pre-flight Checklist)

Trước khi chạy deploy hoặc chỉnh sửa bất kỳ file nào trong `serverless/`:
- [ ] Đã kiểm tra tính tương thích của JSON ASL với AWS Step Functions linter.
- [ ] Đã xác nhận `CheckPool` dùng Exponential Backoff 5 lần (~155s).
- [ ] Đã xác nhận `TimeoutSeconds` của cả 2 Step Function là **300 giây**.
- [ ] Đã xác nhận Lambda `sync_dynamodb.py` lưu `owner = username` (cấm `"system"`).
- [ ] Đã xác nhận Lambda `TerminateInstance-SyncDynamoDB` thực hiện `delete_item` (Hard Delete).
- [ ] Đã xác nhận `cinder_pool_manager.py` dùng mốc tối đa 2 volume rảnh rỗi (`max(0, 2 - occupied)`).
- [ ] Đã chạy toàn bộ bộ test `pytest serverless/launch-contract/tests` đạt 100% PASS.

---

## 5. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành Quy chế Quản trị Serverless Scope Guard và Pause Protocol cho Lambda & Step Functions. |
| `2026-11-10` | `1.1.0` | Lead Architect / Product Owner | Cập nhật SPEC-SF-02 v1.1.0 sau phỏng vấn xác nhận xacnhan-skill cho Terminate Step Function. |
| `2026-11-11` | `1.2.0` | Lead Architect / Product Owner | Ban hành SPEC-SF-06 v1.0.0: chuyển STOP/START/REBOOT sang Step Functions `LifecycleInstance`, observe-before-write, cấm shelve/unshelve, timeout 300s. |
