package com.iaas.xregion.Entity;

import software.amazon.awssdk.enhanced.dynamodb.AttributeConverter;
import software.amazon.awssdk.enhanced.dynamodb.AttributeValueType;
import software.amazon.awssdk.enhanced.dynamodb.EnhancedType;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.time.Instant;
import java.time.OffsetDateTime;

/**
 * Converter linh hoạt cho các cột timestamp trong DynamoDB:
 * đọc được cả Number/String epoch (giây hoặc mili-giây) lẫn chuỗi ISO-8601 (vd: "2026-11-13T10:07:02Z"),
 * và ghi ra dạng Number (N) để tương thích ngược.
 */
public class FlexibleEpochTimestampConverter implements AttributeConverter<Long> {

    @Override
    public AttributeValue transformFrom(Long input) {
        if (input == null) {
            return AttributeValue.builder().nul(true).build();
        }
        return AttributeValue.builder().n(String.valueOf(input)).build();
    }

    @Override
    public Long transformTo(AttributeValue input) {
        if (input == null || Boolean.TRUE.equals(input.nul())) {
            return null;
        }
        if (input.n() != null && !input.n().isBlank()) {
            return Long.parseLong(input.n().trim());
        }
        if (input.s() != null) {
            String raw = input.s().trim();
            if (raw.isEmpty()) {
                return null;
            }
            if (raw.matches("^-?\\d+$")) {
                return Long.parseLong(raw);
            }
            try {
                return Instant.parse(raw).getEpochSecond();
            } catch (Exception ignored) {
                return OffsetDateTime.parse(raw).toEpochSecond();
            }
        }
        return null;
    }

    @Override
    public EnhancedType<Long> type() {
        return EnhancedType.of(Long.class);
    }

    @Override
    public AttributeValueType attributeValueType() {
        return AttributeValueType.N;
    }
}
