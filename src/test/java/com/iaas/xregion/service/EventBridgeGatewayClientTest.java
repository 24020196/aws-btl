package com.iaas.xregion.service;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

class EventBridgeGatewayClientTest {

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
}
