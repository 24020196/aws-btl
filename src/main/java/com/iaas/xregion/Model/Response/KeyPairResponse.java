package com.iaas.xregion.Model.Response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class KeyPairResponse {
    private String keyId;
    private String keyName;
    private String keyFingerprint;
    private String keyType;
    private String publicKey;
    private String privateKey; // Chỉ trả về khi mới tạo key
    private String description;
    private long createdAt;
}

