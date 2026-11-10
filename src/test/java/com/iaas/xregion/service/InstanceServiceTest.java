package com.iaas.xregion.service;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.InstanceStatus;
import com.iaas.xregion.Entity.NovaEntity;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Response.InstanceResponse;
import com.iaas.xregion.Services.AuditLogService;
import com.iaas.xregion.Services.AuthService;
import com.iaas.xregion.Services.InstanceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import software.amazon.awssdk.core.pagination.sync.SdkIterable;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;

import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class InstanceServiceTest {

    @Mock
    private DynamoDbTable<InstanceEntity> instancesTable;

    @Mock
    private DynamoDbTable<NovaEntity> novaTable;

    @Mock
    private AuditLogService auditLogService;

    @Mock
    private EventBridgeGatewayClient eventBridgeGatewayClient;

    @Mock
    private AuthService authService;
    @Mock
    private com.iaas.xregion.Services.LaunchAdmissionService launchAdmissionService;

    private InstanceService instanceService;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("testuser", "pass", List.of()));
        instanceService = new InstanceService(instancesTable, novaTable, auditLogService, eventBridgeGatewayClient, authService, launchAdmissionService);
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void maintenanceDoesNotPersistOrPublish() {
        LaunchInstanceRequest request = new LaunchInstanceRequest();
        doThrow(new com.iaas.xregion.Exceptions.LaunchUnavailableException("maintenance"))
                .when(launchAdmissionService).validate(request, "testuser");
        assertThatThrownBy(() -> instanceService.launchInstance(request))
                .isInstanceOf(com.iaas.xregion.Exceptions.LaunchUnavailableException.class);
        verifyNoInteractions(instancesTable, eventBridgeGatewayClient, auditLogService, authService);
    }

    @Test
    @DisplayName("getAllInstances filters by current user and returns sorted list")
    @SuppressWarnings("unchecked")
    void testGetAllInstances() {
        InstanceEntity userInst = InstanceEntity.builder()
                .instanceId("i-user1")
                .instanceName("User VM")
                .username("testuser")
                .activeNovaId("nova-user1")
                .currentRegion("ap-southeast-2")
                .currentStatus("RUNNING")
                .lastMigrationTimestamp(2000L)
                .build();
        InstanceEntity otherInst = InstanceEntity.builder()
                .instanceId("i-other")
                .instanceName("Other VM")
                .username("otheruser")
                .activeNovaId("nova-other")
                .currentRegion("us-east-1")
                .currentStatus("RUNNING")
                .lastMigrationTimestamp(3000L)
                .build();

        PageIterable<InstanceEntity> mockPageIterable = mock(PageIterable.class);
        SdkIterable<InstanceEntity> mockSdkIterable = mock(SdkIterable.class);

        when(instancesTable.scan()).thenReturn(mockPageIterable);
        when(mockPageIterable.items()).thenReturn(mockSdkIterable);
        when(mockSdkIterable.stream()).thenReturn(Stream.of(userInst, otherInst));

        List<InstanceResponse> result = instanceService.getAllInstances();

        assertThat(result).hasSize(1);
        assertThat(result.get(0).getId()).isEqualTo("i-user1");
        assertThat(result.get(0).getName()).isEqualTo("User VM");
    }

    @Test
    @DisplayName("getInstanceById returns instance when matching user")
    void testGetInstanceByIdFound() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-12345")
                .instanceName("Web Server")
                .username("testuser")
                .activeNovaId("nova-12345")
                .currentRegion("ap-southeast-2")
                .currentStatus("RUNNING")
                .build();

        when(instancesTable.getItem(any(Key.class))).thenReturn(inst);

        InstanceResponse response = instanceService.getInstanceById("i-12345");

        assertThat(response).isNotNull();
        assertThat(response.getId()).isEqualTo("i-12345");
        assertThat(response.getName()).isEqualTo("Web Server");
    }

    @Test
    @DisplayName("getInstanceById throws ResourceNotFoundException when instance belongs to another user or absent")
    void testGetInstanceByIdNotFound() {
        when(instancesTable.getItem(any(Key.class))).thenReturn(null);

        assertThatThrownBy(() -> instanceService.getInstanceById("i-missing"))
                .isInstanceOf(ResourceNotFoundException.class)
                .hasMessageContaining("Instance not found");

        InstanceEntity otherInst = InstanceEntity.builder()
                .instanceId("i-other")
                .username("otheruser")
                .build();
        when(instancesTable.getItem(any(Key.class))).thenReturn(otherInst);

        assertThatThrownBy(() -> instanceService.getInstanceById("i-other"))
                .isInstanceOf(ResourceNotFoundException.class)
                .hasMessageContaining("Instance not found");
    }

    @Test
    @DisplayName("launchInstance creates instance in PENDING status and sends launch event")
    void testLaunchInstance() {
        LaunchInstanceRequest req = new LaunchInstanceRequest();
        req.setName("Production-DB");
        req.setRegion("ap-southeast-2");
        req.setFlavor("m1.medium");
        req.setImageId("img-ubuntu22");
        req.setEbsSizeGb(50);
        req.setKeyPairName("prod-key");
        // SPEC-SF-01 bước 7: rule người dùng soạn phải đi cùng sự kiện launch, không bị bỏ lại ở UI.
        List<java.util.Map<String, Object>> inbound = List.of(
                java.util.Map.of("protocol", "tcp", "fromPort", 443, "toPort", 443, "cidr", "0.0.0.0/0"));
        List<java.util.Map<String, Object>> outbound = List.of();
        req.setInboundRules(inbound);
        req.setOutboundRules(outbound);

        UserEntity userEntity = UserEntity.builder()
                .userId("usr-testuser")
                .username("testuser")
                .build();
        when(authService.findUserByUsername("testuser")).thenReturn(userEntity);

        InstanceResponse response = instanceService.launchInstance(req);

        assertThat(response).isNotNull();
        assertThat(response.getName()).isEqualTo("Production-DB");
        assertThat(response.getStatus()).isEqualTo(InstanceStatus.PENDING.name());
        assertThat(response.getRegion()).isEqualTo("ap-southeast-2");
        assertThat(response.getFlavor()).isEqualTo("m1.medium");
        assertThat(response.getImageId()).isEqualTo("img-ubuntu22");
        assertThat(response.getImageName()).isNull();
        assertThat(response.getPrivateIp()).isNull();
        assertThat(response.getPublicIp()).isNull();
        assertThat(response.getVolumeId()).isNull();
        assertThat(response.getSecurityGroupId()).isNull();
        verify(instancesTable, times(1)).putItem(any(InstanceEntity.class));
        verify(auditLogService, times(1)).logAction(eq("LAUNCH_VM"), eq("INSTANCE"), anyString(), anyString());
        verify(eventBridgeGatewayClient, times(1)).sendInstanceLaunchEvent(
                anyString(), eq("Production-DB"), eq(50), eq("gp3"), eq("m1.medium"), eq("img-ubuntu22"), eq("prod-key"), eq("testuser"),
                eq(inbound), eq(outbound));
    }

    @Test
    @DisplayName("executeAction transitions instance to STOPPING when STOP requested")
    void testExecuteActionStop() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-action-test")
                .instanceName("Target")
                .username("testuser")
                .activeNovaId("nova-action-test")
                .currentStatus("RUNNING")
                .build();

        when(instancesTable.getItem(any(Key.class))).thenReturn(inst);

        InstanceActionRequest req = new InstanceActionRequest();
        req.setAction("STOP");

        InstanceResponse response = instanceService.executeAction("i-action-test", req);

        assertThat(response).isNotNull();
        assertThat(response.getStatus()).isEqualTo(InstanceStatus.STOPPING.name());
        verify(instancesTable).updateItem(any(UpdateItemEnhancedRequest.class));
        verify(instancesTable, never()).putItem(any(InstanceEntity.class));
        verify(novaTable, never()).putItem(any(NovaEntity.class));
    }

    @Test
    @DisplayName("executeAction transitions instance to SHUTTING_DOWN when TERMINATE requested")
    void testExecuteActionTerminate() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-action-test2")
                .instanceName("Target")
                .username("testuser")
                .activeNovaId("nova-action-test2")
                .currentStatus("RUNNING")
                .build();

        when(instancesTable.getItem(any(Key.class))).thenReturn(inst);

        InstanceActionRequest req = new InstanceActionRequest();
        req.setAction("TERMINATE");

        InstanceResponse response = instanceService.executeAction("i-action-test2", req);

        assertThat(response).isNotNull();
        assertThat(response.getStatus()).isEqualTo(InstanceStatus.SHUTTING_DOWN.name());
    }

    @Test
    @DisplayName("mapToResponse returns PENDING when activeNovaId is null")
    void testMapToResponseWithoutActiveNovaIdReturnsPending() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-no-nova")
                .instanceName("Pending VM")
                .username("testuser")
                .activeNovaId(null)
                .currentStatus("RUNNING") // even if currentStatus was RUNNING, without activeNovaId it must be PENDING
                .build();

        InstanceResponse response = instanceService.mapToResponse(inst);
        assertThat(response.getStatus()).isEqualTo(InstanceStatus.PENDING.name());
        assertThat(response.getActiveNovaId()).isNull();
    }

    @Test
    void requestedImageAndSizeSurvivePersistenceWithoutInventedAllocations() {
        var schema = software.amazon.awssdk.enhanced.dynamodb.TableSchema.fromBean(InstanceEntity.class);
        InstanceEntity pending = InstanceEntity.builder().instanceId("i-pending")
                .instanceName("Requested VM").currentRegion("ap-southeast-2").flavor("m1.tiny")
                .imageId("real-glance-id").requestedSizeGb(13).currentStatus("PENDING").build();
        InstanceEntity restored = schema.mapToItem(schema.itemToMap(pending, true));
        InstanceResponse response = instanceService.mapToResponse(restored);
        assertThat(response.getImageId()).isEqualTo("real-glance-id");
        assertThat(response.getEbsSizeGb()).isEqualTo(13);
        assertThat(response.getName()).isEqualTo("Requested VM");
        assertThat(response.getPrivateIp()).isNull();
        assertThat(response.getPublicIp()).isNull();
        assertThat(response.getVolumeId()).isNull();
        assertThat(response.getSecurityGroupId()).isNull();
    }

    @Test
    void terminatedWithoutActiveNovaIdRemainsTerminated() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-terminated")
                .activeNovaId("")
                .currentStatus("TERMINATED")
                .build();

        assertThat(instanceService.mapToResponse(inst).getStatus()).isEqualTo("TERMINATED");
    }

    @Test
    void shelvedNovaMapsToStoppedAndStartRemainsPending() {
        InstanceEntity inst = InstanceEntity.builder().instanceId("i-shelved")
                .activeNovaId("nova-shelved").currentStatus("STOPPED").build();
        when(novaTable.getItem(any(Key.class))).thenReturn(
                NovaEntity.builder().novaId("nova-shelved").status("SHELVED_OFFLOADED").build());
        assertThat(instanceService.mapToResponse(inst).getStatus()).isEqualTo("STOPPED");
        inst.setCurrentStatus("PENDING");
        assertThat(instanceService.mapToResponse(inst).getStatus()).isEqualTo("PENDING");
    }

    @Test
    void launchEventFailureMarksRecordFailedAndRaises() {
        LaunchInstanceRequest req = new LaunchInstanceRequest();
        req.setName("Launch failure");
        req.setRegion("ap-southeast-2");
        req.setFlavor("m1.medium");
        doThrow(new EventBridgeGatewayClient.EventRejectedException("FailedEntryCount=1"))
                .when(eventBridgeGatewayClient).sendInstanceLaunchEvent(
                        anyString(), anyString(), anyInt(), anyString(), anyString(), anyString(),
                        anyString(), anyString());

        assertThatThrownBy(() -> instanceService.launchInstance(req))
                .isInstanceOf(AppException.class)
                .hasMessageContaining("Không gửi được yêu cầu tạo máy ảo");
        verify(instancesTable).putItem(any(InstanceEntity.class));
        verify(instancesTable).updateItem(any(UpdateItemEnhancedRequest.class));
    }

    @Test
    void ambiguousLaunchDeliveryIsRecordedInsteadOfLeftPending() {
        // XR-RISK-003: a transport failure left the record PENDING forever: nothing showed
        // the request was stuck, and it was indistinguishable from a launch still starting.
        LaunchInstanceRequest req = new LaunchInstanceRequest();
        req.setName("Unconfirmed launch");
        req.setRegion("ap-southeast-2");
        req.setFlavor("m1.medium");
        doThrow(new IllegalStateException("Connection reset after send"))
                .when(eventBridgeGatewayClient).sendInstanceLaunchEvent(
                        anyString(), anyString(), anyInt(), anyString(), anyString(), anyString(),
                        anyString(), anyString());

        assertThatThrownBy(() -> instanceService.launchInstance(req)).isInstanceOf(AppException.class);
        // Still PENDING (we cannot prove it was not delivered) but rewritten with an explicit
        // marker, so the request is visible and reconcilable rather than silently stuck.
        verify(instancesTable).updateItem(any(UpdateItemEnhancedRequest.class));
    }

    @Test
    @SuppressWarnings("unchecked")
    void lifecycleUpdateOnlyWritesStatusAndTimestamp() {
        InstanceEntity inst = InstanceEntity.builder().instanceId("i-partial")
                .username("testuser").userId("usr-testuser").dns("app.example")
                .activeNovaId("nova-partial").currentStatus("RUNNING").build();
        when(instancesTable.getItem(any(Key.class))).thenReturn(inst);
        InstanceActionRequest req = new InstanceActionRequest();
        req.setAction("STOP");
        instanceService.executeAction("i-partial", req);
        org.mockito.ArgumentCaptor<UpdateItemEnhancedRequest<InstanceEntity>> captor =
                org.mockito.ArgumentCaptor.forClass(UpdateItemEnhancedRequest.class);
        verify(instancesTable).updateItem(captor.capture());
        UpdateItemEnhancedRequest<InstanceEntity> update = captor.getValue();
        assertThat(update.ignoreNulls()).isTrue();
        assertThat(update.item().getCurrentStatus()).isEqualTo("STOPPING");
        assertThat(update.item().getUserId()).isNull();
        assertThat(update.item().getDns()).isNull();
        assertThat(update.item().getActiveNovaId()).isNull();
        assertThat(update.conditionExpression().expression()).contains("current_status = :expected");
    }

    @Test
    void actionEventFailureRaisesWithoutMarkingFinalState() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-failed-event")
                .username("testuser")
                .currentStatus("RUNNING")
                .build();
        when(instancesTable.getItem(any(Key.class))).thenReturn(inst);
        doThrow(new IllegalStateException("FailedEntryCount=1"))
                .when(eventBridgeGatewayClient).sendInstanceLifecycleEvent(
                        anyString(), anyString(), anyString(), any(), anyString(), any(), anyString());
        InstanceActionRequest req = new InstanceActionRequest();
        req.setAction("STOP");

        assertThatThrownBy(() -> instanceService.executeAction("i-failed-event", req))
                .isInstanceOf(AppException.class);
        assertThat(inst.getCurrentStatus()).isEqualTo("STOPPING");
        verify(novaTable, never()).putItem(any(NovaEntity.class));
    }

    @Test
    @DisplayName("mapToResponse returns status based on active Nova VM from novaTable")
    void testMapToResponseWithActiveNovaIdFetchesStatusFromNovaTable() {
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-with-nova")
                .instanceName("Active VM")
                .username("testuser")
                .activeNovaId("nova-uuid-999")
                .novaIds(List.of("nova-uuid-999"))
                .currentStatus("PENDING")
                .build();

        NovaEntity nova = NovaEntity.builder()
                .novaId("nova-uuid-999")
                .status("ACTIVE")
                .instanceName("Active VM on Nova")
                .flavor("m1.medium")
                .build();

        when(novaTable.getItem(Key.builder().partitionValue("nova-uuid-999").build())).thenReturn(nova);

        InstanceResponse response = instanceService.mapToResponse(inst);
        assertThat(response.getStatus()).isEqualTo(InstanceStatus.RUNNING.name());
        assertThat(response.getActiveNovaId()).isEqualTo("nova-uuid-999");
        assertThat(response.getNovaIds()).containsExactly("nova-uuid-999");
    }

    @Test
    @DisplayName("auto-link ignores terminated Nova and never publishes RUNNING for a SHUTOFF VM")
    @SuppressWarnings("unchecked")
    void autoLinkIgnoresDeadNovaRows() {
        // XR-RISK-002: the index query has no filter, so a terminated server from an older
        // launch could be relinked while the real VM was SHUTOFF, publishing RUNNING.
        InstanceEntity inst = InstanceEntity.builder()
                .instanceId("i-7953bdff")
                .instanceName("canary")
                .username("testuser")
                .currentStatus("PENDING")
                .currentRegion("ap-southeast-2")
                .build();
        when(instancesTable.getItem(any(Key.class))).thenReturn(inst);

        NovaEntity dead = NovaEntity.builder()
                .novaId("nova-old").instanceId("i-7953bdff")
                .status("TERMINATED").createdAt(1000L).build();
        NovaEntity stopped = NovaEntity.builder()
                .novaId("nova-current").instanceId("i-7953bdff")
                .status("SHUTOFF").createdAt(2000L).build();

        var index = mock(software.amazon.awssdk.enhanced.dynamodb.DynamoDbIndex.class);
        when(novaTable.index("instance_id-index")).thenReturn(index);
        PageIterable<NovaEntity> pages = mock(PageIterable.class);
        @SuppressWarnings("unchecked")
        software.amazon.awssdk.enhanced.dynamodb.model.Page<NovaEntity> page =
                mock(software.amazon.awssdk.enhanced.dynamodb.model.Page.class);
        when(page.items()).thenReturn(List.of(dead, stopped));
        doReturn(pages).when(index).query(any(java.util.function.Consumer.class));
        when(pages.iterator()).thenReturn(List.of(page).iterator());

        InstanceResponse response = instanceService.getInstanceById("i-7953bdff");

        assertThat(inst.getActiveNovaId()).isEqualTo("nova-current");
        assertThat(inst.getCurrentStatus()).isEqualTo("STOPPED");
        assertThat(response.getStatus()).isNotEqualTo("RUNNING");
    }
}

