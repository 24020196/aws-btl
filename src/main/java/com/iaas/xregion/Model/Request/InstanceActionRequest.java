package com.iaas.xregion.Model.Request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class InstanceActionRequest {
    @NotBlank(message = "Action is required")
    private String action; // START, STOP, REBOOT, TERMINATE, CONSOLE
}

