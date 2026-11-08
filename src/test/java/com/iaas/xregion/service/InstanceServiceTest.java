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
import com.iaas.xregion.Model.Request.UpdateInstanceRequest;
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

    private InstanceService instanceService;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("testuser", "pass", List.of()));
        instanceService = new InstanceService(instancesTable, novaTable, auditLogService, eventBridgeGatewayClient, authService);
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
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
        verify(instancesTable, times(1)).putItem(any(InstanceEntity.class));
        verify(auditLogService, times(1)).logAction(eq("LAUNCH_VM"), eq("INSTANCE"), anyString(), anyString());
        verify(eventBridgeGatewayClient, times(1)).sendInstanceLaunchEvent(
                anyString(), eq("Production-DB"), eq(50), eq("gp3"), eq("m1.medium"), eq("img-ubuntu22"), eq("prod-key"), eq("testuser"));
    }

    @Test
    @DisplayName("updateInstance prevents flavor modification when instance is RUNNING (EC2 rule)")
    void testUpdateFlavorWhileRunningFails() {
        InstanceEntity runningInst = InstanceEntity.builder()
                .instanceId("i-running")
                .instanceName("App")
                .flavor("m1.small")
                .username("testuser")
                .currentStatus("RUNNING")
                .build();

        when(instancesTable.getItem(any(Key.class))).thenReturn(runningInst);

        UpdateInstanceRequest req = UpdateInstanceRequest.builder()
                .name("App")
                .flavor("m1.large")
                .build();

        assertThatThrownBy(() -> instanceService.updateInstance("i-running", req))
                .isInstanceOf(AppException.class)
                .hasMessageContaining("Dừng máy ảo (Stop) trước khi thay đổi");
    }

    @Test
    @DisplayName("updateInstance permits flavor modification when instance is STOPPED")
    void testUpdateFlavorWhileStoppedSucceeds() {
        InstanceEntity stoppedInst = InstanceEntity.builder()
                .instanceId("i-stopped")
                .instanceName("App")
                .flavor("m1.small")
                .username("testuser")
                .activeNovaId("nova-stopped")
                .currentStatus("STOPPED")
                .build();

        when(instancesTable.getItem(any(Key.class))).thenReturn(stoppedInst);

        UpdateInstanceRequest req = UpdateInstanceRequest.builder()
                .name("App Renamed")
                .flavor("m1.large")
                .build();

        InstanceResponse response = instanceService.updateInstance("i-stopped", req);

        assertThat(response).isNotNull();
        assertThat(response.getFlavor()).isEqualTo("m1.large");
        assertThat(response.getName()).isEqualTo("App Renamed");
        verify(instancesTable, times(1)).putItem(any(InstanceEntity.class));
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
}
