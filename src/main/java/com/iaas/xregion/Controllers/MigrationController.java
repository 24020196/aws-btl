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
    public ResponseEntity<ApiResponse<MigrationResponse>> triggerMigration(@Valid @RequestBody TriggerMigrationRequest request) {
        MigrationResponse response = migrationService.triggerMigration(request.getId());
        return ResponseEntity.ok(ApiResponse.ok("Cross-region migration workflow started", response));
    }

    @GetMapping("/progress/{instanceId}")
    public ResponseEntity<ApiResponse<MigrationResponse>> getProgress(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(migrationService.getProgress(instanceId)));
    }
}

