package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MetricsResponse {
    private String instanceId;
    private double currentCpuUsage;
    private double currentRamUsage;
    private double currentDiskIo;
    private double currentNetworkIn;
    private double currentNetworkOut;
    private List<Map<String, Object>> timeSeries;
    private Map<String, Object> costSummary;
}

