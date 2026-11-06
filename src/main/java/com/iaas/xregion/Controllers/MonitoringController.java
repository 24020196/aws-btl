package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.MetricsResponse;
import com.iaas.xregion.Services.MonitoringService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/metrics")
@RequiredArgsConstructor
public class MonitoringController {

    private final MonitoringService monitoringService;

    @GetMapping("/instances/{instanceId}")
    public ResponseEntity<ApiResponse<MetricsResponse>> getMetrics(@PathVariable String instanceId) {
        return ResponseEntity.ok(ApiResponse.ok(monitoringService.getMetricsForInstance(instanceId)));
    }
}

