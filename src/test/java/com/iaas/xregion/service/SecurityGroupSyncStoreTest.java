package com.iaas.xregion.service;

import com.iaas.xregion.Entity.SecurityGroupSyncStatus;
import com.iaas.xregion.Services.SecurityGroupSyncStore;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest;
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse;

import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The sync store must write a real partial UpdateItem: before this, the enhanced
 * table API rewrote the record from a key-only bean, which would have deleted the
 * rules the backend had just saved.
 */
class SecurityGroupSyncStoreTest {

    private static final String GROUP = "sg-b6027893d2";
    private static final String TABLE = "XRegion-SecurityGroups";

    @SuppressWarnings("unchecked")
    private static UpdateItemRequest capture(DynamoDbClient client) {
        ArgumentCaptor<Consumer<UpdateItemRequest.Builder>> captor = ArgumentCaptor.forClass(Consumer.class);
        verify(client).updateItem(captor.capture());
        UpdateItemRequest.Builder builder = UpdateItemRequest.builder();
        captor.getValue().accept(builder);
        return builder.build();
    }

    @Test
    void markAppliedSendsAPartialUpdateForOnlyTheSyncColumns() {
        DynamoDbClient client = mock(DynamoDbClient.class);
        when(client.updateItem(any(Consumer.class))).thenReturn(UpdateItemResponse.builder().build());
        SecurityGroupSyncStore store = new SecurityGroupSyncStore(client, TABLE);

        assertThat(store.markApplied(GROUP, 7L, 7L, 3, "ok")).isTrue();

        UpdateItemRequest request = capture(client);
        assertThat(request.tableName()).isEqualTo(TABLE);
        // Khoá phải là tên thuộc tính THẬT; "#pk" chỉ là alias của expression, gửi vào Key sẽ sai.
        assertThat(request.key().get("group_id").s()).isEqualTo(GROUP);
        assertThat(request.key()).doesNotContainKey("#pk");
        // Cột cấu hình (inbound_rules/outbound_rules/name/owner) KHÔNG được xuất hiện trong biểu thức.
        assertThat(request.updateExpression())
                .contains("SET applied_revision = :ar")
                .contains("sync_status = :st")
                .doesNotContain("inbound_rules")
                .doesNotContain("outbound_rules")
                // Backend không được tự phá lease của worker.
                .doesNotContain("sync_lease");
        assertThat(request.conditionExpression())
                .contains("attribute_exists(group_id)")
                .contains("revision = :rev")
                .contains("applied_revision <= :ar");
        assertThat(request.expressionAttributeValues()).containsOnlyKeys(
                ":ar", ":st", ":now", ":note", ":empty", ":zero", ":rc", ":rev");
        assertThat(request.expressionAttributeValues().get(":st").s())
                .isEqualTo(SecurityGroupSyncStatus.SYNCED);
        assertThat(request.expressionAttributeValues().get(":rev").n()).isEqualTo("7");
    }

    @Test
    void onlyReferencedPlaceholdersAreSent() {
        DynamoDbClient client = mock(DynamoDbClient.class);
        when(client.updateItem(any(Consumer.class))).thenReturn(UpdateItemResponse.builder().build());
        SecurityGroupSyncStore store = new SecurityGroupSyncStore(client, TABLE);

        // ruleCount âm: markApplied không thêm :rc, nên placeholder đó không được gửi kèm.
        assertThat(store.markApplied(GROUP, 4L, 4L, -1, "")).isTrue();

        UpdateItemRequest request = capture(client);
        assertThat(request.expressionAttributeValues()).doesNotContainKey(":rc");
        assertThat(request.updateExpression()).doesNotContain("rule_count");
    }

    @Test
    void staleRevisionIsReportedAsFalseAndIsNotAnError() {
        DynamoDbClient client = mock(DynamoDbClient.class);
        when(client.updateItem(any(Consumer.class)))
                .thenThrow(ConditionalCheckFailedException.builder().message("stale").build());
        SecurityGroupSyncStore store = new SecurityGroupSyncStore(client, TABLE);

        assertThat(store.markFailed(GROUP, 3L, "boom")).isFalse();
    }
}
