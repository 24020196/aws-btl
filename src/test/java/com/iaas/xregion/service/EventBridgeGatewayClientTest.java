package com.iaas.xregion.service;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.jsonPath;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

class EventBridgeGatewayClientTest {

    @Test
    void launchUsesCanonicalSizeImageAndUsername() {
        RestClient.Builder builder = RestClient.builder().baseUrl("https://example.test");
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        server.expect(requestTo("https://example.test"))
                .andExpect(jsonPath("$.detailType").value("instance.launch"))
                .andExpect(jsonPath("$.detail.size_gb").value(25))
                .andExpect(jsonPath("$.detail.image_id").value("image-123"))
                .andExpect(jsonPath("$.detail.username").value("lam"))
                .andExpect(jsonPath("$.detail.ebs_size_gb").doesNotExist())
                .andExpect(jsonPath("$.detail.image_name").doesNotExist())
                .andExpect(jsonPath("$.detail.user").doesNotExist())
                .andExpect(jsonPath("$.detail.user_id").doesNotExist())
                .andRespond(withSuccess("{\"FailedEntryCount\":0,\"Entries\":[{\"EventId\":\"event-123\"}]}",
                        MediaType.APPLICATION_JSON));

        EventBridgeGatewayClient client = new EventBridgeGatewayClient(builder.build());
        client.sendInstanceLaunchEvent("i-123", "vm", 25, "gp3", "m1.medium",
                "image-123", "key-123", "lam");
        server.verify();
    }

    @Test
    void routesToSelectedRegionGateway() {
        RestClient.Builder defaultBuilder = RestClient.builder().baseUrl("https://default.test");
        MockRestServiceServer defaultServer = MockRestServiceServer.bindTo(defaultBuilder).build();

        RestClient.Builder virginiaBuilder = RestClient.builder().baseUrl("https://virginia.test");
        MockRestServiceServer virginiaServer = MockRestServiceServer.bindTo(virginiaBuilder).build();

        virginiaServer.expect(requestTo("https://virginia.test"))
                .andExpect(jsonPath("$.detailType").value("instance.launch"))
                .andExpect(jsonPath("$.detail.target_region").value("us-east-1"))
                .andRespond(withSuccess("{\"FailedEntryCount\":0,\"Entries\":[{\"EventId\":\"evt-va-1\"}]}",
                        MediaType.APPLICATION_JSON));

        var regionClients = new com.iaas.xregion.Config.ApiGatewayClientConfig.RegionEventGatewayClients(
                java.util.Map.of("us-east-1", virginiaBuilder.build(), "ap-southeast-2", defaultBuilder.build()));

        EventBridgeGatewayClient client = new EventBridgeGatewayClient(defaultBuilder.build(), regionClients);
        client.sendInstanceLaunchEvent("i-va", "vm-va", 1, "gp3", "m1.tiny", "img-1", "key-1", "user1",
                "us-east-1", null, null);

        virginiaServer.verify();
        defaultServer.verify();
    }

    @Test
    void securityGroupSyncEventCarriesRevisionAndNovaId() {
        RestClient.Builder builder = RestClient.builder().baseUrl("https://example.test");
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        server.expect(requestTo("https://example.test"))
                .andExpect(jsonPath("$.source").value("xregion.backend.security"))
                .andExpect(jsonPath("$.detailType").value("security-group.updated"))
                .andExpect(jsonPath("$.detail.group_id").value("sg-abc"))
                .andExpect(jsonPath("$.detail.instance_id").value("i-4c0906ee"))
                .andExpect(jsonPath("$.detail.nova_id").value("nova-1"))
                .andExpect(jsonPath("$.detail.revision").value(6))
                .andExpect(jsonPath("$.detail.rule_count").value(4))
                .andRespond(withSuccess("{\"FailedEntryCount\":0,\"Entries\":[{\"EventId\":\"event-1\"}]}",
                        MediaType.APPLICATION_JSON));

        new EventBridgeGatewayClient(builder.build())
                .sendSecurityGroupSyncEvent("sg-abc", "i-4c0906ee", "nova-1", 6, 4, "lam");
        server.verify();
    }

    @Test
    void rejectsPartialPutEventsFailure() {
        RestClient.Builder builder = RestClient.builder().baseUrl("https://example.test");
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        server.expect(requestTo("https://example.test"))
                .andRespond(withSuccess("{\"FailedEntryCount\":1,\"Entries\":[{\"ErrorCode\":\"InternalFailure\"}]}",
                        MediaType.APPLICATION_JSON));

        EventBridgeGatewayClient client = new EventBridgeGatewayClient(builder.build());
        assertThatThrownBy(() -> client.sendEvent("test.source", "test.type", java.util.Map.of("id", "1")))
                .isInstanceOf(EventBridgeGatewayClient.EventRejectedException.class);
        server.verify();
    }

    @Test
    void rejectsEmptyResponse() {
        RestClient.Builder builder = RestClient.builder().baseUrl("https://example.test");
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        server.expect(requestTo("https://example.test"))
                .andRespond(withSuccess("", MediaType.APPLICATION_JSON));

        EventBridgeGatewayClient client = new EventBridgeGatewayClient(builder.build());
        assertThatThrownBy(() -> client.sendEvent("test.source", "test.type", java.util.Map.of("id", "1")))
                .isInstanceOf(RuntimeException.class);
        server.verify();
    }

    @Test
    void keySyncFansOutToBothRegions() {
        RestClient.Builder sydneyBuilder = RestClient.builder().baseUrl("https://sydney.test");
        MockRestServiceServer sydneyServer = MockRestServiceServer.bindTo(sydneyBuilder).build();

        RestClient.Builder virginiaBuilder = RestClient.builder().baseUrl("https://virginia.test");
        MockRestServiceServer virginiaServer = MockRestServiceServer.bindTo(virginiaBuilder).build();

        sydneyServer.expect(requestTo("https://sydney.test"))
                .andExpect(jsonPath("$.detailType").value("key.import"))
                .andExpect(jsonPath("$.detail.key_id").value("key-1"))
                .andRespond(withSuccess("{\"FailedEntryCount\":0,\"Entries\":[{\"EventId\":\"evt-sy-key\"}]}",
                        MediaType.APPLICATION_JSON));

        virginiaServer.expect(requestTo("https://virginia.test"))
                .andExpect(jsonPath("$.detailType").value("key.import"))
                .andExpect(jsonPath("$.detail.key_id").value("key-1"))
                .andRespond(withSuccess("{\"FailedEntryCount\":0,\"Entries\":[{\"EventId\":\"evt-va-key\"}]}",
                        MediaType.APPLICATION_JSON));

        var regionClients = new com.iaas.xregion.Config.ApiGatewayClientConfig.RegionEventGatewayClients(
                java.util.Map.of("us-east-1", virginiaBuilder.build(), "ap-southeast-2", sydneyBuilder.build()));

        EventBridgeGatewayClient client = new EventBridgeGatewayClient(sydneyBuilder.build(), regionClients);
        client.sendKeySyncEvent("key-1", "RSA 2048", "pub-key", "fingerprint-123",
                java.util.List.of("ap-southeast-2", "us-east-1"), "lam");

        sydneyServer.verify();
        virginiaServer.verify();
    }

    @Test
    void securityGroupSyncRoutesByRegion() {
        RestClient.Builder sydneyBuilder = RestClient.builder().baseUrl("https://sydney.test");
        MockRestServiceServer sydneyServer = MockRestServiceServer.bindTo(sydneyBuilder).build();

        RestClient.Builder virginiaBuilder = RestClient.builder().baseUrl("https://virginia.test");
        MockRestServiceServer virginiaServer = MockRestServiceServer.bindTo(virginiaBuilder).build();

        virginiaServer.expect(requestTo("https://virginia.test"))
                .andExpect(jsonPath("$.detailType").value("security-group.updated"))
                .andExpect(jsonPath("$.detail.instance_id").value("i-va-1"))
                .andRespond(withSuccess("{\"FailedEntryCount\":0,\"Entries\":[{\"EventId\":\"evt-va-sg\"}]}",
                        MediaType.APPLICATION_JSON));

        var regionClients = new com.iaas.xregion.Config.ApiGatewayClientConfig.RegionEventGatewayClients(
                java.util.Map.of("us-east-1", virginiaBuilder.build(), "ap-southeast-2", sydneyBuilder.build()));

        EventBridgeGatewayClient client = new EventBridgeGatewayClient(sydneyBuilder.build(), regionClients);
        client.sendSecurityGroupSyncEvent("us-east-1", "sg-va", "i-va-1", "nova-va-1", 2L, 3, "lam");

        virginiaServer.verify();
        sydneyServer.verify();
    }

    @Test
    void failClosedWhenRegionInvalidInMultiRegionMode() {
        RestClient.Builder builder = RestClient.builder().baseUrl("https://default.test");
        var regionClients = new com.iaas.xregion.Config.ApiGatewayClientConfig.RegionEventGatewayClients(
                java.util.Map.of("us-east-1", builder.build(), "ap-southeast-2", builder.build()));
        EventBridgeGatewayClient client = new EventBridgeGatewayClient(builder.build(), regionClients);

        assertThatThrownBy(() -> client.sendEvent("eu-central-1", "test.source", "test.type", java.util.Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Vùng mục tiêu không hợp lệ");
    }
}
