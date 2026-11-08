package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.CreateScenarioRequest;
import com.iaas.xregion.Model.Request.TriggerMigrationRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.MigrationResponse;
import com.iaas.xregion.Services.MigrationService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/migrations")
@RequiredArgsConstructor
public class MigrationController {

    private final MigrationService migrationService;

    @GetMapping("/scenarios")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getAllScenarios() {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getAllScenarios()));
    }

    @PostMapping("/scenarios")
    public ResponseEntity<ApiResponse<Map<String, Object>>> createScenario(@Valid @RequestBody CreateScenarioRequest request) {
        Map<String, Object> scenario = migrationService.createScenario(request);
        return ResponseEntity.ok(ApiResponse.ok("Migration scenario created", scenario));
    }

    @PostMapping("/trigger")
    public ResponseEntity<ApiResponse<MigrationResponse>> triggerMigration(@Valid @RequestBody TriggerMigrationRequest request,
                                                                            @RequestParam(defaultValue = "vi") String lang) {
        MigrationResponse response = migrationService.triggerMigration(request.getId(), lang);
        return ResponseEntity.ok(ApiResponse.ok("Cross-region migration workflow started", response));
    }

    /** Lịch sử chuyển vùng của riêng một máy ảo + trạng thái migration_lock và cooldown còn lại. */
    @GetMapping("/history/{instanceId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getHistory(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getHistory(instanceId)));
    }

    /** Tóm tắt chuyển vùng của người dùng hiện tại cho trang Tổng quan. */
    @GetMapping("/summary")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getSummary() {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getSummary()));
    }

    /** Snapshot EBS sinh ra khi chuyển vùng (bản gốc ở vùng nguồn + bản sao ở vùng đích). Lọc theo máy bằng ?instanceId=. */
    @GetMapping("/snapshots")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getSnapshots(@RequestParam(required = false) String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getSnapshots(instanceId == null || instanceId.isBlank() ? null : instanceId)));
    }

    @GetMapping("/progress/{instanceId}")
    public ResponseEntity<ApiResponse<MigrationResponse>> getProgress(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getProgress(instanceId)));
    }
}

