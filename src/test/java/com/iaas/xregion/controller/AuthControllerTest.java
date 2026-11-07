package com.iaas.xregion.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Controllers.AuthController;
import com.iaas.xregion.Model.Request.LoginRequest;
import com.iaas.xregion.Model.Request.RegisterRequest;
import com.iaas.xregion.Model.Response.JwtResponse;
import com.iaas.xregion.Security.JwtAuthenticationFilter;
import com.iaas.xregion.Services.AuthService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(AuthController.class)
@AutoConfigureMockMvc(addFilters = false)
class AuthControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private AuthService authService;

    @MockBean
    private JwtAuthenticationFilter jwtAuthenticationFilter;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    @DisplayName("GET /api/auth/health responds with HTTP 200 and status UP")
    void testHealthEndpoint() throws Exception {
        mockMvc.perform(get("/api/auth/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"))
                .andExpect(jsonPath("$.service").value("xregion"))
                .andExpect(jsonPath("$.timezone").value("Asia/Ho_Chi_Minh (UTC+7)"));
    }

    @Test
    @DisplayName("POST /api/auth/login returns JWT token upon valid credentials")
    void testLoginSuccess() throws Exception {
        JwtResponse jwtResponse = JwtResponse.builder()
                .token("mock-jwt-token-xyz")
                .type("Bearer")
                .username("admin")
                .fullName("IaaS Super Administrator")
                .role("ROLE_ADMIN")
                .expiresIn(86400L)
                .build();

        Mockito.when(authService.login(any(LoginRequest.class))).thenReturn(jwtResponse);

        LoginRequest req = new LoginRequest();
        req.setUsername("admin");
        req.setPassword("admin123");

        mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.message").value("Login successful"))
                .andExpect(jsonPath("$.data.token").value("mock-jwt-token-xyz"))
                .andExpect(jsonPath("$.data.username").value("admin"))
                .andExpect(jsonPath("$.data.role").value("ROLE_ADMIN"));
    }

    @Test
    @DisplayName("POST /api/auth/register returns JWT token upon valid registration")
    void testRegisterSuccess() throws Exception {
        JwtResponse jwtResponse = JwtResponse.builder()
                .token("mock-registered-token")
                .type("Bearer")
                .username("newdeveloper")
                .fullName("Developer")
                .role("ROLE_USER")
                .expiresIn(86400L)
                .build();

        Mockito.when(authService.register(any(RegisterRequest.class))).thenReturn(jwtResponse);

        RegisterRequest req = new RegisterRequest();
        req.setUsername("newdeveloper");
        req.setPassword("DevPass123!");
        req.setFullName("Developer");

        mockMvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.token").value("mock-registered-token"))
                .andExpect(jsonPath("$.data.username").value("newdeveloper"));
    }
}
