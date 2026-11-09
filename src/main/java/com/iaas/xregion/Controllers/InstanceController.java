package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Request.UpdateInstanceRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.InstanceResponse;
import com.iaas.xregion.Services.InstanceService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/instances")
@RequiredArgsConstructor
public class InstanceController {

    private final InstanceService instanceService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<InstanceResponse>>> getAllInstances() {
        return ResponseEntity.ok(ApiResponse.ok(instanceService.getAllInstances()));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<InstanceResponse>> getInstanceById(@PathVariable String id) {
        return ResponseEntity.ok(ApiResponse.ok(instanceService.getInstanceById(id)));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<InstanceResponse>> launchInstance(@Valid @RequestBody LaunchInstanceRequest request) {
        InstanceResponse response = instanceService.launchInstance(request);
        return ResponseEntity.accepted().body(ApiResponse.ok("Instance launch request accepted", response));
    }

    @PutMapping("/{id}")
    public ResponseEntity<ApiResponse<InstanceResponse>> updateInstance(
            @PathVariable String id,
            @Valid @RequestBody UpdateInstanceRequest request) {
        InstanceResponse response = instanceService.updateInstance(id, request);
        return ResponseEntity.ok(ApiResponse.ok("Cập nhật thông tin máy ảo thành công", response));
    }

    @PostMapping("/{id}/actions")
    public ResponseEntity<ApiResponse<InstanceResponse>> executeAction(
            @PathVariable String id,
            @Valid @RequestBody InstanceActionRequest request) {
        InstanceResponse response = instanceService.executeAction(id, request);
        return ResponseEntity.ok(ApiResponse.ok("Action " + request.getAction() + " executed", response));
    }
}

