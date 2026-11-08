package com.iaas.xregion.Services;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.NovaEntity;
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
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;

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
    private final DynamoDbTable<NovaEntity> novaTable;
    private final AuditLogService auditLogService;
    private final EventBridgeGatewayClient eventBridgeGatewayClient;
    private final AuthService authService;
    private final ScheduledExecutorService stateTransitionExecutor = Executors.newScheduledThreadPool(4);
    private final Map<String, Integer> instanceEbsSizeMap = new ConcurrentHashMap<>();

    @PreDestroy
    public void cleanup() {
        stateTransitionExecutor.shutdown();
    }

    private void scheduleStateTransition(String instanceId, InstanceStatus expectedIntermediate,
            InstanceStatus targetStatus, long delayMs) {
        stateTransitionExecutor.schedule(() -> {
            try {
                InstanceEntity fresh = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
                if (fresh != null && expectedIntermediate.name().equalsIgnoreCase(fresh.getCurrentStatus())) {
                    fresh.setCurrentStatus(targetStatus.name());
                    fresh.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                    instancesTable.putItem(fresh);

                    if (novaTable != null && fresh.getActiveNovaId() != null) {
                        try {
                            NovaEntity activeNova = novaTable.getItem(Key.builder().partitionValue(fresh.getActiveNovaId()).build());
                            if (activeNova != null) {
                                activeNova.setStatus(targetStatus.name());
                                novaTable.putItem(activeNova);
                            }
                        } catch (Exception ex) {
                            log.warn("Async state transition could not update active Nova [{}]: {}", fresh.getActiveNovaId(), ex.getMessage());
                        }
                    }

                    log.info("Async state transition complete: [{}] {} -> {}", instanceId, expectedIntermediate,
                            targetStatus);
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

    private boolean isOwner(InstanceEntity entity, String currentUser) {
        if (entity == null || currentUser == null) {
            return false;
        }
        if ("admin".equalsIgnoreCase(currentUser)) {
            return true;
        }
        if (currentUser.equalsIgnoreCase(entity.getUsername())) {
            return true;
        }
        try {
            UserEntity user = authService.findUserByUsername(currentUser);
            if (user != null && user.getUserId() != null && user.getUserId().equalsIgnoreCase(entity.getUserId())) {
                return true;
            }
        } catch (Exception e) {
            log.debug("Auth service user check failed for [{}]: {}", currentUser, e.getMessage());
        }
        return false;
    }

    private void autoLinkNovaIfAvailable(InstanceEntity entity) {
        if (entity == null || entity.getActiveNovaId() != null || novaTable == null) {
            return;
        }
        try {
            var index = novaTable.index("instance_id-index");
            if (index == null) return;
            var query = index.query(r -> r.queryConditional(
                    QueryConditional.keyEqualTo(Key.builder().partitionValue(entity.getInstanceId()).build())));
            for (var page : query) {
                for (NovaEntity nova : page.items()) {
                    if (nova != null && nova.getNovaId() != null) {
                        entity.setActiveNovaId(nova.getNovaId());
                        if (entity.getNovaIds() == null) {
                            entity.setNovaIds(new java.util.ArrayList<>());
                        }
                        if (!entity.getNovaIds().contains(nova.getNovaId())) {
                            entity.getNovaIds().add(nova.getNovaId());
                        }
                        if ("ACTIVE".equalsIgnoreCase(nova.getStatus())) {
                            entity.setCurrentStatus("RUNNING");
                        }
                        entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                        instancesTable.putItem(entity);
                        log.info("Auto-linked current Nova [{}] to instance [{}] with status [{}]",
                                nova.getNovaId(), entity.getInstanceId(), entity.getCurrentStatus());
                        return;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Auto-link Nova for instance [{}] not ready: {}", entity.getInstanceId(), e.getMessage());
        }
    }

    public List<InstanceResponse> getAllInstances() {
        String currentUser = getCurrentUsername();
        try {
            return instancesTable.scan()
                    .items()
                    .stream()
                    .filter(entity -> isOwner(entity, currentUser))
                    .peek(this::autoLinkNovaIfAvailable)
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
        if (entity == null || !isOwner(entity, currentUser)) {
            throw new ResourceNotFoundException("Instance not found in AWS DynamoDB: " + id);
        }
        autoLinkNovaIfAvailable(entity);
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
        String keyId = (request.getKeyPairName() != null && !request.getKeyPairName().trim().isEmpty())
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
        String volumeId = "vol-" + (id.length() > 8 ? id.substring(0, 8) : id);
        String securityGroupId = id;
        int initialEbsGb = (request.getEbsSizeGb() > 0) ? request.getEbsSizeGb() : 10;
        instanceEbsSizeMap.put(id, initialEbsGb);

        // 1. Initial Streamlined Instance record in XRegion-Instances with PENDING status (active_nova_id not yet assigned)
        InstanceEntity entity = InstanceEntity.builder()
                .instanceId(id)
                .instanceName(request.getName().trim())
                .currentRegion(region)
                .flavor(request.getFlavor())
                .privateIp(privateIp)
                .elasticIp(elasticIp)
                .volumeId(volumeId)
                .keyId(keyId)
                .securityGroupId(securityGroupId)
                .userId(userId)
                .currentStatus(InstanceStatus.PENDING.name())
                .dns(dns)
                .migrationLock(false)
                .lastMigrationTimestamp(nowSec)
                .build();

        try {
            instancesTable.putItem(entity);
            log.info("Persisted initial PENDING instance record [{}] in XRegion-Instances", id);
        } catch (Exception e) {
            log.error("Failed to put instance into AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi ghi máy ảo vào AWS DynamoDB: " + e.getMessage());
        }

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
                    id,
                    request.getName().trim(),
                    ebsSize,
                    volType,
                    request.getFlavor(),
                    imageId,
                    keyId,
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

        if (entity == null || !isOwner(entity, currentUser)) {
            throw new ResourceNotFoundException("Instance not found: " + id);
        }

        if (Boolean.TRUE.equals(entity.getMigrationLock()) || "MIGRATING".equalsIgnoreCase(entity.getCurrentStatus())) {
            throw new AppException(
                    "Máy ảo đang trong quá trình chuyển vùng (MIGRATING), không thể chỉnh sửa cấu hình lúc này.");
        }

        NovaEntity activeNova = null;
        if (entity.getActiveNovaId() != null && novaTable != null) {
            try {
                activeNova = novaTable.getItem(Key.builder().partitionValue(entity.getActiveNovaId()).build());
            } catch (Exception e) {
                log.warn("Could not fetch active Nova [{}] for update: {}", entity.getActiveNovaId(), e.getMessage());
            }
        }

        String oldName = (activeNova != null && activeNova.getInstanceName() != null) ? activeNova.getInstanceName() : entity.getInstanceName();
        String oldFlavor = (activeNova != null && activeNova.getFlavor() != null) ? activeNova.getFlavor() : (entity.getFlavor() != null ? entity.getFlavor() : "m1.medium");
        String oldKey = (activeNova != null && activeNova.getKeyId() != null) ? activeNova.getKeyId() : entity.getKeyId();
        String oldSg = (activeNova != null && activeNova.getSecurityGroupId() != null) ? activeNova.getSecurityGroupId() : entity.getSecurityGroupId();
        String oldEip = (activeNova != null && activeNova.getElasticIp() != null) ? activeNova.getElasticIp() : entity.getElasticIp();

        boolean isStopped = "STOPPED".equalsIgnoreCase(entity.getCurrentStatus())
                || "SHUTOFF".equalsIgnoreCase(entity.getCurrentStatus());

        // Quy tắc AWS EC2 Nhóm 2 (Cold-modify): Thay đổi Instance Type (Flavor) bắt buộc máy ảo phải ở trạng thái STOPPED
        String requestedFlavor = request.getFlavor() != null ? request.getFlavor().trim() : oldFlavor;
        if (!requestedFlavor.equalsIgnoreCase(oldFlavor)) {
            if (!isStopped) {
                throw new AppException(
                        "Theo quy tắc AWS EC2, bạn bắt buộc phải Dừng máy ảo (Stop) trước khi thay đổi gói cấu hình phần cứng (Instance Type / Flavor từ "
                                + oldFlavor + " sang " + requestedFlavor + ")!");
            }
            if (activeNova != null) {
                activeNova.setFlavor(requestedFlavor);
            }
            entity.setFlavor(requestedFlavor);
        }

        // Quy tắc AWS EC2 Nhóm 3 & 1 (EBS Elastic Volumes): Chỉ cho phép tăng dung lượng ổ cứng, không hỗ trợ giảm (Downsize)
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
        String newName = request.getName().trim();
        if (activeNova != null) {
            activeNova.setInstanceName(newName);
        }
        entity.setInstanceName(newName);

        if (request.getKeyPairName() != null && !request.getKeyPairName().trim().isEmpty()) {
            String newKey = request.getKeyPairName().trim();
            String newKeyId = newKey.startsWith("key-") ? newKey : "key-" + newKey;
            if (activeNova != null) {
                activeNova.setKeyId(newKeyId);
            }
            entity.setKeyId(newKeyId);
        }
        if (request.getDomainName() != null && !request.getDomainName().trim().isEmpty()) {
            entity.setDns(request.getDomainName().trim());
        }
        if (request.getSecurityGroupId() != null && !request.getSecurityGroupId().trim().isEmpty()) {
            String newSgId = request.getSecurityGroupId().trim();
            if (activeNova != null) {
                activeNova.setSecurityGroupId(newSgId);
            }
            entity.setSecurityGroupId(newSgId);
        }
        if (request.getElasticIpAction() != null) {
            String eipAct = request.getElasticIpAction().trim().toUpperCase();
            if ("ALLOCATE_NEW".equals(eipAct)) {
                String newEip = (request.getCustomElasticIp() != null && !request.getCustomElasticIp().trim().isEmpty())
                        ? request.getCustomElasticIp().trim()
                        : "3.27." + (new Random().nextInt(200) + 10) + "." + (new Random().nextInt(250) + 1);
                if (activeNova != null) {
                    activeNova.setElasticIp(newEip);
                }
                entity.setElasticIp(newEip);
            } else if ("DISASSOCIATE".equals(eipAct)) {
                if (activeNova != null) {
                    activeNova.setElasticIp("Chưa gán");
                }
                entity.setElasticIp("Chưa gán");
            }
        }

        if (activeNova != null && novaTable != null) {
            try {
                novaTable.putItem(activeNova);
            } catch (Exception e) {
                log.error("Failed to update active Nova in AWS DynamoDB: {}", e.getMessage());
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

        if (entity == null || !isOwner(entity, currentUser)) {
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

        if (entity.getActiveNovaId() != null && novaTable != null) {
            try {
                NovaEntity activeNova = novaTable.getItem(Key.builder().partitionValue(entity.getActiveNovaId()).build());
                if (activeNova != null) {
                    activeNova.setStatus(entity.getCurrentStatus());
                    novaTable.putItem(activeNova);
                }
            } catch (Exception e) {
                log.warn("Failed to update active Nova status in executeAction: {}", e.getMessage());
            }
        }

        auditLogService.logAction(action + "_VM", "INSTANCE", id,
                "Requested lifecycle action " + action + " for instance " + id);

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
        NovaEntity activeNova = null;
        if (entity.getActiveNovaId() != null && novaTable != null) {
            try {
                activeNova = novaTable.getItem(Key.builder().partitionValue(entity.getActiveNovaId()).build());
            } catch (Exception e) {
                log.warn("Could not fetch active Nova [{}] for instance [{}]: {}", entity.getActiveNovaId(), entity.getInstanceId(), e.getMessage());
            }
        }

        String regionCode = (activeNova != null && activeNova.getRegion() != null)
                ? activeNova.getRegion()
                : (entity.getCurrentRegion() != null ? entity.getCurrentRegion() : "ap-southeast-2");
        RegionType regionType = RegionType.fromCode(regionCode);

        String status;
        if (Boolean.TRUE.equals(entity.getMigrationLock()) || "MIGRATING".equalsIgnoreCase(entity.getCurrentStatus())) {
            status = InstanceStatus.MIGRATING.name();
        } else if (entity.getActiveNovaId() == null || entity.getActiveNovaId().trim().isEmpty()) {
            status = InstanceStatus.PENDING.name();
        } else {
            String rawStatus = activeNova != null ? activeNova.getStatus() : entity.getCurrentStatus();
            if ("ACTIVE".equalsIgnoreCase(rawStatus)) {
                status = InstanceStatus.RUNNING.name();
            } else if ("SHUTOFF".equalsIgnoreCase(rawStatus) || "STOPPED".equalsIgnoreCase(rawStatus)) {
                status = InstanceStatus.STOPPED.name();
            } else if ("TERMINATED".equalsIgnoreCase(rawStatus) || "DELETED".equalsIgnoreCase(rawStatus)) {
                status = InstanceStatus.TERMINATED.name();
            } else if (rawStatus != null) {
                try {
                    status = InstanceStatus.valueOf(rawStatus.toUpperCase().trim()).name();
                } catch (IllegalArgumentException e) {
                    status = rawStatus.toUpperCase().trim();
                }
            } else {
                status = InstanceStatus.RUNNING.name();
            }
        }

        long timestampMs = TimeSyncUtil.toEpochMillis(entity.getLastMigrationTimestamp());

        String instName = (activeNova != null && activeNova.getInstanceName() != null)
                ? activeNova.getInstanceName()
                : (entity.getInstanceName() != null ? entity.getInstanceName() : entity.getInstanceId());
        String flavor = (activeNova != null && activeNova.getFlavor() != null)
                ? activeNova.getFlavor()
                : (entity.getFlavor() != null ? entity.getFlavor() : "m1.medium");
        String privateIp = (activeNova != null && activeNova.getPrivateIp() != null)
                ? activeNova.getPrivateIp()
                : (entity.getPrivateIp() != null ? entity.getPrivateIp() : "10.0.1.10");
        String elasticIp = (activeNova != null && activeNova.getElasticIp() != null)
                ? activeNova.getElasticIp()
                : (entity.getElasticIp() != null ? entity.getElasticIp() : "Chưa gán");
        String keyId = (activeNova != null && activeNova.getKeyId() != null)
                ? activeNova.getKeyId()
                : entity.getKeyId();
        String volumeId = (activeNova != null && activeNova.getVolumeId() != null)
                ? activeNova.getVolumeId()
                : entity.getVolumeId();
        String sgId = (activeNova != null && activeNova.getSecurityGroupId() != null)
                ? activeNova.getSecurityGroupId()
                : (entity.getSecurityGroupId() != null ? entity.getSecurityGroupId() : entity.getInstanceId());

        return InstanceResponse.builder()
                .username(entity.getUsername())
                .userId(entity.getUserId() != null ? entity.getUserId() : "")
                .id(entity.getInstanceId())
                .activeNovaId(entity.getActiveNovaId())
                .novaIds(entity.getNovaIds())
                .name(instName)
                .region(regionCode)
                .regionName(regionType.getDisplayName())
                .flavor(flavor)
                .status(status)
                .privateIp(privateIp)
                .publicIp(elasticIp)
                .securityGroup(entity.getSecurityGroup() != null ? entity.getSecurityGroup() : "sg-default")
                .dnsDomain((entity.getDns() != null && !entity.getDns().trim().isEmpty())
                        ? entity.getDns()
                        : (instName != null ? instName.toLowerCase().replaceAll("[^a-z0-9.-]", "-") + ".xregion.net"
                                : "app.xregion.net"))
                .imageId("img-u22")
                .imageName("Ubuntu 22.04 LTS (Jammy Jellyfish)")
                .consoleUrl("https://console.xregion.internal/vnc?vm=" + entity.getInstanceId())
                .createdAt(timestampMs)
                .updatedAt(timestampMs)
                .keyId(keyId)
                .keyName(keyId != null ? keyId : "xregion-key")
                .volumeId(volumeId)
                .ebsSizeGb(instanceEbsSizeMap.getOrDefault(entity.getInstanceId(), 10))
                .securityGroupId(sgId)
                .build();
    }
}
