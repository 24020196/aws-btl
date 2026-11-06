package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.RegionType;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Response.InstanceResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class InstanceService {

    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final AuditLogService auditLogService;

    public List<InstanceResponse> getAllInstances() {
        try {
            return instancesTable.scan()
                    .items()
                    .stream()
                    .map(this::mapToResponse)
                    .sorted((a, b) -> Long.compare(b.getUpdatedAt(), a.getUpdatedAt()))
                    .collect(Collectors.toList());
        } catch (Exception e) {
            log.error("Failed to scan instances from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi kết nối AWS DynamoDB khi đọc danh sách máy ảo: " + e.getMessage());
        }
    }

    public InstanceResponse getInstanceById(String id) {
        InstanceEntity entity;
        try {
            entity = instancesTable.getItem(Key.builder().partitionValue(id).build());
        } catch (Exception e) {
            log.error("Failed to get instance from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi kết nối AWS DynamoDB khi tra cứu máy ảo: " + e.getMessage());
        }
        if (entity == null) {
            throw new ResourceNotFoundException("Instance not found in AWS DynamoDB: " + id);
        }
        return mapToResponse(entity);
    }

    public InstanceResponse launchInstance(LaunchInstanceRequest request) {
        String id = "i-" + UUID.randomUUID().toString().substring(0, 8);
        long now = System.currentTimeMillis();

        String region = request.getRegion();
        String privateIp = region.contains("southeast") ? "10.0.1." + (100 + new Random().nextInt(150))
                : "10.1.1." + (100 + new Random().nextInt(150));
        String elasticIp = "3.27." + (new Random().nextInt(200) + 10) + "." + (new Random().nextInt(250) + 1);

        InstanceEntity entity = InstanceEntity.builder()
                .instanceId(id)
                .instanceName(request.getName())
                .currentRegion(region)
                .currentStatus("RUNNING")
                .elasticIp(elasticIp)
                .privateIp(privateIp)
                .flavor(request.getFlavor())
                .migrationLock(false)
                .lockAcquiredAt(0L)
                .cooldownSeconds(300)
                .lastMigrationTimestamp(now)
                .build();

        try {
            instancesTable.putItem(entity);
        } catch (Exception e) {
            log.error("Failed to put instance into AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi ghi máy ảo vào AWS DynamoDB: " + e.getMessage());
        }

        auditLogService.logAction("LAUNCH_VM", "INSTANCE", id,
                "Launched instance [" + request.getName() + "] in AWS region [" + region + "] with IP " + elasticIp);

        return mapToResponse(entity);
    }

    public InstanceResponse executeAction(String id, InstanceActionRequest request) {
        InstanceEntity entity;
        try {
            entity = instancesTable.getItem(Key.builder().partitionValue(id).build());
        } catch (Exception e) {
            log.error("Failed to read instance from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi đọc máy ảo từ AWS DynamoDB: " + e.getMessage());
        }

        if (entity == null) {
            throw new ResourceNotFoundException("Instance not found: " + id);
        }

        String action = request.getAction().toUpperCase();
        String currentStatus = entity.getCurrentStatus();

        switch (action) {
            case "START":
                entity.setCurrentStatus("RUNNING");
                break;
            case "STOP":
                entity.setCurrentStatus("STOPPED");
                break;
            case "REBOOT":
                entity.setCurrentStatus("REBOOTING");
                new Timer().schedule(new TimerTask() {
                    @Override
                    public void run() {
                        entity.setCurrentStatus("RUNNING");
                        try {
                            instancesTable.putItem(entity);
                        } catch (Exception e) {
                            log.error("Failed to update reboot status in DynamoDB: {}", e.getMessage());
                        }
                    }
                }, 3000);
                break;
            case "TERMINATE":
            case "DELETE":
                try {
                    instancesTable.deleteItem(Key.builder().partitionValue(id).build());
                } catch (Exception e) {
                    log.error("Failed to delete instance from AWS DynamoDB: {}", e.getMessage());
                    throw new AppException("Lỗi xóa máy ảo trên AWS DynamoDB: " + e.getMessage());
                }
                auditLogService.logAction("TERMINATE_VM", "INSTANCE", id, "Terminated instance " + id);
                return mapToResponse(entity);
            default:
                throw new IllegalArgumentException("Unknown lifecycle action: " + action);
        }

        try {
            instancesTable.putItem(entity);
        } catch (Exception e) {
            log.error("Failed to update instance on AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi cập nhật trạng thái máy ảo trên AWS DynamoDB: " + e.getMessage());
        }

        auditLogService.logAction(action + "_VM", "INSTANCE", id,
                "Changed status from " + currentStatus + " to " + entity.getCurrentStatus());

        return mapToResponse(entity);
    }

    public InstanceResponse mapToResponse(InstanceEntity entity) {
        String regionCode = entity.getCurrentRegion() != null ? entity.getCurrentRegion() : "ap-southeast-2";
        RegionType regionType = RegionType.fromCode(regionCode);

        // Normalize status for UI display (RUNNING -> ACTIVE)
        String uiStatus = "ACTIVE";
        if (Boolean.TRUE.equals(entity.getMigrationLock()) || "MIGRATING".equalsIgnoreCase(entity.getCurrentStatus())) {
            uiStatus = "MIGRATING";
        } else if ("STOPPED".equalsIgnoreCase(entity.getCurrentStatus())
                || "SHUTOFF".equalsIgnoreCase(entity.getCurrentStatus())) {
            uiStatus = "SHUTOFF";
        } else if ("REBOOTING".equalsIgnoreCase(entity.getCurrentStatus())) {
            uiStatus = "REBOOTING";
        }

        long timestamp = entity.getLastMigrationTimestamp() != null && entity.getLastMigrationTimestamp() > 0
                ? entity.getLastMigrationTimestamp()
                : System.currentTimeMillis();

        return InstanceResponse.builder()
                .id(entity.getInstanceId())
                .name(entity.getInstanceName() != null ? entity.getInstanceName() : entity.getInstanceId())
                .region(regionCode)
                .regionName(regionType.getDisplayName())
                .flavor(entity.getFlavor() != null ? entity.getFlavor() : "m1.medium")
                .status(uiStatus)
                .privateIp(entity.getPrivateIp() != null ? entity.getPrivateIp() : "10.0.1.10")
                .publicIp(entity.getElasticIp() != null ? entity.getElasticIp() : "Chưa gán")
                .dnsDomain(entity.getInstanceName() != null ? entity.getInstanceName().toLowerCase() + ".xregion.net"
                        : "app.xregion.net")
                .imageId("img-u22")
                .imageName("Ubuntu 22.04 LTS (Jammy Jellyfish)")
                .consoleUrl("https://console.xregion.internal/vnc?vm=" + entity.getInstanceId())
                .createdAt(timestamp)
                .updatedAt(timestamp)
                .build();
    }
}
