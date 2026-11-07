package com.iaas.xregion.Client.Model;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EventBridgeEventResponse {

    @JsonProperty("FailedEntryCount")
    private int failedEntryCount;

    @JsonProperty("Entries")
    private List<Map<String, Object>> entries;
}

