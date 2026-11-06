package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@DynamoDbBean
public class ApiTokenItem {

    private String tokenId;
    private String name;
    private String token;
    private Long createdAt;
    private Long expiresAt;
    private Integer durationMonths; // 1, 3, 6, 0 (no date / permanent)
    private Boolean active;

    @DynamoDbAttribute("token_id")
    public String getTokenId() {
        return tokenId;
    }

    @DynamoDbAttribute("name")
    public String getName() {
        return name;
    }

    @DynamoDbAttribute("token")
    public String getToken() {
        return token;
    }

    @DynamoDbAttribute("created_at")
    public Long getCreatedAt() {
        return createdAt;
    }

    @DynamoDbAttribute("expires_at")
    public Long getExpiresAt() {
        return expiresAt;
    }

    @DynamoDbAttribute("duration_months")
    public Integer getDurationMonths() {
        return durationMonths;
    }

    @DynamoDbAttribute("active")
    public Boolean getActive() {
        return active;
    }
}

