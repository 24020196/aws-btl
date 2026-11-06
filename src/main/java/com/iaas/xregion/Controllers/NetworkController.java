package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.NetworkResponse;
import com.iaas.xregion.Services.NetworkService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/network")
@RequiredArgsConstructor
public class NetworkController {

    private final NetworkService networkService;

    @GetMapping
    public ResponseEntity<ApiResponse<NetworkResponse>> getNetworkOverview() {
        return ResponseEntity.ok(ApiResponse.ok(networkService.getNetworkOverview()));
    }

    @PostMapping("/dns")
    public ResponseEntity<ApiResponse<Map<String, Object>>> updateDnsRecord(@Valid @RequestBody UpdateDnsRequest request) {
        Map<String, Object> record = networkService.updateDnsRecord(request);
        return ResponseEntity.ok(ApiResponse.ok("DNS Record updated successfully", record));
    }
}

