package com.iaas.xregion.Client;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.signer.Aws4Signer;
import software.amazon.awssdk.auth.signer.params.Aws4SignerParams;
import software.amazon.awssdk.http.SdkHttpFullRequest;
import software.amazon.awssdk.http.SdkHttpMethod;
import software.amazon.awssdk.regions.Region;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.util.Map;

/**
 * Interceptor tự động ký số AWS IAM SigV4 cho mọi HTTP Request gửi tới AWS API Gateway.
 */
@Slf4j
public class AwsSigV4Interceptor implements ClientHttpRequestInterceptor {

    private final AwsCredentialsProvider credentialsProvider;
    private final String region;
    private final String serviceName;
    private final Aws4Signer signer;

    public AwsSigV4Interceptor(AwsCredentialsProvider credentialsProvider, String region, String serviceName) {
        this.credentialsProvider = credentialsProvider;
        this.region = region;
        this.serviceName = serviceName;
        this.signer = Aws4Signer.create();
    }

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution) throws IOException {
        try {
            URI uri = request.getURI();
            SdkHttpFullRequest.Builder sdkRequestBuilder = SdkHttpFullRequest.builder()
                    .method(SdkHttpMethod.fromValue(request.getMethod().name()))
                    .uri(uri);

            // Sao chép headers từ Spring request sang SDK request builder
            request.getHeaders().forEach(sdkRequestBuilder::putHeader);

            // Đảm bảo có Host header
            if (!request.getHeaders().containsKey("Host")) {
                sdkRequestBuilder.putHeader("Host", uri.getHost());
            }

            if (body != null && body.length > 0) {
                sdkRequestBuilder.contentStreamProvider(() -> new ByteArrayInputStream(body));
            }

            Aws4SignerParams params = Aws4SignerParams.builder()
                    .awsCredentials(credentialsProvider.resolveCredentials())
                    .signingName(serviceName)
                    .signingRegion(Region.of(region))
                    .build();

            SdkHttpFullRequest signedRequest = signer.sign(sdkRequestBuilder.build(), params);

            // Sao chép các header đã được ký (Authorization, X-Amz-Date, X-Amz-Security-Token...) trở lại Spring request
            for (Map.Entry<String, List<String>> entry : signedRequest.headers().entrySet()) {
                request.getHeaders().put(entry.getKey(), entry.getValue());
            }
        } catch (Exception e) {
            log.error("Lỗi ký AWS IAM SigV4 cho request tới API Gateway: {}", e.getMessage(), e);
            throw new IOException("Ký AWS SigV4 thất bại: " + e.getMessage(), e);
        }

        return execution.execute(request, body);
    }
}

