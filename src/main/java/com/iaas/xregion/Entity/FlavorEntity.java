package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;

/**
 * Maps to live AWS DynamoDB table: XRegion-Flavors
 * Primary Key: flavor_id (S)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class FlavorEntity {

    private String flavorId;
    private String flavorName;
    private Integer vcpus;
    private Integer ramMb;
    private Integer diskGb;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("flavor_id")
    public String getFlavorId() {
        return flavorId;
    }

    @DynamoDbAttribute("flavor_name")
    public String getFlavorName() {
        return flavorName;
    }

    @DynamoDbAttribute("vcpus")
    public Integer getVcpus() {
        return vcpus;
    }

    @DynamoDbAttribute("ram_mb")
    public Integer getRamMb() {
        return ramMb;
    }

    @DynamoDbAttribute("disk_gb")
    public Integer getDiskGb() {
        return diskGb;
    }
}
