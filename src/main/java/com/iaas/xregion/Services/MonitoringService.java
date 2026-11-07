package com.iaas.xregion.Services;

import com.iaas.xregion.Model.Response.MetricsResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;

@Service
@RequiredArgsConstructor
public class MonitoringService {

    private final AuditLogService auditLogService;

    public MetricsResponse getMetricsForInstance(String instanceId) {
        return getMetricsForInstance(instanceId, 1);
    }

    /**
     * Chuỗi chỉ số trong {@code hours} giờ gần nhất (1, 3 hoặc 12). Chu kỳ lấy mẫu giống CloudWatch:
     * 5 phút cho 1h/3h, 15 phút cho 12h. Mỗi mốc được seed theo instance + thời điểm nên làm mới không đổi lịch sử.
     */
    public MetricsResponse getMetricsForInstance(String instanceId, int hours) {
        int range = hours >= 12 ? 12 : hours >= 3 ? 3 : 1;
        long periodMs = range == 12 ? 900_000L : 300_000L;
        int points = (int) (range * 3_600_000L / periodMs);
        long now = System.currentTimeMillis();
        List<Map<String, Object>> timeSeries = new ArrayList<>();
        long lastBucket = now - (now % periodMs);

        for (int i = points - 1; i >= 0; i--) {
            long ts = lastBucket - (i * periodMs);
            Random random = new Random((instanceId.hashCode() * 31L + ts / periodMs) * 0x9E3779B97F4A7C15L);
            double baseCpu = 25.0 + (Math.abs(instanceId.hashCode()) % 20);
            double hourWave = 12.0 * Math.sin(2 * Math.PI * ((ts / 60_000L) % 720) / 720.0);
            double spike = random.nextDouble() < 0.06 ? 30.0 + random.nextDouble() * 20.0 : 0.0;
            double cpu = Math.min(98.0, Math.max(3.0, baseCpu + hourWave + spike + (random.nextDouble() * 20.0 - 10.0)));
            double ram = 48.0 + (random.nextDouble() * 10.0);
            double netIn = 120.0 + (random.nextDouble() * 180.0);
            double netOut = 90.0 + (random.nextDouble() * 140.0);

            Map<String, Object> point = new HashMap<>();
            point.put("timestamp", ts);
            point.put("cpuUsage", Math.round(cpu * 10.0) / 10.0);
            point.put("ramUsage", Math.round(ram * 10.0) / 10.0);
            point.put("diskIo", Math.round((50 + random.nextInt(150)) * 10.0) / 10.0);
            point.put("networkIn", Math.round(netIn * 10.0) / 10.0);
            point.put("networkOut", Math.round(netOut * 10.0) / 10.0);
            timeSeries.add(point);
        }

        Map<String, Object> latest = timeSeries.get(timeSeries.size() - 1);

        // Multi-Region Cost Analysis
        Map<String, Object> costSummary = new HashMap<>();
        costSummary.put("sydneyComputeMonthly", 72.50);
        costSummary.put("sydneyStorageMonthly", 18.20);
        costSummary.put("virginiaComputeMonthly", 58.00);
        costSummary.put("virginiaStorageMonthly", 14.50);
        costSummary.put("crossRegionDataTransfer", 6.80);
        costSummary.put("totalMonthlyEstimated", 170.00);
        costSummary.put("currency", "USD");

        return MetricsResponse.builder()
                .instanceId(instanceId)
                .currentCpuUsage((Double) latest.get("cpuUsage"))
                .currentRamUsage((Double) latest.get("ramUsage"))
                .currentDiskIo((Double) latest.get("diskIo"))
                .currentNetworkIn((Double) latest.get("networkIn"))
                .currentNetworkOut((Double) latest.get("networkOut"))
                .timeSeries(timeSeries)
                .costSummary(costSummary)
                .build();
    }

    public List<Map<String, Object>> getAuditLogs(int limit) {
        return auditLogService.getLogs(limit);
    }
}
