package com.iaas.xregion.Services;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.RegionType;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Request.UpdateInstanceRequest;
import com.iaas.xregion.Model.Response.InstanceResponse;
import com.iaas.xregion.Entity.InstanceStatus;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class InstanceService {

    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final AuditLogService auditLogService;
    private final EventBridgeGatewayClient eventBridgeGatewayClient;
    private final AuthService authService;
    private final Map<String, Integer> instanceEbsSizeMap = new ConcurrentHashMap<>();
    private final ScheduledExecutorService stateTransitionExecutor = Executors.newScheduledThreadPool(4);

    @PreDestroy
    public void cleanup() {
        stateTransitionExecutor.shutdown();
    }

    private void scheduleStateTransition(String instanceId, InstanceStatus expectedIntermediate, InstanceStatus targetStatus, long delayMs) {
        stateTransitionExecutor.schedule(() -> {
            try {
                InstanceEntity fresh = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
                if (fresh != null && expectedIntermediate.name().equalsIgnoreCase(fresh.getCurrentStatus())) {
                    fresh.setCurrentStatus(targetStatus.name());
                    fresh.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                    instancesTable.putItem(fresh);
                    log.info("Async state transition complete: [{}] {} -> {}", instanceId, expectedIntermediate, targetStatus);
                }
            } catch (Exception e) {
                log.error("Async state transition failed for [{}]: {}", instanceId, e.getMessage());
            }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private String getCurrentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return "admin";
    }

    public List<InstanceResponse> getAllInstances() {
        String currentUser = getCurrentUsername();
        try {
            return instancesTable.scan()
                    .items()
                    .stream()
                    .filter(entity -> currentUser.equalsIgnoreCase(entity.getUsername()))
                    .map(this::mapToResponse)
                    .sorted((a, b) -> Long.compare(b.getUpdatedAt(), a.getUpdatedAt()))
                    .collect(Collectors.toList());
        } catch (Exception e) {
            log.error("Failed to scan instances from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi kết nối AWS DynamoDB khi đọc danh sách máy ảo: " + e.getMessage());
        }
    }

    public InstanceResponse getInstanceById(String id) {
        String currentUser = getCurrentUsername();
        InstanceEntity entity;
        try {
            entity = instancesTable.getItem(Key.builder().partitionValue(id).build());
        } catch (Exception e) {
            log.error("Failed to get instance from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi kết nối AWS DynamoDB khi tra cứu máy ảo: " + e.getMessage());
        }
        if (entity == null || !currentUser.equalsIgnoreCase(entity.getUsername())) {
            throw new ResourceNotFoundException("Instance not found in AWS DynamoDB: " + id);
        }
        return mapToResponse(entity);
    }

    public InstanceResponse launchInstance(LaunchInstanceRequest request) {
        String currentUser = getCurrentUsername();
        String id = "i-" + UUID.randomUUID().toString().substring(0, 8);
        long nowSec = TimeSyncUtil.nowEpochSeconds();

        String region = request.getRegion();
        String privateIp = region.contains("southeast") ? "10.0.1." + (100 + new Random().nextInt(150))
                : "10.1.1." + (100 + new Random().nextInt(150));
        String elasticIp = "3.27." + (new Random().nextInt(200) + 10) + "." + (new Random().nextInt(250) + 1);
        String keyName = (request.getKeyPairName() != null && !request.getKeyPairName().trim().isEmpty())
                ? request.getKeyPairName().trim()
                : "xregion-key";
        String securityGroup = (request.getSecurityGroup() != null && !request.getSecurityGroup().trim().isEmpty())
                ? request.getSecurityGroup().trim()
                : "sg-default";
        String dns = (request.getDomainName() != null && !request.getDomainName().trim().isEmpty())
                ? request.getDomainName().trim()
                : request.getName().trim().toLowerCase().replaceAll("[^a-z0-9.-]", "-") + ".xregion.net";

        UserEntity currentUserEntity = authService.findUserByUsername(currentUser);
        String userId = (currentUserEntity != null && currentUserEntity.getUserId() != null)
                ? currentUserEntity.getUserId()
                : ("usr-" + currentUser);
        String keyId = "key-" + keyName;
        String volumeId = "vol-" + (id.length() > 8 ? id.substring(0, 8) : id);
        String securityGroupId = "7295eaec-b17d-4dd0-be49-97389e6b361a";
        int initialEbsGb = (request.getEbsSizeGb() > 0) ? request.getEbsSizeGb() : 10;
        instanceEbsSizeMap.put(id, initialEbsGb);

        InstanceEntity entity = InstanceEntity.builder()
                .username(currentUser)
                .userId(userId)
                .keyId(keyId)
                .volumeId(volumeId)
                .securityGroupId(securityGroupId)
                .instanceId(id)
                .instanceName(request.getName())
                .currentRegion(region)
                .currentStatus(InstanceStatus.PENDING.name())
                .elasticIp(elasticIp)
                .privateIp(privateIp)
                .flavor(request.getFlavor())
                .keyName(keyName)
                .securityGroup(securityGroup)
                .dns(dns)
                .migrationLock(false)
                .build();

        try {
            instancesTable.putItem(entity);
        } catch (Exception e) {
            log.error("Failed to put instance into AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi ghi máy ảo vào AWS DynamoDB: " + e.getMessage());
        }

        // Schedule async transition: PENDING -> RUNNING after 3500ms
        scheduleStateTransition(id, InstanceStatus.PENDING, InstanceStatus.RUNNING, 3500);

        auditLogService.logAction("LAUNCH_VM", "INSTANCE", id,
                "Requested launch for instance [" + request.getName() + "] in AWS region [" + region + "]");

        // Bắn sự kiện qua API Gateway vào EventBridge để Step Function LaunchInstance tự động cấp phát và đồng bộ DynamoDB
        try {
            int ebsSize = request.getEbsSizeGb() > 0 ? request.getEbsSizeGb() : 10;
            String volType = (request.getEbsVolumeType() != null && !request.getEbsVolumeType().trim().isEmpty())
                    ? request.getEbsVolumeType().trim() : "gp3";
            String imageId = (request.getImageId() != null && !request.getImageId().trim().isEmpty())
                    ? request.getImageId().trim() : "72e9830a-53ef-4c36-8b5c-fae3b96a3fd0";

            eventBridgeGatewayClient.sendInstanceLaunchEvent(
                    request.getName().trim(),
                    ebsSize,
                    volType,
                    request.getFlavor(),
                    imageId,
                    keyName,
                    currentUser);
        } catch (Exception e) {
            log.warn("Không thể gửi sự kiện LAUNCH qua API Gateway EventBridge: {}", e.getMessage());
        }

        return mapToResponse(entity);
    }

    public InstanceResponse updateInstance(String id, UpdateInstanceRequest request) {
        String currentUser = getCurrentUsername();
        InstanceEntity entity;
        try {
            entity = instancesTable.getItem(Key.builder().partitionValue(id).build());
        } catch (Exception e) {
            log.error("Failed to read instance from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi đọc máy ảo từ AWS DynamoDB: " + e.getMessage());
        }

        if (entity == null || !currentUser.equalsIgnoreCase(entity.getUsername())) {
            throw new ResourceNotFoundException("Instance not found: " + id);
        }

        if (Boolean.TRUE.equals(entity.getMigrationLock()) || "MIGRATING".equalsIgnoreCase(entity.getCurrentStatus())) {
            throw new AppException(
                    "Máy ảo đang trong quá trình chuyển vùng (MIGRATING), không thể chỉnh sửa cấu hình lúc này.");
        }

        String oldName = entity.getInstanceName();
        String oldFlavor = entity.getFlavor() != null ? entity.getFlavor() : "m1.medium";
        String oldKey = entity.getKeyId();
        String oldSg = entity.getSecurityGroupId();
        String oldEip = entity.getElasticIp();

        boolean isStopped = "STOPPED".equalsIgnoreCase(entity.getCurrentStatus())
                || "SHUTOFF".equalsIgnoreCase(entity.getCurrentStatus());

        // Quy tắc AWS EC2 Nhóm 2 (Cold-modify): Thay đổi Instance Type (Flavor) bắt
        // buộc máy ảo phải ở trạng thái STOPPED
        String requestedFlavor = request.getFlavor() != null ? request.getFlavor().trim() : oldFlavor;
        if (!requestedFlavor.equalsIgnoreCase(oldFlavor)) {
            if (!isStopped) {
                throw new AppException(
                        "Theo quy tắc AWS EC2, bạn bắt buộc phải Dừng máy ảo (Stop) trước khi thay đổi gói cấu hình phần cứng (Instance Type / Flavor từ "
                                + oldFlavor + " sang " + requestedFlavor + ")!");
            }
            entity.setFlavor(requestedFlavor);
        }

        // Quy tắc AWS EC2 Nhóm 3 & 1 (EBS Elastic Volumes): Chỉ cho phép tăng dung
        // lượng ổ cứng, không hỗ trợ giảm (Downsize)
        int currentEbsSize = instanceEbsSizeMap.getOrDefault(id, 10);
        if (request.getEbsSizeGb() != null) {
            if (request.getEbsSizeGb() < currentEbsSize) {
                throw new AppException(
                        "AWS EBS chỉ cho phép mở rộng (tăng) kích thước ổ cứng, không hỗ trợ giảm dung lượng trực tiếp (Hiện tại: "
                                + currentEbsSize + " GB, Yêu cầu: " + request.getEbsSizeGb() + " GB).");
            }
            instanceEbsSizeMap.put(id, request.getEbsSizeGb());
        }

        // Quy tắc AWS EC2 Nhóm 1 (Hot-modify): Sửa trực tiếp khi máy đang chạy
        entity.setInstanceName(request.getName().trim());
        if (request.getKeyPairName() != null && !request.getKeyPairName().trim().isEmpty()) {
            String newKey = request.getKeyPairName().trim();
            entity.setKeyId(newKey.startsWith("key-") ? newKey : "key-" + newKey);
        }
        if (request.getDomainName() != null && !request.getDomainName().trim().isEmpty()) {
            entity.setDns(request.getDomainName().trim());
        }
        if (request.getSecurityGroupId() != null && !request.getSecurityGroupId().trim().isEmpty()) {
            entity.setSecurityGroupId(request.getSecurityGroupId().trim());
        }
        if (request.getElasticIpAction() != null) {
            String eipAct = request.getElasticIpAction().trim().toUpperCase();
            if ("ALLOCATE_NEW".equals(eipAct)) {
                if (request.getCustomElasticIp() != null && !request.getCustomElasticIp().trim().isEmpty()) {
                    entity.setElasticIp(request.getCustomElasticIp().trim());
                } else {
                    String newEip = "3.27." + (new Random().nextInt(200) + 10) + "." + (new Random().nextInt(250) + 1);
                    entity.setElasticIp(newEip);
                }
            } else if ("DISASSOCIATE".equals(eipAct)) {
                entity.setElasticIp("Chưa gán");
            }
        }

        try {
            instancesTable.putItem(entity);
        } catch (Exception e) {
            log.error("Failed to update instance in AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi cập nhật thông tin máy ảo vào AWS DynamoDB: " + e.getMessage());
        }

        auditLogService.logAction("UPDATE_VM", "INSTANCE", id,
                String.format(
                        "Updated instance [%s -> %s], flavor [%s -> %s], sg [%s -> %s], eip [%s -> %s], ebs [%dGB]",
                        oldName, entity.getInstanceName(), oldFlavor, entity.getFlavor(),
                        oldSg, entity.getSecurityGroupId(), oldEip, entity.getElasticIp(),
                        instanceEbsSizeMap.getOrDefault(id, 10)));

        try {
            eventBridgeGatewayClient.sendInstanceLifecycleEvent(
                    "MODIFY", id, entity.getInstanceName(), entity.getFlavor(),
                    entity.getCurrentRegion(), entity.getKeyId(), currentUser);
        } catch (Exception e) {
            log.warn("Không thể gửi sự kiện MODIFY qua API Gateway EventBridge: {}", e.getMessage());
        }

        return mapToResponse(entity);
    }

    public InstanceResponse executeAction(String id, InstanceActionRequest request) {
        String currentUser = getCurrentUsername();
        InstanceEntity entity;
        try {
            entity = instancesTable.getItem(Key.builder().partitionValue(id).build());
        } catch (Exception e) {
            log.error("Failed to read instance from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi đọc máy ảo từ AWS DynamoDB: " + e.getMessage());
        }

        if (entity == null || !currentUser.equalsIgnoreCase(entity.getUsername())) {
            throw new ResourceNotFoundException("Instance not found: " + id);
        }

        String action = request.getAction().toUpperCase();

        switch (action) {
            case "START":
                entity.setCurrentStatus(InstanceStatus.PENDING.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                scheduleStateTransition(id, InstanceStatus.PENDING, InstanceStatus.RUNNING, 3500);
                break;
            case "STOP":
                entity.setCurrentStatus(InstanceStatus.STOPPING.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                scheduleStateTransition(id, InstanceStatus.STOPPING, InstanceStatus.STOPPED, 3500);
                break;
            case "REBOOT":
                entity.setCurrentStatus(InstanceStatus.REBOOTING.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                scheduleStateTransition(id, InstanceStatus.REBOOTING, InstanceStatus.RUNNING, 3500);
                break;
            case "TERMINATE":
            case "DELETE":
                entity.setCurrentStatus(InstanceStatus.SHUTTING_DOWN.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                scheduleStateTransition(id, InstanceStatus.SHUTTING_DOWN, InstanceStatus.TERMINATED, 3500);
                break;
            case "CONSOLE":
                return mapToResponse(entity);
            default:
                throw new IllegalArgumentException("Unknown lifecycle action: " + action);
        }

        auditLogService.logAction(action + "_VM", "INSTANCE", id,
                "Requested lifecycle action " + action + " for instance " + id);

        // Bắn sự kiện qua API Gateway vào EventBridge để Lambda NovaLifecycleManager
        // thực thi OpenStack
        // và OpenStack event forwarder tự động trigger Lambda SyncNovaToDynamoDB cập
        // nhật trạng thái thực tế vào DynamoDB
        try {
            eventBridgeGatewayClient.sendInstanceLifecycleEvent(
                    action, id, entity.getInstanceName(), entity.getFlavor(), entity.getCurrentRegion(),
                    entity.getKeyId(), currentUser);
        } catch (Exception e) {
            log.warn("Không thể gửi sự kiện {} qua API Gateway EventBridge: {}", action, e.getMessage());
        }

        return mapToResponse(entity);
    }

    public InstanceResponse mapToResponse(InstanceEntity entity) {
        String regionCode = entity.getCurrentRegion() != null ? entity.getCurrentRegion() : "ap-southeast-2";
        RegionType regionType = RegionType.fromCode(regionCode);

        // Standard EC2 Statuses: PENDING, RUNNING, STOPPING, STOPPED, REBOOTING,
        // SHUTTING_DOWN, TERMINATED, MIGRATING
        String status = InstanceStatus.RUNNING.name();
        if (Boolean.TRUE.equals(entity.getMigrationLock()) || "MIGRATING".equalsIgnoreCase(entity.getCurrentStatus())) {
            status = InstanceStatus.MIGRATING.name();
        } else if (entity.getCurrentStatus() != null) {
            try {
                status = InstanceStatus.valueOf(entity.getCurrentStatus().toUpperCase().trim()).name();
            } catch (IllegalArgumentException e) {
                if ("SHUTOFF".equalsIgnoreCase(entity.getCurrentStatus())) {
                    status = InstanceStatus.STOPPED.name();
                } else if ("ACTIVE".equalsIgnoreCase(entity.getCurrentStatus())) {
                    status = InstanceStatus.RUNNING.name();
                } else {
                    status = entity.getCurrentStatus().toUpperCase().trim();
                }
            }
        }

        long timestampMs = TimeSyncUtil.toEpochMillis(entity.getLastMigrationTimestamp());

        return InstanceResponse.builder()
                .username(entity.getUsername())
                .userId(entity.getUserId() != null ? entity.getUserId() : "")
                .id(entity.getInstanceId())
                .name(entity.getInstanceName() != null ? entity.getInstanceName() : entity.getInstanceId())
                .region(regionCode)
                .regionName(regionType.getDisplayName())
                .flavor(entity.getFlavor() != null ? entity.getFlavor() : "m1.medium")
                .status(status)
                .privateIp(entity.getPrivateIp() != null ? entity.getPrivateIp() : "10.0.1.10")
                .publicIp(entity.getElasticIp() != null ? entity.getElasticIp() : "Chưa gán")
                .securityGroup(entity.getSecurityGroup() != null ? entity.getSecurityGroup() : "sg-default")
                .dnsDomain((entity.getDns() != null && !entity.getDns().trim().isEmpty())
                        ? entity.getDns()
                        : (entity.getInstanceName() != null ? entity.getInstanceName().toLowerCase() + ".xregion.net"
                                : "app.xregion.net"))
                .imageId("img-u22")
                .imageName("Ubuntu 22.04 LTS (Jammy Jellyfish)")
                .consoleUrl("https://console.xregion.internal/vnc?vm=" + entity.getInstanceId())
                .createdAt(timestampMs)
                .updatedAt(timestampMs)
                .keyId(entity.getKeyId())
                .keyName(entity.getKeyId() != null ? entity.getKeyId().replaceFirst("^key-", "") : "xregion-key")
                .volumeId(entity.getVolumeId())
                .ebsSizeGb(instanceEbsSizeMap.getOrDefault(entity.getInstanceId(), 10))
                .securityGroupId(entity.getSecurityGroupId() != null ? entity.getSecurityGroupId()
                        : "7295eaec-b17d-4dd0-be49-97389e6b361a")
                .build();
    }
}
