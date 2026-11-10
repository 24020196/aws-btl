package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Services.NetworkService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/network")
@RequiredArgsConstructor
public class NetworkController {

    private final NetworkService networkService;

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
     * 200 khi không có gì thay đổi; 202 khi đã lưu cấu hình và còn chờ đồng bộ xuống hạ tầng (data.syncStatus).
     */
    /**
     * PUT /api/network/security-groups/instances/{instanceId}
     * body: {"inboundRules": [...], "outboundRules": [...], "expectedRevision": 5}
     * 200 khi không có gì thay đổi; 202 khi đã lưu cấu hình và còn chờ đồng bộ xuống hạ tầng (data.syncStatus).
     *
     * eventPublished/syncAccepted phải nằm trong response: giao diện dựa vào đó để nói rõ đã gửi yêu cầu
     * áp dụng hay chưa, khác với việc cấu hình đã được lưu.
     */
    @PutMapping("/security-groups/instances/{instanceId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> replaceInstanceRules(
            @PathVariable String instanceId, @Valid @RequestBody SecurityGroupRequest request) {
        Map<String, Object> group = networkService.replaceInstanceRules(instanceId, request);
        boolean syncRequested = Boolean.TRUE.equals(group.get("eventPublished"))
                || Boolean.TRUE.equals(group.get("syncAccepted"));
        String message = syncRequested
                ? "Đã lưu rule, đang chờ đồng bộ xuống hạ tầng"
                : "Đã lưu rule; hạ tầng chưa được cập nhật (xem syncStatus)";
        return ResponseEntity.status(syncRequested ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .body(ApiResponse.ok(message, group));
    }

    /** DELETE /api/network/security-groups/{groupId}/rules/{ruleId}: xóa một inbound/outbound rule. */
    @DeleteMapping("/security-groups/{groupId}/rules/{ruleId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> deleteRule(@PathVariable String groupId, @PathVariable String ruleId) {
        return ResponseEntity.ok(ApiResponse.ok("Security group rule deleted", networkService.deleteRule(groupId, ruleId)));
    }
}
