package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.ImageResponse;
import com.iaas.xregion.Services.ImageService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@Hidden
@Tag(name = "Image & Snapshot Management", description = "Quản lý ảnh hệ điều hành (Glance Images) và tạo/xóa Snapshot máy ảo")
@RestController
@RequestMapping("/api/images")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class ImageController {

    private final ImageService imageService;

    @Operation(summary = "Danh sách ảnh đĩa (Images)", description = "Lấy danh sách các Image hệ điều hành sẵn có từ Glance")
    @GetMapping
    public ResponseEntity<ApiResponse<List<ImageResponse>>> getAllImages() {
        return ResponseEntity.ok(ApiResponse.ok(imageService.getAllImages()));
    }

    @Operation(summary = "Tạo Snapshot từ máy ảo", description = "Tạo ảnh snapshot tức thời từ một máy ảo đang hoạt động")
    @PostMapping("/snapshot")
    public ResponseEntity<ApiResponse<ImageResponse>> createImageFromInstance(@RequestBody Map<String, String> request) {
        String instanceId = request.get("instanceId");
        String imageName = request.getOrDefault("name", "Snapshot-" + System.currentTimeMillis());
        ImageResponse response = imageService.createImageFromInstance(instanceId, imageName);
        return ResponseEntity.ok(ApiResponse.ok("Snapshot image created successfully", response));
    }

    @Operation(summary = "Xóa ảnh đĩa", description = "Xóa một Image hoặc Snapshot theo ID")
    @DeleteMapping("/{id}")
    public ResponseEntity<ApiResponse<Void>> deleteImage(@PathVariable String id) {
        imageService.deleteImage(id);
        return ResponseEntity.ok(ApiResponse.ok("Image deleted successfully", null));
    }
}

