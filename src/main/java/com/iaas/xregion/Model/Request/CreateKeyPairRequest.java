package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreateKeyPairRequest {
    @NotBlank(message = "Tên khóa Key Pair không được để trống")
    private String name;

    private String publicKey; // Tùy chọn nếu người dùng import public key sẵn có
    private String description;
}

