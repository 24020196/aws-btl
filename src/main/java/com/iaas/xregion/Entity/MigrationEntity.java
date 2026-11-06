package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
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
    public Long getStartedAt() {
        return startedAt;
    }

    @DynamoDbAttribute("completed_at")
    public Long getCompletedAt() {
        return completedAt;
    }

    @DynamoDbAttribute("error_message")
    public String getErrorMessage() {
        return errorMessage;
    }
}

