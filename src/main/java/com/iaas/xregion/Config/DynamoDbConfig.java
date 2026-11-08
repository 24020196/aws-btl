package com.iaas.xregion.Config;

import com.iaas.xregion.Entity.FlavorEntity;
import com.iaas.xregion.Entity.ImageEntity;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Entity.NovaEntity;
import com.iaas.xregion.Entity.UserEntity;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.DynamoDbClientBuilder;

import java.net.URI;

@Slf4j
@Configuration
public class DynamoDbConfig {

    @Value("${aws.region:ap-southeast-2}")
    private String awsRegion;

    @Value("${aws.accessKeyId:}")
    private String accessKeyId;

    @Value("${aws.secretAccessKey:}")
    private String secretAccessKey;

    @Value("${dynamodb.instancesTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Instances}")
    private String instancesTableArn;

    @Value("${dynamodb.migrationsTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Migrations}")
    private String migrationsTableArn;

    @Value("${dynamodb.novaTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Nova}")
    private String novaTableArn;

    @Value("${dynamodb.usersTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Users}")
    private String usersTableArn;

    @Value("${dynamodb.imagesTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Images}")
    private String imagesTableArn;

    @Value("${dynamodb.flavorsTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Flavors}")
    private String flavorsTableArn;

    @Value("${dynamodb.endpoint:}")
    private String endpoint;

    public static String parseTableNameFromArn(String arn, String fallback) {
        if (arn != null && arn.startsWith("arn:aws:dynamodb:")) {
            String[] parts = arn.split(":");
            if (parts.length >= 6 && parts[5].startsWith("table/")) {
                return parts[5].substring(6).trim();
            }
        }
        return (arn != null && !arn.trim().isEmpty()) ? arn.trim() : fallback;
    }

    public static String parseRegionFromArn(String arn, String fallbackRegion) {
        if (arn != null && arn.startsWith("arn:aws:dynamodb:")) {
            String[] parts = arn.split(":");
            if (parts.length >= 4 && !parts[3].trim().isEmpty()) {
                return parts[3].trim();
            }
        }
        return fallbackRegion;
    }

    @Bean
    public software.amazon.awssdk.auth.credentials.AwsCredentialsProvider awsCredentialsProvider() {
        if (accessKeyId != null && !accessKeyId.trim().isEmpty() &&
            secretAccessKey != null && !secretAccessKey.trim().isEmpty()) {
            log.info("Initialized StaticCredentialsProvider with configured IAM Access Key");
            return StaticCredentialsProvider.create(
                    AwsBasicCredentials.create(accessKeyId.trim(), secretAccessKey.trim())
            );
        }
        log.info("Initialized DefaultCredentialsProvider for AWS components");
        return DefaultCredentialsProvider.create();
    }

    @Bean
    public DynamoDbClient dynamoDbClient(software.amazon.awssdk.auth.credentials.AwsCredentialsProvider credentialsProvider) {
        String regionCode = parseRegionFromArn(instancesTableArn, awsRegion);
        DynamoDbClientBuilder builder = DynamoDbClient.builder()
                .region(Region.of(regionCode));

        // 1. If custom local endpoint is provided (for offline testing)
        if (endpoint != null && !endpoint.trim().isEmpty()) {
            log.info("Connecting to local DynamoDB endpoint: {}", endpoint);
            builder.endpointOverride(URI.create(endpoint.trim()));
            builder.credentialsProvider(StaticCredentialsProvider.create(
                    AwsBasicCredentials.create("dummy_local_key", "dummy_local_secret")
            ));
        } else {
            builder.credentialsProvider(credentialsProvider);
        }

        return builder.build();
    }

    @Bean
    public DynamoDbEnhancedClient dynamoDbEnhancedClient(DynamoDbClient dynamoDbClient) {
        return DynamoDbEnhancedClient.builder()
                .dynamoDbClient(dynamoDbClient)
                .build();
    }

    @Bean
    public DynamoDbTable<InstanceEntity> instancesTable(DynamoDbEnhancedClient enhancedClient) {
        String tableName = parseTableNameFromArn(instancesTableArn, "XRegion-Instances");
        log.info("Initialized DynamoDB table bean for instances: {}", tableName);
        return enhancedClient.table(tableName, TableSchema.fromBean(InstanceEntity.class));
    }

    @Bean
    public DynamoDbTable<NovaEntity> novaTable(DynamoDbEnhancedClient enhancedClient) {
        String tableName = parseTableNameFromArn(novaTableArn, "XRegion-Nova");
        log.info("Initialized DynamoDB table bean for nova: {}", tableName);
        return enhancedClient.table(tableName, TableSchema.fromBean(NovaEntity.class));
    }

    @Bean
    public DynamoDbTable<MigrationEntity> migrationsTable(DynamoDbEnhancedClient enhancedClient) {
        String tableName = parseTableNameFromArn(migrationsTableArn, "XRegion-Migrations");
        log.info("Initialized DynamoDB table bean for migrations: {}", tableName);
        return enhancedClient.table(tableName, TableSchema.fromBean(MigrationEntity.class));
    }

    @Bean
    public DynamoDbTable<UserEntity> usersTable(DynamoDbEnhancedClient enhancedClient) {
        String tableName = parseTableNameFromArn(usersTableArn, "XRegion-Users");
        log.info("Initialized DynamoDB table bean for users: {}", tableName);
        return enhancedClient.table(tableName, TableSchema.fromBean(UserEntity.class));
    }

    @Bean
    public DynamoDbTable<ImageEntity> imagesTable(DynamoDbEnhancedClient enhancedClient) {
        String tableName = parseTableNameFromArn(imagesTableArn, "XRegion-Images");
        log.info("Initialized DynamoDB table bean for images: {}", tableName);
        return enhancedClient.table(tableName, TableSchema.fromBean(ImageEntity.class));
    }

    @Bean
    public DynamoDbTable<FlavorEntity> flavorsTable(DynamoDbEnhancedClient enhancedClient) {
        String tableName = parseTableNameFromArn(flavorsTableArn, "XRegion-Flavors");
        log.info("Initialized DynamoDB table bean for flavors: {}", tableName);
        return enhancedClient.table(tableName, TableSchema.fromBean(FlavorEntity.class));
    }
}
