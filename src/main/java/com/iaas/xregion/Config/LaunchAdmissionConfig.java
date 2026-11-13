package com.iaas.xregion.Config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.ssm.SsmClient;

import java.util.Map;
import java.util.function.Function;

@Configuration
public class LaunchAdmissionConfig {

    @Bean
    public Function<String, SsmClient> ssmClientResolver(AwsCredentialsProvider credentialsProvider) {
        Map<String, SsmClient> clients = Map.of(
                "ap-southeast-2", SsmClient.builder().region(Region.AP_SOUTHEAST_2).credentialsProvider(credentialsProvider).build(),
                "us-east-1", SsmClient.builder().region(Region.US_EAST_1).credentialsProvider(credentialsProvider).build()
        );
        return region -> clients.getOrDefault(region, clients.get("ap-southeast-2"));
    }

    @Bean
    public SsmClient ssmClient(AwsCredentialsProvider credentialsProvider) {
        return SsmClient.builder().region(Region.AP_SOUTHEAST_2).credentialsProvider(credentialsProvider).build();
    }
}

