package com.iaas.xregion.service;

import com.iaas.xregion.Entity.ApiTokenItem;
import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Model.Request.CreateApiTokenRequest;
import com.iaas.xregion.Model.Request.LoginRequest;
import com.iaas.xregion.Model.Request.RegisterRequest;
import com.iaas.xregion.Model.Response.JwtResponse;
import com.iaas.xregion.Security.CustomUserDetails;
import com.iaas.xregion.Security.JwtTokenProvider;
import com.iaas.xregion.Services.AuditLogService;
import com.iaas.xregion.Services.AuthService;
import com.iaas.xregion.Services.UserRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.Collections;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AuthServiceTest {

    @Mock
    private AuthenticationManager authenticationManager;

    @Mock
    private JwtTokenProvider tokenProvider;

    @Mock
    private AuditLogService auditLogService;

    @Mock
    private UserRepository userRepository;

    @Mock
    private PasswordEncoder passwordEncoder;

    @InjectMocks
    private AuthService authService;

    @Test
    @DisplayName("findUserByUsername returns entity when user exists")
    void testFindUserByUsernameFound() {
        UserEntity user = UserEntity.builder()
                .userId("usr-test")
                .username("testuser")
                .fullName("Test User")
                .build();
        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        UserEntity result = authService.findUserByUsername("testuser");

        assertThat(result).isNotNull();
        assertThat(result.getUsername()).isEqualTo("testuser");
    }

    @Test
    @DisplayName("findUserByUsername returns null when not found or null input")
    void testFindUserByUsernameNotFound() {
        assertThat(authService.findUserByUsername(null)).isNull();

        when(userRepository.findByUsername("unknown")).thenReturn(Optional.empty());
        assertThat(authService.findUserByUsername("unknown")).isNull();
    }

    @Test
    @DisplayName("login succeeds with valid credentials")
    void testLoginSuccess() {
        LoginRequest req = new LoginRequest();
        req.setUsername("admin");
        req.setPassword("admin123");

        CustomUserDetails userDetails = CustomUserDetails.builder()
                .username("admin")
                .password("hash")
                .fullName("IaaS Admin")
                .role("ROLE_ADMIN")
                .active(true)
                .build();

        Authentication auth = new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());
        when(authenticationManager.authenticate(any(UsernamePasswordAuthenticationToken.class))).thenReturn(auth);
        when(tokenProvider.generateToken(auth)).thenReturn("mock-jwt-token");
        when(tokenProvider.getExpirationMs()).thenReturn(86400000L);

        JwtResponse response = authService.login(req);

        assertThat(response).isNotNull();
        assertThat(response.getToken()).isEqualTo("mock-jwt-token");
        assertThat(response.getUsername()).isEqualTo("admin");
        assertThat(response.getRole()).isEqualTo("ROLE_ADMIN");
        verify(auditLogService, times(1)).logAction(eq("LOGIN"), eq("USER"), eq("admin"), anyString());
    }

    @Test
    @DisplayName("login throws AppException on authentication failure")
    void testLoginFailure() {
        LoginRequest req = new LoginRequest();
        req.setUsername("admin");
        req.setPassword("wrongpassword");

        when(authenticationManager.authenticate(any(UsernamePasswordAuthenticationToken.class)))
                .thenThrow(new BadCredentialsException("Bad credentials"));

        assertThatThrownBy(() -> authService.login(req))
                .isInstanceOf(AppException.class)
                .hasMessageContaining("Tên đăng nhập hoặc mật khẩu không chính xác");
    }

    @Test
    @DisplayName("register throws ConflictException when username is admin")
    void testRegisterAdminConflict() {
        RegisterRequest req = new RegisterRequest();
        req.setUsername("admin");
        req.setPassword("secret");

        assertThatThrownBy(() -> authService.register(req))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("Username already exists");
    }

    @Test
    @DisplayName("register throws ConflictException when user already exists")
    void testRegisterExistingUserConflict() {
        RegisterRequest req = new RegisterRequest();
        req.setUsername("existinguser");
        req.setPassword("secret");

        when(userRepository.findByUsername("existinguser")).thenReturn(Optional.of(new UserEntity()));

        assertThatThrownBy(() -> authService.register(req))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("Username already exists");
    }

    @Test
    @DisplayName("register creates user and generates JWT token")
    void testRegisterSuccess() {
        RegisterRequest req = new RegisterRequest();
        req.setUsername("newuser");
        req.setPassword("newpass123");
        req.setFullName("New User Account");

        when(userRepository.findByUsername("newuser")).thenReturn(Optional.empty());
        when(passwordEncoder.encode("newpass123")).thenReturn("encoded-pass");

        CustomUserDetails userDetails = CustomUserDetails.builder()
                .username("newuser")
                .password("encoded-pass")
                .fullName("New User Account")
                .role("ROLE_USER")
                .active(true)
                .build();
        Authentication auth = new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());
        when(authenticationManager.authenticate(any(UsernamePasswordAuthenticationToken.class))).thenReturn(auth);
        when(tokenProvider.generateToken(auth)).thenReturn("mock-new-jwt-token");
        when(tokenProvider.getExpirationMs()).thenReturn(86400000L);

        JwtResponse response = authService.register(req);

        assertThat(response).isNotNull();
        assertThat(response.getToken()).isEqualTo("mock-new-jwt-token");
        assertThat(response.getUsername()).isEqualTo("newuser");
        verify(userRepository, times(1)).save(any(UserEntity.class));
        verify(auditLogService, times(1)).logAction(eq("REGISTER"), eq("USER"), eq("newuser"), anyString());
    }

    @Test
    @DisplayName("createApiToken creates a token with correct structure")
    void testCreateApiToken() {
        UserEntity user = UserEntity.builder()
                .userId("usr-testuser")
                .username("testuser")
                .apiTokens(new java.util.ArrayList<>())
                .build();
        when(userRepository.findByUsername("testuser")).thenReturn(Optional.of(user));

        CreateApiTokenRequest req = new CreateApiTokenRequest();
        req.setName("CLI Token");
        req.setDurationMonths(3);

        ApiTokenItem tokenItem = authService.createApiToken("testuser", req);

        assertThat(tokenItem).isNotNull();
        assertThat(tokenItem.getName()).isEqualTo("CLI Token");
        assertThat(tokenItem.getToken()).startsWith("xreg_");
        assertThat(tokenItem.getTokenId()).startsWith("tok-");
        assertThat(tokenItem.getActive()).isTrue();
        verify(userRepository, times(1)).save(any(UserEntity.class));
    }
}
