package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CopySnapshotRequest {
    @NotBlank(message = "Source volume ID is required")
    private String volumeId;

    @NotBlank(message = "Source region is required")
    private String sourceRegion;

    @NotBlank(message = "Destination region is required")
    private String destinationRegion;

    private String description;
}

