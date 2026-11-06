package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class UpdateDnsRequest {
    @NotBlank(message = "Domain name is required")
    private String domainName;

    @NotBlank(message = "Target IP is required")
    private String targetIp;

    private int ttl = 60;
}

