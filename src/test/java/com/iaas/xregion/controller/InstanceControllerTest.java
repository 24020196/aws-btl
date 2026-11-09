package com.iaas.xregion.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Controllers.InstanceController;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.InstanceActionRequest;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Model.Response.InstanceResponse;
import com.iaas.xregion.Security.JwtAuthenticationFilter;
import com.iaas.xregion.Services.InstanceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(InstanceController.class)
@AutoConfigureMockMvc(addFilters = false)
class InstanceControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private InstanceService instanceService;

    @MockBean
    private JwtAuthenticationFilter jwtAuthenticationFilter;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    @DisplayName("GET /api/instances returns instance list")
    void testGetAllInstances() throws Exception {
        InstanceResponse res = InstanceResponse.builder()
                .id("i-alpha1")
                .name("Alpha Instance")
                .status("RUNNING")
                .region("ap-southeast-2")
                .flavor("m1.small")
                .build();

        Mockito.when(instanceService.getAllInstances()).thenReturn(List.of(res));

        mockMvc.perform(get("/api/instances"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data[0].id").value("i-alpha1"))
                .andExpect(jsonPath("$.data[0].name").value("Alpha Instance"));
    }

    @Test
    @DisplayName("GET /api/instances/{id} returns instance when exists")
    void testGetInstanceByIdSuccess() throws Exception {
        InstanceResponse res = InstanceResponse.builder()
                .id("i-beta2")
                .name("Beta Instance")
                .status("STOPPED")
                .region("us-east-1")
                .build();

        Mockito.when(instanceService.getInstanceById("i-beta2")).thenReturn(res);

        mockMvc.perform(get("/api/instances/i-beta2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.id").value("i-beta2"))
                .andExpect(jsonPath("$.data.status").value("STOPPED"));
    }

    @Test
    @DisplayName("GET /api/instances/{id} returns 404 when instance not found")
    void testGetInstanceByIdNotFound() throws Exception {
        Mockito.when(instanceService.getInstanceById("i-missing"))
                .thenThrow(new ResourceNotFoundException("Instance not found: i-missing"));

        mockMvc.perform(get("/api/instances/i-missing"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value("Instance not found: i-missing"));
    }

    @Test
    @DisplayName("POST /api/instances launches instance successfully")
    void testLaunchInstanceSuccess() throws Exception {
        LaunchInstanceRequest req = new LaunchInstanceRequest();
        req.setName("Web-Server-1");
        req.setRegion("ap-southeast-2");
        req.setFlavor("m1.medium");
        req.setImageId("img-u22");

        InstanceResponse res = InstanceResponse.builder()
                .id("i-newly-created")
                .name("Web-Server-1")
                .status("PENDING")
                .region("ap-southeast-2")
                .flavor("m1.medium")
                .build();

        Mockito.when(instanceService.launchInstance(any(LaunchInstanceRequest.class))).thenReturn(res);

        mockMvc.perform(post("/api/instances")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(req)))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.message").value("Instance launch request accepted"))
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.id").value("i-newly-created"))
                .andExpect(jsonPath("$.data.status").value("PENDING"));
    }

    @Test
    @DisplayName("POST /api/instances returns 400 when required fields are missing")
    void testLaunchInstanceValidationFailure() throws Exception {
        LaunchInstanceRequest req = new LaunchInstanceRequest();
        // Missing name, region, flavor, imageId

        mockMvc.perform(post("/api/instances")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(req)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value("Validation failed"));
    }

    @Test
    @DisplayName("POST /api/instances/{id}/actions executes lifecycle action")
    void testExecuteAction() throws Exception {
        InstanceActionRequest req = new InstanceActionRequest();
        req.setAction("STOP");

        InstanceResponse res = InstanceResponse.builder()
                .id("i-act1")
                .status("STOPPING")
                .build();

        Mockito.when(instanceService.executeAction(eq("i-act1"), any(InstanceActionRequest.class))).thenReturn(res);

        mockMvc.perform(post("/api/instances/i-act1/actions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(req)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.status").value("STOPPING"));
    }
}
