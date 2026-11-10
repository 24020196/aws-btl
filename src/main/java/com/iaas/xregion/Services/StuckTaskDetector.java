package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.SecurityGroupSyncStatus;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Phát hiện tác vụ "kẹt": đã sang trạng thái chuyển tiếp nhưng ở đó quá lâu.
 *
 * <p>Vì sao cần: XR-RISK-004. Trước đây trạng thái kẹt chỉ lộ ra khi người dùng mở UI, nên
 * thử nghiệm không giám sát có thể để một yêu cầu mắc kẹt vô thời hạn mà không ai biết.
 *
 * <p>Nguyên tắc: chỉ báo, không tự retry và không tự sửa tài nguyên. Ngưỡng tính theo từng
 * loại thao tác để không báo động chỉ vì eventual consistency bình thường.
 */
public final class StuckTaskDetector {

    /** Mốc thời gian tính bằng giây; đủ rộng để không báo nhầm khi hệ thống chậm. */
    public record Thresholds(long pendingSeconds, long transitioningSeconds, long syncPendingSeconds) {
        public static Thresholds defaults() {
            return new Thresholds(15 * 60, 30 * 60, 10 * 60);
        }
    }

    public record Finding(String instanceId, String kind, String status, String detail) {
    }

    private StuckTaskDetector() {
    }

    /** Tuổi của bản ghi tính bằng giây; null khi không có mốc thời gian để kết luận. */
    static Long ageSeconds(Long lastTimestampEpoch, long nowEpochSeconds) {
        if (lastTimestampEpoch == null || lastTimestampEpoch <= 0) {
            return null;
        }
        return nowEpochSeconds - lastTimestampEpoch;
    }

    public static List<Finding> inspect(InstanceEntity entity, long nowEpochSeconds, Thresholds thresholds) {
        List<Finding> findings = new ArrayList<>();
        if (entity == null || entity.getInstanceId() == null) {
            return findings;
        }
        Long age = ageSeconds(entity.getLastMigrationTimestamp(), nowEpochSeconds);
        if (age == null || age < 0) {
            // Không có mốc thời gian tin được thì không kết luận — im lặng tốt hơn báo nhầm.
            return findings;
        }
        String status = entity.getCurrentStatus() == null ? "" : entity.getCurrentStatus().toUpperCase();
        switch (status) {
            case "PENDING" -> {
                if (age > thresholds.pendingSeconds()) {
                    findings.add(new Finding(entity.getInstanceId(), "LAUNCH_PENDING", status,
                            "PENDING " + age + "s > " + thresholds.pendingSeconds() + "s"));
                }
            }
            case "STOPPING", "REBOOTING", "SHUTTING_DOWN", "MIGRATING" -> {
                if (age > thresholds.transitioningSeconds()) {
                    findings.add(new Finding(entity.getInstanceId(), "TRANSITION_STUCK", status,
                            status + " " + age + "s > " + thresholds.transitioningSeconds() + "s"));
                }
            }
            default -> {
                // RUNNING/STOPPED/FAILED/TERMINATED không phải trạng thái chuyển tiếp.
            }
        }
        return findings;
    }

    /**
     * Cấu hình SG đã tăng revision nhưng hạ tầng chưa xác nhận áp dụng.
     *
     * <p>So sánh {@code applied_revision} với {@code revision} thay vì tin {@code sync_status}:
     * trên canary, sync_status = SYNCED nhưng applied_revision đứng ở 15 trong khi revision là 17.
     */
    public static Finding inspectSecurityGroup(Long revision, Long appliedRevision, String syncStatus,
                                               Long lastCheckedEpoch, long nowEpochSeconds,
                                               Thresholds thresholds) {
        if (revision == null || revision <= 0) {
            return null;
        }
        if (SecurityGroupSyncStatus.SYNC_BLOCKED.equals(syncStatus)) {
            // Đã biết lý do chặn; đây là trạng thái cần người xử lý chứ không phải "kẹt mù".
            return null;
        }
        long applied = appliedRevision == null ? 0L : appliedRevision;
        if (applied >= revision) {
            return null;
        }
        Long age = ageSeconds(lastCheckedEpoch, nowEpochSeconds);
        if (age == null) {
            age = 0L;
        }
        if (age <= thresholds.syncPendingSeconds()) {
            return null;
        }
        return new Finding("sg:" + revision, "SG_NOT_APPLIED", syncStatus,
                "applied_revision=" + applied + " < revision=" + revision
                        + " (không đổi trong " + Duration.ofSeconds(age).toSeconds() + "s)");
    }
}
