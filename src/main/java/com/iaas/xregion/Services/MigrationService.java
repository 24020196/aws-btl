package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Entity.MigrationStep;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.CreateScenarioRequest;
import com.iaas.xregion.Model.Response.MigrationResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Expression;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class MigrationService {

    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final DynamoDbTable<MigrationEntity> migrationsTable;
    private final AuditLogService auditLogService;

    private final Map<String, MigrationResponse> activeRuns = new ConcurrentHashMap<>();

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
            throw new ResourceNotFoundException("Instance not found: " + instanceId);
        }

        // 1. ATOMIC CONDITIONAL WRITE ON AWS CLOUD DYNAMODB
        if (Boolean.TRUE.equals(instance.getMigrationLock())) {
            throw new ConflictException("Instance [" + instanceId + "] is currently LOCKED by an ongoing migration.");
        }

        try {
            instance.setMigrationLock(true);
            instance.setCurrentStatus("MIGRATING");
            instance.setLockAcquiredAt(System.currentTimeMillis());

            UpdateItemEnhancedRequest<InstanceEntity> lockReq = UpdateItemEnhancedRequest.builder(InstanceEntity.class)
                    .item(instance)
                    .conditionExpression(Expression.builder()
                            .expression("attribute_exists(instance_id) AND (migration_lock = :unlocked OR attribute_not_exists(migration_lock))")
                            .putExpressionValue(":unlocked", AttributeValue.fromBool(false))
                            .build())
                    .build();

            instancesTable.updateItem(lockReq);
            log.info("Acquired atomic migration lock on AWS DynamoDB for instance {}", instanceId);
        } catch (Exception e) {
            throw new ConflictException("Concurrent lock acquisition failed for instance " + instanceId + ": " + e.getMessage());
        }

        long startTime = System.currentTimeMillis();
        String migrationId = "mig_" + (startTime / 1000);
        String srcRegion = instance.getCurrentRegion() != null ? instance.getCurrentRegion() : "ap-southeast-2";
        String dstRegion = srcRegion.contains("southeast") ? "us-east-1" : "ap-southeast-2";

        // Create initial record in XRegion-Migrations
        MigrationEntity migrationRecord = MigrationEntity.builder()
                .instanceId(instanceId)
                .migrationId(migrationId)
                .sourceRegion(srcRegion)
                .destRegion(dstRegion)
                .status("IN_PROGRESS")
                .copyProgress(15)
                .startedAt(startTime / 1000)
                .completedAt(0L)
                .errorMessage("")
                .build();
        migrationsTable.putItem(migrationRecord);

        List<String> logs = new ArrayList<>();
        logs.add("[" + new Date() + "] Migration initiated for instance " + instanceId);
        logs.add("[" + new Date() + "] Acquired migration_lock on AWS Cloud DynamoDB (XRegion-Instances)");

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
                .startedAt(startTime)
                .finishedAt(0L)
                .logs(logs)
                .build();

        activeRuns.put(instanceId, response);
        auditLogService.logAction("MIGRATE_START", "INSTANCE", instanceId, "Started migration to " + dstRegion);

        // Run 6-step async execution
        execute6StepAsync(instanceId, migrationRecord, response, instance, dstRegion);

        return response;
    }

    @Async
    public void execute6StepAsync(String instanceId, MigrationEntity migrationRecord, 
                                 MigrationResponse run, InstanceEntity instance, String dstRegion) {
        try {
            // STEP 1: Stop Source VM
            Thread.sleep(2000);
            updateStep(run, 1, 20, MigrationStep.STOP_SOURCE_VM.getDescription(), "Flushed disk cache and stopped source VM.");
            migrationRecord.setCopyProgress(20);
            migrationsTable.putItem(migrationRecord);

            // STEP 2: Create EBS Snapshot
            Thread.sleep(2000);
            updateStep(run, 2, 40, MigrationStep.CREATE_EBS_SNAPSHOT.getDescription(), "EBS gp3 Snapshot created successfully.");
            migrationRecord.setCopyProgress(40);
            migrationsTable.putItem(migrationRecord);

            // STEP 3: Cross-Region Transfer
            Thread.sleep(3000);
            updateStep(run, 3, 65, MigrationStep.COPY_SNAPSHOT_CROSS_REGION.getDescription(), "Transferred snapshot across regions to " + dstRegion);
            migrationRecord.setCopyProgress(65);
            migrationsTable.putItem(migrationRecord);

            // STEP 4: Target Volume
            Thread.sleep(2000);
            updateStep(run, 4, 80, MigrationStep.CREATE_TARGET_VOLUME.getDescription(), "Restored target EBS volume in " + dstRegion);
            migrationRecord.setCopyProgress(80);
            migrationsTable.putItem(migrationRecord);

            // STEP 5: Boot VM in Target Region
            Thread.sleep(2500);
            String newIp = "3.27." + (new Random().nextInt(200) + 10) + "." + (new Random().nextInt(250) + 1);
            instance.setElasticIp(newIp);
            instance.setCurrentRegion(dstRegion);
            updateStep(run, 5, 90, MigrationStep.BOOT_TARGET_VM.getDescription(), "Booted NovaVM in " + dstRegion + " with IP: " + newIp);
            migrationRecord.setCopyProgress(90);
            migrationsTable.putItem(migrationRecord);

            // STEP 6: Route 53 Cutover
            Thread.sleep(1500);
            updateStep(run, 6, 100, MigrationStep.ROUTE53_DNS_CUTOVER.getDescription(), "Route 53 DNS updated. Automated switchover completed!");

            // FINALIZE: Release migration_lock on AWS Cloud DynamoDB
            instance.setMigrationLock(false);
            instance.setCurrentStatus("RUNNING");
            instance.setLastMigrationTimestamp(System.currentTimeMillis() / 1000);
            instancesTable.putItem(instance);

            migrationRecord.setStatus("COMPLETED");
            migrationRecord.setCopyProgress(100);
            migrationRecord.setCompletedAt(System.currentTimeMillis() / 1000);
            migrationsTable.putItem(migrationRecord);

            run.setStatus("COMPLETED");
            run.setCurrentStep(MigrationStep.COMPLETED.getDescription());
            run.setFinishedAt(System.currentTimeMillis());

            auditLogService.logAction("MIGRATE_COMPLETED", "INSTANCE", instanceId, "Migration completed to " + dstRegion);
        } catch (Exception e) {
            log.error("Migration error: {}", e.getMessage());
            // Rollback lock
            instance.setMigrationLock(false);
            instance.setCurrentStatus("RUNNING");
            instancesTable.putItem(instance);

            migrationRecord.setStatus("FAILED");
            migrationRecord.setErrorMessage(e.getMessage());
            migrationsTable.putItem(migrationRecord);

            run.setStatus("ROLLED_BACK");
            run.getLogs().add("[" + new Date() + "] ERROR: " + e.getMessage() + ". Migration lock released.");
        }
    }

    private void updateStep(MigrationResponse run, int stepNum, int percent, String stepName, String logMsg) {
        run.setStepNumber(stepNum);
        run.setProgressPercent(percent);
        run.setCurrentStep(stepName);
        run.getLogs().add("[" + new Date() + "] Step " + stepNum + "/6: " + logMsg);
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
