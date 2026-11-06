package com.iaas.xregion.Services;

import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Response.ImageResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class ImageService {

    private final AuditLogService auditLogService;
    private final Map<String, ImageResponse> imageStore = new ConcurrentHashMap<>();

    {
        imageStore.put("img-u22", ImageResponse.builder()
                .id("img-u22").name("Ubuntu 22.04 LTS (Jammy Jellyfish)").osType("Ubuntu")
                .glanceId("glance-ubuntu-22.04-x86_64").sizeGb(20).visibility("PUBLIC").status("ACTIVE").createdAt(System.currentTimeMillis()).build());
        imageStore.put("img-deb12", ImageResponse.builder()
                .id("img-deb12").name("Debian 12 Bookworm Cloud").osType("Debian")
                .glanceId("glance-debian-12-generic").sizeGb(15).visibility("PUBLIC").status("ACTIVE").createdAt(System.currentTimeMillis()).build());
        imageStore.put("img-rocky9", ImageResponse.builder()
                .id("img-rocky9").name("Rocky Linux 9 Enterprise").osType("Rocky Linux")
                .glanceId("glance-rocky-9-cloud").sizeGb(25).visibility("PUBLIC").status("ACTIVE").createdAt(System.currentTimeMillis()).build());
        imageStore.put("img-alp319", ImageResponse.builder()
                .id("img-alp319").name("Alpine Linux 3.19 Micro-VM").osType("Alpine")
                .glanceId("glance-alpine-3.19-virt").sizeGb(5).visibility("PUBLIC").status("ACTIVE").createdAt(System.currentTimeMillis()).build());
    }

    public List<ImageResponse> getAllImages() {
        return imageStore.values().stream().sorted(Comparator.comparing(ImageResponse::getName)).collect(Collectors.toList());
    }

    public ImageResponse createImageFromInstance(String instanceId, String imageName) {
        String imgId = "img-snap-" + UUID.randomUUID().toString().substring(0, 8);
        ImageResponse img = ImageResponse.builder()
                .id(imgId)
                .name(imageName)
                .osType("Custom Snapshot")
                .glanceId("glance-" + imgId)
                .sizeGb(30)
                .visibility("PRIVATE")
                .status("ACTIVE")
                .createdAt(System.currentTimeMillis())
                .build();

        imageStore.put(imgId, img);
        auditLogService.logAction("CREATE_IMAGE", "IMAGE", imgId, "Created image snapshot from " + instanceId);
        return img;
    }

    public void deleteImage(String id) {
        imageStore.remove(id);
        auditLogService.logAction("DELETE_IMAGE", "IMAGE", id, "Deleted image " + id);
    }
}
