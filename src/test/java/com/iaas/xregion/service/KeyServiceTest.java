package com.iaas.xregion.service;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Client.Model.EventBridgeEventResponse;
import com.iaas.xregion.Entity.KeyPairItem;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.CreateKeyPairRequest;
import com.iaas.xregion.Model.Response.KeyPairResponse;
import com.iaas.xregion.Services.AuditLogService;
import com.iaas.xregion.Services.KeyService;
import com.iaas.xregion.Services.UserRepository;
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

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class KeyServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private AuditLogService auditLogService;

    @Mock
    private EventBridgeGatewayClient eventBridgeGatewayClient;

    @InjectMocks
    private KeyService keyService;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("testuser", "pass", List.of()));
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("getAllKeyPairs returns sorted keys for the current user")
    void testGetAllKeyPairs() {
        KeyPairItem key1 = KeyPairItem.builder()
                .keyName("key-alpha")
                .keyFingerprint("SHA256:111")
                .keyType("RSA")
                .createdAt(1000L)
                .build();
        KeyPairItem key2 = KeyPairItem.builder()
                .keyName("key-beta")
                .keyFingerprint("SHA256:222")
                .keyType("RSA")
                .createdAt(2000L)
                .build();

        UserEntity user = UserEntity.builder()
                .username("testuser")
                .sshKeys(List.of(key1, key2))
                .build();

        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        List<KeyPairResponse> keys = keyService.getAllKeyPairs();

        assertThat(keys).hasSize(2);
        // Sorted by createdAt descending
        assertThat(keys.get(0).getKeyName()).isEqualTo("key-beta");
        assertThat(keys.get(1).getKeyName()).isEqualTo("key-alpha");
    }

    @Test
    @DisplayName("getKeyPair returns existing key by name")
    void testGetKeyPairSuccess() {
        KeyPairItem key = KeyPairItem.builder()
                .keyName("my-prod-key")
                .keyFingerprint("SHA256:abcdef")
                .keyType("RSA")
                .createdAt(1500L)
                .build();

        UserEntity user = UserEntity.builder()
                .username("testuser")
                .sshKeys(List.of(key))
                .build();

        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        KeyPairResponse response = keyService.getKeyPair("my-prod-key");

        assertThat(response).isNotNull();
        assertThat(response.getKeyName()).isEqualTo("my-prod-key");
        assertThat(response.getKeyFingerprint()).isEqualTo("SHA256:abcdef");
    }

    @Test
    @DisplayName("getKeyPair throws ResourceNotFoundException when key not found")
    void testGetKeyPairNotFound() {
        UserEntity user = UserEntity.builder()
                .username("testuser")
                .sshKeys(new ArrayList<>())
                .build();

        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        assertThatThrownBy(() -> keyService.getKeyPair("non-existent-key"))
                .isInstanceOf(ResourceNotFoundException.class)
                .hasMessageContaining("Không tìm thấy Key Pair");
    }

    @Test
    @DisplayName("createKeyPair throws ConflictException if key name already exists")
    void testCreateKeyPairConflict() {
        KeyPairItem existing = KeyPairItem.builder()
                .keyName("duplicate-key")
                .build();

        UserEntity user = UserEntity.builder()
                .username("testuser")
                .sshKeys(List.of(existing))
                .build();

        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        CreateKeyPairRequest req = new CreateKeyPairRequest();
        req.setName("duplicate-key");

        assertThatThrownBy(() -> keyService.createKeyPair(req))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("đã tồn tại");
    }

    @Test
    @DisplayName("createKeyPair generates RSA 2048 keypair when no public key provided")
    void testCreateKeyPairGenerated() {
        UserEntity user = UserEntity.builder()
                .username("testuser")
                .sshKeys(new ArrayList<>())
                .build();

        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        EventBridgeEventResponse ebResp = EventBridgeEventResponse.builder()
                .failedEntryCount(0)
                .entries(List.of(java.util.Map.of("EventId", "mock-event-id-123")))
                .build();
        when(eventBridgeGatewayClient.sendKeySyncEvent(any(), any(), any(), any(), any(), any()))
                .thenReturn(ebResp);

        CreateKeyPairRequest req = new CreateKeyPairRequest();
        req.setName("new-rsa-key");
        req.setDescription("Primary server key");

        KeyPairResponse response = keyService.createKeyPair(req);

        assertThat(response).isNotNull();
        assertThat(response.getKeyName()).isEqualTo("new-rsa-key");
        assertThat(response.getPrivateKey()).contains("BEGIN RSA PRIVATE KEY");
        assertThat(response.getPublicKey()).startsWith("ssh-rsa ");
        assertThat(response.getKeyFingerprint()).startsWith("SHA256:");
        verify(userRepository, times(1)).save(any(UserEntity.class));
        verify(auditLogService, times(1)).logAction(eq("CREATE_KEYPAIR"), eq("KEY"), eq("new-rsa-key"), anyString());
    }
}
