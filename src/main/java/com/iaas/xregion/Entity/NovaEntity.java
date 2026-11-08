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
 * Maps to live AWS DynamoDB table: XRegion-Nova
 * Primary Key: nova_id (S)
 * GSI: instance_id-index (instance_id)
 * Represents 1-to-N relationship with XRegion-Instances
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class NovaEntity {

    private String novaId;
    private String instanceId;
    private String instanceName;
    private String status;
    private String region;
    private String flavor;
    private String privateIp;
    private String elasticIp;
    private String volumeId;
    private String keyId;
    private String securityGroupId;
    private Long createdAt;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("nova_id")
    public String getNovaId() {
        return novaId;
    }

    @DynamoDbSecondaryPartitionKey(indexNames = "instance_id-index")
    @DynamoDbAttribute("instance_id")
    public String getInstanceId() {
        return instanceId;
    }

    @DynamoDbAttribute("instance_name")
    public String getInstanceName() {
        return instanceName;
    }

    @DynamoDbAttribute("status")
    public String getStatus() {
        return status;
    }

    @DynamoDbAttribute("region")
    public String getRegion() {
        return region;
    }

    @DynamoDbAttribute("flavor")
    public String getFlavor() {
        return flavor;
    }

    @DynamoDbAttribute("private_ip")
    public String getPrivateIp() {
        return privateIp;
    }

    @DynamoDbAttribute("elastic_ip")
    public String getElasticIp() {
        return elasticIp;
    }

    @DynamoDbAttribute("volume_id")
    public String getVolumeId() {
        return volumeId;
    }

    @DynamoDbAttribute("key_id")
    public String getKeyId() {
        return keyId;
    }

    @DynamoDbAttribute("security_group_id")
    public String getSecurityGroupId() {
        return securityGroupId;
    }

    @DynamoDbAttribute("created_at")
    public Long getCreatedAt() {
        return createdAt;
    }
}
