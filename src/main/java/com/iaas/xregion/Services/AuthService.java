package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.ApiTokenItem;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.ChangePasswordRequest;
import com.iaas.xregion.Model.Request.CreateApiTokenRequest;
import com.iaas.xregion.Model.Request.LoginRequest;
import com.iaas.xregion.Model.Request.RegisterRequest;
import com.iaas.xregion.Model.Response.JwtResponse;
import com.iaas.xregion.Security.CustomUserDetails;
import com.iaas.xregion.Security.JwtTokenProvider;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;

import java.nio.charset.StandardCharsets;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class AuthService {

    private final AuthenticationManager authenticationManager;
    private final JwtTokenProvider tokenProvider;
    private final AuditLogService auditLogService;
    private final DynamoDbTable<UserEntity> usersTable;
    private final PasswordEncoder passwordEncoder;

    public JwtResponse login(LoginRequest request) {
        try {
            Authentication authentication = authenticationManager.authenticate(
                    new UsernamePasswordAuthenticationToken(request.getUsername(), request.getPassword()));

            SecurityContextHolder.getContext().setAuthentication(authentication);
            String token = tokenProvider.generateToken(authentication);
            CustomUserDetails userDetails = (CustomUserDetails) authentication.getPrincipal();

            auditLogService.logAction("LOGIN", "USER", userDetails.getUsername(), "Successful JWT login");

            return JwtResponse.builder()
                    .token(token)
                    .type("Bearer")
                    .username(userDetails.getUsername())
                    .fullName(userDetails.getFullName())
                    .role(userDetails.getRole())
                    .expiresIn(tokenProvider.getExpirationMs() / 1000)
                    .build();
        } catch (Exception e) {
            throw new AppException("Authentication failed: " + e.getMessage());
        }
    }

    public JwtResponse register(RegisterRequest request) {
        String username = request.getUsername().trim();

        if ("admin".equalsIgnoreCase(username)) {
            throw new ConflictException("Username already exists: " + username);
        }

        UserEntity existing = usersTable.getItem(Key.builder().partitionValue(username).build());
        if (existing != null) {
            throw new ConflictException("Username already exists: " + username);
        }

        String fullName = (request.getFullName() != null && !request.getFullName().trim().isEmpty())
                ? request.getFullName().trim()
                : username;
        String role = (request.getRole() != null && !request.getRole().trim().isEmpty())
                ? request.getRole().trim()
                : "ROLE_USER";

        UserEntity newUser = UserEntity.builder()
                .username(username)
                .password(passwordEncoder.encode(request.getPassword()))
                .fullName(fullName)
                .role(role)
                .active(true)
                .createdAt(System.currentTimeMillis())
                .build();

        usersTable.putItem(newUser);
        auditLogService.logAction("REGISTER", "USER", username, "Registered new user account in XRegion-Users");

        Authentication authentication = authenticationManager.authenticate(
                new UsernamePasswordAuthenticationToken(username, request.getPassword()));
        SecurityContextHolder.getContext().setAuthentication(authentication);
        String token = tokenProvider.generateToken(authentication);

        return JwtResponse.builder()
                .token(token)
                .type("Bearer")
                .username(username)
                .fullName(fullName)
                .role(role)
                .expiresIn(tokenProvider.getExpirationMs() / 1000)
                .build();
    }

    public List<ApiTokenItem> getApiTokens(String username) {
        UserEntity user = usersTable.getItem(Key.builder().partitionValue(username).build());
        if (user == null) {
            throw new ResourceNotFoundException("User not found: " + username);
        }
        return user.getApiTokens() != null ? user.getApiTokens() : Collections.emptyList();
    }

    public ApiTokenItem createApiToken(String username, CreateApiTokenRequest request) {
        UserEntity user = usersTable.getItem(Key.builder().partitionValue(username).build());
        if (user == null) {
            throw new ResourceNotFoundException("User not found: " + username);
        }

        String tokenId = "tok-" + UUID.randomUUID().toString().substring(0, 8);
        String encodedUser = Base64.getUrlEncoder().withoutPadding().encodeToString(username.getBytes(StandardCharsets.UTF_8));
        String randomSecret = UUID.randomUUID().toString().replace("-", "") + Long.toHexString(System.nanoTime());
        String fullToken = "xreg_" + encodedUser + "_" + randomSecret;

        long now = System.currentTimeMillis();
        long expiresAt = 0L;
        int months = (request.getDurationMonths() != null) ? request.getDurationMonths() : 1;
        if (months > 0) {
            expiresAt = now + ((long) months) * 30L * 24L * 3600L * 1000L;
        }

        ApiTokenItem tokenItem = ApiTokenItem.builder()
                .tokenId(tokenId)
                .name(request.getName().trim())
                .token(fullToken)
                .createdAt(now)
                .expiresAt(expiresAt)
                .durationMonths(months)
                .active(true)
                .build();

        List<ApiTokenItem> tokens = user.getApiTokens();
        if (tokens == null) {
            tokens = new ArrayList<>();
        }
        tokens.add(0, tokenItem);
        user.setApiTokens(tokens);

        usersTable.putItem(user);
        auditLogService.logAction("CREATE_API_TOKEN", "USER", username,
                "Tạo API Token [" + request.getName() + "], hạn dùng: " + (months > 0 ? months + " tháng" : "Không thời hạn"));

        return tokenItem;
    }

    public void revokeApiToken(String username, String tokenId) {
        UserEntity user = usersTable.getItem(Key.builder().partitionValue(username).build());
        if (user == null) {
            throw new ResourceNotFoundException("User not found: " + username);
        }

        List<ApiTokenItem> tokens = user.getApiTokens();
        if (tokens != null) {
            for (ApiTokenItem t : tokens) {
                if (tokenId.equals(t.getTokenId())) {
                    t.setActive(false);
                    break;
                }
            }
            user.setApiTokens(tokens);
            usersTable.putItem(user);
            auditLogService.logAction("REVOKE_API_TOKEN", "USER", username, "Thu hồi API Token ID: " + tokenId);
        }
    }

    public void changePassword(String username, ChangePasswordRequest request) {
        UserEntity user = usersTable.getItem(Key.builder().partitionValue(username).build());
        if (user == null) {
            throw new ResourceNotFoundException("User not found: " + username);
        }

        if (!passwordEncoder.matches(request.getOldPassword(), user.getPassword())) {
            throw new AppException("Mật khẩu hiện tại không chính xác!");
        }

        user.setPassword(passwordEncoder.encode(request.getNewPassword()));
        usersTable.putItem(user);
        auditLogService.logAction("CHANGE_PASSWORD", "USER", username, "Đổi mật khẩu tài khoản thành công");
    }

    public UserEntity getUserProfile(String username) {
        UserEntity user = usersTable.getItem(Key.builder().partitionValue(username).build());
        if (user == null) {
            throw new ResourceNotFoundException("User not found: " + username);
        }
        return user;
    }
}
