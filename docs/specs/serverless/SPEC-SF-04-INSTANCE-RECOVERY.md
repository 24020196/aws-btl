# SPEC-SF-04: Hệ Thống Tự Thu Hồi Máy Ảo Lỗi (Instance Fault Recovery)

> **Phiên bản**: `1.0.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Tài liệu cha**: [SPEC-SF-00: Serverless Scope Guard](SPEC-SF-00-SERVERLESS-SCOPE-GUARD.md)

---

## 1. Tổng Quan Kiến Trúc & Mô Hình An Toàn

Lambda `XRegion-InstanceRecovery` là cơ chế giám sát chạy ngầm độc lập (mỗi **5 phút** qua EventBridge Schedule) nhằm phát hiện các máy ảo thử nghiệm bị treo, lỗi phần cứng Nova hoặc lệch trạng thái kéo dài, sau đó kích hoạt quy trình thu hồi và dọn dẹp tài nguyên tự động.

- **Mã nguồn**: `serverless/launch-contract/XRegion-InstanceRecovery/` (`recovery_policy.py`, `recovery_worker.py`).
- **Mô hình An toàn Đa Tầng (Multi-Layer Safety Model)**:
  1. **Mặc định là Chế độ Quan Sát (Dry-Run by Default)**: Nếu biến môi trường `XREGION_RECOVERY_LIVE` không bật `true`, hệ thống chỉ ghi log phân loại (`WOULD_RECOVER`, `DECISION`), tuyệt đối không sửa đổi DB hoặc xóa tài nguyên.
  2. **Kiểm soát qua Danh Sách Cho Phép (Allowlist Guard)**: Khi bật Live Mode, chỉ những máy ảo nằm trong danh sách `XREGION_RECOVERY_ALLOWLIST` mới được phép tiến hành dọn dẹp.
  3. **Không dùng Circuit Breaker (Xử lý lỗi tuần tự toàn diện)**: Thu hồi tuần tự từng máy ảo lỗi thỏa mãn điều kiện bền vững mà không ngắt quãng cả đợt quét, đảm bảo giải phóng tối đa tài nguyên có thể.

---

## 2. Tiêu Chí Đánh Giá Lỗi Bền Vững (Durable Fault Mandate)

Một máy ảo **CHỈ ĐƯỢC PHÉP ĐƯA RA QUYẾT ĐỊNH XÓA (`DELETE`)** khi thỏa mãn đồng thời cả 2 điều kiện bất biến:

1. **Chu kỳ quan sát liên tiếp**: Được phát hiện bị lỗi trong **tối thiểu 3 chu kỳ quét liên tiếp (`seen >= 3`)**.
2. **Thời gian lỗi tồn đọng**: Thời gian tính từ lần đầu ghi nhận lỗi vượt ngưỡng **tối thiểu 30 phút (`age >= 1800 giây`)**.

```python
def durable(evidence, record, policy_cfg, now):
    since = record.get("recovery_decision_at")
    seen = int(record.get("recovery_observations") or 1)
    if not since:
        return False, "chưa có lịch sử quan sát"
    elapsed = now - int(since)
    if elapsed < policy_cfg.get("min_age_s", 1800):
        return False, "mới được đánh giá lỗi %ds" % elapsed
    if seen < policy_cfg.get("min_observations", 3):
        return False, "mới quan sát %d lần" % seen
    return True, ""
```

---

## 3. Ma Trận Quyết Định Phân Loại (Classification Matrix)

Các trạng thái máy ảo được phân loại thuần túy qua module `recovery_policy.py`:

| Trạng thái DDB | Trạng thái Nova Thực Tế | Thời gian tồn tại | Quyết định (`verdict`) | Hành động kỹ thuật |
| :--- | :--- | :--- | :--- | :--- |
| `FAILED` | `ERROR` / `TERMINATED` / `DELETED` | `>= 30 phút & >= 3 sweeps` | **`DELETE`** | Gọi Step Function TerminateInstance dọn dẹp sạch sẽ |
| `FAILED` | `ERROR` / `TERMINATED` | `< 30 phút hoặc < 3 sweeps` | **`OBSERVE`** | Tăng số lần quan sát `recovery_observations`, chờ tiếp |
| `RUNNING` | Không có bản ghi Nova | `>= 30 phút` | **`REPAIR`** | Sửa trạng thái (không phá hủy tài nguyên) |
| `RUNNING` | `SHUTOFF` / `STOPPED` | Mọi thời điểm | **`REPAIR`** | Đồng bộ lại DDB sang `STOPPED` (người dùng chủ động tắt) |
| `MIGRATING` | Bất kỳ | Mọi thời điểm | **`HOLD`** | Đang có tiến trình di trú, cấm can thiệp |
| Bất kỳ | OpenStack không phản hồi (`SICK`) | Mọi thời điểm | **`HOLD`** | Sự cố hạ tầng chung, cấm đưa ra quyết định xóa |

> [!WARNING]
> **Loại bỏ trạng thái Shelved**: Toàn bộ tham chiếu tới `SHELVED` và `SHELVED_OFFLOADED` đã bị xóa bỏ hoàn toàn khỏi `recovery_policy.py` để tuân thủ tính bất biến của SPEC-01.

---

## 4. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành đặc tả Instance Fault Recovery, chuẩn hóa tiêu chí lỗi bền vững (>=3 sweeps, >=30m), loại bỏ shelved, xóa tuần tự không dùng circuit breaker. |
