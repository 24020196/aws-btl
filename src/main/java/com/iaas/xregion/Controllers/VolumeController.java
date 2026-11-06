package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.AttachVolumeRequest;
import com.iaas.xregion.Model.Request.CopySnapshotRequest;
import com.iaas.xregion.Model.Request.CreateVolumeRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.VolumeResponse;
import com.iaas.xregion.Services.VolumeService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/volumes")
@RequiredArgsConstructor
public class VolumeController {

    private final VolumeService volumeService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<VolumeResponse>>> getAllVolumes() {
        return ResponseEntity.ok(ApiResponse.ok(volumeService.getAllVolumes()));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<VolumeResponse>> getVolumeById(@PathVariable String id) {
        return ResponseEntity.ok(ApiResponse.ok(volumeService.getVolumeById(id)));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<VolumeResponse>> createVolume(@Valid @RequestBody CreateVolumeRequest request) {
        VolumeResponse response = volumeService.createVolume(request);
        return ResponseEntity.ok(ApiResponse.ok("EBS Volume created", response));
    }

    @PostMapping("/{id}/attach")
    public ResponseEntity<ApiResponse<VolumeResponse>> attachVolume(
            @PathVariable String id,
            @Valid @RequestBody AttachVolumeRequest request) {
        VolumeResponse response = volumeService.attachVolume(id, request);
        return ResponseEntity.ok(ApiResponse.ok("Volume attached to instance", response));
    }

    @PostMapping("/{id}/detach")
    public ResponseEntity<ApiResponse<VolumeResponse>> detachVolume(@PathVariable String id) {
        VolumeResponse response = volumeService.detachVolume(id);
        return ResponseEntity.ok(ApiResponse.ok("Volume detached", response));
    }

    @PostMapping("/cross-region-copy")
    public ResponseEntity<ApiResponse<VolumeResponse>> copySnapshotCrossRegion(@Valid @RequestBody CopySnapshotRequest request) {
        VolumeResponse response = volumeService.copySnapshotCrossRegion(request);
        return ResponseEntity.ok(ApiResponse.ok("Cross-region snapshot copy initiated", response));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<ApiResponse<Void>> deleteVolume(@PathVariable String id) {
        volumeService.deleteVolume(id);
        return ResponseEntity.ok(ApiResponse.ok("Volume deleted successfully", null));
    }
}

