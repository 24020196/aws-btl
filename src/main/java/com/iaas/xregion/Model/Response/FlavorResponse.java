package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class FlavorResponse {
    private String id;
    private String name;
    private int vcpus;
    private int ramMb;
    private int diskGb;
    private String ramDisplay;
    private String series;
}
