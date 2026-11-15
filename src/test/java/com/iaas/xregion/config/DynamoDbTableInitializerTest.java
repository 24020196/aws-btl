package com.iaas.xregion.config;

import com.iaas.xregion.Config.DynamoDbTableInitializer;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class DynamoDbTableInitializerTest {
    private final DynamoDbClient client = mock(DynamoDbClient.class);
    private static final String PREFIX = "arn:aws:dynamodb:ap-southeast-2:348498387626:table/";

    private DynamoDbTableInitializer initializer(String endpoint) {
        return new DynamoDbTableInitializer(client, PREFIX + "XRegion-Instances", PREFIX + "XRegion-Migrations",
                PREFIX + "XRegion-Users", PREFIX + "XRegion-Nova", PREFIX + "XRegion-MigrationScenarios",
                PREFIX + "XRegion-Images", PREFIX + "XRegion-Flavors", endpoint);
    }

    @Test
    void rejectsHealthyTableFromWrongAccount() {
        when(client.describeTable(any(DescribeTableRequest.class))).thenReturn(DescribeTableResponse.builder()
                .table(TableDescription.builder().tableStatus(TableStatus.ACTIVE)
                        .tableArn("arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Instances").build()).build());
        var error = assertThrows(IllegalStateException.class, () -> initializer("").run(null));
        assertTrue(error.getCause().getMessage().contains("ARN mismatch"));
    }

    @Test
    void verifiesAllSevenTables() {
        when(client.describeTable(any(DescribeTableRequest.class))).thenAnswer(invocation -> {
            DescribeTableRequest request = invocation.getArgument(0);
            return DescribeTableResponse.builder().table(TableDescription.builder()
                    .tableArn(PREFIX + request.tableName()).tableStatus(TableStatus.ACTIVE).build()).build();
        });
        assertDoesNotThrow(() -> initializer("").run(null));
        verify(client, times(7)).describeTable(any(DescribeTableRequest.class));
    }

    @Test
    void failsStartupIfCloudTableCannotBeVerified() {
        when(client.describeTable(any(DescribeTableRequest.class)))
                .thenThrow(ResourceNotFoundException.builder().message("Table missing").build());
        assertThrows(IllegalStateException.class, () -> initializer("").run(null));
    }

    @Test
    void preservesLocalDynamoDbSupport() {
        when(client.describeTable(any(DescribeTableRequest.class)))
                .thenThrow(ResourceNotFoundException.builder().message("Local table missing").build());
        assertDoesNotThrow(() -> initializer("http://localhost:8000").run(null));
    }
}
