package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.SecurityGroupSyncStatus;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Channel that writes Security Group sync status into XRegion-SecurityGroups.
 *
 * Every write is a real partial UpdateItem: only sync metadata columns are
 * touched, so the worker never overwrites rules the backend just saved, and the
 * backend never overwrites worker-owned status. Each condition compares the
 * stored revision with the request revision, so a stale writer can never record
 * a result for a newer configuration.
 */
public class SecurityGroupSyncStore {

    private final DynamoDbClient lowLevel;
    private final String tableName;

    public SecurityGroupSyncStore(DynamoDbClient lowLevel, String tableName) {
        this.lowLevel = lowLevel;
        this.tableName = tableName;
    }

    private DynamoDbClient client() {
        if (lowLevel == null) {
            throw new IllegalStateException("DynamoDB client for " + tableName + " is unavailable");
        }
        return lowLevel;
    }
    /** Record the applied revision. Only wins when it is not older than what is already applied. */
    public boolean markApplied(String groupId, long appliedRevision, long revision, int ruleCount, String note) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":ar", appliedRevision);
        values.put(":st", SecurityGroupSyncStatus.SYNCED);
        values.put(":now", System.currentTimeMillis());
        values.put(":note", truncate(note, 1000));
        values.put(":empty", "");
        values.put(":zero", 0L);
        String expression = "SET applied_revision = :ar, sync_status = :st, synced_at = :now, sync_note = :note"
                + ", sync_error = :empty, sync_attempts = :zero, next_sync_at = :zero";
        if (ruleCount >= 0) {
            values.put(":rc", ruleCount);
            expression += ", rule_count = :rc";
        }
        return update(groupId, expression,
                "attribute_exists(group_id) AND revision = :rev AND (attribute_not_exists(applied_revision) OR applied_revision <= :ar)",
                values, revision);
    }

    /** Record that the sync request was published for the current revision (does not bump it). */
    public boolean markEventPublished(String groupId, long revision) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":st", SecurityGroupSyncStatus.PENDING_SYNC);
        values.put(":now", System.currentTimeMillis());
        values.put(":zero", 0L);
        String expression = "SET sync_status = :st, sync_requested_at = :now, last_event_id = :rev"
                + ", sync_attempts = :zero, next_sync_at = :zero";
        return update(groupId, expression,
                "attribute_exists(group_id) AND revision = :rev", values, revision);
    }

    /** Publishing failed: keep the desired configuration, record that no request was delivered. */
    public boolean markEventFailed(String groupId, long revision, String error) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":st", SecurityGroupSyncStatus.PENDING_SYNC);
        values.put(":err", truncate(error, 1000));
        values.put(":now", System.currentTimeMillis());
        return update(groupId, "SET sync_status = :st, sync_error = :err, sync_requested_at = :now",
                "attribute_exists(group_id) AND revision = :rev", values, revision);
    }

    /** Record a sync failure for exactly this revision; an older revision's error is ignored. */
    public boolean markFailed(String groupId, long revision, String error) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":st", SecurityGroupSyncStatus.SYNC_FAILED);
        values.put(":err", truncate(error, 1000));
        values.put(":now", System.currentTimeMillis());
        return update(groupId, "SET sync_status = :st, sync_error = :err, sync_failed_at = :now",
                "attribute_exists(group_id) AND revision = :rev", values, revision);
    }

    /** The instance has no network resources yet: nothing can be applied. */
    public boolean markNotApplicable(String groupId, long revision, String reason) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":st", SecurityGroupSyncStatus.SYNC_NOT_APPLICABLE);
        values.put(":err", truncate(reason, 1000));
        values.put(":now", System.currentTimeMillis());
        return update(groupId, "SET sync_status = :st, sync_error = :err, sync_checked_at = :now",
                "attribute_exists(group_id) AND revision = :rev", values, revision);
    }

    /** Blocked: shared group, missing mapping, or legacy data that must be reconciled first. */
    public boolean markBlocked(String groupId, long revision, String reason) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":st", SecurityGroupSyncStatus.SYNC_BLOCKED);
        values.put(":err", truncate(reason, 1000));
        values.put(":now", System.currentTimeMillis());
        return update(groupId, "SET sync_status = :st, sync_error = :err, sync_checked_at = :now",
                "attribute_exists(group_id) AND revision = :rev", values, revision);
    }


    /**
     * Option B: mark that this group now owns the full rule set of the guest Neutron
     * security group. Only a managed group may be reconciled live by the worker.
     */
    public boolean markManaged(String groupId, long revision, String note) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(":now", System.currentTimeMillis());
        values.put(":note", truncate(note, 500));
        values.put(":yes", Boolean.TRUE);
        return update(groupId, "SET managed = :yes, managed_at = :now, managed_note = :note",
                "attribute_exists(group_id) AND revision = :rev", values, revision);
    }

    /**
     * Partial update of an existing record. Returns false when the revision condition no
     * longer holds (a newer revision exists). Other failures propagate to the caller.
     *
     * Uses the low-level client so the update expression is actually sent: the enhanced
     * table API would rewrite the item from a bean and drop every column not set here.
     * Only placeholders referenced by this expression are sent, so DynamoDB can never
     * reject the request for an unused value or for an undefined placeholder.
     */
    boolean update(String groupId, String setExpression, String condition, Map<String, Object> values, Long revision) {
        Map<String, AttributeValue> all = new LinkedHashMap<>();
        values.forEach((key, value) -> all.put(key, toAttributeValue(value)));
        if (revision != null) {
            all.put(":rev", AttributeValue.fromN(String.valueOf(revision)));
        }
        String expression = setExpression;
        Map<String, AttributeValue> used = referenced(expression + " " + condition, all);
        try {
            client().updateItem(request -> request
                    .tableName(tableName)
                    // Key phải là tên thuộc tính THẬT (group_id); alias chỉ dùng trong expression.
                    .key(java.util.Map.of("group_id", AttributeValue.fromS(groupId)))
                    .updateExpression(expression)
                    // Chỉ chạm cột trạng thái đồng bộ: rules do backend sở hữu, lease do worker sở hữu.
                    .conditionExpression(condition)
                    .expressionAttributeValues(used));
            return true;
        } catch (ConditionalCheckFailedException stale) {
            return false;
        }
    }

    private static Map<String, AttributeValue> referenced(String expression, Map<String, AttributeValue> values) {
        Map<String, AttributeValue> used = new LinkedHashMap<>();
        values.forEach((name, value) -> {
            if (expression.contains(name)) {
                used.put(name, value);
            }
        });
        return used;
    }

    private static AttributeValue toAttributeValue(Object value) {
        if (value instanceof Boolean flag) {
            return AttributeValue.fromBool(flag);
        }
        if (value instanceof Number number) {
            return AttributeValue.fromN(String.valueOf(number.longValue()));
        }
        return AttributeValue.fromS(String.valueOf(value));
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return "";
        }
        return value.length() <= max ? value : value.substring(0, max);
    }
}


