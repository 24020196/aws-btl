package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class CreateVolumeRequest {
    @NotBlank(message = "Volume name is required")
    private String name;

    @Min(value = 1, message = "Volume size must be at least 1 GB")
    private int sizeGb = 20;

    private String volumeType = "gp3";
    private int iops = 3000;
    private int throughput = 125;

    @NotBlank(message = "Region is required")
    private String region = "ap-southeast-2";
}

