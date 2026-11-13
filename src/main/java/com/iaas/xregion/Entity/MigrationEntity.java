package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey;

/**
 * Maps to live AWS DynamoDB table: XRegion-Migrations
 * Partition Key: instance_id (S)
 * Sort Key: migration_id (S)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MigrationEntity {

    private String instanceId;
    private String migrationId;
    private String sourceRegion;
    private String destRegion;
    private String status;
    private Integer copyProgress;
    private Long startedAt;
    private Long completedAt;
    private String errorMessage;
    private java.util.List<String> stepLogs;
    private Long downtimeSeconds;
    private String snapshotId;
    private String destSnapshotId;
    private String volumeId;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("instance_id")
    public String getInstanceId() {
        return instanceId;
    }

    @DynamoDbSortKey
    @DynamoDbAttribute("migration_id")
    public String getMigrationId() {
        return migrationId;
    }

    @DynamoDbAttribute("source_region")
    public String getSourceRegion() {
        return sourceRegion;
    }

    @DynamoDbAttribute("dest_region")
    public String getDestRegion() {
        return destRegion;
    }

    @DynamoDbAttribute("status")
    public String getStatus() {
        return status;
    }

    @DynamoDbAttribute("copy_progress")
    public Integer getCopyProgress() {
        return copyProgress;
    }

    @DynamoDbAttribute("started_at")
    @DynamoDbConvertedBy(FlexibleEpochTimestampConverter.class)
    public Long getStartedAt() {
        return startedAt;
    }

    @DynamoDbAttribute("completed_at")
    @DynamoDbConvertedBy(FlexibleEpochTimestampConverter.class)
    public Long getCompletedAt() {
        return completedAt;
    }

    @DynamoDbAttribute("error_message")
    public String getErrorMessage() {
        return errorMessage;
    }

    /** Log 6 bước của lần chuyển vùng, lưu lại để xem sau khi tiến trình đã kết thúc. */
    @DynamoDbAttribute("step_logs")
    public java.util.List<String> getStepLogs() {
        return stepLogs;
    }

    /** Thời gian dịch vụ gián đoạn (RTO): từ lúc dừng VM nguồn tới khi Route 53 trỏ sang IP mới. */
    @DynamoDbAttribute("downtime_seconds")
    public Long getDowntimeSeconds() {
        return downtimeSeconds;
    }

    /** EBS snapshot tạo ở vùng nguồn (bước 2). */
    @DynamoDbAttribute("snapshot_id")
    public String getSnapshotId() {
        return snapshotId;
    }

    /** Bản sao snapshot ở vùng đích (bước 3, CopySnapshot). */
    @DynamoDbAttribute("dest_snapshot_id")
    public String getDestSnapshotId() {
        return destSnapshotId;
    }

    /** Volume nguồn được snapshot. */
    @DynamoDbAttribute("volume_id")
    public String getVolumeId() {
        return volumeId;
    }
}
