package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;

/**
 * Một Security Group lưu trong bảng XRegion-SecurityGroups.
 * Danh sách rule lưu dạng chuỗi JSON để không phải tạo bảng con.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@DynamoDbBean
public class SecurityGroupEntity {

    private String groupId;
    private String name;
    private String description;
    private String region;
    private String owner;
    // Máy ảo sở hữu nhóm này. Đây là liên kết chuẩn (1-1) giữa máy và Security Group;
    // không dùng chuỗi description làm khóa nhận diện vì mỗi luồng tạo ghi một câu khác nhau.
    private String instanceId;
    private String inboundRulesJson;
    private String outboundRulesJson;
    private Long createdAt;

    // desired -> synced: revision là cấu hình mong muốn mới nhất, appliedRevision là bản đã áp dụng xuống hạ tầng.
    private Long revision;
    private Long appliedRevision;
    private String syncStatus;
    private Long syncRequestedAt;
    private Long syncedAt;
    private String syncError;
    private Long lastEventId;

    // Số rule mong muốn; worker so lại sau khi áp dụng để phát hiện lệch số lượng.
    private Integer ruleCount;

    // Phương án B: nhóm đã được chấp nhận quản lý toàn bộ rule của Security Group Neutron của guest.
    // Chưa có cờ này thì worker không live-reconcile, dù revision đã khớp.
    private Boolean managed;
    private Long managedAt;

    // Lease chống hai worker cùng reconcile một nhóm; hết hạn thì worker khác được tiếp quản.
    private String syncLeaseOwner;
    private Long syncLeaseUntil;

    // Số lần thử liên tiếp và thời điểm được phép thử lại (backoff ở phía worker).
    private Integer syncAttempts;
    private Long nextSyncAt;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("group_id")
    public String getGroupId() {
        return groupId;
    }

    @DynamoDbAttribute("name")
    public String getName() {
        return name;
    }

    @DynamoDbAttribute("description")
    public String getDescription() {
        return description;
    }

    @DynamoDbAttribute("region")
    public String getRegion() {
        return region;
    }

    @DynamoDbAttribute("owner")
    public String getOwner() {
        return owner;
    }

    @DynamoDbAttribute("instance_id")
    public String getInstanceId() {
        return instanceId;
    }

    @DynamoDbAttribute("inbound_rules")
    public String getInboundRulesJson() {
        return inboundRulesJson;
    }

    @DynamoDbAttribute("outbound_rules")
    public String getOutboundRulesJson() {
        return outboundRulesJson;
    }

    @DynamoDbAttribute("created_at")
    public Long getCreatedAt() {
        return createdAt;
    }

    @DynamoDbAttribute("revision")
    public Long getRevision() {
        return revision;
    }

    /** Revision đã áp dụng thành công xuống hạ tầng; worker cập nhật sau khi xác minh. */
    @DynamoDbAttribute("applied_revision")
    public Long getAppliedRevision() {
        return appliedRevision;
    }

    /** SYNCED / PENDING_SYNC / SYNCING / SYNC_FAILED / SYNC_NOT_APPLICABLE / SYNC_BLOCKED. */
    @DynamoDbAttribute("sync_status")
    public String getSyncStatus() {
        return syncStatus;
    }

    @DynamoDbAttribute("sync_requested_at")
    public Long getSyncRequestedAt() {
        return syncRequestedAt;
    }

    @DynamoDbAttribute("synced_at")
    public Long getSyncedAt() {
        return syncedAt;
    }

    @DynamoDbAttribute("sync_error")
    public String getSyncError() {
        return syncError;
    }

    /** Số thứ tự lần cập nhật gần nhất; worker bỏ qua sự kiện của lần cũ hơn. */
    @DynamoDbAttribute("last_event_id")
    public Long getLastEventId() {
        return lastEventId;
    }

    @DynamoDbAttribute("rule_count")
    public Integer getRuleCount() {
        return ruleCount;
    }

    /** true: cấu hình trong bảng là nguồn mong muốn cho toàn bộ rule của SG Neutron của guest (phương án B). */
    @DynamoDbAttribute("managed")
    public Boolean getManaged() {
        return managed;
    }

    @DynamoDbAttribute("managed_at")
    public Long getManagedAt() {
        return managedAt;
    }

    @DynamoDbAttribute("sync_lease_owner")
    public String getSyncLeaseOwner() {
        return syncLeaseOwner;
    }

    @DynamoDbAttribute("sync_lease_until")
    public Long getSyncLeaseUntil() {
        return syncLeaseUntil;
    }

    @DynamoDbAttribute("sync_attempts")
    public Integer getSyncAttempts() {
        return syncAttempts;
    }

    @DynamoDbAttribute("next_sync_at")
    public Long getNextSyncAt() {
        return nextSyncAt;
    }
}
