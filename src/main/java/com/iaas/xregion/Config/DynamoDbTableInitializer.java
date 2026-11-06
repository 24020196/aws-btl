package com.iaas.xregion.Config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.DescribeTableRequest;
import software.amazon.awssdk.services.dynamodb.model.TableDescription;

@Slf4j
@Component
public class DynamoDbTableInitializer implements ApplicationRunner {

    private final DynamoDbClient dynamoDbClient;
    private final String instancesTableName;
    private final String migrationsTableName;
    private final String usersTableName;

    public DynamoDbTableInitializer(DynamoDbClient dynamoDbClient,
                                    @Value("${dynamodb.instancesTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Instances}") String instancesTableArn,
                                    @Value("${dynamodb.migrationsTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Migrations}") String migrationsTableArn,
                                    @Value("${dynamodb.usersTableArn:arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Users}") String usersTableArn) {
        this.dynamoDbClient = dynamoDbClient;
        this.instancesTableName = DynamoDbConfig.parseTableNameFromArn(instancesTableArn, "XRegion-Instances");
        this.migrationsTableName = DynamoDbConfig.parseTableNameFromArn(migrationsTableArn, "XRegion-Migrations");
        this.usersTableName = DynamoDbConfig.parseTableNameFromArn(usersTableArn, "XRegion-Users");
    }

    @Override
    public void run(ApplicationArguments args) {
        log.info("Verifying live connection to AWS DynamoDB tables: [{}], [{}] and [{}]", instancesTableName, migrationsTableName, usersTableName);
        verifyTable(instancesTableName);
        verifyTable(migrationsTableName);
        verifyTable(usersTableName);
    }

    private void verifyTable(String tableName) {
        try {
            TableDescription table = dynamoDbClient.describeTable(DescribeTableRequest.builder().tableName(tableName).build()).table();
            log.info("AWS DynamoDB Table [{}] is healthy. Status: {}, Item count: {}, ARN: {}", 
                    tableName, table.tableStatus(), table.itemCount(), table.tableArn());
        } catch (Exception e) {
            log.warn("Could not describe table [{}]: {}. Ensure AWS credentials and network connection are active.", tableName, e.getMessage());
        }
    }
}
