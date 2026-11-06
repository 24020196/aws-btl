package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CreateScenarioRequest {
    @NotBlank(message = "Scenario name is required")
    private String name;

    @NotBlank(message = "Target instance ID is required")
    private String targetInstanceId;

    @NotBlank(message = "Source region is required")
    private String sourceRegion;

    @NotBlank(message = "Destination region is required")
    private String destRegion;

    private String triggerType = "MANUAL"; // MANUAL or SCHEDULED
    private String cronExpression = "0 2 * * *";
    private int cooldownMinutes = 60;
}

