package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class InstanceResponse {
    private String username;
    private String userId;
    private String id;
    private String activeNovaId;
    private List<String> novaIds;
    private String name;
    private String region;
    private String regionName;
    private String flavor;
    private String status;
    private String errorCode;
    private String errorMessage;
    private String privateIp;
    private String publicIp;
    private String publicDns;
    private String dnsDomain;
    private String imageId;
    private String imageName;
    private long createdAt;
    private long updatedAt;
    private String consoleUrl;
    private String keyId;
    private String keyName;
    private String volumeId;
    private Integer ebsSizeGb;
    private Integer requestedSizeGb;
    private String securityGroupId;
    private Integer cooldownSeconds;
    private String securityGroup;
    private String scenarioId;
    private String scenarioStatus;
}
