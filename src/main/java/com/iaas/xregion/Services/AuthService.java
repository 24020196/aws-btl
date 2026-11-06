package com.iaas.xregion.Services;

import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Model.Request.LoginRequest;
import com.iaas.xregion.Model.Response.JwtResponse;
import com.iaas.xregion.Security.CustomUserDetails;
import com.iaas.xregion.Security.JwtTokenProvider;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final AuthenticationManager authenticationManager;
    private final JwtTokenProvider tokenProvider;
    private final AuditLogService auditLogService;
    private final com.iaas.xregion.Security.UserDetailsServiceImpl userDetailsService;

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

    public void register(com.iaas.xregion.Model.Request.RegisterRequest request) {
        try {
            userDetailsService.registerUser(
                    request.getUsername(),
                    request.getPassword(),
                    request.getFullName(),
                    request.getRole()
            );
            auditLogService.logAction("REGISTER", "USER", request.getUsername(), "Registered new user account");
        } catch (IllegalArgumentException e) {
            throw new AppException(e.getMessage());
        } catch (Exception e) {
            throw new AppException("Đăng ký tài khoản thất bại: " + e.getMessage());
        }
    }
}

