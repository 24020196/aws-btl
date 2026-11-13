package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.FlavorResponse;
import com.iaas.xregion.Services.FlavorService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@Hidden
@Tag(name = "Flavor Management", description = "Quản lý cấu hình phần cứng máy ảo (vCPU, RAM, Root Disk)")
@RestController
@RequestMapping("/api/flavors")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class FlavorController {

    private final FlavorService flavorService;

    @Operation(summary = "Danh sách Flavors", description = "Lấy danh sách các gói cấu hình máy ảo khả dụng trong hệ thống")
    @GetMapping
    public ResponseEntity<ApiResponse<List<FlavorResponse>>> getAllFlavors() {
        return ResponseEntity.ok(ApiResponse.ok(flavorService.getAllFlavors()));
    }
}
