package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CreateScenarioRequest {
    private String name;

    @NotBlank(message = "Target instance ID is required")
    private String targetInstanceId;

    @NotBlank(message = "Source region is required")
    private String sourceRegion;

    @NotBlank(message = "Destination region is required")
    private String destRegion;

    private String triggerType = "SCHEDULED"; // MANUAL or SCHEDULED
    private String dayTime = "07:00";
    private String nightTime = "19:00";
    private String cronExpression = "0 7,19 * * *";
    private int cooldownMinutes = 60;
    private String status = "ACTIVE"; // ACTIVE or PAUSED
}

