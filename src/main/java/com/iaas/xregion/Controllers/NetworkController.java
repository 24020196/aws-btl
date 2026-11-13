package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Services.NetworkService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@Tag(name = "Network & Security Groups", description = "Quản lý định tuyến DNS và Security Groups/Rules theo chuẩn SPEC-04, SPEC-06 và SPEC-SF-05")
@RestController
@RequestMapping("/api/network")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class NetworkController {

    private final NetworkService networkService;

    @Operation(summary = "Cập nhật bản ghi DNS", description = "Cập nhật hoặc thêm bản ghi DNS cho máy ảo hoặc gateway")
    @Hidden
    @PostMapping("/dns")
    public ResponseEntity<ApiResponse<Map<String, Object>>> updateDnsRecord(@Valid @RequestBody UpdateDnsRequest request) {
        Map<String, Object> record = networkService.updateDnsRecord(request);
        return ResponseEntity.ok(ApiResponse.ok("DNS Record updated successfully", record));
    }

    /** GET /api/network/security-groups?instanceId=i-xxx (instanceId optional: only groups attached to that VM). */
    @Operation(summary = "Danh sách Security Groups", description = "Lấy danh sách Security Groups, có thể lọc theo instanceId")
    @Hidden
    @GetMapping("/security-groups")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getSecurityGroups(
            @RequestParam(required = false) String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(networkService.getSecurityGroups(instanceId)));
    }

    /** POST /api/network/security-groups: create a group, or add rules when groupId is given. */
    @Operation(summary = "Tạo mới hoặc bổ sung rules cho Security Group", description = "Tạo mới SG hoặc thêm rules vào SG theo groupId")
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
    @Operation(summary = "Ghi đè rules cho Security Group của máy ảo", description = "Cập nhật inbound/outbound rules theo cơ chế khóa lạc quan revision (SPEC-SF-05)")
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
    @Operation(summary = "Xóa rule khỏi Security Group", description = "Xóa một inbound hoặc outbound rule theo groupId và ruleId")
    @DeleteMapping("/security-groups/{groupId}/rules/{ruleId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> deleteRule(@PathVariable String groupId, @PathVariable String ruleId) {
        return ResponseEntity.ok(ApiResponse.ok("Security group rule deleted", networkService.deleteRule(groupId, ruleId)));
    }
}
