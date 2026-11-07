package com.iaas.xregion.Controllers;

import com.iaas.xregion.Config.TimeSyncUtil;
import com.iaas.xregion.Entity.ApiTokenItem;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Model.Request.ChangePasswordRequest;
import com.iaas.xregion.Model.Request.CreateApiTokenRequest;
import com.iaas.xregion.Model.Request.LoginRequest;
import com.iaas.xregion.Model.Request.RegisterRequest;
import com.iaas.xregion.Model.Response.ApiResponse;
import com.iaas.xregion.Model.Response.JwtResponse;
import com.iaas.xregion.Services.AuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @PostMapping("/login")
    public ResponseEntity<ApiResponse<JwtResponse>> login(@Valid @RequestBody LoginRequest request) {
        JwtResponse response = authService.login(request);
        return ResponseEntity.ok(ApiResponse.ok("Login successful", response));
    }

    @PostMapping("/register")
    public ResponseEntity<ApiResponse<JwtResponse>> register(@Valid @RequestBody RegisterRequest request) {
        JwtResponse response = authService.register(request);
        return ResponseEntity.ok(ApiResponse.ok("Register successful", response));
    }

    @GetMapping("/me")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getCurrentUser() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "anonymous";
        UserEntity user = authService.getUserProfile(username);

        Map<String, Object> profile = new HashMap<>();
        profile.put("username", user.getUsername());
        profile.put("fullName", user.getFullName());
        profile.put("role", user.getRole());
        profile.put("active", user.getActive());
        profile.put("createdAt", user.getCreatedAt());
        return ResponseEntity.ok(ApiResponse.ok(profile));
    }

    @GetMapping("/tokens")
    public ResponseEntity<ApiResponse<List<ApiTokenItem>>> getApiTokens() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        List<ApiTokenItem> tokens = authService.getApiTokens(username);
        return ResponseEntity.ok(ApiResponse.ok(tokens));
    }

    @PostMapping("/tokens")
    public ResponseEntity<ApiResponse<ApiTokenItem>> createApiToken(@Valid @RequestBody CreateApiTokenRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        ApiTokenItem created = authService.createApiToken(username, request);
        return ResponseEntity.ok(ApiResponse.ok("Tạo API Token thành công", created));
    }

    @DeleteMapping("/tokens/{tokenId}")
    public ResponseEntity<ApiResponse<String>> revokeApiToken(@PathVariable String tokenId) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        authService.revokeApiToken(username, tokenId);
        return ResponseEntity.ok(ApiResponse.ok("Thu hồi API Token thành công", tokenId));
    }

    @PostMapping("/change-password")
    public ResponseEntity<ApiResponse<String>> changePassword(@Valid @RequestBody ChangePasswordRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        authService.changePassword(username, request);
        return ResponseEntity.ok(ApiResponse.ok("Đổi mật khẩu thành công", username));
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> healthCheck() {
        long nowMs = TimeSyncUtil.nowEpochMillis();
        Map<String, String> health = new HashMap<>();
        health.put("status", "UP");
        health.put("service", "xregion");
        health.put("timestamp", String.valueOf(nowMs));
        health.put("epochSeconds", String.valueOf(TimeSyncUtil.nowEpochSeconds()));
        health.put("timezone", "Asia/Ho_Chi_Minh (UTC+7)");
        health.put("formattedTime", TimeSyncUtil.formatVietnamTime(nowMs));
        return ResponseEntity.ok(health);
    }
}
