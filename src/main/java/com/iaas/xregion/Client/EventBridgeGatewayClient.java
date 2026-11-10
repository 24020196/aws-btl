package com.iaas.xregion.Client;

import com.iaas.xregion.Client.Model.EventBridgeEventRequest;
import com.iaas.xregion.Client.Model.EventBridgeEventResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Tầng Client gửi REST API tới AWS API Gateway để ingest sự kiện vào Amazon EventBridge.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EventBridgeGatewayClient {

    public static class EventRejectedException extends RuntimeException {
        public EventRejectedException(String message) {
            super(message);
        }
    }

    private final RestClient eventBridgeRestClient;

    /**
     * Gửi một sự kiện tùy biến qua API Gateway vào EventBridge với chữ ký AWS IAM SigV4.
     *
     * @param source     Nguồn phát sự kiện (ví dụ: "xregion.backend.instance")
     * @param detailType Phân loại sự kiện (ví dụ: "Instance Lifecycle Request")
     * @param detail     Dữ liệu nghiệp vụ chi tiết
     * @return EventBridgeEventResponse chứa trạng thái phản hồi và EventId
     */
    public EventBridgeEventResponse sendEvent(String source, String detailType, Object detail) {
        EventBridgeEventRequest request = EventBridgeEventRequest.builder()
                .source(source)
                .detailType(detailType)
                .detail(detail)
                .build();

        try {
            log.info("Phát sự kiện tới API Gateway EventBridge: source=[{}], detailType=[{}]", source, detailType);
            EventBridgeEventResponse response = eventBridgeRestClient.post()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(EventBridgeEventResponse.class);

            if (response != null && (response.getFailedEntryCount() > 0
                    || (response.getEntries() != null && response.getEntries().stream()
                    .anyMatch(entry -> entry != null && entry.get("ErrorCode") != null)))) {
                throw new EventRejectedException("EventBridge từ chối sự kiện: " + response);
            }
            if (response == null || response.getEntries() == null
                    || response.getEntries().isEmpty() || response.getEntries().stream()
                    .anyMatch(entry -> entry == null || entry.get("ErrorCode") != null || entry.get("EventId") == null)) {
                throw new IllegalStateException("EventBridge không xác nhận nhận sự kiện: " + response);
            }
            log.info("EventBridge nhận sự kiện: source=[{}], detailType=[{}]", source, detailType);
            return response;
        } catch (Exception e) {
            if (e instanceof EventRejectedException rejected) {
                throw rejected;
            }
            log.error("Lỗi khi gửi sự kiện qua API Gateway EventBridge: {}", e.getMessage(), e);
            throw new RuntimeException("Gửi sự kiện qua API Gateway thất bại: " + e.getMessage(), e);
        }
    }

    /**
     * Gửi sự kiện yêu cầu hành động vòng đời máy ảo (Launch, Start, Stop, Reboot, Terminate).
     *
     * <p>SPEC-06 mục 2.1: chỉ gửi {@code key_id} — không gửi {@code key_name}/{@code name} để tránh
     * xung đột namespace giữa OpenStack và AWS.
     */
    public EventBridgeEventResponse sendInstanceLifecycleEvent(String action, String instanceId, String instanceName,
                                                              String flavor, String targetRegion, String keyId, String requestedBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("action", action);
        detail.put("instance_id", instanceId);
        detail.put("instance_name", instanceName);
        detail.put("flavor", flavor);
        detail.put("target_region", targetRegion);
        detail.put("key_id", keyId);
        detail.put("requested_by", requestedBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.instance", "instance.lifecycle", detail);
    }

    /**
     * Gửi sự kiện yêu cầu khởi tạo máy ảo boot from volume qua Step Function LaunchInstance
     */
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceId, String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username) {
        return sendInstanceLaunchEvent(instanceId, instanceName, sizeGb, volumeType, flavorName, imageId, keyId, username,
                null, null);
    }

    /**
     * Launch kèm bộ rule tường lửa người dùng soạn ở bước 6.
     *
     * <p>SPEC-SF-01 mục 2.2 bước 7: pipeline phải ánh xạ 1-1 inbound/outbound từ payload và không tự
     * tiêm rule mặc định. Hai danh sách được chuyển tiếp nguyên vẹn để SyncDynamoDB lưu đúng cấu hình
     * mà hạ tầng đã nhận, thay vì ghi danh sách rỗng kèm trạng thái SYNCED.
     */
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceId, String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username,
                                                            List<Map<String, Object>> inboundRules,
                                                            List<Map<String, Object>> outboundRules) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-launch-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("instance_id", instanceId);
        detail.put("instance_name", instanceName);
        detail.put("key_id", keyId);
        detail.put("size_gb", sizeGb);
        detail.put("volume_type", volumeType != null ? volumeType : "gp3");
        detail.put("flavor", flavorName);
        detail.put("flavor_name", flavorName);
        detail.put("image_id", imageId);
        detail.put("username", username);
        if (inboundRules != null) {
            detail.put("inbound_rules", inboundRules);
        }
        if (outboundRules != null) {
            detail.put("outbound_rules", outboundRules);
        }
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.instance", "instance.launch", detail);
    }

    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username) {
        return sendInstanceLaunchEvent("i-" + UUID.randomUUID().toString().substring(0, 8), instanceName, sizeGb, volumeType, flavorName, imageId, keyId, username);
    }

    /**
     * Gửi sự kiện tạo SSH Key Pair (kèm Public Key do backend tạo) để đồng bộ vào OpenStack / AWS EC2
     */
    public EventBridgeEventResponse sendKeySyncEvent(String keyId, String keyType, String publicKey,
                                                    String fingerprint, List<String> targetRegions, String createdBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-key-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("key_id", keyId);
        detail.put("key_type", keyType);
        detail.put("public_key", publicKey);
        detail.put("fingerprint", fingerprint);
        detail.put("target_regions", targetRegions);
        detail.put("created_by", createdBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.key", "key.import", detail);
    }

    public EventBridgeEventResponse sendKeySyncEvent(String keyId, String keyName, String keyType, String publicKey,
                                                    String fingerprint, List<String> targetRegions, String createdBy) {
        return sendKeySyncEvent(keyId, keyType, publicKey, fingerprint, targetRegions, createdBy);
    }

    /**
     * Gửi sự kiện tạo Security Group qua OpenStack Neutron & DynamoDB
     */
    public EventBridgeEventResponse sendSecurityGroupCreateEvent(String name, String description,
                                                                List<Map<String, Object>> inboundRules, String createdBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-sg-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("name", name);
        detail.put("description", description);
        detail.put("inbound_rules", inboundRules);
        detail.put("created_by", createdBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.security", "security.create", detail);
    }

    /**
     * Gửi sự kiện cập nhật rule Security Group của một máy ảo (worker XRegion-SyncSecurityGroup tiêu thụ).
     * Firewall không đổi tại lời gọi này: backend chỉ lưu cấu hình mong muốn rồi phát yêu cầu áp dụng.
     *
     * @param groupId    mã Security Group phía backend (XRegion-SecurityGroups)
     * @param instanceId mã máy ảo đang dùng nhóm này
     * @param novaId     Nova UUID đang hoạt động, dùng để tìm Neutron SG đã gắn vào máy
     * @param revision   số revision của cấu hình mong muốn
     * @param ruleCount  số rule inbound + outbound sau khi thay
     * @param requestedBy người yêu cầu
     */
    public EventBridgeEventResponse sendSecurityGroupSyncEvent(String groupId, String instanceId, String novaId,
                                                               long revision, int ruleCount, String requestedBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-sg-sync-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("group_id", groupId);
        detail.put("instance_id", instanceId);
        detail.put("nova_id", novaId);
        detail.put("revision", revision);
        detail.put("rule_count", ruleCount);
        detail.put("requested_by", requestedBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.security", "security-group.updated", detail);
    }

    /**
     * Gửi sự kiện di trú X-Region
     */
    public EventBridgeEventResponse sendMigrationEvent(String migrationId, String instanceId, String sourceRegion,
                                                      String destRegion, String phase, String status, int progressPercent) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("migration_id", migrationId);
        detail.put("instance_id", instanceId);
        detail.put("source_region", sourceRegion);
        detail.put("dest_region", destRegion);
        detail.put("phase", phase);
        detail.put("status", status);
        detail.put("progress_percent", progressPercent);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.migration", "Migration Lifecycle Event", detail);
    }
}

