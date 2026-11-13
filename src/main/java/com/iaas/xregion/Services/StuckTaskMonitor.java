package com.iaas.xregion.Services;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;

import java.util.HashSet;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Quét định kỳ tác vụ kẹt và ghi cảnh báo (XR-RISK-004).
 *
 * <p>Chỉ <b>phát hiện và báo</b>. Không tự retry, không tự đổi trạng thái, không sửa tài nguyên:
 * một bộ quét tự sửa lỗi có thể gây hậu quả lớn hơn chính sự cố nó đang xử lý.
 *
 * <p>Chống lặp cảnh báo: mỗi phát hiện chỉ ghi log một lần cho tới khi nó biến mất, tránh làm
 * ngập log mỗi phút với cùng một vấn đề.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class StuckTaskMonitor {

    private final DynamoDbTable<com.iaas.xregion.Entity.InstanceEntity> instancesTable;

    @Value("${xregion.stuck-task.enabled:true}")
    private boolean enabled;

    private final Set<String> alreadyReported = new HashSet<>();

    @Scheduled(fixedDelayString = "${xregion.stuck-task.interval-ms:600000}",
            initialDelayString = "${xregion.stuck-task.initial-delay-ms:120000}")
    public void scan() {
        if (!enabled) {
            return;
        }
        long now = System.currentTimeMillis() / 1000;
        StuckTaskDetector.Thresholds thresholds = StuckTaskDetector.Thresholds.defaults();
        Set<String> foundNow = new HashSet<>();
        try {
            for (com.iaas.xregion.Entity.InstanceEntity entity : instancesTable.scan().items()) {
                for (StuckTaskDetector.Finding finding :
                        StuckTaskDetector.inspect(entity, now, thresholds)) {
                    String key = finding.instanceId() + "|" + finding.kind() + "|" + finding.status();
                    foundNow.add(key);
                    if (alreadyReported.add(key)) {
                        log.warn("STUCK_TASK kind={} instance={} status={} detail={}",
                                finding.kind(), finding.instanceId(), finding.status(), finding.detail());
                    }
                }
            }
        } catch (Exception e) {
            log.error("Stuck-task scan failed, will retry next interval: {}", e.toString());
            return;
        }
        // Chỉ giữ các mục còn tồn tại để một sự cố tái diễn vẫn được báo lại.
        alreadyReported.retainAll(foundNow);
        if (!foundNow.isEmpty()) {
            log.warn("Stuck-task scan: {} task(s) still stuck ({})", foundNow.size(),
                    foundNow.stream().sorted().collect(Collectors.joining(", ")));
        }
    }
}
