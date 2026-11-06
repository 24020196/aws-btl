package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class NetworkResponse {
    private List<Map<String, Object>> vpcs;
    private List<Map<String, Object>> floatingIps;
    private List<Map<String, Object>> dnsRecords;
}

