package com.iaas.xregion.Services;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Client.Model.EventBridgeEventResponse;
import com.iaas.xregion.Entity.KeyPairItem;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.CreateKeyPairRequest;
import com.iaas.xregion.Model.Response.KeyPairResponse;
import com.iaas.xregion.Utils.UlidCreator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPublicKey;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class KeyService {

    private final UserRepository userRepository;
    private final AuditLogService auditLogService;
    private final EventBridgeGatewayClient eventBridgeGatewayClient;

    // Fallback cache nếu bảng DynamoDB chưa tạo bản ghi cho tài khoản mặc định
    private final Map<String, List<KeyPairItem>> fallbackUserKeys = new ConcurrentHashMap<>();

    private String getCurrentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return "admin";
    }

    private UserEntity findUserByUsername(String username) {
        if (username == null) return null;
        try {
            UserEntity user = usersTable.index("username-index")
                    .query(software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional.keyEqualTo(Key.builder().partitionValue(username).build()))
                    .stream()
                    .flatMap(page -> page.items().stream())
                    .findFirst()
                    .orElse(null);
            if (user != null) return user;
        } catch (Exception ex) {
            log.debug("GSI lookup error in KeyService: {}", ex.getMessage());
        }
        if (username.startsWith("usr-")) {
            return usersTable.getItem(Key.builder().partitionValue(username).build());
        }
        return null;
    }

    private List<KeyPairItem> loadUserKeyItems(String username) {
        try {
            UserEntity user = userRepository.findByUsername(username).orElse(null);
            if (user != null) {
                if (user.getSshKeys() != null) {
                    return new ArrayList<>(user.getSshKeys());
                }
                return new ArrayList<>();
            }
        } catch (Exception e) {
            log.warn("Không thể đọc ssh_keys của user [{}] từ DynamoDB: {}", username, e.getMessage());
        }
        return new ArrayList<>(fallbackUserKeys.getOrDefault(username, Collections.emptyList()));
    }

    private void saveUserKeyItems(String username, List<KeyPairItem> keys) {
        fallbackUserKeys.put(username, new ArrayList<>(keys));
        try {
            UserEntity user = userRepository.findByUsername(username).orElse(null);
            if (user == null) {
                String userId = "usr-" + UlidCreator.nextUlid();
                user = UserEntity.builder()
                        .userId("usr-" + username.toLowerCase())
                        .username(username)
                        .fullName(username)
                        .role("ROLE_USER")
                        .active(true)
                        .createdAt(System.currentTimeMillis())
                        .sshKeys(keys)
                        .build();
            } else {
                user.setSshKeys(keys);
            }
            userRepository.save(user);
        } catch (Exception e) {
            log.warn("Không thể lưu ssh_keys của user [{}] vào DynamoDB: {}", username, e.getMessage());
        }
    }

    public List<KeyPairResponse> getAllKeyPairs() {
        String currentUser = getCurrentUsername();
        List<KeyPairItem> items = loadUserKeyItems(currentUser);

        return items.stream()
                .sorted((a, b) -> Long.compare(
                        b.getCreatedAt() != null ? b.getCreatedAt() : 0L,
                        a.getCreatedAt() != null ? a.getCreatedAt() : 0L))
                .map(k -> KeyPairResponse.builder()
                        .keyName(k.getKeyName())
                        .keyFingerprint(k.getKeyFingerprint())
                        .keyType(k.getKeyType())
                        .publicKey(k.getPublicKey())
                        .description(k.getDescription())
                        .createdAt(k.getCreatedAt() != null ? k.getCreatedAt() : 0L)
                        .build())
                .collect(Collectors.toList());
    }

    public KeyPairResponse getKeyPair(String keyName) {
        String currentUser = getCurrentUsername();
        return loadUserKeyItems(currentUser).stream()
                .filter(k -> keyName.equalsIgnoreCase(k.getKeyName()))
                .findFirst()
                .map(k -> KeyPairResponse.builder()
                        .keyName(k.getKeyName())
                        .keyFingerprint(k.getKeyFingerprint())
                        .keyType(k.getKeyType())
                        .publicKey(k.getPublicKey())
                        .description(k.getDescription())
                        .createdAt(k.getCreatedAt() != null ? k.getCreatedAt() : 0L)
                        .build())
                .orElseThrow(() -> new ResourceNotFoundException("Không tìm thấy Key Pair với tên: " + keyName));
    }

    public KeyPairResponse createKeyPair(CreateKeyPairRequest request) {
        String currentUser = getCurrentUsername();
        String name = request.getName().trim();

        List<KeyPairItem> userKeys = loadUserKeyItems(currentUser);
        boolean exists = userKeys.stream().anyMatch(k -> name.equalsIgnoreCase(k.getKeyName()));
        if (exists) {
            throw new ConflictException("Key Pair với tên '" + name + "' đã tồn tại trong tài khoản của bạn!");
        }

        long now = System.currentTimeMillis();
        String privateKeyPem = "";
        String publicKeyStr = "";
        String fingerprint = "";

        if (request.getPublicKey() != null && !request.getPublicKey().trim().isEmpty()) {
            publicKeyStr = request.getPublicKey().trim();
            fingerprint = generateFingerprint(publicKeyStr.getBytes(StandardCharsets.UTF_8));
        } else {
            // Sinh cặp khóa RSA 2048 chuẩn PKCS#1 PEM (-----BEGIN RSA PRIVATE KEY-----)
            // giống hệt AWS EC2
            try {
                KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
                kpg.initialize(2048);
                KeyPair kp = kpg.generateKeyPair();

                RSAPrivateCrtKey privKey = (RSAPrivateCrtKey) kp.getPrivate();
                RSAPublicKey pubKey = (RSAPublicKey) kp.getPublic();

                byte[] pkcs1Bytes = encodePkcs1PrivateKey(privKey);
                Base64.Encoder mimeEncoder = Base64.getMimeEncoder(64, new byte[] { '\n' });
                privateKeyPem = "-----BEGIN RSA PRIVATE KEY-----\n"
                        + mimeEncoder.encodeToString(pkcs1Bytes)
                        + "\n-----END RSA PRIVATE KEY-----";

                byte[] sshRsaBytes = encodeOpenSshPublicKey(pubKey);
                publicKeyStr = "ssh-rsa " + Base64.getEncoder().encodeToString(sshRsaBytes) + " " + name;
                fingerprint = generateFingerprint(sshRsaBytes);
            } catch (Exception e) {
                log.error("Lỗi sinh khóa RSA 2048: {}", e.getMessage(), e);
                throw new RuntimeException("Lỗi sinh khóa RSA: " + e.getMessage());
            }
        }

        String desc = (request.getDescription() != null && !request.getDescription().trim().isEmpty())
                ? request.getDescription().trim()
                : "Khóa SSH RSA 2048 tạo bởi " + currentUser;

        // 1. Gửi sự kiện Import Public Key đồng bộ qua API Gateway vào EventBridge với chữ ký AWS IAM SigV4
        try {
            EventBridgeEventResponse ebResp = eventBridgeGatewayClient.sendKeySyncEvent(
                    name,
                    "RSA 2048",
                    publicKeyStr,
                    fingerprint,
                    List.of("ap-southeast-2", "us-east-1"),
                    currentUser
            );
            if (ebResp == null || ebResp.getFailedEntryCount() > 0) {
                log.error("API Gateway từ chối hoặc lỗi đồng bộ SSH Key [{}]: {}", name, ebResp);
                throw new AppException("Gửi sự kiện import SSH Key qua API Gateway thất bại. Không thể tạo khóa.");
            }
            log.info("API Gateway đã xác nhận gửi thành công sự kiện SSH Key [{}] với EventId={}",
                    name, (ebResp.getEntries() != null && !ebResp.getEntries().isEmpty()) ? ebResp.getEntries().get(0).get("EventId") : "OK");
        } catch (AppException ae) {
            throw ae;
        } catch (Exception e) {
            log.error("Lỗi khi kết nối API Gateway để import SSH Key [{}]: {}", name, e.getMessage(), e);
            throw new AppException("Không thể kết nối API Gateway để import SSH Key: " + e.getMessage());
        }

        // 2. Chỉ khi API Gateway phản hồi thành công mới lưu Public Key vào DynamoDB
        KeyPairItem itemToSave = KeyPairItem.builder()
                .keyName(name)
                .keyFingerprint(fingerprint)
                .keyType("RSA 2048")
                .publicKey(publicKeyStr)
                .description(desc)
                .createdAt(now)
                .build();

        userKeys.add(itemToSave);
        saveUserKeyItems(currentUser, userKeys);

        auditLogService.logAction("CREATE_KEYPAIR", "KEY", name,
                "Đã tạo SSH Key Pair [" + name + "] cho user " + currentUser);

        // 3. Trả về kèm privateKey duy nhất 1 lần để trình duyệt tự tải file <name>.pem
        return KeyPairResponse.builder()
                .keyName(name)
                .keyFingerprint(fingerprint)
                .keyType("RSA 2048")
                .publicKey(publicKeyStr)
                .privateKey(privateKeyPem)
                .description(desc)
                .createdAt(now)
                .build();
    }

    public void deleteKeyPair(String keyName) {
        String currentUser = getCurrentUsername();
        List<KeyPairItem> userKeys = loadUserKeyItems(currentUser);
        boolean removed = userKeys.removeIf(k -> keyName.equalsIgnoreCase(k.getKeyName()));
        if (!removed) {
            throw new ResourceNotFoundException("Không tìm thấy Key Pair: " + keyName);
        }
        saveUserKeyItems(currentUser, userKeys);
        auditLogService.logAction("DELETE_KEYPAIR", "KEY", keyName, "Đã xóa SSH Key Pair: " + keyName);
    }

    /**
     * Mã hóa chuẩn ASN.1 DER PKCS#1 RSAPrivateKey (MIIEp...) khớp 100% cấu trúc
     * file .pem của AWS EC2 / OpenSSH
     */
    private byte[] encodePkcs1PrivateKey(RSAPrivateCrtKey key) throws IOException {
        ByteArrayOutputStream seq = new ByteArrayOutputStream();
        writeDerInteger(seq, BigInteger.ZERO); // version = 0
        writeDerInteger(seq, key.getModulus());
        writeDerInteger(seq, key.getPublicExponent());
        writeDerInteger(seq, key.getPrivateExponent());
        writeDerInteger(seq, key.getPrimeP());
        writeDerInteger(seq, key.getPrimeQ());
        writeDerInteger(seq, key.getPrimeExponentP());
        writeDerInteger(seq, key.getPrimeExponentQ());
        writeDerInteger(seq, key.getCrtCoefficient());
        return wrapDerSequence(seq.toByteArray());
    }

    private void writeDerInteger(ByteArrayOutputStream out, BigInteger value) throws IOException {
        byte[] bytes = value.toByteArray();
        out.write(0x02); // INTEGER tag
        writeDerLength(out, bytes.length);
        out.write(bytes);
    }

    private byte[] wrapDerSequence(byte[] content) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0x30); // SEQUENCE tag
        writeDerLength(out, content.length);
        out.write(content);
        return out.toByteArray();
    }

    private void writeDerLength(ByteArrayOutputStream out, int length) {
        if (length < 128) {
            out.write(length);
        } else if (length < 256) {
            out.write(0x81);
            out.write(length);
        } else {
            out.write(0x82);
            out.write((length >> 8) & 0xFF);
            out.write(length & 0xFF);
        }
    }

    /**
     * Mã hóa chuẩn RFC 4253 OpenSSH "ssh-rsa" wire format
     */
    private byte[] encodeOpenSshPublicKey(RSAPublicKey pub) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(buf);
        byte[] sshRsa = "ssh-rsa".getBytes(StandardCharsets.US_ASCII);
        dos.writeInt(sshRsa.length);
        dos.write(sshRsa);

        byte[] e = pub.getPublicExponent().toByteArray();
        dos.writeInt(e.length);
        dos.write(e);

        byte[] n = pub.getModulus().toByteArray();
        dos.writeInt(n.length);
        dos.write(n);
        dos.flush();
        return buf.toByteArray();
    }

    private String generateFingerprint(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(data);
            StringBuilder sb = new StringBuilder("SHA256:");
            for (int i = 0; i < Math.min(16, digest.length); i++) {
                if (i > 0)
                    sb.append(":");
                sb.append(String.format("%02x", digest[i]));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            return "SHA256:unknown";
        }
    }
}
