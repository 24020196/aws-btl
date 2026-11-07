package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSecondaryPartitionKey;

/**
 * Maps to live AWS DynamoDB table: XRegion-Instances
 * Primary Key: instance_id (S)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class InstanceEntity {

    private String username;
    private String instanceId;
    private String instanceName;
    private String currentRegion;
    private String currentStatus;
    private String elasticIp;
    private String privateIp;
    private String flavor;
    private Boolean migrationLock;
    private Long lockAcquiredAt;
    private Integer cooldownSeconds;
    private Long lastMigrationTimestamp;
    private String keyName;
    private String dns;

    @DynamoDbSecondaryPartitionKey(indexNames = "username-index")
    @DynamoDbAttribute("username")
    public String getUsername() {
        return username;
    }

    @DynamoDbPartitionKey
    @DynamoDbAttribute("instance_id")
    public String getInstanceId() {
        return instanceId;
    }

    @DynamoDbAttribute("instance_name")
    public String getInstanceName() {
        return instanceName;
    }

    @DynamoDbAttribute("current_region")
    public String getCurrentRegion() {
        return currentRegion;
    }

    @DynamoDbAttribute("current_status")
    public String getCurrentStatus() {
        return currentStatus;
    }

    @DynamoDbAttribute("elastic_ip")
    public String getElasticIp() {
        return elasticIp;
    }

    @DynamoDbAttribute("private_ip")
    public String getPrivateIp() {
        return privateIp;
    }

    @DynamoDbAttribute("flavor")
    public String getFlavor() {
        return flavor;
    }

    @DynamoDbAttribute("migration_lock")
    public Boolean getMigrationLock() {
        return migrationLock;
    }

    @DynamoDbAttribute("lock_acquired_at")
    public Long getLockAcquiredAt() {
        return lockAcquiredAt;
    }

    @DynamoDbAttribute("cooldown_seconds")
    public Integer getCooldownSeconds() {
        return cooldownSeconds;
    }

    @DynamoDbAttribute("last_migration_timestamp")
    public Long getLastMigrationTimestamp() {
        return lastMigrationTimestamp;
    }

    @DynamoDbAttribute("key_name")
    public String getKeyName() {
        return keyName;
    }

    @DynamoDbAttribute("dns")
    public String getDns() {
        return dns;
    }
}
