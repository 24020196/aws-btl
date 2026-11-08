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
    private String inboundRulesJson;
    private String outboundRulesJson;
    private Long createdAt;

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
}
