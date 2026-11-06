package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Services.MonitoringService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/logs")
@RequiredArgsConstructor
public class AuditLogController {

    private final MonitoringService monitoringService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getLogs(
            @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(ApiResponse.ok(monitoringService.getAuditLogs(limit)));
    }
}

