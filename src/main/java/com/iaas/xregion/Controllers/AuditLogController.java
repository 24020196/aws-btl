package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Services.MonitoringService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@Hidden
@Tag(name = "Audit Logs", description = "Truy vấn nhật ký kiểm toán và lịch sử hoạt động hệ thống")
@RestController
@RequestMapping("/api/logs")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class AuditLogController {

    private final MonitoringService monitoringService;

    @Operation(summary = "Lấy nhật ký kiểm toán", description = "Truy vấn danh sách audit logs hệ thống với giới hạn số lượng (limit)")
    @GetMapping
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getLogs(
            @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(ApiResponse.ok(monitoringService.getAuditLogs(limit)));
    }
}

