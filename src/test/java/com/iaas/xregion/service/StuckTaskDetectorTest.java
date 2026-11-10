package com.iaas.xregion.service;

import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.SecurityGroupSyncStatus;
import com.iaas.xregion.Services.StuckTaskDetector;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * XR-RISK-004: kẹt chỉ được phát hiện khi thật sự quá hạn, và không được che giấu bằng
 * sync_status = SYNCED như đã gặp trên canary.
 */
class StuckTaskDetectorTest {

    private static final long NOW = 1_800_000_000L;
    private static final StuckTaskDetector.Thresholds T = StuckTaskDetector.Thresholds.defaults();

    private static InstanceEntity instance(String status, Long lastTimestamp) {
        return InstanceEntity.builder()
                .instanceId("i-1")
                .currentStatus(status)
                .lastMigrationTimestamp(lastTimestamp)
                .build();
    }

    @Test
    @DisplayName("PENDING quá ngưỡng bị báo là LAUNCH_PENDING")
    void pendingBeyondThresholdIsReported() {
        var findings = StuckTaskDetector.inspect(instance("PENDING", NOW - T.pendingSeconds() - 5), NOW, T);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("LAUNCH_PENDING");
    }

    @Test
    @DisplayName("PENDING còn trong ngưỡng thì không báo")
    void pendingWithinThresholdIsQuiet() {
        assertThat(StuckTaskDetector.inspect(instance("PENDING", NOW - 60), NOW, T)).isEmpty();
    }

    @Test
    @DisplayName("Không có mốc thời gian thì không kết luận")
    void missingTimestampIsInconclusive() {
        assertThat(StuckTaskDetector.inspect(instance("PENDING", null), NOW, T)).isEmpty();
        assertThat(StuckTaskDetector.inspect(instance("PENDING", 0L), NOW, T)).isEmpty();
    }

    @Test
    @DisplayName("Trạng thái chuyển tiếp quá lâu bị báo là TRANSITION_STUCK")
    void transitionStuckIsReported() {
        var findings = StuckTaskDetector.inspect(
                instance("STOPPING", NOW - T.transitioningSeconds() - 1), NOW, T);
        assertThat(findings).hasSize(1);
        assertThat(findings.get(0).kind()).isEqualTo("TRANSITION_STUCK");
    }

    @Test
    @DisplayName("RUNNING và FAILED không bị coi là kẹt")
    void settledStatesAreNotStuck() {
        assertThat(StuckTaskDetector.inspect(instance("RUNNING", NOW - 99999), NOW, T)).isEmpty();
        assertThat(StuckTaskDetector.inspect(instance("FAILED", NOW - 99999), NOW, T)).isEmpty();
    }

    @Test
    @DisplayName("SG chưa áp dụng bị báo dù sync_status ghi SYNCED")
    void securityGroupMismatchIsReportedEvenWhenMarkedSynced() {
        var finding = StuckTaskDetector.inspectSecurityGroup(17L, 15L, SecurityGroupSyncStatus.SYNCED,
                NOW - T.syncPendingSeconds() - 1, NOW, T);
        assertThat(finding).isNotNull();
        assertThat(finding.kind()).isEqualTo("SG_NOT_APPLIED");
        assertThat(finding.detail()).contains("applied_revision=15").contains("revision=17");
    }

    @Test
    @DisplayName("SG đã áp dụng đủ revision thì không báo")
    void securityGroupAppliedIsQuiet() {
        assertThat(StuckTaskDetector.inspectSecurityGroup(17L, 17L, SecurityGroupSyncStatus.SYNCED,
                NOW - 99999, NOW, T)).isNull();
    }

    @Test
    @DisplayName("SG khối rõ ràng (SYNC_BLOCKED) không tính là kẹt mù")
    void blockedSecurityGroupIsNotAmbiguous() {
        assertThat(StuckTaskDetector.inspectSecurityGroup(17L, 15L, SecurityGroupSyncStatus.SYNC_BLOCKED,
                NOW - 99999, NOW, T)).isNull();
    }

    @Test
    @DisplayName("SG vừa đổi chưa quá ngưỡng thì chưa báo")
    void securityGroupWithinThresholdIsQuiet() {
        assertThat(StuckTaskDetector.inspectSecurityGroup(17L, 15L, SecurityGroupSyncStatus.PENDING_SYNC,
                NOW - 30, NOW, T)).isNull();
    }
}
