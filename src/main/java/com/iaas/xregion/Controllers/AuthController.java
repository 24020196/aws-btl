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
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Hidden
@Tag(name = "Authentication & User Management", description = "Đăng nhập, đăng ký, thông tin người dùng, đổi mật khẩu và quản lý API Tokens")
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @Operation(summary = "Đăng nhập hệ thống", description = "Xác thực tài khoản và trả về JWT Bearer Token")
    @PostMapping("/login")
    public ResponseEntity<ApiResponse<JwtResponse>> login(@Valid @RequestBody LoginRequest request) {
        JwtResponse response = authService.login(request);
        return ResponseEntity.ok(ApiResponse.ok("Login successful", response));
    }

    @Operation(summary = "Đăng ký tài khoản", description = "Đăng ký tài khoản người dùng mới trong hệ thống")
    @PostMapping("/register")
    public ResponseEntity<ApiResponse<JwtResponse>> register(@Valid @RequestBody RegisterRequest request) {
        JwtResponse response = authService.register(request);
        return ResponseEntity.ok(ApiResponse.ok("Register successful", response));
    }

    @Operation(summary = "Lấy hồ sơ cá nhân", description = "Lấy thông tin tài khoản đang đăng nhập hiện tại", security = @SecurityRequirement(name = "BearerAuth"))
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

    @Operation(summary = "Danh sách API Tokens", description = "Lấy danh sách Long-lived API Tokens đã cấp phát", security = @SecurityRequirement(name = "BearerAuth"))
    @GetMapping("/tokens")
    public ResponseEntity<ApiResponse<List<ApiTokenItem>>> getApiTokens() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        List<ApiTokenItem> tokens = authService.getApiTokens(username);
        return ResponseEntity.ok(ApiResponse.ok(tokens));
    }

    @Operation(summary = "Tạo API Token mới", description = "Tạo mới Long-lived API Token theo chuẩn SPEC-07", security = @SecurityRequirement(name = "BearerAuth"))
    @PostMapping("/tokens")
    public ResponseEntity<ApiResponse<ApiTokenItem>> createApiToken(@Valid @RequestBody CreateApiTokenRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        ApiTokenItem created = authService.createApiToken(username, request);
        return ResponseEntity.ok(ApiResponse.ok("Tạo API Token thành công", created));
    }

    @Operation(summary = "Thu hồi API Token", description = "Thu hồi hiệu lực một API Token theo tokenId", security = @SecurityRequirement(name = "BearerAuth"))
    @DeleteMapping("/tokens/{tokenId}")
    public ResponseEntity<ApiResponse<String>> revokeApiToken(@PathVariable String tokenId) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        authService.revokeApiToken(username, tokenId);
        return ResponseEntity.ok(ApiResponse.ok("Thu hồi API Token thành công", tokenId));
    }

    @Operation(summary = "Đổi mật khẩu", description = "Thay đổi mật khẩu tài khoản hiện tại", security = @SecurityRequirement(name = "BearerAuth"))
    @PostMapping("/change-password")
    public ResponseEntity<ApiResponse<String>> changePassword(@Valid @RequestBody ChangePasswordRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String username = auth != null ? auth.getName() : "admin";
        authService.changePassword(username, request);
        return ResponseEntity.ok(ApiResponse.ok("Đổi mật khẩu thành công", username));
    }

    @Operation(summary = "Kiểm tra trạng thái dịch vụ (Health Check)", description = "Kiểm tra trạng thái uptime và timestamp đồng bộ")
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
