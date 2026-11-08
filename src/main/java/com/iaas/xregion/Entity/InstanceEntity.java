package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbIgnore;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;

import java.util.List;

/**
 * Maps to live AWS DynamoDB table: XRegion-Instances
 * Primary Key: instance_id (S)
 * Streamlined entity: All Nova compute details are decoupled into XRegion-Nova
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class InstanceEntity {

    private String instanceId;
    private String activeNovaId;
    private List<String> novaIds;
    private String userId;
    private String currentStatus;
    private Boolean migrationLock;
    private Long lockAcquiredAt;
    private Integer cooldownSeconds;
    private Long lastMigrationTimestamp;
    private String dns;

    // Transient fields (decoupled to XRegion-Nova)
    private String instanceName;
    private String username;
    private String currentRegion;
    private String flavor;
    private String privateIp;
    private String elasticIp;
    private String volumeId;
    private String keyId;
    private String keyName;
    private String securityGroup;
    private String securityGroupId;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("instance_id")
    public String getInstanceId() {
        return instanceId;
    }

    @DynamoDbAttribute("active_nova_id")
    public String getActiveNovaId() {
        return activeNovaId;
    }

    public void setActiveNovaId(String activeNovaId) {
        this.activeNovaId = activeNovaId;
    }

    @DynamoDbAttribute("nova_ids")
    public List<String> getNovaIds() {
        return novaIds;
    }

    @DynamoDbAttribute("user_id")
    public String getUserId() {
        return userId;
    }

    @DynamoDbAttribute("current_status")
    public String getCurrentStatus() {
        return currentStatus;
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

    @DynamoDbAttribute("dns")
    public String getDns() {
        return dns;
    }

    // ==========================================
    // Decoupled / Transient Getters (Ignored in DynamoDB)
    // ==========================================

    @DynamoDbIgnore
    public String getInstanceName() {
        return instanceName != null ? instanceName : instanceId;
    }

    @DynamoDbIgnore
    public String getUsername() {
        if (username != null) return username;
        return (userId != null && userId.startsWith("usr-")) ? userId.substring(4) : userId;
    }

    @DynamoDbIgnore
    public String getCurrentRegion() {
        return currentRegion != null ? currentRegion : "ap-southeast-2";
    }

    @DynamoDbIgnore
    public String getFlavor() {
        return flavor;
    }

    @DynamoDbIgnore
    public String getPrivateIp() {
        return privateIp;
    }

    @DynamoDbIgnore
    public String getElasticIp() {
        return elasticIp;
    }

    @DynamoDbIgnore
    public String getVolumeId() {
        return volumeId;
    }

    @DynamoDbIgnore
    public String getKeyId() {
        return keyId;
    }

    @DynamoDbIgnore
    public String getKeyName() {
        return keyName;
    }

    @DynamoDbIgnore
    public String getSecurityGroup() {
        return securityGroup;
    }

    @DynamoDbIgnore
    public String getSecurityGroupId() {
        return securityGroupId;
    }
}
