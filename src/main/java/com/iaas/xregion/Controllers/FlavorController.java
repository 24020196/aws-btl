package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.FlavorResponse;
import com.iaas.xregion.Services.FlavorService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/flavors")
@RequiredArgsConstructor
public class FlavorController {

    private final FlavorService flavorService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<FlavorResponse>>> getAllFlavors() {
        return ResponseEntity.ok(ApiResponse.ok(flavorService.getAllFlavors()));
    }
}
