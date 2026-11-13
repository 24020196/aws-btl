package com.iaas.xregion.entity;

import com.iaas.xregion.Entity.FlexibleEpochTimestampConverter;
import com.iaas.xregion.Entity.MigrationEntity;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class FlexibleEpochTimestampConverterTest {

    private final FlexibleEpochTimestampConverter converter = new FlexibleEpochTimestampConverter();

    @Test
    void readsNumericEpochFromNumberAttribute() {
        Long result = converter.transformTo(AttributeValue.builder().n("1794564299").build());
        assertThat(result).isEqualTo(1794564299L);
    }

    @Test
    void readsNumericEpochFromStringAttribute() {
        Long result = converter.transformTo(AttributeValue.builder().s("1794564299").build());
        assertThat(result).isEqualTo(1794564299L);
    }

    @Test
    void readsIso8601UtcStringAttribute() {
        String iso = "2026-11-13T10:07:02Z";
        Long result = converter.transformTo(AttributeValue.builder().s(iso).build());
        assertThat(result).isEqualTo(Instant.parse(iso).getEpochSecond());
    }

    @Test
    void readsIso8601OffsetStringAttribute() {
        Long result = converter.transformTo(AttributeValue.builder().s("2026-11-13T17:07:02+07:00").build());
        assertThat(result).isEqualTo(Instant.parse("2026-11-13T10:07:02Z").getEpochSecond());
    }

    @Test
    void handlesNullAndBlankValues() {
        assertThat(converter.transformTo(null)).isNull();
        assertThat(converter.transformTo(AttributeValue.builder().nul(true).build())).isNull();
        assertThat(converter.transformTo(AttributeValue.builder().s("   ").build())).isNull();
    }

    @Test
    void writesEpochAsNumberAttribute() {
        AttributeValue encoded = converter.transformFrom(1794564299L);
        assertThat(encoded.n()).isEqualTo("1794564299");

        AttributeValue encodedNull = converter.transformFrom(null);
        assertThat(encodedNull.nul()).isTrue();
    }

    @Test
    void migrationEntitySchemaMapsIsoCompletedAtWithoutNumberFormatException() {
        TableSchema<MigrationEntity> schema = TableSchema.fromBean(MigrationEntity.class);
        MigrationEntity entity = schema.mapToItem(Map.of(
                "instance_id", AttributeValue.fromS("i-d65fc339"),
                "migration_id", AttributeValue.fromS("mig_1794564299"),
                "started_at", AttributeValue.fromN("1794564299"),
                "completed_at", AttributeValue.fromS("2026-11-13T10:07:02Z"),
                "status", AttributeValue.fromS("COMPLETED")
        ));

        assertThat(entity.getStartedAt()).isEqualTo(1794564299L);
        assertThat(entity.getCompletedAt()).isEqualTo(Instant.parse("2026-11-13T10:07:02Z").getEpochSecond());
    }
}
