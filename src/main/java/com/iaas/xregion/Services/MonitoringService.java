package com.iaas.xregion.Services;

import com.iaas.xregion.Model.Response.MetricsResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;

@Service
@RequiredArgsConstructor
public class MonitoringService {

    private final AuditLogService auditLogService;
    private final Random random = new Random();

    public MetricsResponse getMetricsForInstance(String instanceId) {
        long now = System.currentTimeMillis();
        List<Map<String, Object>> timeSeries = new ArrayList<>();

        // Generate last 12 data points (5-min intervals)
        for (int i = 11; i >= 0; i--) {
            long ts = now - (i * 300_000L);
            double baseCpu = 25.0 + (Math.abs(instanceId.hashCode()) % 20);
            double cpu = Math.min(95.0, Math.max(5.0, baseCpu + (random.nextDouble() * 20.0 - 10.0)));
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
