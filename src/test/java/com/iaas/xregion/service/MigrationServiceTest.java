package com.iaas.xregion.service;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Client.Model.EventBridgeEventResponse;
import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Exceptions.ConflictException;
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
}
