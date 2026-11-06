package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.CreateKeyPairRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.KeyPairResponse;
import com.iaas.xregion.Services.KeyService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/keys")
@RequiredArgsConstructor
public class KeyController {

    private final KeyService keyService;

    @GetMapping
    public ResponseEntity<ApiResponse<List<KeyPairResponse>>> getAllKeyPairs() {
        return ResponseEntity.ok(ApiResponse.ok(keyService.getAllKeyPairs()));
    }

    @GetMapping("/{name}")
    public ResponseEntity<ApiResponse<KeyPairResponse>> getKeyPairByName(@PathVariable String name) {
        return ResponseEntity.ok(ApiResponse.ok(keyService.getKeyPair(name)));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<KeyPairResponse>> createKeyPair(@Valid @RequestBody CreateKeyPairRequest request) {
        KeyPairResponse response = keyService.createKeyPair(request);
        return ResponseEntity.ok(ApiResponse.ok("Tạo SSH Key Pair thành công", response));
    }

    @DeleteMapping("/{name}")
    public ResponseEntity<ApiResponse<Void>> deleteKeyPair(@PathVariable String name) {
        keyService.deleteKeyPair(name);
        return ResponseEntity.ok(ApiResponse.ok("Đã xóa SSH Key Pair thành công", null));
    }
}

