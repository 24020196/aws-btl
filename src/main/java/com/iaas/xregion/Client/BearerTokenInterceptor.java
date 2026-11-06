package com.iaas.xregion.Client;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

import java.io.IOException;

/**
 * Interceptor tự động gắn Bearer Token vào header Authorization khi gọi AWS API Gateway.
 */
@Slf4j
public class BearerTokenInterceptor implements ClientHttpRequestInterceptor {

    private final String apiToken;

    public BearerTokenInterceptor(String apiToken) {
        this.apiToken = apiToken;
    }

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution) throws IOException {
        if (apiToken != null && !apiToken.trim().isEmpty()) {
            String tokenValue = apiToken.trim();
            if (!tokenValue.toLowerCase().startsWith("bearer ")) {
                tokenValue = "Bearer " + tokenValue;
            }
            request.getHeaders().set("Authorization", tokenValue);
        } else {
            log.warn("Chưa cấu hình API Token cho API Gateway (aws.apigateway.apiToken rỗng)");
        }
        return execution.execute(request, body);
    }
}

