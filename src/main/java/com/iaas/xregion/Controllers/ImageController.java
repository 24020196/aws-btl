package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.ImageResponse;
import com.iaas.xregion.Services.ImageService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/images")
@RequiredArgsConstructor
public class ImageController {

    private final ImageService imageService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<ImageResponse>>> getAllImages() {
        return ResponseEntity.ok(ApiResponse.ok(imageService.getAllImages()));
    }

    @PostMapping("/snapshot")
    public ResponseEntity<ApiResponse<ImageResponse>> createImageFromInstance(@RequestBody Map<String, String> request) {
        String instanceId = request.get("instanceId");
        String imageName = request.getOrDefault("name", "Snapshot-" + System.currentTimeMillis());
        ImageResponse response = imageService.createImageFromInstance(instanceId, imageName);
        return ResponseEntity.ok(ApiResponse.ok("Snapshot image created successfully", response));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<ApiResponse<Void>> deleteImage(@PathVariable String id) {
        imageService.deleteImage(id);
        return ResponseEntity.ok(ApiResponse.ok("Image deleted successfully", null));
    }
}

