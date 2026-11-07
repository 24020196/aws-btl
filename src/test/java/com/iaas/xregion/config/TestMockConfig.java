package com.iaas.xregion.config;

import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Config.DynamoDbTableInitializer;
import com.iaas.xregion.Entity.FlavorEntity;
import com.iaas.xregion.Entity.ImageEntity;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Entity.UserEntity;
import org.mockito.Mockito;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.DescribeTableRequest;
import software.amazon.awssdk.services.dynamodb.model.DescribeTableResponse;
import software.amazon.awssdk.services.dynamodb.model.TableDescription;
import software.amazon.awssdk.services.dynamodb.model.TableStatus;

@TestConfiguration
public class TestMockConfig {

    @Bean
    @Primary
    public DynamoDbClient mockDynamoDbClient() {
        DynamoDbClient client = Mockito.mock(DynamoDbClient.class);
        TableDescription tableDesc = TableDescription.builder()
                .tableName("mock-table")
                .tableStatus(TableStatus.ACTIVE)
                .itemCount(0L)
                .tableArn("arn:aws:dynamodb:ap-southeast-2:123456789012:table/mock-table")
                .build();
        DescribeTableResponse response = DescribeTableResponse.builder()
                .table(tableDesc)
                .build();
        Mockito.when(client.describeTable(Mockito.any(DescribeTableRequest.class)))
                .thenReturn(response);
        return client;
    }

    @Bean
    @Primary
    public DynamoDbEnhancedClient mockDynamoDbEnhancedClient() {
        return Mockito.mock(DynamoDbEnhancedClient.class);
    }

    @Bean
    @Primary
    @SuppressWarnings("unchecked")
    public DynamoDbTable<InstanceEntity> mockInstancesTable() {
        return Mockito.mock(DynamoDbTable.class);
    }

    @Bean
    @Primary
    @SuppressWarnings("unchecked")
    public DynamoDbTable<MigrationEntity> mockMigrationsTable() {
        return Mockito.mock(DynamoDbTable.class);
    }

    @Bean
    @Primary
    @SuppressWarnings("unchecked")
    public DynamoDbTable<UserEntity> mockUsersTable() {
        return Mockito.mock(DynamoDbTable.class);
    }

    @Bean
    @Primary
    @SuppressWarnings("unchecked")
    public DynamoDbTable<ImageEntity> mockImagesTable() {
        return Mockito.mock(DynamoDbTable.class);
    }

    @Bean
    @Primary
    @SuppressWarnings("unchecked")
    public DynamoDbTable<FlavorEntity> mockFlavorsTable() {
        return Mockito.mock(DynamoDbTable.class);
    }

    @Bean
    @Primary
    public DynamoDbTableInitializer mockDynamoDbTableInitializer() {
        return Mockito.mock(DynamoDbTableInitializer.class);
    }

    @Bean
    @Primary
    public EventBridgeGatewayClient mockEventBridgeGatewayClient() {
        return Mockito.mock(EventBridgeGatewayClient.class);
    }
}
