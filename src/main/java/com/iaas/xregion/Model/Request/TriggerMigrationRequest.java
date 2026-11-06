package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class TriggerMigrationRequest {
    @NotBlank(message = "Scenario ID or Instance ID is required")
    private String id;
}

