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
public class UpdateInstanceRequest {

    @NotBlank(message = "Tên máy ảo không được để trống")
    private String name;

    @NotBlank(message = "Flavor không được để trống")
    private String flavor;

    private String keyPairName;

    private Integer cooldownSeconds;
}

