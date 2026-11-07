package com.iaas.xregion.Services;

import com.iaas.xregion.Config.TimeSyncUtil;
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
import com.iaas.xregion.Utils.UlidCreator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class AuthService {

    private final AuthenticationManager authenticationManager;
    private final JwtTokenProvider tokenProvider;
    private final AuditLogService auditLogService;
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public UserEntity findUserByUsername(String username) {
        if (username == null) return null;
        return userRepository.findByUsername(username).orElse(null);
    }

    public JwtResponse login(LoginRequest request) {
        try {
            Authentication authentication = authenticationManager.authenticate(
                    new UsernamePasswordAuthenticationToken(request.getUsername(), request.getPassword()));
            SecurityContextHolder.getContext().setAuthentication(authentication);
            String token = tokenProvider.generateToken(authentication);

            CustomUserDetails userDetails = (CustomUserDetails) authentication.getPrincipal();
            long expMs = tokenProvider.getExpirationMs();

            auditLogService.logAction("LOGIN", "USER", userDetails.getUsername(), "User logged in successfully");

            return JwtResponse.builder()
                    .token(token)
                    .type("Bearer")
                    .username(userDetails.getUsername())
                    .fullName(userDetails.getFullName())
                    .role(userDetails.getRole())
                    .expiresIn(expMs / 1000)
                    .expiresAt(TimeSyncUtil.nowEpochMillis() + expMs)
                    .build();
        } catch (Exception e) {
            log.error("Login failed for user {}: {}", request.getUsername(), e.getMessage());
            throw new AppException("Tên đăng nhập hoặc mật khẩu không chính xác!");
        }
    }

    public JwtResponse register(RegisterRequest request) {
        String username = request.getUsername().trim();

        if ("admin".equalsIgnoreCase(username)) {
            throw new ConflictException("Username already exists: " + username);
        }

        if (userRepository.findByUsername(username).isPresent()) {
            throw new ConflictException("Username already exists: " + username);
        }

        String fullName = (request.getFullName() != null && !request.getFullName().trim().isEmpty())
                ? request.getFullName().trim()
                : username;
        String role = (request.getRole() != null && !request.getRole().trim().isEmpty())
                ? request.getRole().trim()
                : "ROLE_USER";

        String userId = "usr-" + UlidCreator.nextUlid();
        UserEntity newUser = UserEntity.builder()
                .userId("usr-" + username.toLowerCase())
                .username(username)
                .password(passwordEncoder.encode(request.getPassword()))
                .fullName(fullName)
                .role(role)
                .active(true)
                .createdAt(System.currentTimeMillis())
                .build();

        userRepository.save(newUser);
        auditLogService.logAction("REGISTER", "USER", username, "Registered new user account in XRegion-Users");

        Authentication authentication = authenticationManager.authenticate(
                new UsernamePasswordAuthenticationToken(username, request.getPassword()));
        SecurityContextHolder.getContext().setAuthentication(authentication);
        String token = tokenProvider.generateToken(authentication);

        long expMs = tokenProvider.getExpirationMs();
        return JwtResponse.builder()
                .token(token)
                .type("Bearer")
                .username(username)
                .fullName(fullName)
                .role(role)
                .expiresIn(expMs / 1000)
                .expiresAt(TimeSyncUtil.nowEpochMillis() + expMs)
                .build();
    }

    public List<ApiTokenItem> getApiTokens(String username) {
        UserEntity user = getOrInitUser(username);
        return user.getApiTokens() != null ? user.getApiTokens() : Collections.emptyList();
    }

    public ApiTokenItem createApiToken(String username, CreateApiTokenRequest request) {
        UserEntity user = getOrInitUser(username);

        String tokenId = "tok-" + UUID.randomUUID().toString().substring(0, 8);
        String encodedUser = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(username.getBytes(StandardCharsets.UTF_8));
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

        userRepository.save(user);
        auditLogService.logAction("CREATE_API_TOKEN", "USER", username,
                "Tạo API Token [" + request.getName() + "], hạn dùng: "
                        + (months > 0 ? months + " tháng" : "Không thời hạn"));

        return tokenItem;
    }

    public void revokeApiToken(String username, String tokenId) {
        UserEntity user = getOrInitUser(username);

        List<ApiTokenItem> tokens = user.getApiTokens();
        if (tokens != null) {
            for (ApiTokenItem t : tokens) {
                if (tokenId.equals(t.getTokenId())) {
                    t.setActive(false);
                    break;
                }
            }
            user.setApiTokens(tokens);
            userRepository.save(user);
            auditLogService.logAction("REVOKE_API_TOKEN", "USER", username, "Thu hồi API Token ID: " + tokenId);
        }
    }

    public void changePassword(String username, ChangePasswordRequest request) {
        UserEntity user = getOrInitUser(username);

        if (!passwordEncoder.matches(request.getOldPassword(), user.getPassword())) {
            throw new AppException("Mật khẩu hiện tại không chính xác!");
        }

        user.setPassword(passwordEncoder.encode(request.getNewPassword()));
        userRepository.save(user);
        auditLogService.logAction("CHANGE_PASSWORD", "USER", username, "Đổi mật khẩu tài khoản thành công");
    }

    public UserEntity getUserProfile(String username) {
        return getOrInitUser(username);
    }

    private UserEntity getOrInitUser(String username) {
        Optional<UserEntity> userOpt = userRepository.findByUsername(username);
        if (userOpt.isPresent()) {
            return userOpt.get();
        }

        if ("admin".equalsIgnoreCase(username)) {
            UserEntity adminUser = UserEntity.builder()
                    .userId("usr-admin")
                    .username("admin")
                    .password(passwordEncoder.encode("admin123"))
                    .fullName("IaaS Super Administrator")
                    .role("ROLE_ADMIN")
                    .active(true)
                    .createdAt(System.currentTimeMillis())
                    .build();
            try {
                userRepository.save(adminUser);
            } catch (Exception e) {
                log.debug("Auto-save admin user failed: {}", e.getMessage());
            }
            return adminUser;
        }

        throw new ResourceNotFoundException("User not found: " + username);
    }
}
