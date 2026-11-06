package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.VolumeStatus;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.AttachVolumeRequest;
import com.iaas.xregion.Model.Request.CopySnapshotRequest;
import com.iaas.xregion.Model.Request.CreateVolumeRequest;
import com.iaas.xregion.Model.Response.VolumeResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class VolumeService {

    private final AuditLogService auditLogService;
    private final Map<String, VolumeResponse> volumeStore = new ConcurrentHashMap<>();

    {
        // Default initial EBS gp3 volume for Web-Prod-01
        volumeStore.put("vol-ebs-prod01", VolumeResponse.builder()
                .id("vol-ebs-prod01")
                .name("ebs-gp3-root-web-prod01")
                .sizeGb(50)
                .volumeType("gp3")
                .iops(3000)
                .throughput(125)
                .region("ap-southeast-2")
                .status("IN_USE")
                .attachedInstanceId("i-0a3f9c21e7b4d5810")
                .attachedInstanceName("Web-Prod-01")
                .device("/dev/vda")
                .createdAt(System.currentTimeMillis() - 86400000L)
                .build());
    }

    public List<VolumeResponse> getAllVolumes() {
        return volumeStore.values().stream()
                .sorted((a, b) -> Long.compare(b.getCreatedAt(), a.getCreatedAt()))
                .collect(Collectors.toList());
    }

    public VolumeResponse getVolumeById(String id) {
        VolumeResponse vol = volumeStore.get(id);
        if (vol == null) {
            throw new ResourceNotFoundException("Volume not found: " + id);
        }
        return vol;
    }

    public VolumeResponse createVolume(CreateVolumeRequest request) {
        String id = "vol-" + UUID.randomUUID().toString().substring(0, 8);
        long now = System.currentTimeMillis();

        VolumeResponse vol = VolumeResponse.builder()
                .id(id)
                .name(request.getName())
                .sizeGb(request.getSizeGb())
                .volumeType("gp3")
                .iops(request.getIops() > 0 ? request.getIops() : 3000)
                .throughput(request.getThroughput() > 0 ? request.getThroughput() : 125)
                .region(request.getRegion())
                .status(VolumeStatus.AVAILABLE.name())
                .attachedInstanceId("")
                .attachedInstanceName("None (Available)")
                .device("")
                .createdAt(now)
                .build();

        volumeStore.put(id, vol);
        auditLogService.logAction("CREATE_VOLUME", "VOLUME", id, 
                "Created EBS gp3 volume (" + request.getSizeGb() + " GB) in " + request.getRegion());

        return vol;
    }

    public VolumeResponse attachVolume(String volumeId, AttachVolumeRequest request) {
        VolumeResponse vol = getVolumeById(volumeId);
        vol.setStatus("IN_USE");
        vol.setAttachedInstanceId(request.getInstanceId());
        vol.setAttachedInstanceName(request.getInstanceId());
        vol.setDevice(request.getDevice() != null ? request.getDevice() : "/dev/vdb");

        auditLogService.logAction("ATTACH_VOLUME", "VOLUME", volumeId, "Attached to instance " + request.getInstanceId());
        return vol;
    }

    public VolumeResponse detachVolume(String volumeId) {
        VolumeResponse vol = getVolumeById(volumeId);
        vol.setStatus("AVAILABLE");
        vol.setAttachedInstanceId("");
        vol.setAttachedInstanceName("None (Available)");
        vol.setDevice("");

        auditLogService.logAction("DETACH_VOLUME", "VOLUME", volumeId, "Detached volume");
        return vol;
    }

    public VolumeResponse copySnapshotCrossRegion(CopySnapshotRequest request) {
        String newVolId = "vol-replica-" + UUID.randomUUID().toString().substring(0, 8);
        long now = System.currentTimeMillis();

        VolumeResponse replica = VolumeResponse.builder()
                .id(newVolId)
                .name("replica-" + request.getVolumeId() + "-" + request.getDestinationRegion())
                .sizeGb(50)
                .volumeType("gp3")
                .iops(3000)
                .throughput(125)
                .region(request.getDestinationRegion())
                .status(VolumeStatus.AVAILABLE.name())
                .attachedInstanceId("")
                .attachedInstanceName("None (Available)")
                .device("")
                .createdAt(now)
                .build();

        volumeStore.put(newVolId, replica);
        auditLogService.logAction("CROSS_REGION_COPY", "VOLUME", newVolId, 
                "Cross-region snapshot copied from " + request.getSourceRegion() + " to " + request.getDestinationRegion());

        return replica;
    }

    public void deleteVolume(String volumeId) {
        volumeStore.remove(volumeId);
        auditLogService.logAction("DELETE_VOLUME", "VOLUME", volumeId, "Deleted volume " + volumeId);
    }
}
