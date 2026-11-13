package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

import java.util.List;
import java.util.Map;

@Data
public class LaunchInstanceRequest {
    @NotBlank(message = "Instance name is required")
    private String name;

    @NotBlank(message = "Target region is required")
    private String region; // us-east-1 (Region A) or ap-southeast-2 (Region B)

    @NotBlank(message = "Flavor is required")
    private String flavor = "m1.tiny"; // m1.tiny (default), m1.small, m1.medium, m1.large, m1.xlarge, h1.medium, h1.large, h1.xlarge

    @NotBlank(message = "OS Image is required")
    private String imageId; // UUID of OS Image in XRegion-Images

    @Min(value = 1, message = "EBS volume size must be at least 1 GB")
    @Max(value = 5, message = "EBS volume size must not exceed 5 GB")
    private int ebsSizeGb = 1;
    private String ebsVolumeType = "gp3";
    private int ebsIops = 3000;
    private int ebsThroughput = 125;
    private String keyPairName = "xregion-key";
    // Rule tường lửa người dùng soạn ở bước 6 của launch wizard. Backend chuyển nguyên vẹn vào sự kiện
    // instance.launch để pipeline và bản ghi Security Group dùng đúng cấu hình này (SPEC-SF-01 bước 7).
    private List<Map<String, Object>> inboundRules;
    private List<Map<String, Object>> outboundRules;
    private String domainName; // optional custom domain name for Route 53
}

