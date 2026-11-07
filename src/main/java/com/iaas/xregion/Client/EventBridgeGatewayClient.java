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

            if (response != null) {
                log.info("API Gateway trả về: FailedEntryCount={}, Entries={}",
                        response.getFailedEntryCount(), response.getEntries());
            }
            return response;
        } catch (Exception e) {
            log.error("Lỗi khi gửi sự kiện qua API Gateway EventBridge: {}", e.getMessage(), e);
            throw new RuntimeException("Gửi sự kiện qua API Gateway thất bại: " + e.getMessage(), e);
        }
    }

    /**
     * Gửi sự kiện yêu cầu hành động vòng đời máy ảo (Launch, Start, Stop, Shelve, Terminate)
     */
    public EventBridgeEventResponse sendInstanceLifecycleEvent(String action, String instanceId, String instanceName,
                                                              String flavor, String targetRegion, String keyName, String requestedBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("action", action);
        detail.put("instance_id", instanceId);
        detail.put("instance_name", instanceName);
        detail.put("flavor", flavor);
        detail.put("target_region", targetRegion);
        detail.put("key_name", keyName);
        detail.put("requested_by", requestedBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.instance", "instance.lifecycle", detail);
    }

    /**
     * Gửi sự kiện yêu cầu khởi tạo máy ảo boot from volume qua Step Function OpenStack-NovaVM-EBS-Provisioner
     */
    public EventBridgeEventResponse sendInstanceLaunchEvent(String instanceName, int sizeGb, String volumeType,
                                                            String flavorName, String imageName, String keyName, String username) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-launch-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("instance_name", instanceName);
        detail.put("size_gb", sizeGb);
        detail.put("volume_type", volumeType != null ? volumeType : "gp3");
        detail.put("flavor_name", flavorName);
        detail.put("image_name", imageName);
        detail.put("key_name", keyName);
        detail.put("username", username);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.instance", "instance.launch", detail);
    }

    /**
     * Gửi sự kiện tạo SSH Key Pair (kèm Public Key do backend tạo) để đồng bộ vào OpenStack / AWS EC2
     */
    public EventBridgeEventResponse sendKeySyncEvent(String keyName, String keyType, String publicKey,
                                                    String fingerprint, List<String> targetRegions, String createdBy) {
        Map<String, Object> detail = new HashMap<>();
        detail.put("event_id", "evt-key-" + UUID.randomUUID().toString().substring(0, 8));
        detail.put("key_name", keyName);
        detail.put("key_type", keyType);
        detail.put("public_key", publicKey);
        detail.put("fingerprint", fingerprint);
        detail.put("target_regions", targetRegions);
        detail.put("created_by", createdBy);
        detail.put("timestamp", System.currentTimeMillis());

        return sendEvent("xregion.backend.key", "key.import", detail);
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

