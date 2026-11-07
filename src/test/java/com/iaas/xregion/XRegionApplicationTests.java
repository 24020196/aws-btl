package com.iaas.xregion;

import com.iaas.xregion.config.TestMockConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(TestMockConfig.class)
class XRegionApplicationTests {

    @Autowired
    private MockMvc mockMvc;

    @Test
    @DisplayName("Context loads & GET /api/auth/health returns status UP")
    void testContextLoadsAndHealth() throws Exception {
        mockMvc.perform(get("/api/auth/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"))
                .andExpect(jsonPath("$.service").value("xregion"))
                .andExpect(jsonPath("$.timezone").value("Asia/Ho_Chi_Minh (UTC+7)"));
    }

    @Test
    @DisplayName("Protected endpoint GET /api/instances returns 401/403 when unauthenticated")
    void testProtectedEndpointRequiresAuth() throws Exception {
        mockMvc.perform(get("/api/instances"))
                .andExpect(status().isForbidden());
    }
}
