package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class LaunchInstanceRequest {
    @NotBlank(message = "Instance name is required")
    private String name;

    @NotBlank(message = "Target region is required")
    private String region; // ap-southeast-2 or us-east-1

    @NotBlank(message = "Flavor is required")
    private String flavor; // m1.tiny, m1.small, m1.medium, m1.large, m1.xlarge, h1.medium, h1.large, h1.xlarge

    @NotBlank(message = "OS Image is required")
    private String imageId; // img-u22, img-deb12, etc.

    private int ebsSizeGb = 10;
    private String ebsVolumeType = "gp3";
    private int ebsIops = 3000;
    private int ebsThroughput = 125;
    private String keyPairName = "xregion-key";
    private String securityGroup = "sg-default";
    private String domainName; // optional custom domain name for Route 53
}

