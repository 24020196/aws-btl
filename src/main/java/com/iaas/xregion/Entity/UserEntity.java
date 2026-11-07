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
 * Maps to live AWS DynamoDB table: XRegion-Users
 * Primary Key: user_id (S)
 * GSI username-index: username (S)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserEntity {

    private String userId;
    private String username;
    private String password;
    private String fullName;
    private String role;
    private Boolean active;
    private Long createdAt;
    private java.util.List<ApiTokenItem> apiTokens;
    private java.util.List<KeyPairItem> sshKeys;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("user_id")
    public String getUserId() {
        return userId;
    }

    @DynamoDbSecondaryPartitionKey(indexNames = "username-index")
    @DynamoDbAttribute("username")
    public String getUsername() {
        return username;
    }

    @DynamoDbAttribute("password")
    public String getPassword() {
        return password;
    }

    @DynamoDbAttribute("full_name")
    public String getFullName() {
        return fullName;
    }

    @DynamoDbAttribute("role")
    public String getRole() {
        return role;
    }

    @DynamoDbAttribute("active")
    public Boolean getActive() {
        return active;
    }

    @DynamoDbAttribute("created_at")
    public Long getCreatedAt() {
        return createdAt;
    }

    @DynamoDbAttribute("api_tokens")
    public java.util.List<ApiTokenItem> getApiTokens() {
        return apiTokens;
    }

    @DynamoDbAttribute("ssh_keys")
    public java.util.List<KeyPairItem> getSshKeys() {
        return sshKeys;
    }
}

