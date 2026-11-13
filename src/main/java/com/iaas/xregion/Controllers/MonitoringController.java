package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.MetricsResponse;
import com.iaas.xregion.Services.MonitoringService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@Hidden
@Tag(name = "Monitoring & Metrics", description = "Thu thập và trực quan hóa số liệu giám sát máy ảo (CPU, Memory, Disk, Network)")
@RestController
@RequestMapping("/api/metrics")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class MonitoringController {

    private final MonitoringService monitoringService;

    @Operation(summary = "Lấy số liệu giám sát máy ảo", description = "Truy vấn dữ liệu metrics (CPU, Memory, Disk, Network) của máy ảo theo khung thời gian (giờ)")
    @GetMapping("/instances/{instanceId}")
    public ResponseEntity<ApiResponse<MetricsResponse>> getMetrics(@PathVariable String instanceId,
                                                                   @RequestParam(defaultValue = "1") int hours) {
        return ResponseEntity.ok(ApiResponse.ok(monitoringService.getMetricsForInstance(instanceId, hours)));
    }
}

