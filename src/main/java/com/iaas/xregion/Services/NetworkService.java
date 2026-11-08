package com.iaas.xregion.Services;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.SecurityGroupEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.NetworkResponse;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class NetworkService {

    private static final String SYSTEM_OWNER = "system";
    private static final List<String> DEFAULT_INSTANCE_GROUPS = List.of("sg-default", "sg-web-public");

    private final AuditLogService auditLogService;
    private final DynamoDbEnhancedClient enhancedClient;
    private final DynamoDbTable<InstanceEntity> instancesTable;
    private final ObjectMapper objectMapper;

    /** Bản ghi Route 53 người dùng tự cập nhật (ghi đè bản ghi sinh từ dns + elastic_ip của máy). */
    private final List<Map<String, Object>> dnsStore = new CopyOnWriteArrayList<>();

    /** groupId -> security group. Bộ nhớ đệm của bảng XRegion-SecurityGroups (ghi xuống bảng mỗi lần đổi). */
    private final Map<String, Map<String, Object>> securityGroups = new ConcurrentHashMap<>();

    @Value("${aws.dynamodb.table.security-groups:XRegion-SecurityGroups}")
    private String securityGroupsTableName;

    private DynamoDbTable<SecurityGroupEntity> securityGroupsTable;
    private volatile boolean securityGroupsPersistent;

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
    void initSecurityGroupStore() {
        try {
            securityGroupsTable = enhancedClient.table(securityGroupsTableName, TableSchema.fromBean(SecurityGroupEntity.class));
            try {
                securityGroupsTable.describeTable();
            } catch (software.amazon.awssdk.services.dynamodb.model.ResourceNotFoundException missing) {
                log.info("Table [{}] not found, creating it", securityGroupsTableName);
                securityGroupsTable.createTable();
            }
            for (SecurityGroupEntity e : securityGroupsTable.scan().items()) {
                securityGroups.put(e.getGroupId(), fromEntity(e));
            }
            securityGroupsPersistent = true;
            for (String id : List.of("sg-default", "sg-web-public", "sg-ssh-only")) {
                if (securityGroupsTable.getItem(Key.builder().partitionValue(id).build()) == null) {
                    persist(securityGroups.get(id));
                }
            }
            log.info("Security groups loaded from [{}]: {} group(s)", securityGroupsTableName, securityGroups.size());
        } catch (Exception e) {
            securityGroupsPersistent = false;
            log.warn("Security groups will be kept in memory only (table [{}] unavailable: {})", securityGroupsTableName, e.getMessage());
        }
    }

    private void persist(Map<String, Object> sg) {
        if (!securityGroupsPersistent || sg == null) {
            return;
        }
        try {
            securityGroupsTable.putItem(toEntity(sg));
        } catch (Exception e) {
            log.warn("Could not save security group [{}]: {}", sg.get("groupId"), e.getMessage());
        }
    }

    private SecurityGroupEntity toEntity(Map<String, Object> sg) throws Exception {
        return SecurityGroupEntity.builder()
                .groupId(String.valueOf(sg.get("groupId")))
                .name(String.valueOf(sg.get("name")))
                .description(String.valueOf(sg.getOrDefault("description", "")))
                .region(String.valueOf(sg.getOrDefault("region", "all")))
                .owner(String.valueOf(sg.get("owner")))
                .inboundRulesJson(objectMapper.writeValueAsString(sg.get("inboundRules")))
                .outboundRulesJson(objectMapper.writeValueAsString(sg.get("outboundRules")))
                .createdAt(sg.get("createdAt") instanceof Number n ? n.longValue() : System.currentTimeMillis())
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
        sg.put("inboundRules", new CopyOnWriteArrayList<>(e.getInboundRulesJson() != null
                ? objectMapper.readValue(e.getInboundRulesJson(), listType) : List.of()));
        sg.put("outboundRules", new CopyOnWriteArrayList<>(e.getOutboundRulesJson() != null
                ? objectMapper.readValue(e.getOutboundRulesJson(), listType) : List.of()));
        sg.put("createdAt", e.getCreatedAt());
        return sg;
    }

    /**
     * Mỗi máy ảo có đúng một Security Group riêng (nhóm thống nhất không dùng chung nhóm giữa các máy).
     * Mã nhóm lưu ở cột security_group của bảng Instances. Máy chưa có nhóm riêng (mới tạo, hoặc đang trỏ
     * vào nhóm dùng chung cũ như sg-default / sg-web-public) thì tạo nhóm riêng, chép lại các rule đang có.
     */
    @SuppressWarnings("unchecked")
    private synchronized String ensureInstanceGroup(InstanceEntity inst) {
        String owner = inst.getUsername() != null && !inst.getUsername().isBlank() ? inst.getUsername() : getCurrentUsername();
        List<String> current = new ArrayList<>();
        String raw = inst.getSecurityGroup();
        if (raw != null && !raw.isBlank()) {
            Arrays.stream(raw.split(",")).map(String::trim).filter(x -> !x.isEmpty()).forEach(current::add);
        }
        if (current.size() == 1) {
            Map<String, Object> sg = securityGroups.get(current.get(0));
            if (sg != null && owner.equalsIgnoreCase(String.valueOf(sg.get("owner")))) {
                return current.get(0);
            }
        }
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
        sg.put("description", "Security group of " + inst.getInstanceId());
        sg.put("region", inst.getCurrentRegion() != null ? inst.getCurrentRegion() : "all");
        sg.put("owner", owner);
        sg.put("inboundRules", inbound);
        sg.put("outboundRules", outbound);
        sg.put("createdAt", System.currentTimeMillis());
        String groupId = String.valueOf(sg.get("groupId"));
        securityGroups.put(groupId, sg);
        persist(sg);

        inst.setSecurityGroup(groupId);
        instancesTable.putItem(inst);
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

    private List<String> attachedGroupIds(String instanceId) {
        InstanceEntity inst = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        return inst == null ? List.of() : List.of(ensureInstanceGroup(inst));
    }

    private InstanceEntity ownedInstance(String instanceId, String user) {
        InstanceEntity inst = instancesTable.getItem(Key.builder().partitionValue(instanceId).build());
        if (inst == null || (inst.getUsername() != null && !user.equalsIgnoreCase(inst.getUsername()))) {
            throw new ResourceNotFoundException("Không tìm thấy máy ảo: " + instanceId);
        }
        return inst;
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

    public NetworkResponse getNetworkOverview() {
        List<Map<String, Object>> vpcs = new ArrayList<>();
        Map<String, Object> vpc1 = new HashMap<>();
        vpc1.put("id", "vpc-syd-prod");
        vpc1.put("name", "Sydney-Production-VPC");
        vpc1.put("cidr", "10.0.0.0/16");
        vpc1.put("region", "ap-southeast-2");
        vpc1.put("primarySubnetId", "subnet-syd-pub-01");
        vpc1.put("primarySubnetCidr", "10.0.1.0/24");
        vpc1.put("availabilityZone", "ap-southeast-2a");
        // ENI của máy chủ EC2 Bare Metal: mỗi NovaVM nhận một secondary private IP trên ENI này,
        // Elastic IP được NAT 1:1 (iptables) vào secondary IP đó.
        vpc1.put("bareMetalEniId", "eni-0syd4b7c2e91a3f01");
        vpc1.put("bareMetalPrivateIp", "10.0.1.10");
        vpcs.add(vpc1);

        Map<String, Object> vpc2 = new HashMap<>();
        vpc2.put("id", "vpc-va-standby");
        vpc2.put("name", "Virginia-Standby-VPC");
        vpc2.put("cidr", "10.1.0.0/16");
        vpc2.put("region", "us-east-1");
        vpc2.put("primarySubnetId", "subnet-va-pub-01");
        vpc2.put("primarySubnetCidr", "10.1.1.0/24");
        vpc2.put("availabilityZone", "us-east-1a");
        vpc2.put("bareMetalEniId", "eni-0va91d3e5c7b2a402");
        vpc2.put("bareMetalPrivateIp", "10.1.1.10");
        vpcs.add(vpc2);

        List<Map<String, Object>> fips = new ArrayList<>();
        Map<String, Object> fip1 = new HashMap<>();
        fip1.put("ip", "3.27.235.135");
        fip1.put("region", "ap-southeast-2");
        fip1.put("associatedInstanceId", "i-0a3f9c21e7b4d5810");
        fip1.put("associatedInstanceName", "Web-Prod-01");
        fip1.put("privateIp", "10.20.10.15");
        fip1.put("status", "ASSOCIATED");
        fips.add(fip1);

        return NetworkResponse.builder()
                .vpcs(vpcs)
                .floatingIps(fips)
                .dnsRecords(dnsRecordsForCurrentUser())
                .build();
    }

    /**
     * Bản ghi A của Route 53 cho các máy của người dùng: sinh từ cột dns + elastic_ip của máy,
     * bản ghi người dùng tự cập nhật (dnsStore) ghi đè lên.
     */
    private List<Map<String, Object>> dnsRecordsForCurrentUser() {
        String user = getCurrentUsername();
        Map<String, Map<String, Object>> records = new LinkedHashMap<>();
        try {
            for (InstanceEntity i : instancesTable.scan().items()) {
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

    /** Groups visible to the current user; only those attached to instanceId when it is given. */
    public List<Map<String, Object>> getSecurityGroups(String instanceId) {
        String user = getCurrentUsername();
        if (instanceId != null && !instanceId.isBlank()) {
            ownedInstance(instanceId.trim(), user);
            return attachedGroupIds(instanceId.trim()).stream()
                    .map(securityGroups::get)
                    .filter(Objects::nonNull)
                    .filter(sg -> visibleTo(sg, user))
                    .map(this::copyOf)
                    .collect(Collectors.toList());
        }
        // Danh sách chung: nhóm riêng của từng máy (chưa bị xóa) của người dùng, tạo nếu máy chưa có
        Set<String> ids = instancesTable.scan().items().stream()
                .filter(i -> user.equalsIgnoreCase(i.getUsername()))
                .filter(i -> !"TERMINATED".equalsIgnoreCase(i.getCurrentStatus()))
                .map(this::ensureInstanceGroup)
                .collect(Collectors.toSet());
        return securityGroups.values().stream()
                .filter(sg -> visibleTo(sg, user) && ids.contains(String.valueOf(sg.get("groupId"))))
                .sorted(Comparator.comparing(sg -> String.valueOf(sg.get("groupId"))))
                .map(this::copyOf)
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
        List<Map<String, Object>> inbound = (List<Map<String, Object>>) sg.get("inboundRules");
        List<Map<String, Object>> outbound = (List<Map<String, Object>>) sg.get("outboundRules");
        int added = addRules(inbound, request.getInboundRules(), user) + addRules(outbound, request.getOutboundRules(), user);

        if (created) {
            securityGroups.put(groupId, sg);
        }
        if (created || added > 0) {
            persist(sg);
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
            List<String> current = new ArrayList<>(attachedGroupIds(instanceId));
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

    /** Không còn đổi nhóm: mỗi máy có một Security Group riêng (giữ endpoint để báo lỗi rõ ràng). */
    public List<Map<String, Object>> setInstanceSecurityGroups(String instanceId, List<String> groupIds) {
        throw new AppException("Mỗi máy ảo có một Security Group riêng, không đổi hoặc dùng chung nhóm giữa các máy.");
    }

    private int addRules(List<Map<String, Object>> target, List<SecurityGroupRequest.Rule> rules, String user) {
        if (rules == null) {
            return 0;
        }
        int added = 0;
        for (SecurityGroupRequest.Rule r : rules) {
            String protocol = r.getProtocol().toLowerCase(Locale.ROOT);
            boolean all = "all".equals(protocol) || "icmp".equals(protocol);
            int from = all ? 0 : r.getFromPort();
            int to = all ? 65535 : (r.getToPort() == 0 ? r.getFromPort() : r.getToPort());
            if (to < from) {
                throw new AppException("Cổng kết thúc phải lớn hơn hoặc bằng cổng bắt đầu");
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
            String addedBy = String.valueOf(r.get("addedBy"));
            boolean ownsGroup = user.equalsIgnoreCase(String.valueOf(sg.get("owner")));
            if (!ownsGroup) {
                throw new ConflictException("Bạn chỉ xóa được rule trong Security Group của máy mình.");
            }
            rules.remove(r);
            persist(sg);
            auditLogService.logAction("SG_RULE_DELETE", "SECURITY_GROUP", groupId,
                    "Deleted " + key.replace("Rules", "") + " rule " + r.get("protocol") + " " + r.get("fromPort") + "-" + r.get("toPort") + " " + r.get("cidr"));
            return copyOf(sg);
        }
        throw new ResourceNotFoundException("Không tìm thấy rule " + ruleId + " trong " + groupId);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> copyOf(Map<String, Object> sg) {
        String user = getCurrentUsername();
        boolean ownsGroup = user.equalsIgnoreCase(String.valueOf(sg.get("owner")));
        Map<String, Object> out = new LinkedHashMap<>(sg);
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
        out.remove("owner");
        return out;
    }
}
