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
public class CreateApiTokenRequest {

    @NotBlank(message = "Tên token không được để trống")
    private String name;

    /**
     * Thời hạn tồn tại: 1, 3, 6 (tháng) hoặc 0 (không thời hạn)
     */
    private Integer durationMonths;
}

