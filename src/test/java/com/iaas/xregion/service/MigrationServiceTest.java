package com.iaas.xregion.service;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Client.MigrationSchedulerClient;
import com.iaas.xregion.Client.Model.EventBridgeEventResponse;
import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Entity.MigrationScenarioEntity;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Model.Request.CreateScenarioRequest;
import com.iaas.xregion.Model.Response.MigrationResponse;
import com.iaas.xregion.Services.AuditLogService;
import com.iaas.xregion.Services.MigrationService;
import com.iaas.xregion.Services.NovaLookup;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import software.amazon.awssdk.core.pagination.sync.SdkIterable;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;

import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class MigrationServiceTest {

    private DynamoDbTable<InstanceEntity> instances;
    private DynamoDbTable<MigrationEntity> migrations;
    private AuditLogService auditLogService;
    private EventBridgeGatewayClient gatewayClient;
    private NovaLookup novaLookup;
    private MigrationService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        instances = mock(DynamoDbTable.class);
        migrations = mock(DynamoDbTable.class);
        auditLogService = mock(AuditLogService.class);
        gatewayClient = mock(EventBridgeGatewayClient.class);
        novaLookup = mock(NovaLookup.class);
        service = new MigrationService(instances, migrations, auditLogService, gatewayClient, novaLookup);
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("user", "unused", List.of()));
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @SuppressWarnings("unchecked")
    private void stubMigrations(List<MigrationEntity> items) {
        PageIterable<MigrationEntity> pageIterable = mock(PageIterable.class);
        SdkIterable<MigrationEntity> sdkIterable = () -> items.iterator();
        when(pageIterable.items()).thenReturn(sdkIterable);
        when(migrations.query(any(QueryConditional.class))).thenReturn(pageIterable);
    }

    @Test
    @SuppressWarnings("unchecked")
    void natMigrationDispatchesEventWithNovaAndVolumeIds() {
        InstanceEntity instance = InstanceEntity.builder()
                .instanceId("i-nat1")
                .instanceName("nat-vm")
                .username("user")
                .currentStatus("RUNNING")
                .currentRegion("ap-southeast-2")
                .networkMode("linux_nat_v1")
                .activeNovaId("nova-uuid-123")
                .volumeId("vol-abc123")
                .migrationLock(false)
                .build();
        when(instances.getItem(any(Key.class))).thenReturn(instance);
        stubMigrations(List.of());
        when(gatewayClient.sendMigrationEvent(anyString(), anyString(), any(), any(), anyString(), anyString(), anyString(), anyString(), anyInt()))
                .thenReturn(new EventBridgeEventResponse());

        MigrationResponse res = service.triggerMigration("i-nat1", "vi");

        assertThat(res.getStatus()).isEqualTo("IN_PROGRESS");
        assertThat(res.getSourceRegion()).isEqualTo("ap-southeast-2");
        assertThat(res.getDestRegion()).isEqualTo("us-east-1");
        assertThat(res.getProgressPercent()).isEqualTo(15);

        verify(instances).updateItem(any(UpdateItemEnhancedRequest.class));
        verify(migrations, times(2)).putItem(any(MigrationEntity.class));
        verify(gatewayClient).sendMigrationEvent(
                startsWith("mig_"),
                eq("i-nat1"),
                eq("nova-uuid-123"),
                eq("vol-abc123"),
                eq("ap-southeast-2"),
                eq("us-east-1"),
                eq("START"),
                eq("IN_PROGRESS"),
                eq(15)
        );
    }

    @Test
    void activeLockWithin900sThrowsConflict() {
        long nowSec = TimeSyncUtil.nowEpochSeconds();
        InstanceEntity instance = InstanceEntity.builder()
                .instanceId("i-locked")
                .username("user")
                .currentStatus("MIGRATING")
                .migrationLock(true)
                .lastMigrationTimestamp(nowSec - 120)
                .build();
        when(instances.getItem(any(Key.class))).thenReturn(instance);
        stubMigrations(List.of());

        assertThatThrownBy(() -> service.triggerMigration("i-locked", "en"))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("migration_lock");

        verifyNoInteractions(gatewayClient);
    }

    @Test
    @SuppressWarnings("unchecked")
    void staleLockOver900sIsRecoveredAndDispatchesNewMigration() {
        long nowSec = TimeSyncUtil.nowEpochSeconds();
        InstanceEntity instance = InstanceEntity.builder()
                .instanceId("i-stale")
                .username("user")
                .currentStatus("MIGRATING")
                .currentRegion("ap-southeast-2")
                .activeNovaId("nova-stale")
                .volumeId("vol-stale")
                .migrationLock(true)
                .lockAcquiredAt(nowSec - 950)
                .build();
        MigrationEntity oldInProgress = MigrationEntity.builder()
                .instanceId("i-stale")
                .migrationId("mig_old")
                .status("IN_PROGRESS")
                .startedAt(nowSec - 950)
                .build();
        when(instances.getItem(any(Key.class))).thenReturn(instance);
        stubMigrations(List.of(oldInProgress));
        when(gatewayClient.sendMigrationEvent(anyString(), anyString(), any(), any(), anyString(), anyString(), anyString(), anyString(), anyInt()))
                .thenReturn(new EventBridgeEventResponse());

        MigrationResponse res = service.triggerMigration("i-stale", "vi");

        assertThat(res.getStatus()).isEqualTo("IN_PROGRESS");
        assertThat(oldInProgress.getStatus()).isEqualTo("FAILED");
        verify(instances).putItem(instance);
        verify(instances).updateItem(any(UpdateItemEnhancedRequest.class));
        verify(gatewayClient).sendMigrationEvent(
                startsWith("mig_"),
                eq("i-stale"),
                eq("nova-stale"),
                eq("vol-stale"),
                eq("ap-southeast-2"),
                eq("us-east-1"),
                eq("START"),
                eq("IN_PROGRESS"),
                eq(15)
        );
    }

    @Test
    void cooldownWithin300sThrowsConflict() {
        long nowSec = TimeSyncUtil.nowEpochSeconds();
        InstanceEntity instance = InstanceEntity.builder()
                .instanceId("i-cool")
                .username("user")
                .currentStatus("RUNNING")
                .migrationLock(false)
                .build();
        MigrationEntity recentCompleted = MigrationEntity.builder()
                .instanceId("i-cool")
                .migrationId("mig_prev")
                .status("COMPLETED")
                .startedAt(nowSec - 180)
                .completedAt(nowSec - 60)
                .build();
        when(instances.getItem(any(Key.class))).thenReturn(instance);
        stubMigrations(List.of(recentCompleted));

        assertThatThrownBy(() -> service.triggerMigration("i-cool", "en"))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("cooldown");

        verifyNoInteractions(gatewayClient);
    }

    @Test
    void getProgressReadsLatestRecordFromDynamoDb() {
        MigrationEntity older = MigrationEntity.builder()
                .instanceId("i-prog")
                .migrationId("mig_1")
                .sourceRegion("ap-southeast-2")
                .destRegion("us-east-1")
                .status("FAILED")
                .copyProgress(40)
                .startedAt(1000L)
                .completedAt(1050L)
                .stepLogs(List.of("old failure"))
                .build();
        MigrationEntity newer = MigrationEntity.builder()
                .instanceId("i-prog")
                .migrationId("mig_2")
                .sourceRegion("ap-southeast-2")
                .destRegion("us-east-1")
                .status("COMPLETED")
                .copyProgress(100)
                .startedAt(2000L)
                .completedAt(2045L)
                .stepLogs(List.of("Step 5/5 completed"))
                .build();
        stubMigrations(List.of(older, newer));

        MigrationResponse progress = service.getProgress("i-prog");

        assertThat(progress.getScenarioId()).isEqualTo("mig_2");
        assertThat(progress.getStatus()).isEqualTo("COMPLETED");
        assertThat(progress.getProgressPercent()).isEqualTo(100);
        assertThat(progress.getLogs()).containsExactly("Step 5/5 completed");
    }

    @Test
    @SuppressWarnings("unchecked")
    void getScenarioByInstanceIdReturnsNullWhenUnlinked() {
        DynamoDbTable<MigrationScenarioEntity> scenarios = mock(DynamoDbTable.class);
        service.setMigrationScenariosTable(scenarios);

        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-new12345")
                .username("user")
                .scenarioId(null)
                .build();
        when(instances.getItem(Key.builder().partitionValue("i-new12345").build())).thenReturn(inst);

        assertThat(service.getScenarioByInstanceId("i-new12345")).isNull();
        verifyNoInteractions(scenarios);
    }

    @Test
    @SuppressWarnings("unchecked")
    void createScenarioPersistsUuidAndLinksForeignKeyOnInstance() {
        DynamoDbTable<MigrationScenarioEntity> scenarios = mock(DynamoDbTable.class);
        service.setMigrationScenariosTable(scenarios);

        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-scen1234")
                .username("user")
                .currentRegion("ap-southeast-2")
                .build();
        when(instances.getItem(Key.builder().partitionValue("i-scen1234").build())).thenReturn(inst);

        CreateScenarioRequest req = new CreateScenarioRequest();
        req.setName("Night-Shift");
        req.setTargetInstanceId("i-scen1234");
        req.setSourceRegion("ap-southeast-2");
        req.setDestRegion("us-east-1");
        req.setDayTime("07:00");
        req.setNightTime("19:00");
        req.setCronExpression("0 7,19 * * *");
        req.setCooldownMinutes(60);

        var saved = service.createScenario(req);

        String scenarioId = (String) saved.get("scenarioId");
        assertThat(scenarioId).hasSize(36);
        assertThat(saved.get("name")).isEqualTo("Night-Shift");
        assertThat(saved.get("status")).isEqualTo("ACTIVE");
        verify(scenarios).putItem(argThat((MigrationScenarioEntity s) ->
                scenarioId.equals(s.getScenarioId()) && "Night-Shift".equals(s.getName())));
        verify(instances).updateItem(any(UpdateItemEnhancedRequest.class));
    }

    @Test
    @SuppressWarnings("unchecked")
    void toggleScenarioStatusUpdatesToPaused() {
        DynamoDbTable<MigrationScenarioEntity> scenarios = mock(DynamoDbTable.class);
        service.setMigrationScenariosTable(scenarios);

        String uuid = "123e4567-e89b-12d3-a456-426614174000";
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-tog1234")
                .username("user")
                .currentRegion("ap-southeast-2")
                .scenarioId(uuid)
                .build();
        PageIterable<InstanceEntity> instPage = mock(PageIterable.class);
        SdkIterable<InstanceEntity> instIterable = () -> List.of(inst).iterator();
        when(instPage.items()).thenReturn(instIterable);
        when(instances.scan()).thenReturn(instPage);

        MigrationScenarioEntity existing = MigrationScenarioEntity.builder()
                .scenarioId(uuid)
                .name("Day-Night")
                .status("ACTIVE")
                .triggerType("SCHEDULED")
                .build();
        when(scenarios.getItem(Key.builder().partitionValue(uuid).build())).thenReturn(existing);

        var updated = service.toggleScenarioStatus(uuid, "PAUSED");

        assertThat(updated.get("status")).isEqualTo("PAUSED");
        verify(scenarios).putItem(argThat((MigrationScenarioEntity s) ->
                uuid.equals(s.getScenarioId()) && "PAUSED".equals(s.getStatus())));
    }

    @Test
    void triggerMigrationPrefersEbsVolumeIdOverCinderVolumeId() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-ebs1234")
                .username("user")
                .currentStatus("RUNNING")
                .currentRegion("us-east-1")
                .activeNovaId("nova-ebs-1")
                .volumeId("34076713-4bbc-4952-ad8c-d0ad1286143c")
                .ebsVolumeId("vol-0122838c50783ea01")
                .migrationLock(false)
                .build();
        when(instances.getItem(Key.builder().partitionValue("i-ebs1234").build())).thenReturn(inst);
        stubMigrations(List.of());

        service.triggerMigration("i-ebs1234", "vi");

        verify(gatewayClient).sendMigrationEvent(
                anyString(),
                eq("i-ebs1234"),
                eq("nova-ebs-1"),
                eq("vol-0122838c50783ea01"),
                eq("us-east-1"),
                eq("ap-southeast-2"),
                eq("START"),
                eq("IN_PROGRESS"),
                eq(15)
        );
    }

    @Test
    @SuppressWarnings("unchecked")
    void createScenarioCreatesDualSchedulesAndBlocksEditWhileActive() {
        DynamoDbTable<MigrationScenarioEntity> scenTable = mock(DynamoDbTable.class);
        MigrationSchedulerClient schedulerClient = mock(MigrationSchedulerClient.class);
        service.setMigrationScenariosTable(scenTable);
        service.setMigrationSchedulerClient(schedulerClient);

        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-scen-1")
                .username("user")
                .currentRegion("ap-southeast-2")
                .currentStatus("RUNNING")
                .build();
        when(instances.getItem(Key.builder().partitionValue("i-scen-1").build())).thenReturn(inst);

        CreateScenarioRequest req = new CreateScenarioRequest();
        req.setTargetInstanceId("i-scen-1");
        req.setDayTime("07:00");
        req.setNightTime("19:00");
        req.setStatus("ACTIVE");

        var saved = service.createScenario(req);
        String scenId = String.valueOf(saved.get("scenarioId"));
        verify(schedulerClient).upsertDualSchedules(
                eq("i-scen-1"), eq(scenId), eq("ap-southeast-2"), eq("us-east-1"), eq("07:00"), eq("19:00"), eq(true));

        when(scenTable.getItem(Key.builder().partitionValue(scenId).build()))
                .thenReturn(MigrationScenarioEntity.builder().scenarioId(scenId).status("ACTIVE").build());
        assertThatThrownBy(() -> service.createScenario(req))
                .isInstanceOf(ConflictException.class);
        assertThatThrownBy(() -> service.triggerMigration("i-scen-1", "vi"))
                .isInstanceOf(ConflictException.class);
    }

    @Test
    @SuppressWarnings("unchecked")
    void toggleScenarioStatusUpdatesDualSchedulesState() {
        DynamoDbTable<MigrationScenarioEntity> scenTable = mock(DynamoDbTable.class);
        MigrationSchedulerClient schedulerClient = mock(MigrationSchedulerClient.class);
        service.setMigrationScenariosTable(scenTable);
        service.setMigrationSchedulerClient(schedulerClient);

        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-scen-2")
                .username("user")
                .scenarioId("scen-2")
                .currentRegion("us-east-1")
                .build();
        PageIterable<InstanceEntity> pages = mock(PageIterable.class);
        SdkIterable<InstanceEntity> sdk = List.of(inst)::iterator;
        when(pages.items()).thenReturn(sdk);
        when(instances.scan()).thenReturn(pages);
        when(scenTable.getItem(Key.builder().partitionValue("scen-2").build()))
                .thenReturn(MigrationScenarioEntity.builder().scenarioId("scen-2").status("ACTIVE").build());

        var res = service.toggleScenarioStatus("scen-2", "PAUSED");
        assertThat(res.get("status")).isEqualTo("PAUSED");
        verify(schedulerClient).setSchedulesEnabled("i-scen-2", false);
    }

    @Test
    @SuppressWarnings("unchecked")
    void scenarioEditAndActivateBlockedDuringCooldownButPauseAllowed() {
        DynamoDbTable<MigrationScenarioEntity> scenTable = mock(DynamoDbTable.class);
        service.setMigrationScenariosTable(scenTable);

        long nowSec = java.time.Instant.now().getEpochSecond();
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-cd-1")
                .username("user")
                .scenarioId("scen-cd")
                .currentRegion("ap-southeast-2")
                .lastMigrationTimestamp(nowSec - 10)
                .build();
        when(instances.getItem(Key.builder().partitionValue("i-cd-1").build())).thenReturn(inst);
        PageIterable<MigrationEntity> migPages = mock(PageIterable.class);
        MigrationEntity completedMig = MigrationEntity.builder()
                .instanceId("i-cd-1")
                .migrationId("mig-cd-1")
                .status("COMPLETED")
                .completedAt(nowSec - 10)
                .build();
        when(migPages.items()).thenReturn(List.of(completedMig)::iterator);
        when(migrations.query(any(QueryConditional.class))).thenReturn(migPages);
        PageIterable<InstanceEntity> pages = mock(PageIterable.class);
        SdkIterable<InstanceEntity> sdk = List.of(inst)::iterator;
        when(pages.items()).thenReturn(sdk);
        when(instances.scan()).thenReturn(pages);
        when(scenTable.getItem(Key.builder().partitionValue("scen-cd").build()))
                .thenReturn(MigrationScenarioEntity.builder().scenarioId("scen-cd").status("PAUSED").build());

        CreateScenarioRequest req = new CreateScenarioRequest();
        req.setTargetInstanceId("i-cd-1");
        assertThatThrownBy(() -> service.createScenario(req))
                .isInstanceOf(ConflictException.class);

        assertThatThrownBy(() -> service.toggleScenarioStatus("scen-cd", "ACTIVE"))
                .isInstanceOf(ConflictException.class);

        var paused = service.toggleScenarioStatus("scen-cd", "PAUSED");
        assertThat(paused.get("status")).isEqualTo("PAUSED");
    }

    @Test
    @SuppressWarnings("unchecked")
    void scenarioAutoPausesAndBlocksActivationWhileMigrating() {
        DynamoDbTable<MigrationScenarioEntity> scenTable = mock(DynamoDbTable.class);
        MigrationSchedulerClient schedulerClient = mock(MigrationSchedulerClient.class);
        service.setMigrationScenariosTable(scenTable);
        service.setMigrationSchedulerClient(schedulerClient);

        long nowSec = java.time.Instant.now().getEpochSecond();
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-mig-1")
                .username("user")
                .scenarioId("scen-mig")
                .currentStatus("MIGRATING")
                .migrationLock(true)
                .lastMigrationTimestamp(nowSec - 15)
                .currentRegion("ap-southeast-2")
                .build();
        when(instances.getItem(Key.builder().partitionValue("i-mig-1").build())).thenReturn(inst);

        MigrationScenarioEntity activeScen = MigrationScenarioEntity.builder()
                .scenarioId("scen-mig")
                .status("ACTIVE")
                .build();
        when(scenTable.getItem(Key.builder().partitionValue("scen-mig").build())).thenReturn(activeScen);

        // 1. Reading scenario while MIGRATING auto-pauses ACTIVE -> PAUSED and disables schedules
        var fetched = service.getScenarioByInstanceId("i-mig-1");
        assertThat(fetched.get("status")).isEqualTo("PAUSED");
        verify(scenTable).putItem(argThat((MigrationScenarioEntity s) ->
                "scen-mig".equals(s.getScenarioId()) && "PAUSED".equals(s.getStatus())));
        verify(schedulerClient).setSchedulesEnabled("i-mig-1", false);

        // 2. Creating/editing scenario while MIGRATING throws ConflictException
        CreateScenarioRequest req = new CreateScenarioRequest();
        req.setTargetInstanceId("i-mig-1");
        assertThatThrownBy(() -> service.createScenario(req))
                .isInstanceOf(ConflictException.class);

        // 3. Activating scenario while MIGRATING throws ConflictException
        PageIterable<InstanceEntity> pages = mock(PageIterable.class);
        SdkIterable<InstanceEntity> sdk = List.of(inst)::iterator;
        when(pages.items()).thenReturn(sdk);
        when(instances.scan()).thenReturn(pages);
        assertThatThrownBy(() -> service.toggleScenarioStatus("scen-mig", "ACTIVE"))
                .isInstanceOf(ConflictException.class);
    }
}
