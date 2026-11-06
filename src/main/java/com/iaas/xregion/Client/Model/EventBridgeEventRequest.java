package com.iaas.xregion.Client.Model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EventBridgeEventRequest {

    /**
     * Nguồn phát sự kiện (ví dụ: xregion.backend.instance, xregion.backend.key, xregion.backend.migration)
     */
    private String source;

    /**
     * Phân loại chi tiết hành vi (ví dụ: Instance Lifecycle Request, Keypair Created Event)
     */
    private String detailType;

    /**
     * Dữ liệu chi tiết của sự kiện (Object, Map, DTO)
     */
    private Object detail;
}

