package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.CreateScenarioRequest;
import com.iaas.xregion.Model.Request.TriggerMigrationRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.MigrationResponse;
import com.iaas.xregion.Services.MigrationService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@Tag(name = "Cross-Region Migration", description = "Quản lý kịch bản, kích hoạt và theo dõi quy trình Live Migration xuyên vùng (SPEC-03)")
@RestController
@RequestMapping("/api/migrations")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class MigrationController {

    private final MigrationService migrationService;

    @Operation(summary = "Danh sách kịch bản di trú", description = "Lấy toàn bộ các kịch bản Migration đã cấu hình")
    @Hidden
    @GetMapping("/scenarios")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getAllScenarios() {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getAllScenarios()));
    }

    @Operation(summary = "Lấy kịch bản di trú theo máy ảo", description = "Trả về kịch bản liên kết qua khóa ngoại scenario_id (null nếu chưa thiết lập)")
    @Hidden
    @GetMapping("/scenarios/instance/{instanceId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getScenarioByInstance(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getScenarioByInstanceId(instanceId)));
    }

    @Operation(summary = "Tạo hoặc cập nhật kịch bản di trú", description = "Lưu kịch bản vào XRegion-MigrationScenarios và gán khóa ngoại scenario_id vào XRegion-Instances")
    @Hidden
    @PostMapping("/scenarios")
    public ResponseEntity<ApiResponse<Map<String, Object>>> createScenario(@Valid @RequestBody CreateScenarioRequest request) {
        Map<String, Object> scenario = migrationService.createScenario(request);
        return ResponseEntity.ok(ApiResponse.ok("Migration scenario saved", scenario));
    }

    @Operation(summary = "Cập nhật trạng thái kịch bản di trú", description = "Chuyển trạng thái ACTIVE / PAUSED trên XRegion-MigrationScenarios")
    @Hidden
    @PatchMapping("/scenarios/{scenarioId}/status")
    public ResponseEntity<ApiResponse<Map<String, Object>>> toggleScenarioStatus(
            @PathVariable String scenarioId,
            @RequestBody(required = false) Map<String, String> body) {
        String status = body != null ? body.get("status") : null;
        return ResponseEntity.ok(ApiResponse.ok("Scenario status updated", migrationService.toggleScenarioStatus(scenarioId, status)));
    }

    @Operation(summary = "Kích hoạt chuyển vùng máy ảo", description = "Khởi chạy quy trình Live Migration xuyên vùng 7 bước với Redis Lock và Step Function")
    @PostMapping("/trigger")
    public ResponseEntity<ApiResponse<MigrationResponse>> triggerMigration(@Valid @RequestBody TriggerMigrationRequest request,
                                                                            @RequestParam(defaultValue = "vi") String lang) {
        MigrationResponse response = migrationService.triggerMigration(request.getId(), lang);
        return ResponseEntity.ok(ApiResponse.ok("Cross-region migration workflow started", response));
    }

    /** Lịch sử chuyển vùng của riêng một máy ảo + trạng thái migration_lock và cooldown còn lại. */
    @Operation(summary = "Lịch sử chuyển vùng máy ảo", description = "Lấy lịch sử các lần migration của máy ảo, trạng thái lock và cooldown")
    @Hidden
    @GetMapping("/history/{instanceId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getHistory(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getHistory(instanceId)));
    }

    /** Tóm tắt chuyển vùng của người dùng hiện tại cho trang Tổng quan. */
    @Operation(summary = "Tóm tắt chuyển vùng", description = "Thống kê tổng hợp số lượt chuyển vùng thành công/thất bại của người dùng")
    @Hidden
    @GetMapping("/summary")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getSummary() {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getSummary()));
    }

    /** Snapshot EBS sinh ra khi chuyển vùng (bản gốc ở vùng nguồn + bản sao ở vùng đích). Lọc theo máy bằng ?instanceId=. */
    @Operation(summary = "Danh sách Snapshot chuyển vùng", description = "Lấy danh sách snapshot sinh ra trong quá trình migration, có thể lọc theo instanceId")
    @Hidden
    @GetMapping("/snapshots")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getSnapshots(@RequestParam(required = false) String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getSnapshots(instanceId == null || instanceId.isBlank() ? null : instanceId)));
    }

    @Operation(summary = "Tiến độ chuyển vùng", description = "Kiểm tra tiến độ thực thi từng bước trong quy trình migration của máy ảo")
    @Hidden
    @GetMapping("/progress/{instanceId}")
    public ResponseEntity<ApiResponse<MigrationResponse>> getProgress(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getProgress(instanceId)));
    }
}

