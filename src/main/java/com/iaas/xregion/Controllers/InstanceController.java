package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.InstanceResponse;
import com.iaas.xregion.Services.InstanceService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Instance Management", description = "Quản lý vòng đời máy ảo: khởi tạo, danh sách, chi tiết và các hành động (start, stop, reboot, terminate)")
@RestController
@RequestMapping("/api/instances")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class InstanceController {

    private final InstanceService instanceService;

    @Operation(summary = "Lấy danh sách máy ảo", description = "Truy vấn toàn bộ máy ảo trên hệ thống XRegion")
    @Hidden
    @GetMapping
    public ResponseEntity<ApiResponse<List<InstanceResponse>>> getAllInstances() {
        return ResponseEntity.ok(ApiResponse.ok(instanceService.getAllInstances()));
    }

    @Operation(summary = "Lấy chi tiết máy ảo", description = "Truy vấn thông tin chi tiết một máy ảo theo Instance ID")
    @Hidden
    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<InstanceResponse>> getInstanceById(@PathVariable String id) {
        return ResponseEntity.ok(ApiResponse.ok(instanceService.getInstanceById(id)));
    }

    @Operation(summary = "Khởi tạo máy ảo mới", description = "Gửi yêu cầu khởi tạo máy ảo theo quy trình Step Function Launch Pipeline (SPEC-SF-01)")
    @PostMapping
    public ResponseEntity<ApiResponse<InstanceResponse>> launchInstance(@Valid @RequestBody LaunchInstanceRequest request) {
        InstanceResponse response = instanceService.launchInstance(request);
        return ResponseEntity.accepted().body(ApiResponse.ok("Instance launch request accepted", response));
    }

    @Operation(summary = "Thực thi hành động trên máy ảo", description = "Gửi lệnh điều khiển trạng thái máy ảo: START, STOP, REBOOT, TERMINATE...")
    @PostMapping("/{id}/actions")
    public ResponseEntity<ApiResponse<InstanceResponse>> executeAction(
            @PathVariable String id,
            @Valid @RequestBody InstanceActionRequest request) {
        InstanceResponse response = instanceService.executeAction(id, request);
        return ResponseEntity.ok(ApiResponse.ok("Action " + request.getAction() + " executed", response));
    }
}

