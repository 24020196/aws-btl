package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class VolumeResponse {
    private String id;
    private String name;
    private int sizeGb;
    private String volumeType;
    private int iops;
    private int throughput;
    private String region;
    private String status;
    private String attachedInstanceId;
    private String attachedInstanceName;
    private String device;
    private long createdAt;
}

