package com.iaas.xregion.Services;

import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.NetworkResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

@Service
@RequiredArgsConstructor
public class NetworkService {

    private final AuditLogService auditLogService;
    private final List<Map<String, Object>> dnsStore = new CopyOnWriteArrayList<>();

    {
        Map<String, Object> dns1 = new HashMap<>();
        dns1.put("domainName", "web01.xregion.net");
        dns1.put("targetIp", "3.27.235.135");
        dns1.put("ttl", 60);
        dns1.put("status", "SYNCED");
        dnsStore.add(dns1);
    }

    public NetworkResponse getNetworkOverview() {
        List<Map<String, Object>> vpcs = new ArrayList<>();
        Map<String, Object> vpc1 = new HashMap<>();
        vpc1.put("id", "vpc-syd-prod");
        vpc1.put("name", "Sydney-Production-VPC");
        vpc1.put("cidr", "10.0.0.0/16");
        vpc1.put("region", "ap-southeast-2");
        vpc1.put("primarySubnetId", "subnet-syd-pub-01");
        vpcs.add(vpc1);

        Map<String, Object> vpc2 = new HashMap<>();
        vpc2.put("id", "vpc-va-standby");
        vpc2.put("name", "Virginia-Standby-VPC");
        vpc2.put("cidr", "10.1.0.0/16");
        vpc2.put("region", "us-east-1");
        vpc2.put("primarySubnetId", "subnet-va-pub-01");
        vpcs.add(vpc2);

        List<Map<String, Object>> fips = new ArrayList<>();
        Map<String, Object> fip1 = new HashMap<>();
        fip1.put("ip", "3.27.235.135");
        fip1.put("region", "ap-southeast-2");
        fip1.put("associatedInstanceId", "i-0a3f9c21e7b4d5810");
        fip1.put("associatedInstanceName", "Web-Prod-01");
        fip1.put("privateIp", "10.20.10.15");
        fip1.put("status", "ASSOCIATED");
        fips.add(fip1);

        return NetworkResponse.builder()
                .vpcs(vpcs)
                .floatingIps(fips)
                .dnsRecords(new ArrayList<>(dnsStore))
                .build();
    }

    public Map<String, Object> updateDnsRecord(UpdateDnsRequest request) {
        String domain = request.getDomainName();
        Map<String, Object> record = new HashMap<>();
        record.put("domainName", domain);
        record.put("targetIp", request.getTargetIp());
        record.put("ttl", request.getTtl());
        record.put("status", "SYNCED");
        record.put("updatedAt", System.currentTimeMillis());

        dnsStore.removeIf(d -> domain.equalsIgnoreCase(String.valueOf(d.get("domainName"))));
        dnsStore.add(record);

        auditLogService.logAction("UPDATE_DNS", "DNS", domain, 
                "Updated Route 53 DNS target to " + request.getTargetIp() + " (TTL: " + request.getTtl() + "s)");

        return record;
    }
}
