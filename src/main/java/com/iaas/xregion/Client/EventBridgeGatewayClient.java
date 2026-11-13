package com.iaas.xregion.Client;

import com.iaas.xregion.Client.Model.EventBridgeEventRequest;
import com.iaas.xregion.Client.Model.EventBridgeEventResponse;
import com.iaas.xregion.Config.ApiGatewayClientConfig.RegionEventGatewayClients;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Tầng Client gửi REST API tới AWS API Gateway để ingest sự kiện vào Amazon EventBridge.
 */
@Slf4j
@Component
public class EventBridgeGatewayClient {

    public static final Set<String> SUPPORTED_REGIONS = Set.of("us-east-1", "ap-southeast-2");

    public static void validateRegion(String region) {
        if (region == null || !SUPPORTED_REGIONS.contains(region.trim())) {
            throw new IllegalArgumentException("Vùng mục tiêu không hợp lệ hoặc bị thiếu: [" + region
                    + "]. Các vùng hỗ trợ: " + SUPPORTED_REGIONS);
        }
    }

    public static class EventRejectedException extends RuntimeException {
        public EventRejectedException(String message) {
            super(message);
        }
    }

    private final RestClient eventBridgeRestClient;
    private final RegionEventGatewayClients regionEventGatewayClients;

    @Autowired
    public EventBridgeGatewayClient(RestClient eventBridgeRestClient, RegionEventGatewayClients regionEventGatewayClients) {
        this.eventBridgeRestClient = eventBridgeRestClient;
        this.regionEventGatewayClients = regionEventGatewayClients;
    }

    public EventBridgeGatewayClient(RestClient eventBridgeRestClient) {
        this(eventBridgeRestClient, null);
    }

    /**
     * Gửi một sự kiện tùy biến qua API Gateway vào EventBridge với chữ ký AWS IAM SigV4 theo vùng đích.
     *
     * @param region     Vùng mục tiêu (ví dụ: "us-east-1" hoặc "ap-southeast-2")
     * @param source     Nguồn phát sự kiện (ví dụ: "xregion.backend.instance")
     * @param detailType Phân loại sự kiện (ví dụ: "Instance Lifecycle Request")
     * @param detail     Dữ liệu nghiệp vụ chi tiết
     * @return EventBridgeEventResponse chứa trạng thái phản hồi và EventId
     */
    public EventBridgeEventResponse sendEvent(String region, String source, String detailType, Object detail) {
        if (regionEventGatewayClients != null) {
            validateRegion(region);
        }

        EventBridgeEventRequest request = EventBridgeEventRequest.builder()
                .source(source)
                .detailType(detailType)
                .detail(detail)
                .build();

        RestClient client = (regionEventGatewayClients != null && region != null)
                ? regionEventGatewayClients.byRegion(region.trim())
                : null;
        if (client == null) {
            client = eventBridgeRestClient;
        }

        try {
            log.info("Phát sự kiện tới API Gateway EventBridge [vùng: {}]: source=[{}], detailType=[{}]",
                    region != null ? region : "default", source, detailType);
            EventBridgeEventResponse response = client.post()
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
     * Gửi một sự kiện tùy biến qua API Gateway vào EventBridge mặc định với chữ ký AWS IAM SigV4.
     */
    @Deprecated
    public EventBridgeEventResponse sendEvent(String source, String detailType, Object detail) {
        return sendEvent(null, source, detailType, detail);
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

        return sendEvent(targetRegion, "xregion.backend.instance", "instance.lifecycle", detail);
    }

    /**
     * Gửi sự kiện yêu cầu khởi tạo máy ảo boot from volume qua Step Function LaunchInstance có định tuyến vùng.
     */
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceId, String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username,
                                                            String targetRegion,
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
        if (targetRegion != null) {
            detail.put("target_region", targetRegion);
        }
        if (inboundRules != null) {
            detail.put("inbound_rules", inboundRules);
        }
        if (outboundRules != null) {
            detail.put("outbound_rules", outboundRules);
        }
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent(targetRegion, "xregion.backend.instance", "instance.launch", detail);
    }

    @Deprecated
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceId, String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username) {
        return sendInstanceLaunchEvent(instanceId, instanceName, sizeGb, volumeType, flavorName, imageId, keyId, username,
                null, null, null);
    }

    @Deprecated
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceId, String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username,
                                                            List<Map<String, Object>> inboundRules,
                                                            List<Map<String, Object>> outboundRules) {
        return sendInstanceLaunchEvent(instanceId, instanceName, sizeGb, volumeType, flavorName, imageId, keyId, username,
                null, inboundRules, outboundRules);
    }

    @Deprecated
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageId, String keyId, String username) {
        return sendInstanceLaunchEvent("i-" + UUID.randomUUID().toString().substring(0, 8), instanceName, sizeGb, volumeType, flavorName, imageId, keyId, username, null, null, null);
    }

    /**
     * Gửi sự kiện tạo SSH Key Pair (kèm Public Key do backend tạo) để đồng bộ vào OpenStack / AWS EC2.
     * Áp dụng quy chuẩn Fan-out song song 2 vùng theo SPEC-08: gửi tới cả API Gateway Sydney và Virginia.
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

        List<String> broadcastRegions = (targetRegions != null && !targetRegions.isEmpty())
                ? targetRegions
                : List.of("ap-southeast-2", "us-east-1");

        EventBridgeEventResponse lastResponse = null;
        for (String reg : broadcastRegions) {
            log.info("Fan-out đồng bộ SSH Key [{}] tới API Gateway vùng [{}]", keyId, reg);
            lastResponse = sendEvent(reg, "xregion.backend.key", "key.import", detail);
        }
        return lastResponse;
    }

    public EventBridgeEventResponse sendKeySyncEvent(String keyId, String keyName, String keyType, String publicKey,
                                                    String fingerprint, List<String> targetRegions, String createdBy) {
        return sendKeySyncEvent(keyId, keyType, publicKey, fingerprint, targetRegions, createdBy);
    }

    /**
     * Gửi sự kiện tạo Security Group qua OpenStack Neutron & DynamoDB
     */
    public EventBridgeEventResponse sendSecurityGroupCreateEvent(String region, String name, String description,
                                                                List<Map<String, Object>> inboundRules, String createdBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-sg-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("name", name);
        detail.put("description", description);
        detail.put("inbound_rules", inboundRules);
        detail.put("created_by", createdBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent(region, "xregion.backend.security", "security.create", detail);
    }

    @Deprecated
    public EventBridgeEventResponse sendSecurityGroupCreateEvent(String name, String description,
                                                                List<Map<String, Object>> inboundRules, String createdBy) {
        return sendSecurityGroupCreateEvent("ap-southeast-2", name, description, inboundRules, createdBy);
    }

    /**
     * Gửi sự kiện cập nhật rule Security Group của một máy ảo (worker XRegion-SyncSecurityGroup tiêu thụ).
     * Định tuyến chính xác tới API Gateway vùng máy ảo đang cư trú theo SPEC-08.
     *
     * @param region     vùng máy ảo cư trú (us-east-1 hoặc ap-southeast-2)
     * @param groupId    mã Security Group phía backend (XRegion-SecurityGroups)
     * @param instanceId mã máy ảo đang dùng nhóm này
     * @param novaId     Nova UUID đang hoạt động, dùng để tìm Neutron SG đã gắn vào máy
     * @param revision   số revision của cấu hình mong muốn
     * @param ruleCount  số rule inbound + outbound sau khi thay
     * @param requestedBy người yêu cầu
     */
    public EventBridgeEventResponse sendSecurityGroupSyncEvent(String region, String groupId, String instanceId, String novaId,
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

        return sendEvent(region, "xregion.backend.security", "security-group.updated", detail);
    }

    @Deprecated
    public EventBridgeEventResponse sendSecurityGroupSyncEvent(String groupId, String instanceId, String novaId,
                                                               long revision, int ruleCount, String requestedBy) {
        return sendSecurityGroupSyncEvent("ap-southeast-2", groupId, instanceId, novaId, revision, ruleCount, requestedBy);
    }

    /**
     * Gửi sự kiện di trú X-Region định tuyến theo sourceRegion (vùng nguồn nơi máy ảo cư trú),
     * truyền kèm nova_id và source_volume_id theo chuẩn SPEC-SF-08 v1.1.0.
     */
    public EventBridgeEventResponse sendMigrationEvent(String migrationId, String instanceId, String novaId,
                                                      String sourceVolumeId, String sourceRegion, String destRegion,
                                                      String phase, String status, int progressPercent) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("migration_id", migrationId);
        detail.put("instance_id", instanceId);
        if (novaId != null && !novaId.isBlank()) {
            detail.put("nova_id", novaId);
        }
        if (sourceVolumeId != null && !sourceVolumeId.isBlank()) {
            detail.put("source_volume_id", sourceVolumeId);
        }
        detail.put("source_region", sourceRegion);
        detail.put("dest_region", destRegion);
        detail.put("phase", phase);
        detail.put("status", status);
        detail.put("progress_percent", progressPercent);
        detail.put("timestamp", System.currentTimeMillis());

        validateRegion(sourceRegion);
        return sendEvent(sourceRegion.trim(), "xregion.backend.migration", "Migration Lifecycle Event", detail);
    }

    /**
     * Gửi sự kiện di trú X-Region định tuyến theo sourceRegion (tương thích ngược).
     */
    public EventBridgeEventResponse sendMigrationEvent(String migrationId, String instanceId, String sourceRegion,
                                                      String destRegion, String phase, String status, int progressPercent) {
        return sendMigrationEvent(migrationId, instanceId, null, null, sourceRegion, destRegion,
                phase, status, progressPercent);
    }
}

