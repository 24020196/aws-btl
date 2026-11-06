package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ImageResponse {
    private String id;
    private String name;
    private String osType;
    private String glanceId;
    private int sizeGb;
    private String visibility;
    private String status;
    private long createdAt;
}

