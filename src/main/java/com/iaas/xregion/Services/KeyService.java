package com.iaas.xregion.Services;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.CreateKeyPairRequest;
import com.iaas.xregion.Model.Response.KeyPairResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.security.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class KeyService {

    private final AuditLogService auditLogService;
    private final EventBridgeGatewayClient eventBridgeGatewayClient;
    private final Map<String, KeyPairResponse> keyStore = new ConcurrentHashMap<>();

    // Khởi tạo các Key Pair mặc định
    {
        keyStore.put("xregion-key", KeyPairResponse.builder()
                .keyName("xregion-key")
                .keyFingerprint("SHA256:7b:19:e4:a1:8f:2c:6d:3e:90:5a:11:ff:34:bb:aa:12")
                .keyType("RSA 2048")
                .publicKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC8v1lJ09k+defaultKey/xregion==")
                .description("Khóa SSH mặc định cho cụm Bare Metal OpenStack & AWS")
                .createdAt(System.currentTimeMillis() - 86400000L * 7)
                .build());

        keyStore.put("prod-ssh-key", KeyPairResponse.builder()
                .keyName("prod-ssh-key")
                .keyFingerprint("SHA256:4d:9a:11:c3:22:ee:aa:55:66:77:88:99:00:11:22:33")
                .keyType("RSA 2048")
                .publicKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDF89mN21k+prodKey/xregion==")
                .description("Khóa SSH Production cho các môi trường chạy tải lớn")
                .createdAt(System.currentTimeMillis() - 86400000L * 3)
                .build());
    }

    public List<KeyPairResponse> getAllKeyPairs() {
        return keyStore.values().stream()
                .sorted((a, b) -> Long.compare(b.getCreatedAt(), a.getCreatedAt()))
                .map(k -> KeyPairResponse.builder()
                        .keyName(k.getKeyName())
                        .keyFingerprint(k.getKeyFingerprint())
                        .keyType(k.getKeyType())
                        .publicKey(k.getPublicKey())
                        .description(k.getDescription())
                        .createdAt(k.getCreatedAt())
                        .build())
                .collect(Collectors.toList());
    }

    public KeyPairResponse getKeyPair(String keyName) {
        KeyPairResponse key = keyStore.get(keyName);
        if (key == null) {
            throw new ResourceNotFoundException("Không tìm thấy Key Pair với tên: " + keyName);
        }
        return key;
    }

    public KeyPairResponse createKeyPair(CreateKeyPairRequest request) {
        String name = request.getName().trim();
        if (keyStore.containsKey(name)) {
            throw new ConflictException("Key Pair với tên '" + name + "' đã tồn tại!");
        }

        long now = System.currentTimeMillis();
        String privateKeyPem = "";
        String publicKeyStr = "";
        String fingerprint = "";

        if (request.getPublicKey() != null && !request.getPublicKey().trim().isEmpty()) {
            // Trường hợp Import Public Key
            publicKeyStr = request.getPublicKey().trim();
            fingerprint = generateFingerprint(publicKeyStr.getBytes());
        } else {
            // Tự động sinh cặp khóa RSA 2048
            try {
                KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
                kpg.initialize(2048);
                KeyPair kp = kpg.generateKeyPair();

                Base64.Encoder encoder = Base64.getMimeEncoder(64, new byte[]{'\n'});
                privateKeyPem = "-----BEGIN RSA PRIVATE KEY-----\n"
                        + encoder.encodeToString(kp.getPrivate().getEncoded())
                        + "\n-----END RSA PRIVATE KEY-----\n";

                publicKeyStr = "ssh-rsa " + Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()) + " " + name + "@xregion";
                fingerprint = generateFingerprint(kp.getPublic().getEncoded());
            } catch (NoSuchAlgorithmException e) {
                log.error("Lỗi thuật toán sinh khóa RSA: {}", e.getMessage());
                throw new RuntimeException("Lỗi sinh khóa RSA: " + e.getMessage());
            }
        }

        String desc = (request.getDescription() != null && !request.getDescription().trim().isEmpty())
                ? request.getDescription().trim()
                : "Khóa SSH xác thực tạo thủ công";

        KeyPairResponse created = KeyPairResponse.builder()
                .keyName(name)
                .keyFingerprint(fingerprint)
                .keyType("RSA 2048")
                .publicKey(publicKeyStr)
                .privateKey(privateKeyPem)
                .description(desc)
                .createdAt(now)
                .build();

        keyStore.put(name, created);
        auditLogService.logAction("CREATE_KEYPAIR", "KEY", name, "Đã tạo/import SSH Key Pair: " + name);

        // Bắn sự kiện qua API Gateway vào EventBridge để đồng bộ Public Key do Backend tạo
        try {
            eventBridgeGatewayClient.sendKeySyncEvent(
                    name,
                    created.getKeyType(),
                    created.getPublicKey(),
                    created.getKeyFingerprint(),
                    List.of("ap-southeast-2"),
                    "admin"
            );
        } catch (Exception e) {
            log.warn("Không thể gửi sự kiện đồng bộ SSH Key qua API Gateway EventBridge: {}", e.getMessage());
        }

        return created;
    }

    public void deleteKeyPair(String keyName) {
        if ("xregion-key".equalsIgnoreCase(keyName)) {
            throw new IllegalArgumentException("Không được phép xóa khóa SSH mặc định 'xregion-key'");
        }
        if (!keyStore.containsKey(keyName)) {
            throw new ResourceNotFoundException("Không tìm thấy Key Pair: " + keyName);
        }
        keyStore.remove(keyName);
        auditLogService.logAction("DELETE_KEYPAIR", "KEY", keyName, "Đã xóa SSH Key Pair: " + keyName);
    }

    private String generateFingerprint(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(data);
            StringBuilder sb = new StringBuilder("SHA256:");
            for (int i = 0; i < Math.min(16, digest.length); i++) {
                if (i > 0) sb.append(":");
                sb.append(String.format("%02x", digest[i]));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            return "SHA256:unknown";
        }
    }
}

