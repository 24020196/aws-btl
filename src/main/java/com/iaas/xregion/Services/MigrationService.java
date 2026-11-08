package com.iaas.xregion.Services;

import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Entity.MigrationStep;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.CreateScenarioRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.MigrationResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class MigrationService {

    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final DynamoDbTable<MigrationEntity> migrationsTable;
    private final AuditLogService auditLogService;
    private final NetworkService networkService;

    private final Map<String, MigrationResponse> activeRuns = new ConcurrentHashMap<>();

    /** Trạng thái chuyển tiếp kiểu EC2: máy đang đổi trạng thái thì không được chuyển vùng. */
    private static final Set<String> TRANSITIONAL_STATES = Set.of("PENDING", "STOPPING", "SHUTTING_DOWN", "TERMINATING", "REBOOTING");

    /** Giống giá trị mặc định InstanceService trả về cho giao diện khi cooldown_seconds trống. */
    private static final int DEFAULT_COOLDOWN_SECONDS = 300;

    /** Khóa giữ quá lâu mà không có tiến trình nào chạy trong bộ nhớ = khóa treo (vd backend restart giữa chừng). */
    private static final long STALE_LOCK_SECONDS = 120;

    private String getCurrentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return "admin";
    }

    public List<Map<String, Object>> getAllScenarios() {
        String currentUser = getCurrentUsername();
        List<Map<String, Object>> scenarios = new ArrayList<>();
        try {
            Set<String> userInstanceIds = instancesTable.scan().items().stream()
                    .filter(i -> currentUser.equalsIgnoreCase(i.getUsername()))
                    .map(InstanceEntity::getInstanceId)
                    .collect(Collectors.toSet());

            List<MigrationEntity> migrations = migrationsTable.scan().items().stream()
                    .filter(m -> userInstanceIds.contains(m.getInstanceId()))
                    .collect(Collectors.toList());
            for (MigrationEntity m : migrations) {
                Map<String, Object> map = new HashMap<>();
                map.put("id", m.getMigrationId());
                map.put("name", "Migration " + m.getMigrationId());
                map.put("targetInstanceId", m.getInstanceId());
                map.put("sourceRegion", m.getSourceRegion());
                map.put("destRegion", m.getDestRegion());
                map.put("triggerType", "MANUAL");
                map.put("status", m.getStatus());
                map.put("progressPercent", m.getCopyProgress() != null ? m.getCopyProgress() : 100);
                map.put("cooldownMinutes", 5);
                scenarios.add(map);
            }
        } catch (Exception e) {
            log.error("Failed to read migration scenarios: {}", e.getMessage());
        }
        return scenarios;
    }

    public Map<String, Object> createScenario(CreateScenarioRequest request) {
        String id = "sc-" + UUID.randomUUID().toString().substring(0, 8);
        Map<String, Object> data = new HashMap<>();
        data.put("id", id);
        data.put("name", request.getName());
        data.put("targetInstanceId", request.getTargetInstanceId());
        data.put("sourceRegion", request.getSourceRegion());
        data.put("destRegion", request.getDestRegion());
        data.put("triggerType", request.getTriggerType());
        data.put("cronExpression", request.getCronExpression());
        data.put("cooldownMinutes", request.getCooldownMinutes());
        return data;
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
        if (instance == null || !currentUser.equalsIgnoreCase(instance.getUsername())) {
            throw new ResourceNotFoundException(msg(lang, "Không tìm thấy máy ảo " + instanceId + ".", "Instance not found: " + instanceId));
        }

        // 0. Chặn khi máy ảo đang ở trạng thái chuyển tiếp (PENDING, STOPPING, SHUTTING_DOWN...)
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

        // Create initial record in XRegion-Migrations (all timestamps in UTC Epoch Seconds)
        MigrationEntity migrationRecord = MigrationEntity.builder()
                .instanceId(instanceId)
                .migrationId(migrationId)
                .sourceRegion(srcRegion)
                .destRegion(dstRegion)
                .status("IN_PROGRESS")
                .copyProgress(15)
                .startedAt(startEpochSec)
                .completedAt(0L)
                .errorMessage("")
                .build();
        migrationsTable.putItem(migrationRecord);

        List<String> logs = new ArrayList<>();
        logs.add("[" + TimeSyncUtil.formatVietnamTime(startEpochMs) + "] Migration initiated for instance " + instanceId);
        logs.add("[" + TimeSyncUtil.formatVietnamTime(startEpochMs) + "] Acquired migration_lock on AWS Cloud DynamoDB (XRegion-Instances)");

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

        activeRuns.put(instanceId, response);
        auditLogService.logAction("MIGRATE_START", "INSTANCE", instanceId, "Started migration to " + dstRegion);

        // Run 6-step execution on a background thread so the API returns immediately
        // and the dashboard can poll /progress for real-time logs.
        // (@Async has no effect when called from inside the same class, so we start the thread explicitly.)
        final String runInstanceId = instanceId;
        CompletableFuture.runAsync(() -> execute6StepAsync(runInstanceId, migrationRecord, response, instance, dstRegion));

        return response;
    }

    public void execute6StepAsync(String instanceId, MigrationEntity migrationRecord, 
                                 MigrationResponse run, InstanceEntity instance, String dstRegion) {
        try {
            // STEP 1: Stop Source VM
            Thread.sleep(2000);
            updateStep(run, 1, 20, MigrationStep.STOP_SOURCE_VM.getDescription(), "Flushed disk cache and stopped source VM.");
            long sourceStoppedMs = TimeSyncUtil.nowEpochMillis();
            migrationRecord.setCopyProgress(20);
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);

            // STEP 2: Create EBS Snapshot
            Thread.sleep(2000);
            String snapshotId = newSnapshotId();
            String volumeId = instance.getVolumeId() != null && !instance.getVolumeId().isBlank() ? instance.getVolumeId() : null;
            updateStep(run, 2, 40, MigrationStep.CREATE_EBS_SNAPSHOT.getDescription(),
                    "EBS gp3 snapshot " + snapshotId + (volumeId != null ? " of " + volumeId : "") + " created in " + migrationRecord.getSourceRegion() + ".");
            migrationRecord.setSnapshotId(snapshotId);
            migrationRecord.setVolumeId(volumeId);
            migrationRecord.setCopyProgress(40);
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);

            // STEP 3: Cross-Region Transfer
            Thread.sleep(3000);
            String destSnapshotId = newSnapshotId();
            updateStep(run, 3, 65, MigrationStep.COPY_SNAPSHOT_CROSS_REGION.getDescription(),
                    "Copied " + snapshotId + " to " + dstRegion + " as " + destSnapshotId + ".");
            migrationRecord.setDestSnapshotId(destSnapshotId);
            migrationRecord.setCopyProgress(65);
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);

            // STEP 4: Target Volume
            Thread.sleep(2000);
            updateStep(run, 4, 80, MigrationStep.CREATE_TARGET_VOLUME.getDescription(), "Restored target EBS volume in " + dstRegion);
            migrationRecord.setCopyProgress(80);
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);

            // STEP 5: Boot VM in Target Region
            Thread.sleep(2500);
            // Elastic IP thuộc dải public của vùng đích: Sydney 3.27.x.x, N. Virginia 54.85.x.x
            String eipPrefix = dstRegion.contains("southeast") ? "3.27." : "54.85.";
            String newIp = eipPrefix + (new Random().nextInt(200) + 10) + "." + (new Random().nextInt(250) + 1);
            // Private IP mới nằm trong subnet của vùng đích (cùng quy tắc với InstanceService khi tạo máy)
            String newPrivateIp = (dstRegion.contains("southeast") ? "10.0.1." : "10.1.1.") + (100 + new Random().nextInt(150));
            instance.setElasticIp(newIp);
            instance.setPrivateIp(newPrivateIp);
            instance.setCurrentRegion(dstRegion);
            updateStep(run, 5, 90, MigrationStep.BOOT_TARGET_VM.getDescription(), "Booted NovaVM in " + dstRegion + " with IP: " + newIp);
            migrationRecord.setCopyProgress(90);
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);

            // STEP 6: Route 53 Cutover
            Thread.sleep(1500);
            String domain = (instance.getDns() != null && !instance.getDns().trim().isEmpty())
                    ? instance.getDns().trim()
                    : (instance.getInstanceName() != null ? instance.getInstanceName().toLowerCase() : instanceId) + ".xregion.net";
            UpdateDnsRequest dnsRequest = new UpdateDnsRequest();
            dnsRequest.setDomainName(domain);
            dnsRequest.setTargetIp(newIp);
            dnsRequest.setTtl(60);
            networkService.updateDnsRecord(dnsRequest);
            updateStep(run, 6, 100, MigrationStep.ROUTE53_DNS_CUTOVER.getDescription(), "Route 53 A record " + domain + " -> " + newIp + " (TTL 60s). Automated switchover completed!");

            // FINALIZE: Release migration_lock on AWS Cloud DynamoDB (store UTC Epoch Seconds)
            long completedSec = TimeSyncUtil.nowEpochSeconds();
            long completedMs = TimeSyncUtil.nowEpochMillis();
            long downtimeSec = Math.max(1, Math.round((completedMs - sourceStoppedMs) / 1000.0));
            run.getLogs().add("[" + TimeSyncUtil.formatVietnamTime(completedMs) + "] Released migration_lock. Downtime (RTO) = " + downtimeSec + "s.");

            instance.setMigrationLock(false);
            instance.setCurrentStatus("RUNNING");
            instancesTable.putItem(instance);

            migrationRecord.setStatus("COMPLETED");
            migrationRecord.setCopyProgress(100);
            migrationRecord.setCompletedAt(completedSec);
            migrationRecord.setDowntimeSeconds(downtimeSec);
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);

            run.setStatus("COMPLETED");
            run.setCurrentStep(MigrationStep.COMPLETED.getDescription());
            run.setFinishedAt(completedMs);

            auditLogService.logAction("MIGRATE_COMPLETED", "INSTANCE", instanceId, "Migration completed to " + dstRegion);
        } catch (Exception e) {
            log.error("Migration error: {}", e.getMessage());
            // Rollback lock
            instance.setMigrationLock(false);
            instance.setCurrentStatus("RUNNING");
            instancesTable.putItem(instance);

            run.setStatus("ROLLED_BACK");
            run.getLogs().add("[" + TimeSyncUtil.formatVietnamTime(TimeSyncUtil.nowEpochMillis()) + "] ERROR: " + e.getMessage() + ". Migration lock released.");

            migrationRecord.setStatus("FAILED");
            migrationRecord.setErrorMessage(e.getMessage());
            migrationRecord.setCompletedAt(TimeSyncUtil.nowEpochSeconds());
            migrationRecord.setStepLogs(new ArrayList<>(run.getLogs()));
            migrationsTable.putItem(migrationRecord);
        }
    }

    private static String newSnapshotId() {
        return "snap-" + UUID.randomUUID().toString().replace("-", "").substring(0, 17);
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
                .collect(Collectors.toMap(InstanceEntity::getInstanceId, i -> i, (a, b) -> a, LinkedHashMap::new));
        if (instanceId != null && mine.isEmpty()) {
            throw new ResourceNotFoundException("Instance not found: " + instanceId);
        }
        List<MigrationEntity> all = new ArrayList<>();
        mine.keySet().forEach(id -> all.addAll(findMigrations(id)));
        return snapshotsOf(all, mine);
    }

    private void updateStep(MigrationResponse run, int stepNum, int percent, String stepName, String logMsg) {
        run.setStepNumber(stepNum);
        run.setProgressPercent(percent);
        run.setCurrentStep(stepName);
        run.getLogs().add("[" + TimeSyncUtil.formatVietnamTime(TimeSyncUtil.nowEpochMillis()) + "] Step " + stepNum + "/6: " + logMsg);
    }

    /** Thời điểm giữ migration_lock (ms): ưu tiên cột lock_acquired_at, không có thì lấy giờ bắt đầu lần chuyển vùng đang chạy. */
    private Long lockSince(InstanceEntity instance, List<MigrationEntity> migrations) {
        if (instance.getLockAcquiredAt() != null && instance.getLockAcquiredAt() > 0) {
            return TimeSyncUtil.toEpochMillis(instance.getLockAcquiredAt());
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
        MigrationResponse run = activeRuns.get(instance.getInstanceId());
        return run == null || !"IN_PROGRESS".equals(run.getStatus());
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
        return migrationsTable.query(QueryConditional.keyEqualTo(Key.builder().partitionValue(instanceId).build()))
                .items().stream()
                .collect(Collectors.toList());
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
        if (instance == null || !currentUser.equalsIgnoreCase(instance.getUsername())) {
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

    public MigrationResponse getProgress(String instanceId) {
        MigrationResponse run = activeRuns.get(instanceId);
        if (run != null) return run;

        return MigrationResponse.builder()
                .instanceId(instanceId)
                .status("IDLE")
                .currentStep("Ready")
                .progressPercent(0)
                .logs(Collections.singletonList("System idle. Ready for migration."))
                .build();
    }
}
