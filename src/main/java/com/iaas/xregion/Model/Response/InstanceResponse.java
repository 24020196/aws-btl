package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class InstanceResponse {
    private String id;
    private String name;
    private String region;
    private String regionName;
    private String flavor;
    private String status;
    private String privateIp;
    private String publicIp;
    private String dnsDomain;
    private String imageId;
    private String imageName;
    private long createdAt;
    private long updatedAt;
    private String consoleUrl;
}

