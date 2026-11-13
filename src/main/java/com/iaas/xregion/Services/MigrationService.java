package com.iaas.xregion.Services;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Client.MigrationSchedulerClient;
import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Entity.MigrationScenarioEntity;
import com.iaas.xregion.Entity.MigrationStep;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.CreateScenarioRequest;
import com.iaas.xregion.Model.Response.MigrationResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Expression;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class MigrationService {

    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final DynamoDbTable<MigrationEntity> migrationsTable;
    private final AuditLogService auditLogService;
    private final EventBridgeGatewayClient eventBridgeGatewayClient;
    private final NovaLookup novaLookup;

    @Autowired(required = false)
    private DynamoDbTable<MigrationScenarioEntity> migrationScenariosTable;

    @Autowired(required = false)
    private AuthService authService;

    @Autowired(required = false)
    private MigrationSchedulerClient migrationSchedulerClient;

    public void setMigrationScenariosTable(DynamoDbTable<MigrationScenarioEntity> migrationScenariosTable) {
        this.migrationScenariosTable = migrationScenariosTable;
    }

    public void setMigrationSchedulerClient(MigrationSchedulerClient migrationSchedulerClient) {
        this.migrationSchedulerClient = migrationSchedulerClient;
    }

    /** Trạng thái chuyển tiếp kiểu EC2: máy đang đổi trạng thái thì không được chuyển vùng. */
    private static final Set<String> TRANSITIONAL_STATES = Set.of("PENDING", "STOPPING", "SHUTTING_DOWN", "TERMINATING", "REBOOTING");

    /** Giống giá trị mặc định InstanceService trả về cho giao diện khi cooldown_seconds trống (SPEC-03: 300s). */
    private static final int DEFAULT_COOLDOWN_SECONDS = 300;

    /** Khóa giữ quá 900s (khớp Timeout Step Function MigrateInstance) = khóa treo (SPEC-03 / SPEC-SF-08). */
    private static final long STALE_LOCK_SECONDS = 900;

    private String getCurrentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return "admin";
    }

    private boolean isOwner(InstanceEntity inst, String currentUser) {
        if (inst == null || currentUser == null) {
            return false;
        }
        if ("admin".equalsIgnoreCase(currentUser)) {
            return true;
        }
        if (currentUser.equalsIgnoreCase(inst.getUsername())) {
            return true;
        }
        if (authService != null && inst.getUserId() != null) {
            try {
                UserEntity user = authService.findUserByUsername(currentUser);
                if (user != null && user.getUserId() != null && user.getUserId().equalsIgnoreCase(inst.getUserId())) {
                    return true;
                }
            } catch (Exception e) {
                log.debug("Auth service user check failed for [{}]: {}", currentUser, e.getMessage());
            }
        }
        return false;
    }

    public List<Map<String, Object>> getAllScenarios() {
        String currentUser = getCurrentUsername();
        List<Map<String, Object>> scenarios = new ArrayList<>();
        if (migrationScenariosTable == null) {
            return scenarios;
        }
        try {
            List<InstanceEntity> userInstances = instancesTable.scan().items().stream()
                    .filter(i -> isOwner(i, currentUser))
                    .filter(i -> i.getScenarioId() != null && !i.getScenarioId().isBlank())
                    .collect(Collectors.toList());

            for (InstanceEntity inst : userInstances) {
                MigrationScenarioEntity scen = migrationScenariosTable.getItem(
                        Key.builder().partitionValue(inst.getScenarioId()).build());
                if (scen != null) {
                    autoPauseScenarioIfMigrating(inst, scen);
                    scenarios.add(toScenarioMap(scen, inst));
                }
            }
        } catch (Exception e) {
            log.error("Failed to read migration scenarios: {}", e.getMessage());
        }
        return scenarios;
    }

    public Map<String, Object> getScenarioByInstanceId(String instanceId) {
        String currentUser = getCurrentUsername();
        InstanceEntity inst = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        if (inst == null || !isOwner(inst, currentUser)) {
            throw new ResourceNotFoundException("Instance not found: " + instanceId);
        }
        if (inst.getScenarioId() == null || inst.getScenarioId().isBlank() || migrationScenariosTable == null) {
            return null;
        }
        MigrationScenarioEntity scen = migrationScenariosTable.getItem(
                Key.builder().partitionValue(inst.getScenarioId()).build());
        if (scen == null) {
            return null;
        }
        autoPauseScenarioIfMigrating(inst, scen);
        return toScenarioMap(scen, inst);
    }

    public Map<String, Object> createScenario(CreateScenarioRequest request) {
        String currentUser = getCurrentUsername();
        InstanceEntity inst = instancesTable.getItem(Key.builder().partitionValue(request.getTargetInstanceId()).build());
        if (inst == null || !isOwner(inst, currentUser)) {
            throw new ResourceNotFoundException("Instance not found: " + request.getTargetInstanceId());
        }
        if (migrationScenariosTable == null) {
            throw new IllegalStateException("MigrationScenarios table is not configured");
        }

        String scenarioId = (inst.getScenarioId() != null && !inst.getScenarioId().isBlank())
                ? inst.getScenarioId()
                : UUID.randomUUID().toString();

        MigrationScenarioEntity existing = (inst.getScenarioId() != null && !inst.getScenarioId().isBlank())
                ? migrationScenariosTable.getItem(Key.builder().partitionValue(inst.getScenarioId()).build())
                : null;

        if (isActivelyMigrating(inst)) {
            autoPauseScenarioIfMigrating(inst, existing);
            throw new ConflictException(
                    "Máy ảo [" + inst.getInstanceId() + "] đang chuyển vùng (MIGRATING). Không thể tạo hoặc kích hoạt kịch bản chuyển vùng lúc này.");
        }

        if (existing != null && "ACTIVE".equalsIgnoreCase(existing.getStatus())) {
            throw new ConflictException(
                    "Kịch bản chuyển vùng của máy [" + inst.getInstanceId()
                            + "] đang kích hoạt (ACTIVE). Hãy tạm dừng kịch bản trước khi chỉnh sửa.");
        }

        long remainingCooldown = getRemainingCooldownSeconds(inst, findMigrations(inst.getInstanceId()));
        if (remainingCooldown > 0) {
            throw new ConflictException(
                    "Máy ảo [" + inst.getInstanceId() + "] đang trong thời gian Cooldown bảo vệ. Vui lòng đợi thêm "
                            + remainingCooldown + " giây trước khi chỉnh sửa kịch bản.");
        }

        String status = "PAUSED".equalsIgnoreCase(request.getStatus()) ? "PAUSED" : "ACTIVE";
        String scenarioName = (request.getName() != null && !request.getName().isBlank())
                ? request.getName().trim()
                : null;
        MigrationScenarioEntity entity = MigrationScenarioEntity.builder()
                .scenarioId(scenarioId)
                .name(scenarioName)
                .status(status)
                .triggerType(request.getTriggerType() != null && !request.getTriggerType().isBlank()
                        ? request.getTriggerType().trim().toUpperCase(Locale.ROOT)
                        : "SCHEDULED")
                .dayTime(request.getDayTime() != null ? request.getDayTime().trim() : "07:00")
                .nightTime(request.getNightTime() != null ? request.getNightTime().trim() : "19:00")
                .cronExpression(request.getCronExpression() != null ? request.getCronExpression().trim() : "0 7,19 * * *")
                .cooldownMinutes(request.getCooldownMinutes() > 0 ? request.getCooldownMinutes() : 60)
                .updatedAt(TimeSyncUtil.nowEpochSeconds())
                .build();

        migrationScenariosTable.putItem(entity);

        if (!scenarioId.equals(inst.getScenarioId())) {
            InstanceEntity patch = new InstanceEntity();
            patch.setInstanceId(inst.getInstanceId());
            patch.setScenarioId(scenarioId);
            instancesTable.updateItem(UpdateItemEnhancedRequest.builder(InstanceEntity.class)
                    .item(patch)
                    .ignoreNulls(true)
                    .build());
            inst.setScenarioId(scenarioId);
        }

        if (migrationSchedulerClient != null) {
            String srcRegion = inst.getCurrentRegion() != null ? inst.getCurrentRegion() : "ap-southeast-2";
            String dstRegion = "ap-southeast-2".equals(srcRegion) ? "us-east-1" : "ap-southeast-2";
            migrationSchedulerClient.upsertDualSchedules(
                    inst.getInstanceId(),
                    scenarioId,
                    srcRegion,
                    dstRegion,
                    entity.getDayTime(),
                    entity.getNightTime(),
                    "ACTIVE".equalsIgnoreCase(status));
        }

        return toScenarioMap(entity, inst);
    }

    public Map<String, Object> toggleScenarioStatus(String scenarioId, String requestedStatus) {
        String currentUser = getCurrentUsername();
        if (migrationScenariosTable == null) {
            throw new IllegalStateException("MigrationScenarios table is not configured");
        }
        InstanceEntity ownerInst = instancesTable.scan().items().stream()
                .filter(i -> isOwner(i, currentUser) && scenarioId.equals(i.getScenarioId()))
                .findFirst()
                .orElseThrow(() -> new ResourceNotFoundException("Scenario not found: " + scenarioId));

        MigrationScenarioEntity scen = migrationScenariosTable.getItem(
                Key.builder().partitionValue(scenarioId).build());
        if (scen == null) {
            throw new ResourceNotFoundException("Scenario not found: " + scenarioId);
        }

        String nextStatus;
        if (requestedStatus != null && !requestedStatus.isBlank()) {
            String upper = requestedStatus.trim().toUpperCase(Locale.ROOT);
            if (!"ACTIVE".equals(upper) && !"PAUSED".equals(upper)) {
                throw new IllegalArgumentException("Invalid scenario status: " + requestedStatus);
            }
            nextStatus = upper;
        } else {
            nextStatus = "ACTIVE".equalsIgnoreCase(scen.getStatus()) ? "PAUSED" : "ACTIVE";
        }

        if ("ACTIVE".equalsIgnoreCase(nextStatus)) {
            if (isActivelyMigrating(ownerInst)) {
                autoPauseScenarioIfMigrating(ownerInst, scen);
                throw new ConflictException(
                        "Máy ảo [" + ownerInst.getInstanceId()
                                + "] đang chuyển vùng (MIGRATING). Không thể kích hoạt kịch bản chuyển vùng lúc này.");
            }
            long remainingCooldown = getRemainingCooldownSeconds(ownerInst, findMigrations(ownerInst.getInstanceId()));
            if (remainingCooldown > 0) {
                throw new ConflictException(
                        "Máy ảo [" + ownerInst.getInstanceId() + "] đang trong thời gian Cooldown bảo vệ. Vui lòng đợi thêm "
                                + remainingCooldown + " giây trước khi kích hoạt kịch bản.");
            }
        }

        scen.setStatus(nextStatus);
        scen.setUpdatedAt(TimeSyncUtil.nowEpochSeconds());
        migrationScenariosTable.putItem(scen);

        if (migrationSchedulerClient != null) {
            migrationSchedulerClient.setSchedulesEnabled(ownerInst.getInstanceId(), "ACTIVE".equalsIgnoreCase(nextStatus));
        }

        return toScenarioMap(scen, ownerInst);
    }

    private boolean isActivelyMigrating(InstanceEntity inst) {
        if (inst == null) {
            return false;
        }
        if ("MIGRATING".equalsIgnoreCase(inst.getCurrentStatus())) {
            return true;
        }
        return Boolean.TRUE.equals(inst.getMigrationLock()) && !isLockStale(inst);
    }

    private void autoPauseScenarioIfMigrating(InstanceEntity inst, MigrationScenarioEntity scen) {
        if (scen == null || !isActivelyMigrating(inst) || !"ACTIVE".equalsIgnoreCase(scen.getStatus())) {
            return;
        }
        scen.setStatus("PAUSED");
        scen.setUpdatedAt(TimeSyncUtil.nowEpochSeconds());
        migrationScenariosTable.putItem(scen);
        if (migrationSchedulerClient != null) {
            try {
                migrationSchedulerClient.setSchedulesEnabled(inst.getInstanceId(), false);
            } catch (Exception e) {
                log.warn("Failed to disable EventBridge schedules while auto-pausing scenario [{}] for [{}]: {}",
                        scen.getScenarioId(), inst.getInstanceId(), e.getMessage());
            }
        }
        log.info("Auto-paused ACTIVE scenario [{}] because instance [{}] is MIGRATING",
                scen.getScenarioId(), inst.getInstanceId());
    }

    private Map<String, Object> toScenarioMap(MigrationScenarioEntity scen, InstanceEntity inst) {
        String srcRegion = inst.getCurrentRegion() != null ? inst.getCurrentRegion() : "ap-southeast-2";
        String dstRegion = "ap-southeast-2".equals(srcRegion) ? "us-east-1" : "ap-southeast-2";
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", scen.getScenarioId());
        map.put("scenarioId", scen.getScenarioId());
        map.put("name", scen.getName());
        map.put("targetInstanceId", inst.getInstanceId());
        map.put("sourceRegion", srcRegion);
        map.put("destRegion", dstRegion);
        map.put("triggerType", scen.getTriggerType());
        map.put("dayTime", scen.getDayTime());
        map.put("nightTime", scen.getNightTime());
        map.put("cronExpression", scen.getCronExpression());
        map.put("cooldownMinutes", scen.getCooldownMinutes());
        map.put("status", scen.getStatus());
        map.put("updatedAt", scen.getUpdatedAt());
        return map;
    }

    public MigrationResponse triggerMigration(String targetId) {
        return triggerMigration(targetId, "vi");
    }

    /** Chọn câu thông báo theo ngôn ngữ giao diện (?lang=en|vi), mặc định tiếng Việt. */
    private static String msg(String lang, String vi, String en) {
        return "en".equalsIgnoreCase(lang) ? en : vi;
    }

    public MigrationResponse triggerMigration(String targetId, String lang) {
        String instanceId = targetId;
        if (targetId.startsWith("sc-") || targetId.startsWith("mig_")) {
            // Find instance from existing migrations
            instanceId = migrationsTable.scan().items().stream()
                    .filter(m -> targetId.equals(m.getMigrationId()))
                    .map(MigrationEntity::getInstanceId)
                    .findFirst()
                    .orElse("i-0a3f9c21e7b4d5810");
        }

        String currentUser = getCurrentUsername();
        InstanceEntity instance = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        novaLookup.fill(instance);
        if (!isOwner(instance, currentUser)) {
            throw new ResourceNotFoundException(msg(lang, "Không tìm thấy máy ảo " + instanceId + ".", "Instance not found: " + instanceId));
        }

        if (instance.getScenarioId() != null && !instance.getScenarioId().isBlank() && migrationScenariosTable != null) {
            MigrationScenarioEntity scen = migrationScenariosTable.getItem(
                    Key.builder().partitionValue(instance.getScenarioId()).build());
            if (scen != null && "ACTIVE".equalsIgnoreCase(scen.getStatus())) {
                throw new ConflictException(msg(lang,
                        "Máy ảo [" + instanceId + "] đang kích hoạt kịch bản chuyển vùng tự động (ACTIVE). Hãy tạm dừng kịch bản trước khi chuyển vùng bằng tay.",
                        "Instance [" + instanceId + "] has an ACTIVE migration scenario. Pause the scenario before manual migration."));
            }
        }

        // 0. Chặn khi máy ảo đang ở trạng thái chuyển tiếp hoặc đã xóa (hỗ trợ đầy đủ linux_nat_v1)
        String status = instance.getCurrentStatus() != null ? instance.getCurrentStatus().toUpperCase(Locale.ROOT) : "";
        if ("TERMINATED".equals(status) || "TERMINATING".equals(status)) {
            throw new ConflictException(msg(lang,
                    "Máy ảo [" + instanceId + "] đã bị xóa (" + status + "), không thể chuyển vùng.",
                    "Instance [" + instanceId + "] is " + status + " and cannot be migrated."));
        }
        if (TRANSITIONAL_STATES.contains(status)) {
            throw new ConflictException(msg(lang,
                    "Máy ảo [" + instanceId + "] đang ở trạng thái " + status + ". Hãy đợi máy chuyển sang RUNNING hoặc STOPPED rồi mới chuyển vùng.",
                    "Instance [" + instanceId + "] is " + status + ". Wait until it is RUNNING or STOPPED before migrating."));
        }

        // 1. ATOMIC CONDITIONAL WRITE ON AWS CLOUD DYNAMODB
        if (Boolean.TRUE.equals(instance.getMigrationLock())) {
            if (isLockStale(instance)) {
                releaseStaleLock(instance);
            } else {
                throw new ConflictException(msg(lang,
                        "Máy ảo [" + instanceId + "] đang có một lần chuyển vùng chạy (migration_lock đang khóa). Mở trang chi tiết máy ảo, tab Chuyển vùng, để xem tiến trình.",
                        "A migration is already running for instance [" + instanceId + "] (migration_lock is held). Open the instance's Migration tab to follow it."));
            }
        }

        // Kiểm tra thời gian Cooldown nếu máy ảo đã từng thực hiện chuyển vùng trước đó
        long remainingCooldown = getRemainingCooldownSeconds(instance, findMigrations(instanceId));
        if (remainingCooldown > 0) {
            throw new ConflictException(msg(lang,
                    "Máy ảo [" + instanceId + "] đang trong thời gian Cooldown bảo vệ. Vui lòng đợi thêm " + remainingCooldown + " giây.",
                    "Instance [" + instanceId + "] is in its cooldown period. Try again in " + remainingCooldown + " seconds."));
        }

        long startEpochSec = TimeSyncUtil.nowEpochSeconds();
        long startEpochMs = TimeSyncUtil.nowEpochMillis();

        try {
            instance.setMigrationLock(true);
            instance.setCurrentStatus("MIGRATING");
            instance.setLastMigrationTimestamp(startEpochSec);

            UpdateItemEnhancedRequest<InstanceEntity> lockReq = UpdateItemEnhancedRequest.builder(InstanceEntity.class)
                    .item(instance)
                    .conditionExpression(Expression.builder()
                            .expression("attribute_exists(instance_id) AND (migration_lock = :unlocked OR attribute_not_exists(migration_lock))")
                            .putExpressionValue(":unlocked", AttributeValue.fromBool(false))
                            .build())
                    .build();

            instancesTable.updateItem(lockReq);
            log.info("Acquired atomic migration lock on AWS DynamoDB for instance {} at epochSec={}", instanceId, startEpochSec);
        } catch (Exception e) {
            log.warn("Concurrent lock acquisition failed for instance {}: {}", instanceId, e.getMessage());
            throw new ConflictException(msg(lang,
                    "Không giữ được migration_lock cho máy ảo " + instanceId + " (có yêu cầu khác vừa chuyển vùng máy này).",
                    "Could not acquire migration_lock for instance " + instanceId + " (another request just started a migration)."));
        }

        String migrationId = "mig_" + startEpochSec;
        String srcRegion = instance.getCurrentRegion() != null ? instance.getCurrentRegion() : "ap-southeast-2";
        String dstRegion = srcRegion.contains("southeast") ? "us-east-1" : "ap-southeast-2";
        String sourceVolumeId = (instance.getEbsVolumeId() != null && !instance.getEbsVolumeId().isBlank())
                ? instance.getEbsVolumeId()
                : instance.getVolumeId();

        List<String> logs = new ArrayList<>();
        logs.add("[" + TimeSyncUtil.formatVietnamTime(startEpochMs) + "] Migration initiated for instance " + instanceId);
        logs.add("[" + TimeSyncUtil.formatVietnamTime(startEpochMs) + "] Acquired migration_lock on AWS Cloud DynamoDB (XRegion-Instances)");

        // Create initial record in XRegion-Migrations (all timestamps in UTC Epoch Seconds)
        MigrationEntity migrationRecord = MigrationEntity.builder()
                .instanceId(instanceId)
                .migrationId(migrationId)
                .sourceRegion(srcRegion)
                .destRegion(dstRegion)
                .volumeId(sourceVolumeId)
                .status("IN_PROGRESS")
                .copyProgress(15)
                .startedAt(startEpochSec)
                .completedAt(0L)
                .errorMessage("")
                .stepLogs(new ArrayList<>(logs))
                .build();
        migrationsTable.putItem(migrationRecord);

        // Phát sự kiện thật qua API Gateway (SigV4) theo sourceRegion để kích hoạt Step Function MigrateInstance (SPEC-SF-08)
        try {
            eventBridgeGatewayClient.sendMigrationEvent(
                    migrationId,
                    instanceId,
                    instance.getActiveNovaId(),
                    sourceVolumeId,
                    srcRegion,
                    dstRegion,
                    "START",
                    "IN_PROGRESS",
                    15
            );
            logs.add("[" + TimeSyncUtil.formatVietnamTime(TimeSyncUtil.nowEpochMillis())
                    + "] Dispatched migration event to API Gateway (" + srcRegion + ") for Step Function MigrateInstance.");
        } catch (Exception e) {
            log.error("Failed to dispatch migration event for instance {} ({}): {}", instanceId, migrationId, e.getMessage(), e);
            logs.add("[" + TimeSyncUtil.formatVietnamTime(TimeSyncUtil.nowEpochMillis())
                    + "] WARNING: Event dispatch error (" + e.getMessage() + "). Retaining migration_lock for 900s stale-lock recovery.");
            migrationRecord.setErrorMessage("Event dispatch error: " + e.getMessage());
        }
        migrationRecord.setStepLogs(new ArrayList<>(logs));
        migrationsTable.putItem(migrationRecord);

        MigrationResponse response = MigrationResponse.builder()
                .scenarioId(migrationId)
                .scenarioName("Live Migration " + migrationId)
                .instanceId(instanceId)
                .instanceName(instance.getInstanceName() != null ? instance.getInstanceName() : instanceId)
                .sourceRegion(srcRegion)
                .destRegion(dstRegion)
                .currentStep(MigrationStep.STOP_SOURCE_VM.getDescription())
                .stepNumber(1)
                .progressPercent(15)
                .status("IN_PROGRESS")
                .startedAt(startEpochMs)
                .finishedAt(0L)
                .logs(logs)
                .build();

        auditLogService.logAction("MIGRATE_START", "INSTANCE", instanceId, "Started migration to " + dstRegion);

        return response;
    }

    /** Một dòng snapshot cho API (giống cột của bảng Snapshots trên AWS). */
    private Map<String, Object> snapshotRow(String snapshotId, String region, MigrationEntity m, InstanceEntity inst, String description, String sourceSnapshotId) {
        Map<String, Object> row = new LinkedHashMap<>();
        boolean failed = "FAILED".equalsIgnoreCase(m.getStatus());
        row.put("snapshotId", snapshotId);
        row.put("region", region);
        row.put("volumeId", m.getVolumeId());
        row.put("instanceId", m.getInstanceId());
        row.put("instanceName", inst != null && inst.getInstanceName() != null ? inst.getInstanceName() : m.getInstanceId());
        row.put("migrationId", m.getMigrationId());
        row.put("sourceSnapshotId", sourceSnapshotId);
        row.put("description", description);
        row.put("state", failed ? "error" : "completed");
        row.put("startedAt", m.getStartedAt() != null && m.getStartedAt() > 0 ? TimeSyncUtil.toEpochMillis(m.getStartedAt()) : 0L);
        return row;
    }

    private List<Map<String, Object>> snapshotsOf(List<MigrationEntity> migrations, Map<String, InstanceEntity> instances) {
        List<Map<String, Object>> rows = new ArrayList<>();
        migrations.stream()
                .sorted(Comparator.comparing((MigrationEntity m) -> m.getStartedAt() != null ? TimeSyncUtil.toEpochSeconds(m.getStartedAt()) : 0L).reversed())
                .forEach(m -> {
                    InstanceEntity inst = instances.get(m.getInstanceId());
                    if (m.getDestSnapshotId() != null) {
                        rows.add(snapshotRow(m.getDestSnapshotId(), m.getDestRegion(), m, inst,
                                "Copied for " + m.getMigrationId() + " from " + m.getSourceRegion(), m.getSnapshotId()));
                    }
                    if (m.getSnapshotId() != null) {
                        rows.add(snapshotRow(m.getSnapshotId(), m.getSourceRegion(), m, inst,
                                "Created for " + m.getMigrationId(), null));
                    }
                });
        return rows;
    }

    /** Snapshot sinh ra từ các lần chuyển vùng; instanceId = null nghĩa là mọi máy của người dùng hiện tại. */
    public List<Map<String, Object>> getSnapshots(String instanceId) {
        String currentUser = getCurrentUsername();
        Map<String, InstanceEntity> mine = instancesTable.scan().items().stream()
                .filter(i -> currentUser.equalsIgnoreCase(i.getUsername()))
                .filter(i -> instanceId == null || instanceId.equals(i.getInstanceId()))
                .peek(novaLookup::fill)
                .collect(Collectors.toMap(InstanceEntity::getInstanceId, i -> i, (a, b) -> a, LinkedHashMap::new));
        if (instanceId != null && mine.isEmpty()) {
            throw new ResourceNotFoundException("Instance not found: " + instanceId);
        }
        List<MigrationEntity> all = new ArrayList<>();
        mine.keySet().forEach(id -> all.addAll(findMigrations(id)));
        return snapshotsOf(all, mine);
    }

    /** Thời điểm giữ migration_lock (ms): ưu tiên cột lock_acquired_at, không có thì lấy last_migration_timestamp hoặc giờ bắt đầu lần chuyển vùng đang chạy. */
    private Long lockSince(InstanceEntity instance, List<MigrationEntity> migrations) {
        if (instance.getLockAcquiredAt() != null && instance.getLockAcquiredAt() > 0) {
            return TimeSyncUtil.toEpochMillis(instance.getLockAcquiredAt());
        }
        if (instance.getLastMigrationTimestamp() != null && instance.getLastMigrationTimestamp() > 0) {
            return TimeSyncUtil.toEpochMillis(instance.getLastMigrationTimestamp());
        }
        return migrations.stream()
                .filter(m -> "IN_PROGRESS".equalsIgnoreCase(m.getStatus()) && m.getStartedAt() != null && m.getStartedAt() > 0)
                .map(m -> TimeSyncUtil.toEpochMillis(m.getStartedAt()))
                .max(Long::compare)
                .orElse(null);
    }

    private boolean isLockStale(InstanceEntity instance) {
        if (!Boolean.TRUE.equals(instance.getMigrationLock())) {
            return false;
        }
        Long acquiredMs = lockSince(instance, findMigrations(instance.getInstanceId()));
        if (acquiredMs == null) {
            return true;
        }
        return (TimeSyncUtil.nowEpochMillis() - acquiredMs) >= STALE_LOCK_SECONDS * 1000L;
    }

    /** Nhả khóa treo và đánh dấu các bản ghi IN_PROGRESS bị bỏ dở là FAILED. */
    private void releaseStaleLock(InstanceEntity instance) {
        String instanceId = instance.getInstanceId();
        log.warn("Releasing stale migration_lock on instance {}", instanceId);
        instance.setMigrationLock(false);
        if ("MIGRATING".equalsIgnoreCase(instance.getCurrentStatus())) {
            instance.setCurrentStatus("RUNNING");
        }
        instancesTable.putItem(instance);

        long nowSec = TimeSyncUtil.nowEpochSeconds();
        findMigrations(instanceId).stream()
                .filter(m -> "IN_PROGRESS".equalsIgnoreCase(m.getStatus()))
                .forEach(m -> {
                    m.setStatus("FAILED");
                    m.setCompletedAt(nowSec);
                    m.setErrorMessage("Tiến trình bị gián đoạn (backend khởi động lại), khóa đã được giải phóng tự động.");
                    migrationsTable.putItem(m);
                });
        auditLogService.logAction("MIGRATE_LOCK_RECOVERED", "INSTANCE", instanceId, "Released stale migration_lock");
    }

    private List<MigrationEntity> findMigrations(String instanceId) {
        if (migrationsTable == null) {
            return List.of();
        }
        var pages = migrationsTable.query(QueryConditional.keyEqualTo(Key.builder().partitionValue(instanceId).build()));
        if (pages == null) {
            return List.of();
        }
        return pages.items().stream().collect(Collectors.toList());
    }

    private int effectiveCooldown(InstanceEntity instance) {
        return DEFAULT_COOLDOWN_SECONDS;
    }

    private long getRemainingCooldownSeconds(InstanceEntity instance, List<MigrationEntity> migrations) {
        Optional<Long> lastCompletedSec = migrations.stream()
                .filter(m -> "COMPLETED".equalsIgnoreCase(m.getStatus()) && m.getCompletedAt() != null && m.getCompletedAt() > 0)
                .map(m -> TimeSyncUtil.toEpochSeconds(m.getCompletedAt()))
                .max(Long::compareTo);
        return lastCompletedSec
                .map(sec -> TimeSyncUtil.getRemainingCooldownSeconds(sec, effectiveCooldown(instance)))
                .orElse(0L);
    }

    /**
     * Lịch sử chuyển vùng của một máy ảo (mới nhất trước) kèm trạng thái migration_lock và cooldown còn lại.
     * Mọi mốc thời gian trả về là Epoch Milliseconds để Dashboard dùng trực tiếp với new Date(ms).
     */
    public Map<String, Object> getHistory(String instanceId) {
        String currentUser = getCurrentUsername();
        InstanceEntity instance = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        novaLookup.fill(instance);
        if (!isOwner(instance, currentUser)) {
            throw new ResourceNotFoundException("Instance not found: " + instanceId);
        }

        List<MigrationEntity> migrations = findMigrations(instanceId);
        List<Map<String, Object>> history = migrations.stream()
                .sorted(Comparator.comparing((MigrationEntity m) -> m.getStartedAt() != null ? TimeSyncUtil.toEpochSeconds(m.getStartedAt()) : 0L).reversed())
                .map(m -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    boolean finished = m.getCompletedAt() != null && m.getCompletedAt() > 0;
                    long startedMs = m.getStartedAt() != null && m.getStartedAt() > 0 ? TimeSyncUtil.toEpochMillis(m.getStartedAt()) : 0L;
                    long completedMs = finished ? TimeSyncUtil.toEpochMillis(m.getCompletedAt()) : 0L;
                    row.put("migrationId", m.getMigrationId());
                    row.put("sourceRegion", m.getSourceRegion());
                    row.put("destRegion", m.getDestRegion());
                    row.put("startedAt", startedMs);
                    row.put("completedAt", completedMs);
                    row.put("durationSeconds", finished && startedMs > 0 ? Math.max(0, (completedMs - startedMs) / 1000) : null);
                    row.put("status", m.getStatus());
                    row.put("progressPercent", m.getCopyProgress() != null ? m.getCopyProgress() : 0);
                    row.put("errorMessage", m.getErrorMessage() != null && !m.getErrorMessage().isBlank() ? m.getErrorMessage() : null);
                    row.put("downtimeSeconds", m.getDowntimeSeconds());
                    row.put("logs", m.getStepLogs() != null ? m.getStepLogs() : Collections.emptyList());
                    return row;
                })
                .collect(Collectors.toList());

        int cooldown = effectiveCooldown(instance);
        long remaining = getRemainingCooldownSeconds(instance, migrations);
        String status = instance.getCurrentStatus() != null ? instance.getCurrentStatus().toUpperCase(Locale.ROOT) : "";

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("instanceId", instanceId);
        result.put("currentRegion", instance.getCurrentRegion());
        result.put("currentStatus", status);
        result.put("migrationLock", Boolean.TRUE.equals(instance.getMigrationLock()));
        result.put("lockStale", isLockStale(instance));
        result.put("lockAcquiredAt", Boolean.TRUE.equals(instance.getMigrationLock()) ? lockSince(instance, migrations) : null);
        result.put("cooldownSeconds", cooldown);
        OptionalDouble avgRto = migrations.stream()
                .filter(m -> m.getDowntimeSeconds() != null && m.getDowntimeSeconds() > 0)
                .mapToLong(MigrationEntity::getDowntimeSeconds).average();
        result.put("expectedDowntimeSeconds", avgRto.isPresent() ? Math.round(avgRto.getAsDouble()) : null);
        result.put("cooldownRemainingSeconds", remaining);
        result.put("transitional", TRANSITIONAL_STATES.contains(status));
        result.put("serverTime", TimeSyncUtil.nowEpochMillis());
        result.put("history", history);
        return result;
    }

    /**
     * Tóm tắt chuyển vùng của mọi máy ảo thuộc người dùng hiện tại, cho trang Tổng quan:
     * số lần thành công/thất bại/đang chạy, lần gần nhất, các máy đang giữ migration_lock, RTO trung bình.
     */
    public Map<String, Object> getSummary() {
        String currentUser = getCurrentUsername();
        Map<String, InstanceEntity> mine = instancesTable.scan().items().stream()
                .filter(i -> currentUser.equalsIgnoreCase(i.getUsername()))
                .filter(i -> !"TERMINATED".equalsIgnoreCase(i.getCurrentStatus()))
                .peek(novaLookup::fill)
                .collect(Collectors.toMap(InstanceEntity::getInstanceId, i -> i, (a, b) -> a, LinkedHashMap::new));

        List<MigrationEntity> all = new ArrayList<>();
        mine.keySet().forEach(id -> all.addAll(findMigrations(id)));

        long completed = all.stream().filter(m -> "COMPLETED".equalsIgnoreCase(m.getStatus())).count();
        long failed = all.stream().filter(m -> "FAILED".equalsIgnoreCase(m.getStatus())).count();
        long inProgress = all.stream().filter(m -> "IN_PROGRESS".equalsIgnoreCase(m.getStatus())).count();
        OptionalDouble avgDowntime = all.stream()
                .filter(m -> m.getDowntimeSeconds() != null && m.getDowntimeSeconds() > 0)
                .mapToLong(MigrationEntity::getDowntimeSeconds).average();

        Map<String, Object> latest = all.stream()
                .filter(m -> m.getStartedAt() != null && m.getStartedAt() > 0)
                .max(Comparator.comparing((MigrationEntity m) -> TimeSyncUtil.toEpochSeconds(m.getStartedAt())))
                .map(m -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    InstanceEntity inst = mine.get(m.getInstanceId());
                    boolean finished = m.getCompletedAt() != null && m.getCompletedAt() > 0;
                    row.put("migrationId", m.getMigrationId());
                    row.put("instanceId", m.getInstanceId());
                    row.put("instanceName", inst != null && inst.getInstanceName() != null ? inst.getInstanceName() : m.getInstanceId());
                    row.put("sourceRegion", m.getSourceRegion());
                    row.put("destRegion", m.getDestRegion());
                    row.put("status", m.getStatus());
                    row.put("startedAt", TimeSyncUtil.toEpochMillis(m.getStartedAt()));
                    row.put("completedAt", finished ? TimeSyncUtil.toEpochMillis(m.getCompletedAt()) : 0L);
                    row.put("downtimeSeconds", m.getDowntimeSeconds());
                    return row;
                })
                .orElse(null);

        List<Map<String, Object>> locked = mine.values().stream()
                .filter(i -> Boolean.TRUE.equals(i.getMigrationLock()))
                .map(i -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("instanceId", i.getInstanceId());
                    row.put("instanceName", i.getInstanceName());
                    row.put("currentRegion", i.getCurrentRegion());
                    row.put("lockAcquiredAt", lockSince(i, findMigrations(i.getInstanceId())));
                    row.put("stale", isLockStale(i));
                    return row;
                })
                .collect(Collectors.toList());

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("snapshotCount", all.stream()
                .mapToLong(m -> (m.getSnapshotId() != null ? 1 : 0) + (m.getDestSnapshotId() != null ? 1 : 0)).sum());
        result.put("total", all.size());
        result.put("completed", completed);
        result.put("failed", failed);
        result.put("inProgress", inProgress);
        result.put("successRate", completed + failed > 0 ? Math.round(completed * 1000.0 / (completed + failed)) / 10.0 : null);
        result.put("avgDowntimeSeconds", avgDowntime.isPresent() ? Math.round(avgDowntime.getAsDouble() * 10) / 10.0 : null);
        result.put("latest", latest);
        result.put("locked", locked);
        result.put("serverTime", TimeSyncUtil.nowEpochMillis());
        return result;
    }

    /**
     * Đọc tiến độ chuyển vùng mới nhất trực tiếp từ bảng DynamoDB XRegion-Migrations (SPEC-03).
     */
    public MigrationResponse getProgress(String instanceId) {
        Optional<MigrationEntity> latestOpt = findMigrations(instanceId).stream()
                .max(Comparator.comparing((MigrationEntity m) ->
                        m.getStartedAt() != null ? TimeSyncUtil.toEpochSeconds(m.getStartedAt()) : 0L));

        if (latestOpt.isEmpty()) {
            return MigrationResponse.builder()
                    .instanceId(instanceId)
                    .status("IDLE")
                    .currentStep("Ready")
                    .progressPercent(0)
                    .logs(Collections.singletonList("System idle. Ready for migration."))
                    .build();
        }

        MigrationEntity latest = latestOpt.get();
        String status = latest.getStatus() != null ? latest.getStatus().toUpperCase(Locale.ROOT) : "IN_PROGRESS";
        int progress = latest.getCopyProgress() != null
                ? latest.getCopyProgress()
                : ("COMPLETED".equals(status) ? 100 : 0);
        long startedMs = latest.getStartedAt() != null && latest.getStartedAt() > 0
                ? TimeSyncUtil.toEpochMillis(latest.getStartedAt())
                : 0L;
        long finishedMs = latest.getCompletedAt() != null && latest.getCompletedAt() > 0
                ? TimeSyncUtil.toEpochMillis(latest.getCompletedAt())
                : 0L;

        String stepDesc;
        int stepNum;
        if ("COMPLETED".equals(status)) {
            stepDesc = MigrationStep.COMPLETED.getDescription();
            stepNum = MigrationStep.COMPLETED.getStepNumber();
        } else if ("FAILED".equals(status) || "ROLLED_BACK".equals(status)) {
            stepDesc = MigrationStep.ROLLED_BACK.getDescription();
            stepNum = MigrationStep.ROLLED_BACK.getStepNumber();
        } else {
            stepDesc = MigrationStep.STOP_SOURCE_VM.getDescription();
            stepNum = 1;
        }

        List<String> logs = latest.getStepLogs() != null && !latest.getStepLogs().isEmpty()
                ? latest.getStepLogs()
                : (latest.getErrorMessage() != null && !latest.getErrorMessage().isBlank()
                ? Collections.singletonList(latest.getErrorMessage())
                : Collections.emptyList());

        return MigrationResponse.builder()
                .scenarioId(latest.getMigrationId())
                .scenarioName("Live Migration " + latest.getMigrationId())
                .instanceId(instanceId)
                .sourceRegion(latest.getSourceRegion())
                .destRegion(latest.getDestRegion())
                .currentStep(stepDesc)
                .stepNumber(stepNum)
                .progressPercent(progress)
                .status(status)
                .startedAt(startedMs)
                .finishedAt(finishedMs)
                .logs(logs)
                .build();
    }
}
