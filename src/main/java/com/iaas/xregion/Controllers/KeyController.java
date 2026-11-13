package com.iaas.xregion.Controllers;

import com.iaas.xregion.Model.Request.CreateKeyPairRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.KeyPairResponse;
import com.iaas.xregion.Services.KeyService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "SSH Key Management", description = "Quản lý SSH KeyPairs theo chuẩn SPEC-06 (truy vấn, tạo mới và xóa)")
@RestController
@RequestMapping("/api/keys")
@RequiredArgsConstructor
@SecurityRequirement(name = "BearerAuth")
public class KeyController {

    private final KeyService keyService;

    @Operation(summary = "Danh sách SSH Keys", description = "Lấy toàn bộ danh sách SSH KeyPair đã lưu trữ trong hệ thống")
    @Hidden
    @GetMapping
    public ResponseEntity<ApiResponse<List<KeyPairResponse>>> getAllKeyPairs() {
        return ResponseEntity.ok(ApiResponse.ok(keyService.getAllKeyPairs()));
    }

    @Operation(summary = "Chi tiết SSH Key", description = "Lấy thông tin public key và fingerprint của SSH KeyPair theo tên")
    @Hidden
    @GetMapping("/{name}")
    public ResponseEntity<ApiResponse<KeyPairResponse>> getKeyPairByName(@PathVariable String name) {
        return ResponseEntity.ok(ApiResponse.ok(keyService.getKeyPair(name)));
    }

    @Operation(summary = "Tạo mới SSH Key", description = "Sinh SSH KeyPair mới hoặc nhập public key theo chuẩn SPEC-06")
    @PostMapping
    public ResponseEntity<ApiResponse<KeyPairResponse>> createKeyPair(@Valid @RequestBody CreateKeyPairRequest request) {
        KeyPairResponse response = keyService.createKeyPair(request);
        return ResponseEntity.ok(ApiResponse.ok("Tạo SSH Key Pair thành công", response));
    }

    @Operation(summary = "Xóa SSH Key", description = "Xóa SSH KeyPair khỏi hệ thống theo tên")
    @DeleteMapping("/{name}")
    public ResponseEntity<ApiResponse<Void>> deleteKeyPair(@PathVariable String name) {
        keyService.deleteKeyPair(name);
        return ResponseEntity.ok(ApiResponse.ok("Đã xóa SSH Key Pair thành công", null));
    }
}

