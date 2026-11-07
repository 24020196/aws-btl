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

@Slf4j
@Configuration
public class ApiGatewayClientConfig {

    @Value("${aws.region:ap-southeast-2}")
    private String awsRegion;

    @Value("${aws.apigateway.eventEndpoint:https://oqp7jmg7je.execute-api.ap-southeast-2.amazonaws.com/prod/events}")
    private String eventEndpoint;

    @Bean
    public RestClient eventBridgeRestClient(AwsCredentialsProvider credentialsProvider) {
        log.info("Khởi tạo RestClient cho API Gateway EventBridge: Endpoint=[{}], Region=[{}]", eventEndpoint, awsRegion);

        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5000);
        requestFactory.setReadTimeout(10000);

        log.info("Sử dụng AwsSigV4Interceptor xác thực với API Gateway qua chuẩn bảo mật AWS_IAM (Signature Version 4)");
        ClientHttpRequestInterceptor authInterceptor = new AwsSigV4Interceptor(credentialsProvider, awsRegion, "execute-api");

        return RestClient.builder()
                .baseUrl(eventEndpoint)
                .requestFactory(requestFactory)
                .requestInterceptor(authInterceptor)
                .defaultHeader("Content-Type", "application/json")
                .defaultHeader("Accept", "application/json")
                .build();
    }
}
