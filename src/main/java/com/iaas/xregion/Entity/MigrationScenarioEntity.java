package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;

/**
 * Maps to live AWS DynamoDB table: XRegion-MigrationScenarios
 * Primary Key: scenario_id (S) - UUID 36 chars (SPEC-03 v1.3.0)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MigrationScenarioEntity {

    private String scenarioId;
    private String name;
    private String status;
    private String triggerType;
    private String dayTime;
    private String nightTime;
    private String cronExpression;
    private Integer cooldownMinutes;
    private Long updatedAt;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("scenario_id")
    public String getScenarioId() {
        return scenarioId;
    }

    @DynamoDbAttribute("name")
    public String getName() {
        return name;
    }

    @DynamoDbAttribute("status")
    public String getStatus() {
        return status;
    }

    @DynamoDbAttribute("trigger_type")
    public String getTriggerType() {
        return triggerType;
    }

    @DynamoDbAttribute("day_time")
    public String getDayTime() {
        return dayTime;
    }

    @DynamoDbAttribute("night_time")
    public String getNightTime() {
        return nightTime;
    }

    @DynamoDbAttribute("cron_expression")
    public String getCronExpression() {
        return cronExpression;
    }

    @DynamoDbAttribute("cooldown_minutes")
    public Integer getCooldownMinutes() {
        return cooldownMinutes;
    }

    @DynamoDbAttribute("updated_at")
    public Long getUpdatedAt() {
        return updatedAt;
    }
}
