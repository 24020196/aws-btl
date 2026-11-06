package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Model.Request.LoginRequest;
import com.iaas.xregion.Model.Request.RegisterRequest;
import com.iaas.xregion.Model.Response.JwtResponse;
import com.iaas.xregion.Security.CustomUserDetails;
import com.iaas.xregion.Security.JwtTokenProvider;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;

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
                    new UsernamePasswordAuthenticationToken(request.getUsername(), request.getPassword())
            );

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
                new UsernamePasswordAuthenticationToken(username, request.getPassword())
        );
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
}

