package com.iaas.xregion.Config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.DescribeTableRequest;
import software.amazon.awssdk.services.dynamodb.model.TableDescription;
import java.util.List;

@Slf4j
@Component
public class DynamoDbTableInitializer implements ApplicationRunner {

    private final DynamoDbClient dynamoDbClient;
    private final List<String> expectedTableArns;
    private final boolean localEndpoint;

    public DynamoDbTableInitializer(DynamoDbClient dynamoDbClient,
                                    @Value("${dynamodb.instancesTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-Instances}") String instancesTableArn,
                                    @Value("${dynamodb.migrationsTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-Migrations}") String migrationsTableArn,
                                    @Value("${dynamodb.usersTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-Users}") String usersTableArn,
                                    @Value("${dynamodb.novaTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-Nova}") String novaTableArn,
                                    @Value("${dynamodb.migrationScenariosTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-MigrationScenarios}") String migrationScenariosTableArn,
                                    @Value("${dynamodb.imagesTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-Images}") String imagesTableArn,
                                    @Value("${dynamodb.flavorsTableArn:arn:aws:dynamodb:ap-southeast-2:348498387626:table/XRegion-Flavors}") String flavorsTableArn,
                                    @Value("${dynamodb.endpoint:}") String endpoint) {
        this.dynamoDbClient = dynamoDbClient;
        this.expectedTableArns = List.of(instancesTableArn, migrationsTableArn, usersTableArn, novaTableArn,
                migrationScenariosTableArn, imagesTableArn, flavorsTableArn);
        this.localEndpoint = endpoint != null && !endpoint.isBlank();
    }

    @Override
    public void run(ApplicationArguments args) {
        for (String expectedArn : expectedTableArns) {
            verifyTable(expectedArn);
        }
    }

    private void verifyTable(String expectedArn) {
        String tableName = DynamoDbConfig.parseTableNameFromArn(expectedArn, expectedArn);
        try {
            TableDescription table = dynamoDbClient.describeTable(DescribeTableRequest.builder().tableName(tableName).build()).table();
            if (!localEndpoint && !expectedArn.equals(table.tableArn())) {
                throw new IllegalStateException("DynamoDB table ARN mismatch: expected " + expectedArn
                        + " but AWS returned " + table.tableArn());
            }
            log.info("AWS DynamoDB Table [{}] is healthy. Status: {}, KeySchema: {}, Attributes: {}, Item count: {}, ARN: {}", 
                    tableName, table.tableStatus(), table.keySchema(), table.attributeDefinitions(), table.itemCount(), table.tableArn());
        } catch (Exception e) {
            if (!localEndpoint) {
                throw new IllegalStateException("Could not verify configured DynamoDB table " + expectedArn, e);
            }
            log.warn("Could not describe table [{}]: {}. Ensure AWS credentials and network connection are active.", tableName, e.getMessage());
        }
    }
}
