package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.ImageEntity;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Response.ImageResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ImageService {

    private final AuditLogService auditLogService;
    private final DynamoDbTable<ImageEntity> imagesTable;
    private final Map<String, ImageResponse> snapshotStore = new ConcurrentHashMap<>();

    private String detectOsType(String name) {
        if (name == null) return "Linux";
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.contains("ubuntu")) return "Ubuntu";
        if (lower.contains("alpine")) return "Alpine";
        if (lower.contains("debian")) return "Debian";
        if (lower.contains("rocky")) return "Rocky Linux";
        if (lower.contains("centos")) return "CentOS";
        if (lower.contains("windows")) return "Windows";
        return "Linux";
    }

    public List<ImageResponse> getAllImages() {
        List<ImageResponse> result = new ArrayList<>();
        try {
            List<ImageEntity> entities = imagesTable.scan().items().stream().collect(Collectors.toList());
            if (!entities.isEmpty()) {
                for (ImageEntity img : entities) {
                    long sizeBytes = img.getSizeBytes() != null ? img.getSizeBytes() : 0L;
                    int sizeGb = sizeBytes > 0 ? (int) Math.ceil(sizeBytes / (1024.0 * 1024.0 * 1024.0)) : 10;
                    if (sizeGb <= 0) sizeGb = 1;

                    result.add(ImageResponse.builder()
                            .id(img.getImageId())
                            .name(img.getImageName() != null ? img.getImageName() : img.getImageId())
                            .osType(detectOsType(img.getImageName()))
                            .glanceId(img.getImageId())
                            .sizeGb(sizeGb)
                            .visibility("PUBLIC")
                            .status("ACTIVE")
                            .createdAt(System.currentTimeMillis())
                            .build());
                }
            }
        } catch (Exception e) {
            log.warn("Không thể quét bảng DynamoDB XRegion-Images: {}", e.getMessage());
        }

        // Bổ sung các custom snapshot được tạo trong phiên
        result.addAll(snapshotStore.values());

        return result.stream()
                .sorted(Comparator.comparing(ImageResponse::getName))
                .collect(Collectors.toList());
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

        snapshotStore.put(imgId, img);
        auditLogService.logAction("CREATE_IMAGE", "IMAGE", imgId, "Created image snapshot from " + instanceId);
        return img;
    }

    public void deleteImage(String id) {
        snapshotStore.remove(id);
        auditLogService.logAction("DELETE_IMAGE", "IMAGE", id, "Deleted image " + id);
    }
}
