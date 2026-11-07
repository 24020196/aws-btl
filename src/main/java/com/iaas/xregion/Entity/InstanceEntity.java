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
 * GSI: username-index (username)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class InstanceEntity {

    private String instanceId;
    private String instanceName;
    private String userId;
    private String keyId;
    private String volumeId;
    private String securityGroupId;
    private String username;
    private String currentRegion;
    private String currentStatus;
    private String elasticIp;
    private String privateIp;
    private String flavor;
    private Boolean migrationLock;
    private String dns;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("instance_id")
    public String getInstanceId() {
        return instanceId;
    }

    @DynamoDbAttribute("instance_name")
    public String getInstanceName() {
        return instanceName;
    }

    @DynamoDbAttribute("user_id")
    public String getUserId() {
        return userId;
    }

    @DynamoDbAttribute("key_id")
    public String getKeyId() {
        return keyId;
    }

    @DynamoDbAttribute("volume_id")
    public String getVolumeId() {
        return volumeId;
    }

    @DynamoDbAttribute("security_group_id")
    public String getSecurityGroupId() {
        return securityGroupId;
    }

    @DynamoDbSecondaryPartitionKey(indexNames = "username-index")
    @DynamoDbAttribute("username")
    public String getUsername() {
        return username;
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

    @DynamoDbAttribute("dns")
    public String getDns() {
        return dns;
    }
}
