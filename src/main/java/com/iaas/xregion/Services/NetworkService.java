package com.iaas.xregion.Services;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Client.EventBridgeGatewayClient;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.NovaEntity;
import com.iaas.xregion.Entity.SecurityGroupEntity;
import com.iaas.xregion.Entity.SecurityGroupSyncStatus;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Exceptions.SecurityGroupPersistenceException;
import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.SecurityGroupSyncResult;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class NetworkService {

    private static final String SYSTEM_OWNER = "system";
    /** Khoá nội bộ (không ghi xuống DynamoDB) giữ revision đọc được từ bảng để làm điều kiện ghi. */
    private static final String REVISION_BASE = "__revisionBase";
    private static final List<String> DEFAULT_INSTANCE_GROUPS = List.of("sg-default", "sg-web-public");
    /** Trạng thái máy còn tài nguyên mạng để áp dụng rule (tương ứng luồng launch/start của backend). */
    private static final Set<String> SYNC_APPLICABLE_STATES = Set.of(
            "PENDING", "RUNNING", "STOPPED", "STOPPING", "SHELVED", "SHELVED_OFFLOADED", "MIGRATING");

    private final AuditLogService auditLogService;
    private final DynamoDbEnhancedClient enhancedClient;
    private final DynamoDbClient dynamoDbClient;
    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final ObjectMapper objectMapper;
    private final NovaLookup novaLookup;


    /** Bản ghi Route 53 người dùng tự cập nhật (ghi đè bản ghi sinh từ dns + elastic_ip của máy). */
    private final List<Map<String, Object>> dnsStore = new CopyOnWriteArrayList<>();

    /**
     * Đọc lại bản ghi mới nhất từ DynamoDB cho một nhóm và cập nhật cache. Trạng thái đồng bộ do worker ghi
     * bằng UpdateItem nên cache khởi động có thể cũ; GET phải thấy revision/appliedRevision/syncStatus mới.
     * Lỗi đọc không làm hỏng màn hình: trả bản trong cache và ghi cảnh báo.
     */
    private synchronized Map<String, Object> refreshFromStore(Map<String, Object> sg) {
        if (sg == null || !isPersistent()) {
            return sg;
        }
        String groupId = String.valueOf(sg.get("groupId"));
        try {
            SecurityGroupEntity stored = securityGroupsTable.getItem(Key.builder().partitionValue(groupId).build());
            if (stored != null) {
                Map<String, Object> fresh = fromEntity(stored);
                securityGroups.put(groupId, fresh);
                return fresh;
            }
        } catch (Exception e) {
            log.warn("Could not refresh security group [{}] from DynamoDB: {}", groupId, e.getMessage());
        }
        return sg;
    }

    /** Bản sao đã làm mới trạng thái rồi trả cho client. */
    private Map<String, Object> refreshed(Map<String, Object> sg) {
        return copyOf(refreshFromStore(sg));
    }

    /**
     * Đọc bắt buộc thành công cho đường GHI: trả bản ghi hiện tại của bảng, hoặc bản cache khi chưa có bảng.
     *
     * Khác refreshFromStore (dùng cho GET, ưu tiên không làm hỏng màn hình): ở đây lỗi đọc hoặc mất bản ghi
     * đều ném lỗi. Ghi cấu hình dựa trên dữ liệu đoán được sẽ xóa/khôi phục rule sai, nên phải fail closed.
     */
    private Map<String, Object> refreshFromStoreStrict(String groupId) {
        if (!isPersistent()) {
            Map<String, Object> cached = securityGroups.get(groupId);
            if (cached == null) {
                throw new ResourceNotFoundException("Không tìm thấy Security Group " + groupId);
            }
            return cached;
        }
        SecurityGroupEntity stored;
        try {
            stored = securityGroupsTable.getItem(Key.builder().partitionValue(groupId).build());
        } catch (RuntimeException e) {
            log.error("Could not read security group [{}] before writing: {}", groupId, e.getMessage());
            throw new SecurityGroupPersistenceException(
                    "Không đọc được Security Group " + groupId + " trước khi ghi, chưa thay đổi gì", e);
        } catch (Exception e) {
            // getItem của bảng khai báo throws Exception: SDK ném RuntimeException, nhưng mock/shim có thể ném
            // checked exception. Bắt riêng để không có đường nào đi tiếp với dữ liệu đoán được.
            log.error("Could not read security group [{}] before writing: {}", groupId, e.getMessage());
            throw new SecurityGroupPersistenceException(
                    "Không đọc được Security Group " + groupId + " trước khi ghi, chưa thay đổi gì", e);
        }
        if (stored == null) {
            throw new ResourceNotFoundException("Không tìm thấy Security Group " + groupId);
        }
        Map<String, Object> fresh;
        try {
            fresh = fromEntity(stored);
        } catch (Exception e) {
            throw new SecurityGroupPersistenceException(
                    "Bản ghi Security Group " + groupId + " không đọc được rule, chưa thay đổi gì", e);
        }
        // Ghim revision ngay tại lần đọc này: mọi lần ghi sau phải so với đúng số này, nên khi bảng
        // đã sang revision khác thì điều kiện ghi thất bại thay vì ghi đè bằng rules cũ.
        fresh.put(REVISION_BASE, fresh.get("revision") instanceof Number n ? n.longValue() : 0L);
        securityGroups.put(groupId, fresh);
        return fresh;
    }

    /** Bản sao nông đủ để thay rule mà không đụng map đang nằm trong cache (copy-on-write). */
    private static Map<String, Object> mutableCopy(Map<String, Object> sg) {
        Map<String, Object> copy = new LinkedHashMap<>(sg);
        copy.put("inboundRules", new CopyOnWriteArrayList<>((List<Map<String, Object>>) sg.get("inboundRules")));
        copy.put("outboundRules", new CopyOnWriteArrayList<>((List<Map<String, Object>>) sg.get("outboundRules")));
        return copy;
    }

    /** groupId -> security group. Bộ nhớ đệm của bảng XRegion-SecurityGroups (ghi xuống bảng mỗi lần đổi). */

    private final Map<String, Map<String, Object>> securityGroups = new ConcurrentHashMap<>();

    @Value("${aws.dynamodb.table.security-groups:XRegion-SecurityGroups}")
    private String securityGroupsTableName;

    private DynamoDbTable<SecurityGroupEntity> securityGroupsTable;
    private volatile boolean securityGroupsPersistent;
    private SecurityGroupSyncStore syncStore;

    /**
     * Web layer không sở hữu NetworkService nên dependency này là tùy chọn: thiếu client thì việc lưu cấu hình
     * vẫn chạy, chỉ không phát được yêu cầu đồng bộ.
     */
    @Autowired(required = false)
    private EventBridgeGatewayClient eventBridgeGatewayClient;

    {
        seedGroup("sg-default", "default",
                "Mặc định: các máy cùng Security Group được nói chuyện với nhau",
                List.of(rule("all", 0, 65535, "sg-default", "Lưu lượng nội bộ giữa các máy cùng nhóm")));

        seedGroup("sg-web-public", "web-public",
                "Máy chủ web công khai: SSH, HTTP, HTTPS",
                List.of(
                        rule("tcp", 22, 22, "0.0.0.0/0", "SSH quản trị"),
                        rule("tcp", 80, 80, "0.0.0.0/0", "HTTP"),
                        rule("tcp", 443, 443, "0.0.0.0/0", "HTTPS")));

        seedGroup("sg-ssh-only", "ssh-only",
                "Chỉ mở SSH, dùng cho máy nội bộ hoặc bastion",
                List.of(rule("tcp", 22, 22, "0.0.0.0/0", "SSH quản trị")));
    }

    private static Map<String, Object> rule(String protocol, int from, int to, String cidr, String description) {
        return rule(protocol, from, to, cidr, description, SYSTEM_OWNER);
    }

    private static Map<String, Object> rule(String protocol, int from, int to, String cidr, String description, String addedBy) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ruleId", "sgr-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10));
        r.put("protocol", protocol);
        r.put("fromPort", from);
        r.put("toPort", to);
        r.put("cidr", cidr);
        r.put("description", description);
        r.put("addedBy", addedBy);
        return r;
    }

    private static List<Map<String, Object>> allowAllOutbound() {
        return new CopyOnWriteArrayList<>(List.of(rule("all", 0, 65535, "0.0.0.0/0", "Cho phép mọi lưu lượng đi ra")));
    }

    private void seedGroup(String id, String name, String description, List<Map<String, Object>> inbound) {
        Map<String, Object> sg = new LinkedHashMap<>();
        sg.put("groupId", id);
        sg.put("name", name);
        sg.put("description", description);
        sg.put("region", "all");
        sg.put("owner", SYSTEM_OWNER);
        sg.put("inboundRules", new CopyOnWriteArrayList<>(inbound));
        sg.put("outboundRules", allowAllOutbound());
        sg.put("createdAt", System.currentTimeMillis());
        securityGroups.put(id, sg);
    }

    /**
     * Nạp Security Group từ DynamoDB lúc khởi động. Chưa có bảng thì thử tạo (DynamoDB Local);
     * không tạo được thì vẫn chạy bằng bộ nhớ như trước và ghi cảnh báo.
     */
    @PostConstruct
    public void initSecurityGroupStore() {
        if (securityGroupsPersistent) {
            return;
        }
        try {
            securityGroupsTable = enhancedClient.table(securityGroupsTableName, TableSchema.fromBean(SecurityGroupEntity.class));
            if (securityGroupsTable == null) {
                throw new IllegalStateException("DynamoDB table handle for " + securityGroupsTableName + " is unavailable");
            }
            try {
                securityGroupsTable.describeTable();
            } catch (software.amazon.awssdk.services.dynamodb.model.ResourceNotFoundException missing) {
                log.info("Table [{}] not found, creating it", securityGroupsTableName);
                securityGroupsTable.createTable();
            }
            List<SecurityGroupEntity> stored;
            try {
                stored = loadStoredGroups();
            } catch (Exception readFailure) {
                // Không đọc được toàn bộ bảng: chỉ đọc từng Security Group qua getItem vẫn an toàn.
                log.warn("Could not scan [{}], falling back to getItem lookups: {}",
                        securityGroupsTableName, readFailure.getMessage());
                stored = List.of();
            }
            for (SecurityGroupEntity e : stored) {
                securityGroups.put(e.getGroupId(), fromEntity(e));
            }
            syncStore = new SecurityGroupSyncStore(dynamoDbClient, securityGroupsTableName);
            securityGroupsPersistent = true;
            for (String id : List.of("sg-default", "sg-web-public", "sg-ssh-only")) {
                if (securityGroupsTable.getItem(Key.builder().partitionValue(id).build()) == null) {
                    persist(securityGroups.get(id));
                }
            }
            log.info("Security groups loaded from [{}]: {} group(s)",
                    securityGroupsTableName, securityGroups.size());
        } catch (Exception e) {
            securityGroupsPersistent = false;
            securityGroupsTable = null;
            log.warn("Security groups will be kept in memory only (table [{}] unavailable)", securityGroupsTableName, e);
        }
    }

    /**
     * Đọc toàn bộ Security Group đã lưu (scan toàn bảng XRegion-SecurityGroups).
     */
    private List<SecurityGroupEntity> loadStoredGroups() {
        List<SecurityGroupEntity> out = new ArrayList<>();
        software.amazon.awssdk.core.pagination.sync.SdkIterable<SecurityGroupEntity> items =
                securityGroupsTable.scan().items();
        if (items != null) {
            items.forEach((SecurityGroupEntity entity) -> {
                if (entity != null) {
                    out.add(entity);
                }
            });
        }
        return out;
    }

    private SecurityGroupSyncStore syncStore() {
        if (!isPersistent()) {
            return null;
        }
        if (syncStore == null) {
            syncStore = new SecurityGroupSyncStore(dynamoDbClient, securityGroupsTableName);
        }
        return syncStore;
    }


    /** Bản ghi mới (chưa có trên DynamoDB) phải ghi thắng điều kiện attribute_not_exists group_id. */
    private void persistNew(Map<String, Object> sg) {
        if (!isPersistent()) {
            throw new SecurityGroupPersistenceException(
                    "Chưa kết nối được bảng Security Group nên không lưu được cấu hình", null);
        }
        try {
            securityGroupsTable.putItem(software.amazon.awssdk.enhanced.dynamodb.model.PutItemEnhancedRequest
                    .builder(SecurityGroupEntity.class)
                    .item(toEntity(sg))
                    .conditionExpression(software.amazon.awssdk.enhanced.dynamodb.Expression.builder()
                            .expression("attribute_not_exists(group_id)")
                            .build())
                    .build());
            securityGroups.put(String.valueOf(sg.get("groupId")), sg);
        } catch (software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException conflict) {
            throw new ConflictException("Security Group " + sg.get("groupId") + " vừa được tạo ở nơi khác, tải lại trang");
        } catch (Exception e) {
            throw persistenceFailure(sg, e);
        }
    }

    /**
     * Ghi đè bản ghi đã có. Ghi lỗi thì không báo thành công và không để cache lệch DynamoDB.
     * Khi có revisionBase (vừa đọc từ bảng trước khi tăng), điều kiện ghi buộc bảng vẫn ở revision đó,
     * nhờ vậy hai backend cùng sửa một nhóm sẽ không âm thầm ghi đè nhau.
     */
    private void persistExisting(Map<String, Object> sg) {
        if (!isPersistent()) {
            throw new SecurityGroupPersistenceException(
                    "Chưa kết nối được bảng Security Group nên không lưu được cấu hình", null);
        }
        Object base = sg.get(REVISION_BASE);
        try {
            Map<String, software.amazon.awssdk.services.dynamodb.model.AttributeValue> values = desiredValues(sg);
            // Mọi tên thuộc tính đều đi qua alias: "name" nằm trong danh sách reserved words của
            // DynamoDB, nên SET name = :name có thể bị từ chối tuỳ ngữ cảnh biểu thức.
            StringBuilder set = new StringBuilder("SET #name = :name, #descr = :descr, #rg = :region"
                    + ", #owner = :owner, #in = :in, #out = :out, #created = :created"
                    + ", #rev = :newrev, #rc = :rc, #sra = :sra, #st = :st");
            values.put(":newrev", number(sg.get("revision")));
            values.put(":rc", number(sg.get("ruleCount")));
            values.put(":sra", number(sg.get("syncRequestedAt")));
            values.put(":st", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                    .fromS(String.valueOf(sg.get("syncStatus"))));
            // instance_id là liên kết 1-1 chuẩn giữa máy và nhóm; chỉ ghi khi đã biết máy sở hữu.
            if (sg.get("instanceId") != null) {
                set.append(", #iid = :iid");
                values.put(":iid", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                        .fromS(String.valueOf(sg.get("instanceId"))));
            }
            if (sg.containsKey("syncError")) {
                set.append(", #serr = :serr");
                values.put(":serr", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                        .fromS(String.valueOf(sg.get("syncError"))));
            } else {
                set.append(" REMOVE #serr");
            }
            String condition = base instanceof Number baseRevision && baseRevision.longValue() == 0L
                    ? "attribute_exists(#pk) AND (attribute_not_exists(#rev) OR #rev = :base)"
                    : "attribute_exists(#pk) AND #rev = :base";
            values.put(":base", number(base));
            dynamoDbClient.updateItem(request -> request
                    .tableName(securityGroupsTableName)
                    // Key phải là tên thuộc tính THẬT; alias chỉ dùng trong expression.
                    .key(Map.of("group_id", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                            .fromS(String.valueOf(sg.get("groupId")))))
                    // Ghi riêng cột cấu hình: cột do worker sở hữu (managed, lease, applied_revision,
                    // synced_at, sync_attempts...) và cột lạ ngoài model không bị putItem ghi đè.
                    .updateExpression(set.toString())
                    .conditionExpression(condition)
                    .expressionAttributeNames(Map.ofEntries(
                            Map.entry("#pk", "group_id"), Map.entry("#rev", "revision"),
                            Map.entry("#name", "name"), Map.entry("#descr", "description"),
                            Map.entry("#rg", "region"), Map.entry("#owner", "owner"),
                            Map.entry("#in", "inbound_rules"), Map.entry("#out", "outbound_rules"),
                            Map.entry("#created", "created_at"), Map.entry("#rc", "rule_count"),
                            Map.entry("#sra", "sync_requested_at"), Map.entry("#st", "sync_status"),
                            Map.entry("#iid", "instance_id"),
                            Map.entry("#serr", "sync_error")))
                    .expressionAttributeValues(values));
            // Không đưa khoá nội bộ vào cache: cache được trả ra API và dùng lại cho lần đọc sau.
            Map<String, Object> stored = new LinkedHashMap<>(sg);
            stored.remove(REVISION_BASE);
            securityGroups.put(String.valueOf(stored.get("groupId")), stored);
        } catch (software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException conflict) {
            sg.remove(REVISION_BASE);
            // Cache đang giữ bản ghi ghim revision của lần đọc thất bại: gỡ khoá nội bộ khỏi đó.
            forgetPinnedRevision(sg);
            throw new ConflictException("Security Group " + sg.get("groupId")
                    + " vừa được sửa ở nơi khác. Tải lại trang để xem cấu hình mới nhất.");
        } catch (Exception e) {
            sg.remove(REVISION_BASE);
            forgetPinnedRevision(sg);
            throw persistenceFailure(sg, e);
        }
    }

    /** Gỡ khoá revision nội bộ khỏi bản ghi đang nằm trong cache (không tạo bản ghi mới). */
    private void forgetPinnedRevision(Map<String, Object> sg) {
        Map<String, Object> cached = securityGroups.get(String.valueOf(sg.get("groupId")));
        if (cached != null) {
            cached.remove(REVISION_BASE);
        }
    }

    /** Giá trị DynamoDB của đúng các cột cấu hình mà dashboard sở hữu. */
    private Map<String, software.amazon.awssdk.services.dynamodb.model.AttributeValue> desiredValues(
            Map<String, Object> sg) throws Exception {
        Map<String, software.amazon.awssdk.services.dynamodb.model.AttributeValue> values = new LinkedHashMap<>();
        values.put(":name", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromS(String.valueOf(sg.get("name"))));
        values.put(":descr", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromS(String.valueOf(sg.getOrDefault("description", ""))));
        values.put(":region", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromS(String.valueOf(sg.getOrDefault("region", "all"))));
        values.put(":owner", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromS(String.valueOf(sg.get("owner"))));
        values.put(":in", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromS(objectMapper.writeValueAsString(sg.get("inboundRules"))));
        values.put(":out", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromS(objectMapper.writeValueAsString(sg.get("outboundRules"))));
        long createdAt = sg.get("createdAt") instanceof Number n ? n.longValue() : System.currentTimeMillis();
        values.put(":created", software.amazon.awssdk.services.dynamodb.model.AttributeValue
                .fromN(String.valueOf(createdAt)));
        return values;
    }

    private static software.amazon.awssdk.services.dynamodb.model.AttributeValue number(Object value) {
        long number = value instanceof Number n ? n.longValue() : 0L;
        return software.amazon.awssdk.services.dynamodb.model.AttributeValue.fromN(String.valueOf(number));
    }

    private SecurityGroupPersistenceException persistenceFailure(Map<String, Object> sg, Exception e) {
        log.error("Could not save security group [{}]: {}", sg.get("groupId"), e.getMessage());
        return new SecurityGroupPersistenceException(
                "Không lưu được Security Group " + sg.get("groupId") + " xuống DynamoDB", e);
    }

    private boolean isPersistent() {
        if (securityGroupsPersistent && syncStore == null && enhancedClient != null) {
            syncStore = new SecurityGroupSyncStore(dynamoDbClient, securityGroupsTableName);
        }
        return securityGroupsPersistent;
    }

    /** Nhóm mặc định lúc khởi động: chưa có bảng thì giữ trong bộ nhớ như trước. */
    private void persist(Map<String, Object> sg) {
        if (sg == null) {
            return;
        }
        try {
            persistExisting(sg);
        } catch (SecurityGroupPersistenceException e) {
            log.warn("Security group [{}] kept in memory only: {}", sg.get("groupId"), e.getMessage());
        }
    }

    private SecurityGroupEntity toEntity(Map<String, Object> sg) throws Exception {
        return SecurityGroupEntity.builder()
                .groupId(String.valueOf(sg.get("groupId")))
                .name(String.valueOf(sg.get("name")))
                .description(String.valueOf(sg.getOrDefault("description", "")))
                .region(String.valueOf(sg.getOrDefault("region", "all")))
                .owner(String.valueOf(sg.get("owner")))
                .instanceId(sg.get("instanceId") == null ? null : String.valueOf(sg.get("instanceId")))
                .inboundRulesJson(objectMapper.writeValueAsString(sg.get("inboundRules")))
                .outboundRulesJson(objectMapper.writeValueAsString(sg.get("outboundRules")))
                .createdAt(sg.get("createdAt") instanceof Number n ? n.longValue() : System.currentTimeMillis())
                .revision(asLong(sg.get("revision")))
                .appliedRevision(asLong(sg.get("appliedRevision")))
                .syncStatus(sg.get("syncStatus") == null ? null : String.valueOf(sg.get("syncStatus")))
                .syncRequestedAt(asLong(sg.get("syncRequestedAt")))
                .syncedAt(asLong(sg.get("syncedAt")))
                .syncError(sg.get("syncError") == null ? null : String.valueOf(sg.get("syncError")))
                .lastEventId(asLong(sg.get("lastEventId")))
                .ruleCount(sg.get("ruleCount") instanceof Number rc ? rc.intValue() : null)
                .managed(sg.get("managed") instanceof Boolean managed ? managed : null)
                .managedAt(asLong(sg.get("managedAt")))
                .syncLeaseOwner(sg.get("syncLeaseOwner") == null ? null : String.valueOf(sg.get("syncLeaseOwner")))
                .syncLeaseUntil(asLong(sg.get("syncLeaseUntil")))
                .syncAttempts(sg.get("syncAttempts") instanceof Number sa ? sa.intValue() : null)
                .nextSyncAt(asLong(sg.get("nextSyncAt")))
                .build();
    }

    private Map<String, Object> fromEntity(SecurityGroupEntity e) throws Exception {
        TypeReference<List<Map<String, Object>>> listType = new TypeReference<>() {};
        Map<String, Object> sg = new LinkedHashMap<>();
        sg.put("groupId", e.getGroupId());
        sg.put("name", e.getName());
        sg.put("description", e.getDescription());
        sg.put("region", e.getRegion());
        sg.put("owner", e.getOwner());
        if (e.getInstanceId() != null) sg.put("instanceId", e.getInstanceId());
        sg.put("inboundRules", new CopyOnWriteArrayList<>(e.getInboundRulesJson() != null
                ? objectMapper.readValue(e.getInboundRulesJson(), listType) : List.of()));
        sg.put("outboundRules", new CopyOnWriteArrayList<>(e.getOutboundRulesJson() != null
                ? objectMapper.readValue(e.getOutboundRulesJson(), listType) : List.of()));
        sg.put("createdAt", e.getCreatedAt());
        // Bản ghi cũ chưa có revision: coi như 0 và chưa từng được hạ tầng xác nhận.
        sg.put("revision", e.getRevision() != null ? e.getRevision() : 0L);
        if (e.getAppliedRevision() != null) sg.put("appliedRevision", e.getAppliedRevision());
        sg.put("syncStatus", e.getSyncStatus() != null ? e.getSyncStatus() : SecurityGroupSyncStatus.PENDING_SYNC);
        if (e.getSyncRequestedAt() != null) sg.put("syncRequestedAt", e.getSyncRequestedAt());
        if (e.getSyncedAt() != null) sg.put("syncedAt", e.getSyncedAt());
        if (e.getSyncError() != null) sg.put("syncError", e.getSyncError());
        if (e.getLastEventId() != null) sg.put("lastEventId", e.getLastEventId());
        if (e.getRuleCount() != null) sg.put("ruleCount", e.getRuleCount().longValue());
        if (e.getManaged() != null) sg.put("managed", e.getManaged());
        if (e.getManagedAt() != null) sg.put("managedAt", e.getManagedAt());
        if (e.getSyncLeaseOwner() != null) sg.put("syncLeaseOwner", e.getSyncLeaseOwner());
        if (e.getSyncLeaseUntil() != null) sg.put("syncLeaseUntil", e.getSyncLeaseUntil());
        if (e.getSyncAttempts() != null) sg.put("syncAttempts", e.getSyncAttempts().longValue());
        if (e.getNextSyncAt() != null) sg.put("nextSyncAt", e.getNextSyncAt());
        return sg;
    }

    private static Long asLong(Object value) {
        return value instanceof Number n ? n.longValue() : null;
    }

    /**
     * Tăng revision cấu hình mong muốn trước khi ghi. Bản ghi cũ (chưa có cột revision) đọc từ DynamoDB bằng
     * revision 0, nên lấy max(cache, DynamoDB) để hai backend cùng sửa không ghi lùi số.
     */
    /**
     * Tăng revision cấu hình mong muốn trước khi ghi. Bản ghi cũ (chưa có cột revision) đọc từ DynamoDB bằng
     * revision 0, nên lấy max(cache, DynamoDB) để hai backend cùng sửa không ghi lùi số.
     *
     * Trả về revision đã đọc từ bảng (revisionBase) trong thuộc tính tạm để persistExisting dùng làm điều kiện
     * ghi: nếu bảng đã sang revision khác trong lúc xử lý thì ghi bị từ chối (optimistic concurrency).
     */
    /**
     * Ghim revision của ĐÚNG cấu hình vừa đọc vào bản ghi (REVISION_BASE) để điều kiện ghi dùng đúng số đó.
     *
     * Không đọc lại bảng ở đây để "lấy số lớn hơn": nếu bảng đã sang revision mới thì rules trong tay đã cũ,
     * nhận revision mới sẽ ghi đè cấu hình mới của người khác bằng nội dung cũ. Đọc lỗi cũng không được đoán
     * số — hàm ném lỗi để lần sửa này dừng lại thay vì ghi mù.
     */
    private long nextRevision(Map<String, Object> sg) {
        // Dung revision cua CHINH lan doc da tao ra rules trong `sg` (ghim boi refreshFromStoreStrict).
        // Doc lai de lay so moi nhat se hop thuc hoa rules cu -> ghi de cau hinh nguoi khac vua luu.
        Object pinned = sg.get(REVISION_BASE);
        if (!(pinned instanceof Number base)) {
            throw new SecurityGroupPersistenceException(
                    "Bản ghi Security Group " + sg.get("groupId")
                            + " chưa được đọc theo chế độ an toàn, chưa thay đổi gì", null);
        }
        long revision = base.longValue() + 1;
        sg.put("revision", revision);
        sg.put("syncRequestedAt", System.currentTimeMillis());
        // Cấu hình đã đổi nhưng chưa có bằng chứng firewall đã áp dụng: trạng thái luôn là PENDING_SYNC.
        // Không còn feature-flag tắt điều phối; đường gửi lệnh là SG service -> API Gateway.
        sg.put("syncStatus", SecurityGroupSyncStatus.PENDING_SYNC);
        sg.put("ruleCount", ((List<?>) sg.get("inboundRules")).size() + ((List<?>) sg.get("outboundRules")).size());
        sg.remove("syncError");
        return revision;
    }


    /**
     * Tìm Security Group riêng của máy: CHỈ ĐỌC. Dùng cho danh sách và GET nên không tạo, không sửa dữ liệu.
     * Trả null khi máy chưa có nhóm riêng; ném ConflictException khi dữ liệu legacy có nhiều nhóm trùng và
     * chưa thể xác định nhóm đúng (không tự chọn một nhóm để tránh mở nhầm cổng).
     */
    @SuppressWarnings("unchecked")
    private synchronized String findInstanceGroup(InstanceEntity inst) {
        String owner = ownerKey(inst);
        String instanceId = inst.getInstanceId();
        // Nếu máy đã có active_nova_id nhưng cache chưa nạp bản ghi SG do Lambda mới tạo, nạp từ DynamoDB trước:
        if (isPersistent() && inst.getActiveNovaId() != null && !inst.getActiveNovaId().isBlank()) {
            String novaSgId = inst.getActiveNovaId().trim();
            if (!securityGroups.containsKey(novaSgId)) {
                try {
                    SecurityGroupEntity stored = securityGroupsTable.getItem(Key.builder().partitionValue(novaSgId).build());
                    if (stored != null) {
                        securityGroups.put(novaSgId, fromEntity(stored));
                    }
                } catch (Exception e) {
                    log.warn("Could not load Nova security group [{}] from DynamoDB: {}", novaSgId, e.getMessage());
                }
            }
        }
        // Liên kết chuẩn: bản ghi do launch tạo mang instance_id; nhóm do backend tạo cũng ghi cột này.
        List<String> byInstance = new ArrayList<>();
        for (Map<String, Object> g : securityGroups.values()) {
            if (instanceId != null && instanceId.equalsIgnoreCase(String.valueOf(g.get("instanceId")))
                    && owner.equalsIgnoreCase(String.valueOf(g.get("owner")))) {
                String candidate = String.valueOf(g.get("groupId"));
                if (!byInstance.contains(candidate)) {
                    byInstance.add(candidate);
                }
            }
        }
        if (byInstance.size() == 1) {
            return byInstance.get(0);
        }
        if (byInstance.size() > 1) {
            Collections.sort(byInstance);
            throw ambiguousInstanceGroups(inst, byInstance);
        }
        // Dữ liệu legacy (chưa có cột instance_id): nhận diện qua mô tả cố định do backend ghi.
        String marker = "Security group of " + inst.getInstanceId();
        List<String> matches = new ArrayList<>();
        for (Map<String, Object> g : securityGroups.values()) {
            if (marker.equals(g.get("description")) && owner.equalsIgnoreCase(String.valueOf(g.get("owner")))) {
                String candidate = String.valueOf(g.get("groupId"));
                if (!matches.contains(candidate)) {
                    matches.add(candidate);
                }
            }
        }
        if (matches.size() == 1) {
            return matches.get(0);
        }
        if (matches.size() > 1) {
            Collections.sort(matches);
            throw ambiguousInstanceGroups(inst, matches);
        }
        List<String> current = attachedGroupIdList(inst);
        if (current.size() == 1) {
            Map<String, Object> sg = securityGroups.get(current.get(0));
            if (sg != null && owner.equalsIgnoreCase(String.valueOf(sg.get("owner")))) {
                return current.get(0);
            }
        }
        return null;
    }

    private ConflictException ambiguousInstanceGroups(InstanceEntity inst, List<String> matches) {
        log.warn("Instance [{}] has {} legacy security groups: {}", inst.getInstanceId(), matches.size(), matches);
        return new ConflictException("Máy " + inst.getInstanceId() + " có " + matches.size()
                + " Security Group trùng (" + String.join(", ", matches) + "). Cần đối chiếu dữ liệu trước khi sửa rule.");
    }

    private List<String> attachedGroupIdList(InstanceEntity inst) {
        List<String> current = new ArrayList<>();
        String raw = inst == null ? null : inst.getSecurityGroup();
        if (raw != null && !raw.isBlank()) {
            Arrays.stream(raw.split(",")).map(String::trim).filter(x -> !x.isEmpty()).forEach(current::add);
        }
        return current;
    }

    /**
     * Mỗi máy ảo có đúng một Security Group riêng. Máy chưa có thì tạo nhóm riêng, chép rule đang có.
     *
     * Nhóm riêng được nhận ra qua mô tả "Security group of <id>" + user_id của máy. Không dùng người gọi HTTP
     * làm chủ sở hữu (người gọi có thể là admin/worker)!
     */
    @SuppressWarnings("unchecked")
    private synchronized String ensureInstanceGroup(InstanceEntity inst) {
        String existing = findInstanceGroup(inst);
        if (existing != null) {
            return existing;
        }
        String owner = ownerKey(inst);
        String marker = "Security group of " + inst.getInstanceId();
        novaLookup.fill(inst);
        List<String> current = attachedGroupIdList(inst);
        if (current.isEmpty()) {
            current = DEFAULT_INSTANCE_GROUPS;
        }

        // Chép rule của các nhóm đang gắn (bỏ rule trỏ tới nhóm khác như "sg-default"), rule thuộc về chủ máy
        List<Map<String, Object>> inbound = new CopyOnWriteArrayList<>();
        List<Map<String, Object>> outbound = new CopyOnWriteArrayList<>();
        for (String id : current) {
            Map<String, Object> old = securityGroups.get(id);
            if (old == null) {
                continue;
            }
            copyRules((List<Map<String, Object>>) old.get("inboundRules"), inbound, owner);
            copyRules((List<Map<String, Object>>) old.get("outboundRules"), outbound, owner);
        }
        if (outbound.isEmpty()) {
            outbound.add(rule("all", 0, 65535, "0.0.0.0/0", "Allow all outbound traffic", owner));
        }
        if (inbound.isEmpty()) {
            // Giống nhóm launch-wizard mặc định của EC2: mở SSH để còn kết nối được vào máy
            inbound.add(rule("tcp", 22, 22, "0.0.0.0/0", "SSH", owner));
        }

        String name = (inst.getInstanceName() != null && !inst.getInstanceName().isBlank() ? inst.getInstanceName() : inst.getInstanceId()) + "-sg";
        Map<String, Object> sg = new LinkedHashMap<>();
        sg.put("groupId", "sg-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10));
        sg.put("name", name);
        sg.put("description", marker);
        sg.put("region", inst.getCurrentRegion() != null ? inst.getCurrentRegion() : "all");
        sg.put("owner", owner);
        // Ghi liên kết 1-1 để lần sau nhận ra nhóm bằng dữ liệu, không phụ thuộc câu mô tả.
        sg.put("instanceId", inst.getInstanceId());
        sg.put("inboundRules", inbound);
        sg.put("outboundRules", outbound);
        sg.put("createdAt", System.currentTimeMillis());
        sg.put("revision", 0L);
        sg.put("syncStatus", SecurityGroupSyncStatus.PENDING_SYNC);
        String groupId = String.valueOf(sg.get("groupId"));
        persistNew(sg);

        auditLogService.logAction("SG_CREATE", "INSTANCE", inst.getInstanceId(),
                "Created dedicated security group " + groupId + " (from " + current + ")");
        return groupId;
    }

    private static void copyRules(List<Map<String, Object>> from, List<Map<String, Object>> to, String owner) {
        if (from == null) {
            return;
        }
        for (Map<String, Object> r : from) {
            String cidr = String.valueOf(r.get("cidr"));
            if (cidr.startsWith("sg-")) {
                continue;
            }
            boolean exists = to.stream().anyMatch(x -> Objects.equals(x.get("protocol"), r.get("protocol"))
                    && Objects.equals(x.get("fromPort"), r.get("fromPort")) && Objects.equals(x.get("toPort"), r.get("toPort"))
                    && Objects.equals(x.get("cidr"), r.get("cidr")));
            if (!exists) {
                to.add(rule(String.valueOf(r.get("protocol")), ((Number) r.get("fromPort")).intValue(), ((Number) r.get("toPort")).intValue(),
                        cidr, String.valueOf(r.getOrDefault("description", "")), owner));
            }
        }
    }

    private List<String> attachedGroupIds(InstanceEntity inst) {
        return inst == null ? List.of() : List.of(ensureInstanceGroup(inst));
    }

    private InstanceEntity ownedInstance(String instanceId, String user) {
        InstanceEntity inst = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        if (inst == null || !user.equalsIgnoreCase(ownerKey(inst))) {
            throw new ResourceNotFoundException("Không tìm thấy máy ảo: " + instanceId);
        }
        return inst;
    }

    /**
     * Chủ của máy lấy từ user_id đã lưu (usr-lam -> lam). Không fallback sang người đang đăng nhập: nếu bản ghi
     * thiếu user_id thì không thể xác định chủ, và việc đoán theo phiên HTTP chính là nguồn tạo nhóm rác.
     */
    private String ownerKey(InstanceEntity inst) {
        String owner = inst == null ? null : inst.getUsername();
        if (owner == null || owner.isBlank()) {
            throw new ConflictException("Máy " + (inst == null ? "" : inst.getInstanceId())
                    + " thiếu user_id nên không xác định được chủ Security Group.");
        }
        return owner;
    }

    private String getCurrentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return "admin";
    }

    /** Chỉ chủ máy thấy và sửa được nhóm của máy mình; các nhóm dùng chung cũ không còn hiện ra. */
    private boolean visibleTo(Map<String, Object> sg, String username) {
        return username.equalsIgnoreCase(String.valueOf(sg.get("owner")));
    }

    // SPEC-04 mục 5: endpoint GET /api/network và hàm getNetworkOverview() (dữ liệu VPC/ENI/FIP
    // giả lập, có cả VPC Virginia us-east-1) đã bị loại bỏ. Tầng mạng chỉ còn đúng các endpoint
    // nghiệp vụ: GET/POST/PUT security-groups và POST /api/network/dns.

    /**
     * Bản ghi A của Route 53 cho các máy của người dùng: sinh từ cột dns + elastic_ip của máy,
     * bản ghi người dùng tự cập nhật (dnsStore) ghi đè lên.
     */
    private List<Map<String, Object>> dnsRecordsForCurrentUser() {
        String user = getCurrentUsername();
        Map<String, Map<String, Object>> records = new LinkedHashMap<>();
        try {
            for (InstanceEntity i : instancesTable.scan().items()) {
                if (user.equalsIgnoreCase(i.getUsername())) {
                    novaLookup.fill(i);
                }
                if (!user.equalsIgnoreCase(i.getUsername()) || i.getDns() == null || i.getDns().isBlank()
                        || i.getElasticIp() == null || i.getElasticIp().isBlank()
                        || "TERMINATED".equalsIgnoreCase(i.getCurrentStatus())) {
                    continue;
                }
                Map<String, Object> r = new HashMap<>();
                r.put("domainName", i.getDns());
                r.put("targetIp", i.getElasticIp());
                r.put("ttl", 60);
                r.put("status", "SYNCED");
                r.put("instanceId", i.getInstanceId());
                records.put(i.getDns().toLowerCase(Locale.ROOT), r);
            }
        } catch (Exception e) {
            log.warn("Could not read instances for DNS records: {}", e.getMessage());
        }
        for (Map<String, Object> manual : dnsStore) {
            String key = String.valueOf(manual.get("domainName")).toLowerCase(Locale.ROOT);
            if (records.containsKey(key)) {
                Map<String, Object> merged = new HashMap<>(records.get(key));
                merged.putAll(manual);
                records.put(key, merged);
            }
        }
        return new ArrayList<>(records.values());
    }

    public Map<String, Object> updateDnsRecord(UpdateDnsRequest request) {
        String domain = request.getDomainName();
        Map<String, Object> record = new HashMap<>();
        record.put("domainName", domain);
        record.put("targetIp", request.getTargetIp());
        record.put("ttl", request.getTtl());
        record.put("status", "SYNCED");
        record.put("updatedAt", System.currentTimeMillis());

        dnsStore.removeIf(d -> domain.equalsIgnoreCase(String.valueOf(d.get("domainName"))));
        dnsStore.add(record);

        auditLogService.logAction("UPDATE_DNS", "DNS", domain,
                "Updated Route 53 DNS target to " + request.getTargetIp() + " (TTL: " + request.getTtl() + "s)");

        return record;
    }

    // ---------------- Security Groups ----------------

    /**
     * Groups visible to the current user; only the dedicated group of instanceId when it is given.
     * GET is read-only: máy chưa có nhóm riêng (hoặc dữ liệu legacy có nhiều nhóm trùng) thì báo lỗi,
     * không tự tạo/thay đổi dữ liệu trong lúc xem.
     */
    public List<Map<String, Object>> getSecurityGroups(String instanceId) {
        String user = getCurrentUsername();
        if (instanceId != null && !instanceId.isBlank()) {
            InstanceEntity inst = ownedInstance(instanceId.trim(), user);
            String groupId = findInstanceGroup(inst);
            if (groupId == null) {
                return List.of();
            }
            Map<String, Object> sg = securityGroups.get(groupId);
            if (sg == null || !visibleTo(sg, user)) {
                return List.of();
            }
            return List.of(refreshed(sg));
        }
        // Danh sách chung: nhóm riêng của từng máy (chưa bị xóa) của người dùng
        Set<String> ids = new HashSet<>();
        for (InstanceEntity i : instancesTable.scan().items()) {
            if (!user.equalsIgnoreCase(i.getUsername()) || "TERMINATED".equalsIgnoreCase(i.getCurrentStatus())) {
                continue;
            }
            try {
                // GET chỉ đọc: máy chưa có nhóm riêng thì bỏ qua, không tạo thêm bản ghi trong lúc xem.
                String groupId = findInstanceGroup(i);
                if (groupId != null) {
                    ids.add(groupId);
                }
            } catch (ConflictException ambiguous) {
                // Dữ liệu legacy trùng: không tạo/chọn nhóm, bỏ qua máy đó cho tới khi đối chiếu xong.
                log.warn("Skipping security group list entry: {}", ambiguous.getMessage());
            }
        }
        return ids.stream()
                .map(securityGroups::get)
                .filter(Objects::nonNull)
                .filter(sg -> visibleTo(sg, user))
                .sorted(Comparator.comparing(sg -> String.valueOf(sg.get("groupId"))))
                .map(this::refreshed)
                .collect(Collectors.toList());
    }

    /**
     * groupId empty -> create a new group. groupId given -> add rules to that group.
     * attachInstanceId given -> also attach the group to that instance.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> createOrUpdateSecurityGroup(SecurityGroupRequest request) {
        String user = getCurrentUsername();
        Map<String, Object> sg;
        boolean created = false;

        if (request.getGroupId() != null && !request.getGroupId().isBlank()) {
            sg = securityGroups.get(request.getGroupId().trim());
            if (sg == null || !visibleTo(sg, user)) {
                throw new ResourceNotFoundException("Không tìm thấy Security Group: " + request.getGroupId());
            }
        } else {
            // Mỗi máy có sẵn một Security Group riêng; chỉ thêm/xóa rule, không tạo nhóm dùng chung
            throw new AppException("Mỗi máy ảo đã có Security Group riêng. Hãy thêm rule inbound/outbound vào nhóm của máy.");
        }

        String groupId = String.valueOf(sg.get("groupId"));
        // Copy-on-write: ghi thất bại hoặc lỗi validation không được làm thay đổi cache đang phục vụ request khác.
        Map<String, Object> working = mutableCopy(refreshFromStoreStrict(String.valueOf(sg.get("groupId"))));
        List<Map<String, Object>> inbound = (List<Map<String, Object>>) working.get("inboundRules");
        List<Map<String, Object>> outbound = (List<Map<String, Object>>) working.get("outboundRules");
        int added = addRules(inbound, request.getInboundRules(), user) + addRules(outbound, request.getOutboundRules(), user);

        if (created || added > 0) {
            // Thêm rule cũng là thay đổi firewall: tăng revision và phát yêu cầu đồng bộ như PUT, không chỉ PUT.
            applyExpectedRevision(working, request.getExpectedRevision());
            nextRevision(working);
            persistExisting(working);
            String instanceId = instanceIdOf(working);
            if (instanceId != null) {
                requestSync(groupId, instanceId, String.valueOf(working.get("revision")), user);
            }
            sg = working;
        }
        if (created) {
            auditLogService.logAction("SG_CREATE", "SECURITY_GROUP", groupId,
                    "Created security group " + sg.get("name") + " with " + added + " rule(s)");
        } else if (added > 0) {
            auditLogService.logAction("SG_RULE_ADD", "SECURITY_GROUP", groupId,
                    "Added " + added + " rule(s) to " + sg.get("name"));
        }

        String attachTo = request.getAttachInstanceId();
        if (attachTo != null && !attachTo.isBlank()) {
            String instanceId = attachTo.trim();
            InstanceEntity inst = ownedInstance(instanceId, user);
            List<String> current = new ArrayList<>(attachedGroupIds(inst));
            if (!current.contains(groupId)) {
                current.add(groupId);
                inst.setSecurityGroup(String.join(",", current));
                instancesTable.putItem(inst);
                auditLogService.logAction("SG_ATTACH", "INSTANCE", instanceId, "Attached security group " + groupId);
            }
        }

        Map<String, Object> result = copyOf(sg);
        result.put("rulesAdded", added);
        return result;
    }

    /**
     * Ghi đè toàn bộ rule inbound/outbound của Security Group riêng của máy (dùng ở bước 6 trang Launch và
     * hộp thoại "Sửa Security Group"). Đây là cấu hình MONG MUỐN: hàm chỉ lưu DynamoDB rồi phát yêu cầu đồng bộ,
     * firewall Neutron/AWS chỉ đổi sau khi worker xác nhận, nên kết quả trả về luôn kèm syncStatus.
     */
    /**
     * Ghi đè toàn bộ rule inbound/outbound của Security Group riêng của máy (dùng ở bước 6 trang Launch và
     * hộp thoại "Sửa Security Group"). Đây là cấu hình MONG MUỐN của toàn bộ rule: firewall Neutron chỉ đổi
     * sau khi worker xác nhận, nên kết quả luôn kèm syncStatus.
     *
     * Phương án B: danh sách rỗng là chủ ý (không cấp rule nào) và KHÔNG được tự thêm allow-all outbound
     * hay SSH, nếu không rule người dùng vừa xóa sẽ xuất hiện lại ở lần áp dụng sau.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> replaceInstanceRules(String instanceId, SecurityGroupRequest request) {
        if (request.getGroupIds() != null) {
            throw new AppException("Không còn đổi Security Group cho máy: mỗi máy có một nhóm riêng. "
                    + "Gửi inboundRules/outboundRules để đặt lại rule của nhóm.");
        }
        if (request.getInboundRules() == null || request.getOutboundRules() == null) {
            throw new AppException("Thiếu inboundRules/outboundRules: gửi danh sách rỗng [] nếu muốn bỏ hết rule.");
        }
        String user = getCurrentUsername();
        InstanceEntity inst = ownedInstance(instanceId, user);
        String groupId = ensureInstanceGroup(inst);
        // Copy-on-write: thao tác trên bản sao để ghi thất bại không làm bẩn cache đang phục vụ request khác.
        // Đọc STRICT: rules và revision phải đến từ cùng một lần đọc, nếu không điều kiện ghi vô nghĩa.
        Map<String, Object> current = refreshFromStoreStrict(groupId);
        Map<String, Object> sg = mutableCopy(current);
        List<Map<String, Object>> inbound = (List<Map<String, Object>>) sg.get("inboundRules");
        List<Map<String, Object>> outbound = (List<Map<String, Object>>) sg.get("outboundRules");
        List<Map<String, Object>> newIn = new CopyOnWriteArrayList<>();
        List<Map<String, Object>> newOut = new CopyOnWriteArrayList<>();
        int added = addRules(newIn, request.getInboundRules(), user) + addRules(newOut, request.getOutboundRules(), user);
        boolean changed = !sameRules(newIn, inbound) || !sameRules(newOut, outbound);
        // Kiểm tra revision TRƯỚC nhánh no-op: nếu chỉ no-op đôi khi kiểm tra thì client đang giữ bản cũ
        // sẽ nhận "đã khớp" trong khi thực tế không có gì được ghi.
        applyExpectedRevision(sg, request.getExpectedRevision());
        if (!changed) {
            // Không có rule nào khác: giữ nguyên revision, không phát sự kiện trùng (idempotent cho launch retry).
            log.info("Security group [{}] of {} already matches the requested rules", groupId, instanceId);
            Map<String, Object> result = copyOf(current);
            result.put("rulesAdded", 0);
            result.put("syncAccepted", false);
            result.put("eventPublished", false);
            return result;
        }
        sg.put("inboundRules", newIn);
        sg.put("outboundRules", newOut);
        long revision = nextRevision(sg);
        persistExisting(sg);
        SecurityGroupSyncResult sync = requestSync(groupId, instanceId, String.valueOf(revision), user);
        auditLogService.logAction("SG_RULES_SET", "SECURITY_GROUP", groupId,
                "Set " + newIn.size() + " inbound / " + newOut.size() + " outbound rule(s) for " + instanceId
                        + " (revision " + revision + ", sync " + sync.getSyncStatus() + ")");
        Map<String, Object> result = copyOf(securityGroups.get(groupId));
        result.put("rulesAdded", added);
        result.put("syncAccepted", sync.isAccepted());
        result.put("eventPublished", sync.isEventPublished());
        return result;
    }

    /**
     * Client gửi kèm revision đang hiển thị: nếu bảng đã có revision khác thì từ chối thay vì ghi đè
     * thầm lặng thay đổi của người khác.
     */
    private void applyExpectedRevision(Map<String, Object> sg, Long expectedRevision) {
        if (expectedRevision == null) {
            return;
        }
        long current = sg.get("revision") instanceof Number n ? n.longValue() : 0L;
        if (current != expectedRevision) {
            throw new ConflictException("Security Group " + sg.get("groupId") + " đã được sửa ở nơi khác (revision "
                    + current + " ≠ " + expectedRevision + "). Tải lại trang để xem cấu hình mới nhất.");
        }
    }

    /** Hai danh sách rule trùng nhau khi cùng giao thức/cổng/CIDR, không phụ thuộc thứ tự hay mô tả. */
    private static boolean sameRules(List<Map<String, Object>> left, List<Map<String, Object>> right) {
        if (left.size() != right.size()) {
            return false;
        }
        Set<String> a = left.stream().map(NetworkService::ruleKey).collect(Collectors.toSet());
        Set<String> b = right.stream().map(NetworkService::ruleKey).collect(Collectors.toSet());
        return a.equals(b);
    }

    private static String ruleKey(Map<String, Object> r) {
        return String.valueOf(r.get("protocol")).toLowerCase(Locale.ROOT) + "|" + r.get("fromPort") + "|"
                + r.get("toPort") + "|" + r.get("cidr");
    }

    /** ID máy của nhóm riêng, nhận từ mô tả "Security group of <id>" do ensureInstanceGroup ghi. */
    private static String instanceIdOf(Map<String, Object> sg) {
        String description = sg == null ? null : String.valueOf(sg.get("description"));
        String prefix = "Security group of ";
        return description != null && description.startsWith(prefix) && description.length() > prefix.length()
                ? description.substring(prefix.length()) : null;
    }

    /**
     * Phát yêu cầu đồng bộ revision mới nhất. Không ném lỗi: cấu hình đã lưu bền vững, còn việc phát sự kiện
     * thất bại được ghi vào syncStatus/syncError; lần sửa kế tiếp phát lại trạng thái đầy đủ của nhóm nên
     * bỏ lỡ một sự kiện không làm mất dữ liệu.
     */
    private SecurityGroupSyncResult requestSync(String groupId, String instanceId, String revisionText, String user) {
        long requested = parseRevision(revisionText);
        Map<String, Object> sg = securityGroups.get(groupId);
        if (sg == null) {
            // Cache có thể chưa có nhóm (backend vừa khởi động, hoặc nhóm vừa được pipeline tạo).
            // Đọc lại từ bảng thay vì im lặng bỏ qua: bỏ qua làm UI báo "đã lưu" mà không có sự kiện nào.
            try {
                sg = refreshFromStoreStrict(groupId);
            } catch (RuntimeException e) {
                log.warn("Could not reload security group [{}] before sync: {}", groupId, e.getMessage());
                sg = null;
            }
        }
        if (sg == null) {
            String reason = "Không đọc lại được Security Group để phát yêu cầu đồng bộ";
            markSyncFailure(groupId, requested, reason);
            return SecurityGroupSyncResult.of(false, false, Math.max(requested, 0L), null);
        }
        long cachedRevision = sg.get("revision") instanceof Number n ? n.longValue() : 0L;
        // revisionText là revision vừa ghi xuống bảng; không suy lại từ cache để tránh phát sự kiện cũ.
        long revision = requested > 0 ? requested : cachedRevision;
        if (revision != cachedRevision) {
            Map<String, Object> fresh = null;
            try {
                fresh = refreshFromStoreStrict(groupId);
            } catch (RuntimeException e) {
                log.warn("Could not reload security group [{}] before sync: {}", groupId, e.getMessage());
            }
            long storedRevision = fresh != null && fresh.get("revision") instanceof Number n ? n.longValue() : -1L;
            if (storedRevision != revision) {
                String reason = "Bản ghi đang ở revision " + storedRevision + " trong khi yêu cầu là "
                        + revision + "; không phát sự kiện cũ";
                markSyncFailure(groupId, revision, reason);
                return SecurityGroupSyncResult.of(false, false, revision, SecurityGroupSyncStatus.PENDING_SYNC);
            }
            sg = fresh;
        }
        SecurityGroupSyncStore store = syncStore();
        InstanceEntity inst = null;
        try {
            inst = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        } catch (Exception e) {
            log.warn("Could not read instance [{}] before security group sync: {}", instanceId, e.getMessage());
        }
        NovaEntity nova = inst == null ? null : novaLookup.find(inst);
        String status = inst == null ? null : String.valueOf(inst.getCurrentStatus()).toUpperCase(Locale.ROOT);
        if (syncNotApplicable(inst, nova)) {
            // Chưa có tài nguyên mạng để áp dụng: giữ cấu hình mong muốn và nói rõ lý do thay vì báo đã mở cổng.
            String reason = status != null && !SYNC_APPLICABLE_STATES.contains(status)
                    ? "Máy ở trạng thái " + status + ", chưa áp dụng được rule xuống hạ tầng"
                    : "Máy chưa có Nova đang hoạt động nên chưa áp dụng được rule";
            sg.put("syncStatus", SecurityGroupSyncStatus.SYNC_NOT_APPLICABLE);
            sg.put("syncError", reason);
            if (store != null) {
                try {
                    store.markNotApplicable(groupId, revision, reason);
                } catch (Exception e) {
                    log.warn("Could not record SYNC_NOT_APPLICABLE for [{}]: {}", groupId, e.getMessage());
                }
            }
            auditLogService.logAction("SG_SYNC_SKIPPED", "SECURITY_GROUP", groupId, reason);
            return SecurityGroupSyncResult.of(false, false, revision, SecurityGroupSyncStatus.SYNC_NOT_APPLICABLE);
        }
        String novaId = nova != null ? nova.getNovaId() : inst.getActiveNovaId();
        try {
            if (eventBridgeGatewayClient == null) {
                throw new IllegalStateException("EventBridge Gateway client chưa được cấu hình");
            }
            int ruleCount = ((List<?>) sg.get("inboundRules")).size() + ((List<?>) sg.get("outboundRules")).size();
            eventBridgeGatewayClient.sendSecurityGroupSyncEvent(groupId, instanceId, novaId, revision, ruleCount, user);
            sg.put("syncStatus", SecurityGroupSyncStatus.PENDING_SYNC);
            sg.put("lastEventId", revision);
            sg.remove("syncError");
            boolean recorded = true;
            if (store != null) {
                try {
                    recorded = store.markEventPublished(groupId, revision);
                } catch (Exception e) {
                    log.warn("Could not record event state for [{}]: {}", groupId, e.getMessage());
                    recorded = false;
                }
            }
            if (!recorded) {
                // Sự kiện đã phát nhưng bảng đã sang revision mới: không được báo "đã gửi cho bản này".
                String reason = "Đã phát sự kiện revision " + revision
                        + " nhưng bản ghi đã sang revision mới; lần lưu kế tiếp sẽ gửi lại";
                sg.put("syncStatus", SecurityGroupSyncStatus.PENDING_SYNC);
                sg.put("syncError", reason);
                log.warn("Security group [{}] revision {} published but the record moved on", groupId, revision);
                return SecurityGroupSyncResult.of(false, false, revision, SecurityGroupSyncStatus.PENDING_SYNC);
            }
            auditLogService.logAction("SG_SYNC_REQUESTED", "SECURITY_GROUP", groupId,
                    "Published security-group.updated revision " + revision + " for " + instanceId);
            return SecurityGroupSyncResult.of(true, true, revision, SecurityGroupSyncStatus.PENDING_SYNC);
        } catch (Exception e) {
            String reason = "Chưa phát được yêu cầu đồng bộ hạ tầng: " + e.getMessage();
            log.error("Could not publish security group sync for [{}]: {}", groupId, e.getMessage());
            sg.put("syncStatus", SecurityGroupSyncStatus.PENDING_SYNC);
            sg.put("syncError", reason);
            if (store != null) {
                try {
                    store.markEventFailed(groupId, revision, reason);
                } catch (Exception ignored) {
                    // Lỗi ghi trạng thái không được che mất lỗi phát sự kiện
                }
            }
            return SecurityGroupSyncResult.of(false, false, revision, SecurityGroupSyncStatus.PENDING_SYNC);
        }
    }

    /**
     * Chưa có tài nguyên mạng để áp dụng rule: thiếu bản ghi máy, máy không còn Nova, hoặc trạng thái máy
     * không còn giữ tài nguyên mạng (FAILED / TERMINATED / ...). Máy đang launch (PENDING) vẫn áp dụng được.
     */
    private static boolean syncNotApplicable(InstanceEntity inst, NovaEntity nova) {
        if (inst == null) {
            return true;
        }
        String status = String.valueOf(inst.getCurrentStatus()).toUpperCase(Locale.ROOT);
        if (!SYNC_APPLICABLE_STATES.contains(status)) {
            return true;
        }
        boolean hasNova = nova != null && nova.getNovaId() != null && !nova.getNovaId().isBlank();
        boolean hasActiveNova = inst.getActiveNovaId() != null && !inst.getActiveNovaId().isBlank();
        return !hasNova && !hasActiveNova;
    }

    /** Revision client vừa lưu; -1 khi chuỗi không phải số dương. */
    private static long parseRevision(String revisionText) {
        try {
            long value = Long.parseLong(String.valueOf(revisionText).trim());
            return value > 0 ? value : -1L;
        } catch (NumberFormatException | NullPointerException e) {
            return -1L;
        }
    }

    /** Ghi nhận lỗi phát sự kiện vào đúng revision; lỗi ghi trạng thái không được che lỗi phát sự kiện. */
    private void markSyncFailure(String groupId, long revision, String reason) {
        log.warn("Security group [{}] sync not published: {}", groupId, reason);
        SecurityGroupSyncStore store = syncStore();
        if (store == null || revision <= 0) {
            return;
        }
        try {
            store.markEventFailed(groupId, revision, reason);
        } catch (Exception e) {
            log.warn("Could not record sync failure for [{}]: {}", groupId, e.getMessage());
        }
    }

    private int addRules(List<Map<String, Object>> target, List<SecurityGroupRequest.Rule> rules, String user) {
        if (rules == null) {
            return 0;
        }
        int added = 0;
        for (SecurityGroupRequest.Rule r : rules) {
            String protocol = r.getProtocol().toLowerCase(Locale.ROOT);
            int from;
            int to;
            if ("icmp".equals(protocol)) {
                // All ICMP không có khái niệm cổng 65535 của TCP/UDP mà dùng type/code. Khóa cứng 0 - 0 cho All ICMP.
                from = 0;
                to = 0;
            } else if ("all".equals(protocol)) {
                from = 0;
                to = 65535;
            } else {
                from = r.getFromPort();
                to = (r.getToPort() == 0 ? r.getFromPort() : r.getToPort());
                if (to < from) {
                    throw new AppException("Cổng kết thúc phải lớn hơn hoặc bằng cổng bắt đầu");
                }
            }
            String cidr = r.getCidr().trim();
            boolean exists = target.stream().anyMatch(x ->
                    protocol.equals(x.get("protocol")) && Objects.equals(from, x.get("fromPort"))
                            && Objects.equals(to, x.get("toPort")) && cidr.equals(x.get("cidr")));
            if (exists) {
                continue;
            }
            target.add(rule(protocol, from, to, cidr, r.getDescription() != null ? r.getDescription().trim() : "", user));
            added++;
        }
        return added;
    }

    /**
     * Xóa một rule (inbound hoặc outbound) khỏi Security Group.
     * Rule mặc định của hệ thống không xóa được; rule do người dùng thêm chỉ người đó (hoặc chủ nhóm) xóa được.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> deleteRule(String groupId, String ruleId) {
        String user = getCurrentUsername();
        Map<String, Object> sg = securityGroups.get(groupId);
        if (sg == null || !visibleTo(sg, user)) {
            throw new ResourceNotFoundException("Không tìm thấy Security Group: " + groupId);
        }
        for (String key : List.of("inboundRules", "outboundRules")) {
            List<Map<String, Object>> rules = (List<Map<String, Object>>) sg.get(key);
            Optional<Map<String, Object>> found = rules.stream().filter(r -> ruleId.equals(r.get("ruleId"))).findFirst();
            if (found.isEmpty()) {
                continue;
            }
            Map<String, Object> r = found.get();
            boolean ownsGroup = user.equalsIgnoreCase(String.valueOf(sg.get("owner")));
            if (!ownsGroup) {
                throw new ConflictException("Bạn chỉ xóa được rule trong Security Group của máy mình.");
            }
            // Copy-on-write: chỉ cache được thay sau khi ghi DynamoDB thành công.
            Map<String, Object> working = mutableCopy(refreshFromStoreStrict(String.valueOf(sg.get("groupId"))));
            List<Map<String, Object>> workingRules = (List<Map<String, Object>>) working.get(key);
            workingRules.removeIf(x -> ruleId.equals(x.get("ruleId")));
            nextRevision(working);
            persistExisting(working);
            String instanceId = instanceIdOf(working);
            if (instanceId != null) {
                requestSync(groupId, instanceId, String.valueOf(working.get("revision")), user);
            }
            auditLogService.logAction("SG_RULE_DELETE", "SECURITY_GROUP", groupId,
                    "Deleted " + key.replace("Rules", "") + " rule " + r.get("protocol") + " " + r.get("fromPort") + "-" + r.get("toPort") + " " + r.get("cidr"));
            return copyOf(working);
        }
        throw new ResourceNotFoundException("Không tìm thấy rule " + ruleId + " trong " + groupId);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> copyOf(Map<String, Object> sg) {
        String user = getCurrentUsername();
        boolean ownsGroup = user.equalsIgnoreCase(String.valueOf(sg.get("owner")));
        Map<String, Object> out = new LinkedHashMap<>(sg);
        // Nhóm riêng của máy: trả kèm instanceId để giao diện ghép nhóm với máy
        String desc = String.valueOf(sg.get("description"));
        if (desc.startsWith("Security group of ")) {
            out.put("instanceId", desc.substring("Security group of ".length()));
        }
        for (String key : List.of("inboundRules", "outboundRules")) {
            List<Map<String, Object>> rules = new ArrayList<>();
            for (Map<String, Object> r : (List<Map<String, Object>>) sg.get(key)) {
                Map<String, Object> copy = new LinkedHashMap<>(r);
                String addedBy = String.valueOf(r.get("addedBy"));
                copy.put("deletable", ownsGroup);
                copy.put("system", false);
                copy.remove("addedBy");
                rules.add(copy);
            }
            out.put(key, rules);
        }
        out.put("shared", SYSTEM_OWNER.equals(sg.get("owner")));
        // Trạng thái đồng bộ: cấu hình đã lưu khác với firewall đã áp dụng, giao diện phải hiện đúng.
        out.put("revision", sg.get("revision") instanceof Number n ? n.longValue() : 0L);
        out.put("appliedRevision", sg.get("appliedRevision") instanceof Number n ? n.longValue() : null);
        out.put("syncStatus", sg.get("syncStatus") != null
                ? String.valueOf(sg.get("syncStatus")) : SecurityGroupSyncStatus.PENDING_SYNC);
        out.put("syncError", sg.get("syncError"));
        out.remove("owner");
        return out;
    }
}
