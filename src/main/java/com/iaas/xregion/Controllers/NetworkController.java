package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.NetworkResponse;
import com.iaas.xregion.Services.NetworkService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/network")
@RequiredArgsConstructor
public class NetworkController {

    private final NetworkService networkService;

    @GetMapping
    public ResponseEntity<ApiResponse<NetworkResponse>> getNetworkOverview() {
        return ResponseEntity.ok(ApiResponse.ok(networkService.getNetworkOverview()));
    }

    @PostMapping("/dns")
    public ResponseEntity<ApiResponse<Map<String, Object>>> updateDnsRecord(@Valid @RequestBody UpdateDnsRequest request) {
        Map<String, Object> record = networkService.updateDnsRecord(request);
        return ResponseEntity.ok(ApiResponse.ok("DNS Record updated successfully", record));
    }

    /** GET /api/network/security-groups?instanceId=i-xxx (instanceId optional: only groups attached to that VM). */
    @GetMapping("/security-groups")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getSecurityGroups(
            @RequestParam(required = false) String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(networkService.getSecurityGroups(instanceId)));
    }

    /** POST /api/network/security-groups: create a group, or add rules when groupId is given. */
    @PostMapping("/security-groups")
    public ResponseEntity<ApiResponse<Map<String, Object>>> createOrUpdateSecurityGroup(
            @Valid @RequestBody SecurityGroupRequest request) {
        Map<String, Object> group = networkService.createOrUpdateSecurityGroup(request);
        String message = (request.getGroupId() == null || request.getGroupId().isBlank())
                ? "Security group created"
                : "Security group rules updated";
        return ResponseEntity.ok(ApiResponse.ok(message, group));
    }

    /**
     * PUT /api/network/security-groups/instances/{instanceId}
     * body: {"inboundRules": [...], "outboundRules": [...]} — ghi đè rule của Security Group riêng của máy.
     */
    @PutMapping("/security-groups/instances/{instanceId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> replaceInstanceRules(
            @PathVariable String instanceId, @Valid @RequestBody SecurityGroupRequest request) {
        return ResponseEntity.ok(ApiResponse.ok("Security group rules replaced",
                networkService.replaceInstanceRules(instanceId, request)));
    }

    /** DELETE /api/network/security-groups/{groupId}/rules/{ruleId}: xóa một inbound/outbound rule. */
    @DeleteMapping("/security-groups/{groupId}/rules/{ruleId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> deleteRule(@PathVariable String groupId, @PathVariable String ruleId) {
        return ResponseEntity.ok(ApiResponse.ok("Security group rule deleted", networkService.deleteRule(groupId, ruleId)));
    }
}
