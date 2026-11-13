package com.iaas.xregion.Services;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Client.MigrationSchedulerClient;
import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationScenarioEntity;
import com.iaas.xregion.Entity.NovaEntity;
import com.iaas.xregion.Entity.RegionType;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Response.InstanceResponse;
import com.iaas.xregion.Entity.InstanceStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.Expression;
import software.amazon.awssdk.enhanced.dynamodb.model.BatchGetItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;
import software.amazon.awssdk.enhanced.dynamodb.model.ReadBatch;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.*;
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
    private final LaunchAdmissionService launchAdmissionService;

    @Autowired(required = false)
    private DynamoDbEnhancedClient enhancedClient;

    @Autowired(required = false)
    private DynamoDbTable<MigrationScenarioEntity> migrationScenariosTable;

    @Autowired(required = false)
    private MigrationSchedulerClient migrationSchedulerClient;

    private String resolveScenarioStatus(InstanceEntity entity) {
        if (entity == null || entity.getScenarioId() == null || entity.getScenarioId().isBlank()
                || migrationScenariosTable == null) {
            return null;
        }
        try {
            MigrationScenarioEntity scen = migrationScenariosTable.getItem(
                    Key.builder().partitionValue(entity.getScenarioId()).build());
            return scen != null ? scen.getStatus() : null;
        } catch (Exception e) {
            log.warn("Failed to read scenario status [{}] for instance [{}]: {}",
                    entity.getScenarioId(), entity.getInstanceId(), e.getMessage());
            return null;
        }
    }

    private void assertNoActiveScenario(InstanceEntity entity) {
        if ("ACTIVE".equalsIgnoreCase(resolveScenarioStatus(entity))) {
            throw new ConflictException(
                    "Máy ảo [" + entity.getInstanceId()
                            + "] đang kích hoạt Kịch bản chuyển vùng tự động (ACTIVE). Vui lòng tạm dừng kịch bản trước khi sửa hoặc xóa máy ảo.");
        }
    }

    /**
     * Ma trận điều kiện tiên quyết của SPEC-01 (mục 2) và trạng thái chuyển tiếp tương ứng.
     *
     * <p>START/STOP/REBOOT sai điều kiện trả 400 qua {@link AppException}; TERMINATE sai điều kiện
     * trả 409 qua {@link ConflictException} — đúng bảng Pre-conditions của Spec.
     */
    private void requireActionPrecondition(String action, String currentStatus) {
        String status = currentStatus == null ? "" : currentStatus.trim().toUpperCase(Locale.ROOT);
        switch (action) {
            case "START", "STOP", "REBOOT" -> {
                String required = "START".equals(action) ? "STOPPED" : "RUNNING";
                if (!required.equals(status)) {
                    throw new AppException("Hành động " + action + " chỉ được phép khi máy ảo ở trạng thái "
                            + required + " (hiện tại: " + (status.isEmpty() ? "không xác định" : status) + ").");
                }
            }
            case "TERMINATE", "DELETE" -> {
                if (!Set.of("RUNNING", "STOPPED", "FAILED").contains(status)) {
                    throw new ConflictException("Terminate chỉ được phép khi máy ảo ở trạng thái RUNNING, STOPPED "
                            + "hoặc FAILED (hiện tại: " + (status.isEmpty() ? "không xác định" : status) + ").");
                }
            }
            default -> throw new IllegalArgumentException("Unknown lifecycle action: " + action);
        }
    }

    private void updateInstanceState(String id, String status, String expectedStatus) {
        Expression.Builder condition = Expression.builder().expression("attribute_exists(instance_id)");
        if (expectedStatus != null) {
            condition.expression("attribute_exists(instance_id) AND current_status = :expected")
                    .putExpressionValue(":expected", AttributeValue.builder().s(expectedStatus).build());
        }
        instancesTable.updateItem(UpdateItemEnhancedRequest.builder(InstanceEntity.class)
                .item(InstanceEntity.builder().instanceId(id).currentStatus(status)
                        .lastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds()).build())
                .ignoreNulls(true)
                .conditionExpression(condition.build())
                .build());
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

    private static final java.util.Set<String> DEAD_NOVA_STATUSES = java.util.Set.of(
            "TERMINATED", "DELETED", "ERROR", "SHELVED_OFFLOADED_DELETED");

    /** Nova row that can still represent the instance: not deleted/terminated/errored. */
    private static boolean isLiveNova(NovaEntity nova) {
        if (nova == null || nova.getNovaId() == null || nova.getNovaId().trim().isEmpty()) {
            return false;
        }
        String status = nova.getStatus() == null ? "" : nova.getStatus().trim();
        return !DEAD_NOVA_STATUSES.contains(status.toUpperCase(java.util.Locale.ROOT));
    }

    private void autoLinkNovaIfAvailable(InstanceEntity entity) {
        if (entity == null || entity.getActiveNovaId() != null || novaTable == null) {
            return;
        }
        if ("FAILED".equalsIgnoreCase(entity.getCurrentStatus())
                || "TERMINATED".equalsIgnoreCase(entity.getCurrentStatus())
                || "DELETED".equalsIgnoreCase(entity.getCurrentStatus())) {
            return;
        }
        try {
            var index = novaTable.index("instance_id-index");
            if (index == null) return;
            var query = index.query(r -> r.queryConditional(
                    QueryConditional.keyEqualTo(Key.builder().partitionValue(entity.getInstanceId()).build())));
            // The index is keyed on instance_id only, so rows come back in no meaningful order
            // and may include terminated servers from earlier launches. Picking page.items()
            // directly relinked a dead Nova and published RUNNING while the VM was SHUTOFF.
            var live = new java.util.ArrayList<NovaEntity>();
            for (var page : query) {
                for (NovaEntity nova : page.items()) {
                    if (isLiveNova(nova)) {
                        live.add(nova);
                    }
                }
            }
            if (live.isEmpty()) {
                log.debug("Auto-link skipped for instance [{}]: no live Nova record", entity.getInstanceId());
                return;
            }
            live.sort(java.util.Comparator.comparing(NovaEntity::getCreatedAt,
                    java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder())));
            NovaEntity chosen = live.get(live.size() - 1);
            entity.setActiveNovaId(chosen.getNovaId());
            if (entity.getNovaIds() == null) {
                entity.setNovaIds(new java.util.ArrayList<>());
            }
            if (!entity.getNovaIds().contains(chosen.getNovaId())) {
                entity.getNovaIds().add(chosen.getNovaId());
            }
            String novaStatus = chosen.getStatus() == null ? "" : chosen.getStatus().toUpperCase(java.util.Locale.ROOT);
            // Only RUNNING when Nova says so; otherwise keep the transition state instead of
            // asserting a status the VM is not actually in.
            switch (novaStatus) {
                case "ACTIVE" -> entity.setCurrentStatus("RUNNING");
                case "SHUTOFF", "SHELVED", "SHELVED_OFFLOADED" -> entity.setCurrentStatus("STOPPED");
                default -> { }
            }
            entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
            instancesTable.putItem(entity);
            log.info("Auto-linked current Nova [{}] to instance [{}] with status [{}]",
                    chosen.getNovaId(), entity.getInstanceId(), entity.getCurrentStatus());
        } catch (Exception e) {
            log.warn("Auto-link Nova for instance [{}] failed: {}", entity.getInstanceId(), e.toString());
        }
    }

    private Map<String, NovaEntity> batchLoadNova(Collection<String> novaIds) {
        Map<String, NovaEntity> result = new HashMap<>();
        if (enhancedClient == null || novaTable == null || novaIds == null || novaIds.isEmpty()) {
            return result;
        }
        List<String> distinctIds = novaIds.stream()
                .filter(id -> id != null && !id.trim().isEmpty())
                .distinct()
                .collect(Collectors.toList());
        for (int i = 0; i < distinctIds.size(); i += 100) {
            List<String> chunk = distinctIds.subList(i, Math.min(i + 100, distinctIds.size()));
            ReadBatch.Builder<NovaEntity> batchBuilder = ReadBatch.builder(NovaEntity.class)
                    .mappedTableResource(novaTable);
            for (String nid : chunk) {
                batchBuilder.addGetItem(Key.builder().partitionValue(nid).build());
            }
            enhancedClient.batchGetItem(BatchGetItemEnhancedRequest.builder()
                            .addReadBatch(batchBuilder.build())
                            .build())
                    .resultsForTable(novaTable)
                    .forEach(nova -> {
                        if (nova != null && nova.getNovaId() != null) {
                            result.put(nova.getNovaId(), nova);
                        }
                    });
        }
        return result;
    }

    public List<InstanceResponse> getAllInstances() {
        String currentUser = getCurrentUsername();
        try {
            List<InstanceEntity> owned = instancesTable.scan()
                    .items()
                    .stream()
                    .filter(entity -> isOwner(entity, currentUser))
                    .collect(Collectors.toList());

            owned.parallelStream().forEach(this::autoLinkNovaIfAvailable);

            Map<String, NovaEntity> novaMap = (enhancedClient != null)
                    ? batchLoadNova(owned.stream().map(InstanceEntity::getActiveNovaId).collect(Collectors.toList()))
                    : Collections.emptyMap();

            return owned.stream()
                    .map(entity -> {
                        if (enhancedClient != null) {
                            NovaEntity preloaded = entity.getActiveNovaId() != null
                                    ? novaMap.get(entity.getActiveNovaId())
                                    : null;
                            return mapToResponse(entity, preloaded);
                        }
                        return mapToResponse(entity);
                    })
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
            entity = instancesTable.getItem(GetItemEnhancedRequest.builder()
                    .key(Key.builder().partitionValue(id).build())
                    .consistentRead(true)
                    .build());
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

    public static final int MAX_INSTANCES_PER_USER = 5;
    private static final Set<String> QUOTA_COUNTED_STATUSES = Set.of(
            "PENDING", "RUNNING", "STOPPED", "REBOOTING", "STOPPING", "MIGRATING"
    );

    public InstanceResponse launchInstance(LaunchInstanceRequest request) {
        String currentUser = getCurrentUsername();
        launchAdmissionService.validate(request, currentUser);

        UserEntity currentUserEntity = authService.findUserByUsername(currentUser);
        String userId = (currentUserEntity != null && currentUserEntity.getUserId() != null)
                ? currentUserEntity.getUserId()
                : ("usr-" + currentUser);

        long activeCount = countActiveQuotaInstances(userId, currentUser);
        if (activeCount >= MAX_INSTANCES_PER_USER) {
            throw new ConflictException("Bạn đã đạt giới hạn tối đa " + MAX_INSTANCES_PER_USER
                    + " máy ảo đang hoạt động. Vui lòng xóa bớt máy ảo trước khi tạo mới.");
        }

        String id = "i-" + UUID.randomUUID().toString().substring(0, 8);
        long nowSec = TimeSyncUtil.nowEpochSeconds();

        String region = request.getRegion();
        String keyId = (request.getKeyPairName() != null && !request.getKeyPairName().trim().isEmpty())
                ? request.getKeyPairName().trim()
                : "xregion-key";
        String publicDns = id + ".xregion-iaas.online";
        String dns = (request.getDomainName() != null && !request.getDomainName().trim().isEmpty())
                ? request.getDomainName().trim()
                : publicDns;

        int initialEbsGb = request.getEbsSizeGb();

        // 1. Initial Streamlined Instance record in XRegion-Instances with PENDING status (active_nova_id not yet assigned)
        InstanceEntity entity = InstanceEntity.builder()
                .instanceId(id)
                .instanceName(request.getName().trim())
                .currentRegion(region)
                .flavor(request.getFlavor())
                .keyId(keyId)
                .imageId(request.getImageId())
                .requestedSizeGb(initialEbsGb)
                .userId(userId)
                .currentStatus(InstanceStatus.PENDING.name())
                .dns(dns)
                .publicDns(publicDns)
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
            int ebsSize = request.getEbsSizeGb();
            String volType = (request.getEbsVolumeType() != null && !request.getEbsVolumeType().trim().isEmpty())
                    ? request.getEbsVolumeType().trim() : "gp3";
            String imageId = (request.getImageId() != null) ? request.getImageId().trim() : "";
            String instName = (request.getName() != null) ? request.getName().trim() : "";

            eventBridgeGatewayClient.sendInstanceLaunchEvent(
                    id,
                    instName,
                    ebsSize,
                    volType,
                    request.getFlavor(),
                    imageId,
                    keyId,
                    currentUser,
                    region,
                    request.getInboundRules(),
                    request.getOutboundRules());
        } catch (Exception e) {
            if (e instanceof EventBridgeGatewayClient.EventRejectedException) {
                // The gateway refused the event: nothing was ever dispatched, so the request
                // is definitively failed and the record must not stay PENDING.
                markFailed(id, InstanceStatus.FAILED.name(), "EventBridge từ chối: " + e.getMessage(), e);
            } else {
                // Transport failure/timeout: we cannot prove the event was not delivered.
                // Leaving it PENDING hides the request forever, and retrying blindly could
                // launch a second VM. Record it as unknown so it is visible and reconcilable.
                markFailed(id, InstanceStatus.PENDING.name(),
                        "Chưa xác minh được sự kiện launch đã được nhận: " + e.getMessage(), e);
            }
            throw new AppException("Không gửi được yêu cầu tạo máy ảo: " + e.getMessage(), e);
        }

        return mapToResponse(entity);
    }

    private long countActiveQuotaInstances(String userId, String currentUser) {
        var page = instancesTable.scan();
        if (page == null || page.items() == null) {
            return 0;
        }
        return page.items().stream()
                .filter(e -> {
                    if (userId != null && userId.equalsIgnoreCase(e.getUserId())) {
                        return true;
                    }
                    return currentUser != null && currentUser.equalsIgnoreCase(e.getUsername());
                })
                .filter(e -> e.getCurrentStatus() != null
                        && QUOTA_COUNTED_STATUSES.contains(e.getCurrentStatus().toUpperCase(Locale.ROOT)))
                .count();
    }

    private void markFailed(String id, String status, String reason, Exception cause) {
        try {
            updateInstanceState(id, status, InstanceStatus.PENDING.name());
            log.warn("Launch request [{}] left in [{}]: {}", id, status, reason);
        } catch (Exception stateError) {
            // Both the event send and the state write failed: surface both, never swallow.
            cause.addSuppressed(stateError);
            log.error("Launch request [{}] could not be marked as [{}]: {}", id, status,
                    stateError.getMessage());
        }
    }

    // SPEC-01 mục 3: cấu hình máy ảo là bất biến sau launch. Endpoint PUT /api/instances/{id} và
    // toàn bộ logic updateInstance (flavor, đĩa, key, SG, EIP, tên) đã được loại bỏ; muốn cấu hình
    // khác phải Terminate rồi Launch máy mới.

    public InstanceResponse executeAction(String id, InstanceActionRequest request) {
        String currentUser = getCurrentUsername();
        InstanceEntity entity;
        try {
            entity = instancesTable.getItem(GetItemEnhancedRequest.builder()
                    .key(Key.builder().partitionValue(id).build())
                    .consistentRead(true)
                    .build());
        } catch (Exception e) {
            log.error("Failed to read instance from AWS DynamoDB: {}", e.getMessage());
            throw new AppException("Lỗi đọc máy ảo từ AWS DynamoDB: " + e.getMessage());
        }

        if (entity == null || !isOwner(entity, currentUser)) {
            throw new ResourceNotFoundException("Instance not found: " + id);
        }

        String action = request.getAction().toUpperCase(Locale.ROOT);
        if (!"CONSOLE".equals(action)) {
            assertNoActiveScenario(entity);
        }
        String previousStatus = entity.getCurrentStatus();
        requireActionPrecondition(action, previousStatus);

        switch (action) {
            case "START":
                entity.setCurrentStatus(InstanceStatus.STARTING.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                break;
            case "STOP":
                entity.setCurrentStatus(InstanceStatus.STOPPING.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                break;
            case "REBOOT":
                entity.setCurrentStatus(InstanceStatus.REBOOTING.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                break;
            case "TERMINATE":
            case "DELETE":
                entity.setCurrentStatus(InstanceStatus.SHUTTING_DOWN.name());
                entity.setLastMigrationTimestamp(TimeSyncUtil.nowEpochSeconds());
                break;
            case "CONSOLE":
                return mapToResponse(entity);
            default:
                throw new IllegalArgumentException("Unknown lifecycle action: " + action);
        }

        // Only the worker may confirm the final state after checking Nova.
        updateInstanceState(id, entity.getCurrentStatus(), previousStatus);

        auditLogService.logAction(action + "_VM", "INSTANCE", id,
                "Requested lifecycle action " + action + " for instance " + id);

        try {
            eventBridgeGatewayClient.sendInstanceLifecycleEvent(
                    action, id, entity.getInstanceName(), entity.getFlavor(), entity.getCurrentRegion(),
                    entity.getKeyId(), currentUser);
        } catch (Exception e) {
            if (e instanceof EventBridgeGatewayClient.EventRejectedException && previousStatus != null) {
                try {
                    updateInstanceState(id, previousStatus, entity.getCurrentStatus());
                } catch (Exception stateError) {
                    e.addSuppressed(stateError);
                }
            }
            throw new AppException("Không gửi được yêu cầu " + action + ": " + e.getMessage(), e);
        }

        if ("TERMINATE".equals(action) || "DELETE".equals(action)) {
            if (migrationSchedulerClient != null) {
                migrationSchedulerClient.deleteDualSchedules(id);
            }
            if (entity.getScenarioId() != null && !entity.getScenarioId().isBlank()
                    && migrationScenariosTable != null) {
                try {
                    migrationScenariosTable.deleteItem(Key.builder().partitionValue(entity.getScenarioId()).build());
                } catch (Exception ex) {
                    log.warn("Failed to delete linked migration scenario [{}] for instance [{}]: {}",
                            entity.getScenarioId(), id, ex.getMessage());
                }
            }
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
        return mapToResponse(entity, activeNova);
    }

    public InstanceResponse mapToResponse(InstanceEntity entity, NovaEntity activeNova) {

        String regionCode = (activeNova != null && activeNova.getRegion() != null)
                ? activeNova.getRegion()
                : (entity.getCurrentRegion() != null ? entity.getCurrentRegion() : "ap-southeast-2");
        RegionType regionType = RegionType.fromCode(regionCode);

        String status;
        if (Boolean.TRUE.equals(entity.getMigrationLock()) || "MIGRATING".equalsIgnoreCase(entity.getCurrentStatus())) {
            status = InstanceStatus.MIGRATING.name();
        } else if ("TERMINATED".equalsIgnoreCase(entity.getCurrentStatus())
                || "DELETED".equalsIgnoreCase(entity.getCurrentStatus())) {
            status = InstanceStatus.TERMINATED.name();
        } else if ("FAILED".equalsIgnoreCase(entity.getCurrentStatus())) {
            status = InstanceStatus.FAILED.name();
        } else if ("STOPPING".equalsIgnoreCase(entity.getCurrentStatus())
                || "STARTING".equalsIgnoreCase(entity.getCurrentStatus())
                || "REBOOTING".equalsIgnoreCase(entity.getCurrentStatus())
                || "SHUTTING_DOWN".equalsIgnoreCase(entity.getCurrentStatus())) {
            status = entity.getCurrentStatus().toUpperCase(Locale.ROOT);
        } else if ("PENDING".equalsIgnoreCase(entity.getCurrentStatus()) && activeNova != null
                && ("SHUTOFF".equalsIgnoreCase(activeNova.getStatus())
                || "STOPPED".equalsIgnoreCase(activeNova.getStatus())
                || "SHELVED".equalsIgnoreCase(activeNova.getStatus())
                || "SHELVED_OFFLOADED".equalsIgnoreCase(activeNova.getStatus()))) {
            status = InstanceStatus.PENDING.name();
        } else if (entity.getActiveNovaId() == null || entity.getActiveNovaId().trim().isEmpty()) {
            status = InstanceStatus.PENDING.name();
        } else {
            String rawStatus = activeNova != null ? activeNova.getStatus() : entity.getCurrentStatus();
            if ("ACTIVE".equalsIgnoreCase(rawStatus)) {
                status = InstanceStatus.RUNNING.name();
            } else if ("SHUTOFF".equalsIgnoreCase(rawStatus) || "STOPPED".equalsIgnoreCase(rawStatus)
                    || "SHELVED".equalsIgnoreCase(rawStatus) || "SHELVED_OFFLOADED".equalsIgnoreCase(rawStatus)) {
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
                : entity.getPrivateIp();
        String elasticIp = (activeNova != null && activeNova.getElasticIp() != null)
                ? activeNova.getElasticIp()
                : entity.getElasticIp();
        String keyId = (activeNova != null && activeNova.getKeyId() != null)
                ? activeNova.getKeyId()
                : entity.getKeyId();
        String volumeId = (activeNova != null && activeNova.getVolumeId() != null)
                ? activeNova.getVolumeId()
                : entity.getVolumeId();
        String sgId = (activeNova != null && activeNova.getSecurityGroupId() != null)
                ? activeNova.getSecurityGroupId()
                : entity.getSecurityGroupId();

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
                .errorCode(entity.getFailureReason())
                .errorMessage(entity.getFailureMessage())
                .privateIp(privateIp)
                .publicIp(elasticIp)
                .publicDns(entity.getPublicDns())
                .securityGroup(entity.getSecurityGroup() != null ? entity.getSecurityGroup() : "sg-default")
                .scenarioId(entity.getScenarioId())
                .scenarioStatus(resolveScenarioStatus(entity))
                .dnsDomain((entity.getPublicDns() != null && !entity.getPublicDns().trim().isEmpty())
                        ? entity.getPublicDns()
                        : (entity.getDns() != null && !entity.getDns().trim().isEmpty())
                                ? entity.getDns()
                                : (instName != null ? instName.toLowerCase().replaceAll("[^a-z0-9.-]", "-") + ".xregion.net"
                                        : "app.xregion.net"))
                .imageId(entity.getImageId())
                .imageName(null)
                // SPEC-01: quản trị máy ảo chỉ qua SSH terminal, không còn Web VNC console.
                .consoleUrl(null)
                .createdAt(timestampMs)
                .updatedAt(timestampMs)
                .keyId(keyId)
                .keyName(keyId != null ? keyId : "xregion-key")
                .volumeId(volumeId)
                .requestedSizeGb(entity.getRequestedSizeGb())
                // Dung lượng đã xác nhận do Step Function ghi (confirmed_size_gb); nếu chưa có thì dùng
                // kích thước yêu cầu đã lưu, không dùng bộ nhớ tạm của tiến trình backend.
                .ebsSizeGb(entity.getConfirmedSizeGb() != null ? entity.getConfirmedSizeGb()
                        : entity.getRequestedSizeGb())
                .securityGroupId(sgId)
                .build();
    }
}
