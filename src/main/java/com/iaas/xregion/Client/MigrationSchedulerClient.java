package com.iaas.xregion.Client;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.scheduler.SchedulerClient;
import software.amazon.awssdk.services.scheduler.model.CreateScheduleRequest;
import software.amazon.awssdk.services.scheduler.model.DeleteScheduleRequest;
import software.amazon.awssdk.services.scheduler.model.FlexibleTimeWindow;
import software.amazon.awssdk.services.scheduler.model.FlexibleTimeWindowMode;
import software.amazon.awssdk.services.scheduler.model.GetScheduleRequest;
import software.amazon.awssdk.services.scheduler.model.GetScheduleResponse;
import software.amazon.awssdk.services.scheduler.model.ResourceNotFoundException;
import software.amazon.awssdk.services.scheduler.model.ScheduleState;
import software.amazon.awssdk.services.scheduler.model.Target;
import software.amazon.awssdk.services.scheduler.model.UpdateScheduleRequest;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class MigrationSchedulerClient {

    private static final String TIMEZONE = "Asia/Ho_Chi_Minh";
    private static final String TRIGGER_FUNCTION_NAME = "XRegion-ScheduledMigrationTrigger";
    private static final String INVOKE_ROLE_NAME = "XRegion-MigrationSchedulerInvokeRole";
    private static final List<String> REGIONS = List.of("ap-southeast-2", "us-east-1");

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, SchedulerClient> clients = new ConcurrentHashMap<>();

    @Value("${aws.scheduler.enabled:true}")
    private boolean enabled;

    @Value("${aws.accountId:291634989063}")
    private String accountId;

    @Value("${aws.accessKeyId:}")
    private String accessKeyId;

    @Value("${aws.secretAccessKey:}")
    private String secretAccessKey;

    public void upsertDualSchedules(String instanceId, String scenarioId, String sourceRegion,
                                    String destRegion, String dayTime, String nightTime, boolean active) {
        if (!enabled) {
            return;
        }
        String src = normalizeRegion(sourceRegion, "ap-southeast-2");
        String dst = normalizeRegion(destRegion, "us-east-1".equals(src) ? "ap-southeast-2" : "us-east-1");
        ScheduleState state = active ? ScheduleState.ENABLED : ScheduleState.DISABLED;

        // Schedule ở vùng nguồn hiện tại: chạy theo giờ bắt đầu của vùng đối ứng (nightTime)
        upsertOne(src, instanceId, scenarioId, dst, nightTime, state);
        // Schedule ở vùng đối ứng: chạy theo giờ bắt đầu của vùng A (dayTime)
        upsertOne(dst, instanceId, scenarioId, src, dayTime, state);
    }

    public void setSchedulesEnabled(String instanceId, boolean active) {
        if (!enabled) {
            return;
        }
        ScheduleState targetState = active ? ScheduleState.ENABLED : ScheduleState.DISABLED;
        for (String region : REGIONS) {
            String name = scheduleName(instanceId, region);
            SchedulerClient client = clientFor(region);
            try {
                GetScheduleResponse existing = client.getSchedule(GetScheduleRequest.builder().name(name).build());
                client.updateSchedule(UpdateScheduleRequest.builder()
                        .name(name)
                        .scheduleExpression(existing.scheduleExpression())
                        .scheduleExpressionTimezone(existing.scheduleExpressionTimezone())
                        .flexibleTimeWindow(existing.flexibleTimeWindow())
                        .target(existing.target())
                        .state(targetState)
                        .description(existing.description())
                        .build());
                log.info("Updated EventBridge Schedule [{}] in [{}] -> {}", name, region, targetState);
            } catch (ResourceNotFoundException ignored) {
                log.warn("EventBridge Schedule [{}] not found in [{}] during state toggle", name, region);
            }
        }
    }

    public void deleteDualSchedules(String instanceId) {
        if (!enabled || instanceId == null || instanceId.isBlank()) {
            return;
        }
        for (String region : REGIONS) {
            String name = scheduleName(instanceId, region);
            try {
                clientFor(region).deleteSchedule(DeleteScheduleRequest.builder().name(name).build());
                log.info("Deleted EventBridge Schedule [{}] in [{}]", name, region);
            } catch (ResourceNotFoundException ignored) {
                // Schedule already absent
            } catch (Exception e) {
                log.warn("Failed to delete EventBridge Schedule [{}] in [{}]: {}", name, region, e.getMessage());
            }
        }
    }

    private void upsertOne(String region, String instanceId, String scenarioId,
                           String destRegion, String hhMm, ScheduleState state) {
        String name = scheduleName(instanceId, region);
        String cron = toSchedulerCron(hhMm);
        String inputJson = buildPayload(instanceId, scenarioId, region, destRegion);
        Target target = Target.builder()
                .arn("arn:aws:lambda:" + region + ":" + accountId + ":function:" + TRIGGER_FUNCTION_NAME)
                .roleArn("arn:aws:iam::" + accountId + ":role/" + INVOKE_ROLE_NAME)
                .input(inputJson)
                .build();
        FlexibleTimeWindow window = FlexibleTimeWindow.builder().mode(FlexibleTimeWindowMode.OFF).build();
        String desc = "XRegion alternating migration for " + instanceId + " (" + region + " -> " + destRegion + ")";

        SchedulerClient client = clientFor(region);
        try {
            client.getSchedule(GetScheduleRequest.builder().name(name).build());
            client.updateSchedule(UpdateScheduleRequest.builder()
                    .name(name)
                    .scheduleExpression(cron)
                    .scheduleExpressionTimezone(TIMEZONE)
                    .flexibleTimeWindow(window)
                    .target(target)
                    .state(state)
                    .description(desc)
                    .build());
            log.info("Updated EventBridge Schedule [{}] in [{}]: {} ({}) [{}]", name, region, cron, TIMEZONE, state);
        } catch (ResourceNotFoundException missing) {
            client.createSchedule(CreateScheduleRequest.builder()
                    .name(name)
                    .scheduleExpression(cron)
                    .scheduleExpressionTimezone(TIMEZONE)
                    .flexibleTimeWindow(window)
                    .target(target)
                    .state(state)
                    .description(desc)
                    .build());
            log.info("Created EventBridge Schedule [{}] in [{}]: {} ({}) [{}]", name, region, cron, TIMEZONE, state);
        }
    }

    private String buildPayload(String instanceId, String scenarioId, String sourceRegion, String destRegion) {
        try {
            Map<String, String> payload = new LinkedHashMap<>();
            payload.put("instance_id", instanceId);
            payload.put("scenario_id", scenarioId);
            payload.put("expected_source_region", sourceRegion);
            payload.put("dest_region", destRegion);
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to serialize scheduler payload", e);
        }
    }

    static String toSchedulerCron(String hhMm) {
        String clean = hhMm == null ? "07:00" : hhMm.trim();
        String[] parts = clean.split(":");
        int hr = parts.length > 0 ? Math.max(0, Math.min(23, Integer.parseInt(parts[0].trim()))) : 7;
        int min = parts.length > 1 ? Math.max(0, Math.min(59, Integer.parseInt(parts[1].trim()))) : 0;
        return "cron(" + min + " " + hr + " * * ? *)";
    }

    static String scheduleName(String instanceId, String region) {
        return "xregion-mig-" + instanceId + "-" + region;
    }

    private static String normalizeRegion(String region, String fallback) {
        return (region == null || region.isBlank()) ? fallback : region.trim();
    }

    protected SchedulerClient clientFor(String region) {
        return clients.computeIfAbsent(region, r -> SchedulerClient.builder()
                .region(Region.of(r))
                .credentialsProvider(credentialsProvider())
                .build());
    }

    private AwsCredentialsProvider credentialsProvider() {
        if (accessKeyId != null && !accessKeyId.isBlank() && secretAccessKey != null && !secretAccessKey.isBlank()) {
            return StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKeyId.trim(), secretAccessKey.trim()));
        }
        return DefaultCredentialsProvider.create();
    }
}
