package com.iaas.xregion.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.NovaEntity;
import com.iaas.xregion.Entity.SecurityGroupEntity;
import com.iaas.xregion.Entity.SecurityGroupSyncStatus;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Exceptions.SecurityGroupPersistenceException;
import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Services.AuditLogService;
import com.iaas.xregion.Services.NetworkService;
import com.iaas.xregion.Services.NovaLookup;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.util.ReflectionTestUtils;
import software.amazon.awssdk.core.pagination.sync.SdkIterable;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.PutItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable;

import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class NetworkServiceTest {

    private static final String INSTANCE_ID = "i-4c0906ee";
    private static final String GROUP_ID = "sg-b6027893d2";

    @Mock
    private AuditLogService auditLogService;
    @Mock
    private DynamoDbEnhancedClient enhancedClient;
    @Mock
    private DynamoDbTable<InstanceEntity> instancesTable;
    @Mock
    private DynamoDbTable<SecurityGroupEntity> securityGroupsTable;
    @Mock
    private NovaLookup novaLookup;
    @Mock
    private EventBridgeGatewayClient eventBridgeGatewayClient;
    @Mock
    private software.amazon.awssdk.services.dynamodb.DynamoDbClient dynamoDbClient;

    private NetworkService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("lam", "pass", List.of()));
        service = new NetworkService(auditLogService, enhancedClient, dynamoDbClient, instancesTable,
                new ObjectMapper(), novaLookup);
        ReflectionTestUtils.setField(service, "securityGroupsTableName", "XRegion-SecurityGroups");
        ReflectionTestUtils.setField(service, "eventBridgeGatewayClient", eventBridgeGatewayClient);
        ReflectionTestUtils.setField(service, "securityGroupsTable", securityGroupsTable);
        ReflectionTestUtils.setField(service, "securityGroupsPersistent", false);
        lenient().when(securityGroupsTable.getItem(any(Key.class))).thenReturn(null);
        lenient().when(dynamoDbClient.updateItem(any(java.util.function.Consumer.class)))
                .thenReturn(software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse.builder().build());
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private InstanceEntity instance(String owner, String status, String activeNovaId) {
        return InstanceEntity.builder().instanceId(INSTANCE_ID).userId(owner == null ? null : "usr-" + owner)
                .currentStatus(status).activeNovaId(activeNovaId).build();
    }

    private void existingGroup(String owner) throws Exception {
        existingGroups(List.of(groupEntity(owner)));
    }

    @SuppressWarnings("unchecked")
    private void existingGroups(List<SecurityGroupEntity> entities) throws Exception {
        lenient().when(enhancedClient.table(anyString(),
                        org.mockito.ArgumentMatchers.<software.amazon.awssdk.enhanced.dynamodb.TableSchema<SecurityGroupEntity>>any()))
                .thenReturn(securityGroupsTable);
        lenient().when(securityGroupsTable.describeTable())
                .thenReturn(software.amazon.awssdk.enhanced.dynamodb.model.DescribeTableEnhancedResponse.builder()
                        .response(software.amazon.awssdk.services.dynamodb.model.DescribeTableResponse.builder()
                                .table(software.amazon.awssdk.services.dynamodb.model.TableDescription.builder()
                                        .tableName("XRegion-SecurityGroups")
                                        .itemCount(0L)
                                        .tableStatus(software.amazon.awssdk.services.dynamodb.model.TableStatus.ACTIVE)
                                        .tableArn("arn:aws:dynamodb:ap-southeast-2:123456789012:table/XRegion-SecurityGroups")
                                        .build())
                                .build())
                        .build());
        service.initSecurityGroupStore();
        for (SecurityGroupEntity entity : entities) {
            // Store giả lập không scan được: nạp thẳng bản ghi vào cache như lúc khởi động đọc thành công.
            try {
                java.lang.reflect.Method fromEntity = NetworkService.class.getDeclaredMethod("fromEntity", SecurityGroupEntity.class);
                fromEntity.setAccessible(true);
                @SuppressWarnings("unchecked")
                java.util.Map<String, Object> cache = (java.util.Map<String, Object>) ReflectionTestUtils.getField(service, "securityGroups");
                cache.put(entity.getGroupId(), fromEntity.invoke(service, entity));
            } catch (ReflectiveOperationException e) {
                throw new IllegalStateException(e);
            }
        }
        ReflectionTestUtils.setField(service, "securityGroupsPersistent", true);
        lenient().when(securityGroupsTable.getItem(any(Key.class))).thenAnswer(invocation -> entities.isEmpty() ? null : entities.get(0));
    }

    private SecurityGroupEntity groupEntity(String owner) {
        String rules = "[{\"ruleId\":\"r1\",\"protocol\":\"tcp\",\"fromPort\":22,\"toPort\":22,\"cidr\":\"0.0.0.0/0\",\"description\":\"SSH\"}]";
        String outbound = "[{\"ruleId\":\"r2\",\"protocol\":\"all\",\"fromPort\":0,\"toPort\":65535,\"cidr\":\"0.0.0.0/0\",\"description\":\"All\"}]";
        return SecurityGroupEntity.builder().groupId(GROUP_ID).name("abc-sg")
                .description("Security group of " + INSTANCE_ID).owner(owner).region("ap-southeast-2")
                .inboundRulesJson(rules).outboundRulesJson(outbound).createdAt(1L).revision(5L)
                .syncStatus(SecurityGroupSyncStatus.PENDING_SYNC).build();
    }

    private SecurityGroupRequest rules(SecurityGroupRequest.Rule... inbound) {
        SecurityGroupRequest request = new SecurityGroupRequest();
        request.setInboundRules(List.of(inbound));
        request.setOutboundRules(List.of());
        return request;
    }

    private SecurityGroupRequest.Rule rule(String protocol, int from, int to) {
        SecurityGroupRequest.Rule rule = new SecurityGroupRequest.Rule();
        rule.setProtocol(protocol);
        rule.setFromPort(from);
        rule.setToPort(to);
        rule.setCidr("0.0.0.0/0");
        return rule;
    }

    @Test
    void savingRulesAlwaysPublishesSyncRequestInsteadOfPendingDeploy() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        when(novaLookup.find(any(InstanceEntity.class)))
                .thenReturn(NovaEntity.builder().novaId("nova-1").instanceId(INSTANCE_ID).build());
        Map<String, Object> saved = service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 80, 80)));

        assertThat(saved.get("syncStatus")).isEqualTo(SecurityGroupSyncStatus.PENDING_SYNC);
        assertThat(saved.get("eventPublished")).isEqualTo(true);
        assertThat(saved.get("revision")).isEqualTo(6L);
        // SG service luôn gửi lệnh qua API Gateway; không còn nhánh PENDING_DEPLOY do cờ tắt.
        verify(eventBridgeGatewayClient).sendSecurityGroupSyncEvent(GROUP_ID, INSTANCE_ID, "nova-1", 6L, 1, "lam");
    }

    @Test
    void failedPersistenceIsReportedInsteadOfReturningSuccess() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        doThrow(new RuntimeException("ProvisionedThroughputExceeded"))
                .when(dynamoDbClient).updateItem(any(java.util.function.Consumer.class));

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 80, 80))))
                .isInstanceOf(SecurityGroupPersistenceException.class);
        verifyNoInteractions(eventBridgeGatewayClient);
    }

    @Test
    void unchangedRulesDoNotPublishOrBumpRevision() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        SecurityGroupRequest same = rules(rule("tcp", 22, 22));
        SecurityGroupRequest.Rule all = rule("all", 0, 65535);
        same.setOutboundRules(List.of(all));

        Map<String, Object> saved = service.replaceInstanceRules(INSTANCE_ID, same);

        assertThat(saved.get("eventPublished")).isEqualTo(false);
        assertThat(saved.get("revision")).isEqualTo(5L);
        verify(securityGroupsTable, never()).putItem(any(PutItemEnhancedRequest.class));
        verifyNoInteractions(eventBridgeGatewayClient);
    }

    @Test
    void publishingRevisionForRunningInstanceIsTheDefault() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        when(novaLookup.find(any(InstanceEntity.class)))
                .thenReturn(NovaEntity.builder().novaId("nova-1").instanceId(INSTANCE_ID).build());
        SecurityGroupRequest request = rules(rule("tcp", 443, 443));
        request.setOutboundRules(List.of(rule("all", 0, 65535)));

        Map<String, Object> saved = service.replaceInstanceRules(INSTANCE_ID, request);

        assertThat(saved.get("eventPublished")).isEqualTo(true);
        assertThat(saved.get("syncStatus")).isEqualTo(SecurityGroupSyncStatus.PENDING_SYNC);
        // 1 inbound + 1 outbound: số rule gửi cho worker là số rule mong muốn thật.
        verify(eventBridgeGatewayClient).sendSecurityGroupSyncEvent(GROUP_ID, INSTANCE_ID, "nova-1", 6L, 2, "lam");
    }

    @Test
    @SuppressWarnings("unchecked")
    void emptyOutboundIsKeptEmptyInsteadOfAddingAllowAll() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));

        Map<String, Object> saved = service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443)));

        // Phương án B: [] là chủ ý không cấp outbound; tự thêm allow-all sẽ làm rule đã xóa sống lại.
        assertThat((List<Map<String, Object>>) saved.get("outboundRules")).isEmpty();
        assertThat(saved.get("revision")).isEqualTo(6L);
    }

    @Test
    @SuppressWarnings("unchecked")
    void savingRulesUpdatesOnlyDesiredColumnsAndKeepsWorkerMetadata() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));

        service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443)));

        org.mockito.ArgumentCaptor<java.util.function.Consumer<software.amazon.awssdk.services.dynamodb.model
                .UpdateItemRequest.Builder>> captor = org.mockito.ArgumentCaptor.forClass(java.util.function.Consumer.class);
        verify(dynamoDbClient, atLeastOnce()).updateItem(captor.capture());
        // Các lần ghi khác thuộc khởi tạo store (sync_status...); lần ghi cấu hình là lần có inbound_rules.
        software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest saved = null;
        for (java.util.function.Consumer<software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest.Builder> call
                : captor.getAllValues()) {
            software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest.Builder builder =
                    software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest.builder();
            call.accept(builder);
            software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest request = builder.build();
            if (request.updateExpression() != null && request.expressionAttributeNames() != null
                    && "inbound_rules".equals(request.expressionAttributeNames().get("#in"))) {
                saved = request;
            }
        }
        assertThat(saved).as("ghi cấu hình phải là UpdateItem riêng cột desired").isNotNull();

        // putItem ghi cả bản ghi sẽ xóa cột do worker sở hữu; ở đây chỉ được UPDATE cột cấu hình.
        verify(securityGroupsTable, never()).putItem(any(PutItemEnhancedRequest.class));
        // Mọi tên cột đi qua alias: "name" là reserved word của DynamoDB, không được ghi trần.
        assertThat(saved.updateExpression())
                .contains("#in = :in")
                .contains("#out = :out")
                .contains("#rev = :newrev")
                .contains("#name = :name")
                .doesNotContain("managed")
                .doesNotContain("applied_revision")
                .doesNotContain("sync_lease")
                .doesNotContain("SET name =");
        assertThat(saved.expressionAttributeNames())
                .containsEntry("#in", "inbound_rules")
                .containsEntry("#out", "outbound_rules")
                .containsEntry("#rev", "revision")
                .containsEntry("#pk", "group_id")
                .containsEntry("#name", "name")
                .doesNotContainKeys("#managed", "#applied_revision");
        assertThat(saved.conditionExpression())
                .contains("#rev = :base");
        assertThat(saved.expressionAttributeValues().get(":base").n()).isEqualTo("5");
        assertThat(saved.expressionAttributeValues().get(":newrev").n()).isEqualTo("6");
    }

    @Test
    @SuppressWarnings("unchecked")
    void revisionBookkeepingNeverLeaksIntoCacheOrResponse() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));

        Map<String, Object> saved = service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443)));

        // Khoá nội bộ dùng cho điều kiện ghi không được trả ra API...
        assertThat(saved.containsKey("__revisionBase")).as("khoá revision nội bộ lọt ra response").isFalse();
        // ...và cũng không nằm lại trong cache mà request khác sẽ đọc.
        Map<String, Object> cache = (Map<String, Object>) ReflectionTestUtils.getField(service, "securityGroups");
        Map<String, Object> cached = (Map<String, Object>) cache.get(GROUP_ID);
        assertThat(cached).isNotNull();
        assertThat(cached.containsKey("__revisionBase"))
                .as("khoá revision nội bộ nằm lại trong cache").isFalse();
    }

    @Test
    @SuppressWarnings("unchecked")
    void failedWriteLeavesCacheFreeOfRevisionBookkeeping() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        failSaving();

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443))))
                .isInstanceOf(SecurityGroupPersistenceException.class);

        Map<String, Object> cache = (Map<String, Object>) ReflectionTestUtils.getField(service, "securityGroups");
        Map<String, Object> cached = (Map<String, Object>) cache.get(GROUP_ID);
        assertThat(cached.containsKey("__revisionBase"))
                .as("ghi lỗi không được để khoá revision nội bộ trong cache").isFalse();
    }

    private void failSaving() {
        when(dynamoDbClient.updateItem(any(java.util.function.Consumer.class)))
                .thenThrow(software.amazon.awssdk.services.dynamodb.model.DynamoDbException.builder()
                        .message("write rejected").build());
    }

    @Test
    void readFailureBeforeSavingStopsTheWrite() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        // Chi nhom dang sua bi loi doc; cac nhom he thong van doc binh thuong.
        doAnswer(invocation -> {
            software.amazon.awssdk.enhanced.dynamodb.Key key = invocation.getArgument(0);
            if (GROUP_ID.equals(key.partitionKeyValue().s())) {
                throw software.amazon.awssdk.services.dynamodb.model.DynamoDbException.builder()
                        .message("table unavailable").build();
            }
            return groupEntity("system");
        }).when(securityGroupsTable).getItem(any(Key.class));

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443))))
                .isInstanceOf(SecurityGroupPersistenceException.class);

        // Lệnh ghi của khởi tạo store không tính; sau khi đọc lỗi thì không được ghi cấu hình nào.
        clearInvocations(dynamoDbClient);
        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443))))
                .isInstanceOf(SecurityGroupPersistenceException.class);
        verify(dynamoDbClient, never()).updateItem(any(java.util.function.Consumer.class));
        verifyNoInteractions(eventBridgeGatewayClient);
    }

    @Test
    @SuppressWarnings("unchecked")
    void concurrentWriteIsRejectedInsteadOfOverwritingNewerRules() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        // Người khác đã lưu revision 6 sau lần đọc của mình: điều kiện revision = 5 phải thất bại.
        doThrow(software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException.builder()
                .message("revision changed").build())
                .when(dynamoDbClient).updateItem(any(java.util.function.Consumer.class));

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443))))
                .isInstanceOf(ConflictException.class);

        // Ghi hỏng thì không được coi như đã lưu, cũng không phát sự kiện đồng bộ.
        verifyNoInteractions(eventBridgeGatewayClient);
    }

    @Test
    void conflictingExpectedRevisionIsRejectedWithoutWriting() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));
        SecurityGroupRequest request = rules(rule("tcp", 443, 443));
        request.setExpectedRevision(3L);

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, request))
                .isInstanceOf(ConflictException.class);
        verify(securityGroupsTable, never()).putItem(any(PutItemEnhancedRequest.class));
        verifyNoInteractions(eventBridgeGatewayClient);
    }

    @Test
    void getDoesNotCreateAGroupForAnInstanceWithoutOne() throws Exception {
        // Nhóm trong bảng thuộc i-4c0906ee; instance được hỏi là máy khác nên không có nhóm riêng.
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class)))
                .thenReturn(InstanceEntity.builder().instanceId("i-no-group").userId("usr-lam")
                        .currentStatus("RUNNING").activeNovaId("nova-2").build());

        List<Map<String, Object>> groups = service.getSecurityGroups("i-no-group");

        // GET read-only: không tạo nhóm mới cho máy chưa có nhóm.
        assertThat(groups).isEmpty();
        verify(securityGroupsTable, never()).putItem(any(PutItemEnhancedRequest.class));
    }

    @Test
    void failedInstanceDoesNotGetSyncEvent() throws Exception {
        existingGroup("lam");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "FAILED", null));

        Map<String, Object> saved = service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 443, 443)));

        assertThat(saved.get("syncStatus")).isEqualTo(SecurityGroupSyncStatus.SYNC_NOT_APPLICABLE);
        assertThat(saved.get("eventPublished")).isEqualTo(false);
        verifyNoInteractions(eventBridgeGatewayClient);
    }

    @Test
    void duplicateLegacyGroupsAreNotResolvedByCreatingAnotherOne() throws Exception {
        existingGroup("lam");
        java.util.Map<String, Object> duplicate = new java.util.LinkedHashMap<>();
        duplicate.put("groupId", "sg-dc927bf84c");
        duplicate.put("name", "abc-sg-old");
        duplicate.put("description", "Security group of " + INSTANCE_ID);
        duplicate.put("owner", "lam");
        duplicate.put("inboundRules", new java.util.concurrent.CopyOnWriteArrayList<>());
        duplicate.put("outboundRules", new java.util.concurrent.CopyOnWriteArrayList<>());
        duplicate.put("revision", 0L);
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> cache = (java.util.Map<String, Object>) ReflectionTestUtils.getField(service, "securityGroups");
        cache.put("sg-dc927bf84c", duplicate);
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("lam", "RUNNING", "nova-1"));

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 80, 80))))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("sg-dc927bf84c")
                .hasMessageContaining(GROUP_ID);
        verify(securityGroupsTable, never()).putItem(any(PutItemEnhancedRequest.class));
    }

    @Test
    void anotherUserCannotEditTheInstanceSecurityGroup() throws Exception {
        existingGroup("other");
        when(instancesTable.getItem(any(Key.class))).thenReturn(instance("other", "RUNNING", "nova-1"));

        assertThatThrownBy(() -> service.replaceInstanceRules(INSTANCE_ID, rules(rule("tcp", 80, 80))))
                .isInstanceOfAny(ResourceNotFoundException.class);
        verify(securityGroupsTable, never()).putItem(any(PutItemEnhancedRequest.class));
    }
}
