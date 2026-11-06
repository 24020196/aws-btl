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
public class MigrationResponse {
    private String scenarioId;
    private String scenarioName;
    private String instanceId;
    private String instanceName;
    private String sourceRegion;
    private String destRegion;
    private String currentStep;
    private int stepNumber; // 1 to 6
    private int progressPercent; // 0 to 100
    private String status; // IN_PROGRESS, COMPLETED, FAILED, ROLLED_BACK
    private long startedAt;
    private long finishedAt;
    private List<String> logs;
}

