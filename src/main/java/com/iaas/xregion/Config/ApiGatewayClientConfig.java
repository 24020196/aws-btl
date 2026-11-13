package com.iaas.xregion.Config;

import com.iaas.xregion.Client.AwsSigV4Interceptor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

@Slf4j
@Configuration
public class ApiGatewayClientConfig {

    private static final String DEFAULT_EVENT_ENDPOINT =
            "https://oqp7jmg7je.execute-api.ap-southeast-2.amazonaws.com/prod/events";

    @Value("${aws.region:ap-southeast-2}")
    private String awsRegion;

    @Value("${aws.apigateway.eventEndpoint:" + DEFAULT_EVENT_ENDPOINT + "}")
    private String eventEndpoint;

    @Value("${aws.apigateway.eventEndpoints.ap-southeast-2:" + DEFAULT_EVENT_ENDPOINT + "}")
    private String apSoutheast2EventEndpoint;

    @Value("${aws.apigateway.eventEndpoints.us-east-1:https://dawfyj0692.execute-api.us-east-1.amazonaws.com/prod/events}")
    private String usEast1EventEndpoint;

    /**
     * Bảng RestClient theo mã vùng.
     *
     * <p>Mỗi API Gateway trong dự án là một REST API riêng của từng vùng và yêu cầu AWS_IAM,
     * nên chữ ký SigV4 phải dùng đúng region của gateway đích: gửi sự kiện của vùng
     * {@code us-east-1} bằng chữ ký {@code ap-southeast-2} sẽ bị API Gateway trả 403.
     */
    public static class RegionEventGatewayClients {

        private final Map<String, RestClient> clientsByRegion;

        public RegionEventGatewayClients(Map<String, RestClient> clientsByRegion) {
            this.clientsByRegion = clientsByRegion;
        }

        /**
         * @param region mã vùng của API Gateway đích (ví dụ {@code us-east-1})
         * @return RestClient đã ký đúng region, hoặc {@code null} nếu vùng không được cấu hình
         */
        public RestClient byRegion(String region) {
            return (region == null) ? null : clientsByRegion.get(region.trim());
        }

        public Set<String> configuredRegions() {
            return clientsByRegion.keySet();
        }
    }

    @Bean
    public RestClient eventBridgeRestClient(AwsCredentialsProvider credentialsProvider) {
        return buildRestClient(credentialsProvider, awsRegion, eventEndpoint);
    }

    @Bean
    public RegionEventGatewayClients regionEventGatewayClients(AwsCredentialsProvider credentialsProvider) {
        Map<String, RestClient> clients = new LinkedHashMap<>();
        clients.put("ap-southeast-2", buildRestClient(credentialsProvider, "ap-southeast-2", apSoutheast2EventEndpoint));
        clients.put("us-east-1", buildRestClient(credentialsProvider, "us-east-1", usEast1EventEndpoint));
        log.info("Bảng định tuyến API Gateway EventBridge theo vùng: {}", clients.keySet());
        return new RegionEventGatewayClients(clients);
    }

    private RestClient buildRestClient(AwsCredentialsProvider credentialsProvider, String region, String endpoint) {
        log.info("Khởi tạo RestClient cho API Gateway EventBridge: Endpoint=[{}], Region=[{}]", endpoint, region);

        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5000);
        requestFactory.setReadTimeout(10000);

        log.info("Sử dụng AwsSigV4Interceptor xác thực với API Gateway qua chuẩn bảo mật AWS_IAM (Signature Version 4)");
        ClientHttpRequestInterceptor authInterceptor = new AwsSigV4Interceptor(credentialsProvider, region, "execute-api");

        return RestClient.builder()
                .baseUrl(endpoint)
                .requestFactory(requestFactory)
                .requestInterceptor(authInterceptor)
                .defaultHeader("Content-Type", "application/json")
                .defaultHeader("Accept", "application/json")
                .build();
    }
}
