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
public class KeyPairItem {

    private String keyId;
    private String keyFingerprint;
    private String keyType;
    private String publicKey;
    private String description;
    private Long createdAt;

    @DynamoDbAttribute("key_id")
    public String getKeyId() {
        return keyId;
    }

    public void setKeyId(String keyId) {
        this.keyId = keyId;
    }

    @software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbIgnore
    public String getKeyName() {
        return keyId;
    }

    public void setKeyName(String keyName) {
        this.keyId = keyName;
    }

    @DynamoDbAttribute("key_fingerprint")
    public String getKeyFingerprint() {
        return keyFingerprint;
    }

    @DynamoDbAttribute("key_type")
    public String getKeyType() {
        return keyType;
    }

    @DynamoDbAttribute("public_key")
    public String getPublicKey() {
        return publicKey;
    }

    @DynamoDbAttribute("description")
    public String getDescription() {
        return description;
    }

    @DynamoDbAttribute("created_at")
    public Long getCreatedAt() {
        return createdAt;
    }
}

