package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class AttachVolumeRequest {
    @NotBlank(message = "Target instance ID is required")
    private String instanceId;

    private String device = "/dev/vdb";
}

