package com.iaas.xregion.Services;

import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Exceptions.ResourceNotFoundException;
import com.iaas.xregion.Model.Request.SecurityGroupRequest;
import com.iaas.xregion.Model.Request.UpdateDnsRequest;
import com.iaas.xregion.Model.Response.NetworkResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class NetworkService {

    private static final String SYSTEM_OWNER = "system";
    private static final List<String> DEFAULT_INSTANCE_GROUPS = List.of("sg-default", "sg-web-public");

    private final AuditLogService auditLogService;
    private final List<Map<String, Object>> dnsStore = new CopyOnWriteArrayList<>();

    /** groupId -> security group (in-memory, like the DNS store). */
    private final Map<String, Map<String, Object>> securityGroups = new ConcurrentHashMap<>();

    /** instanceId -> attached group ids. Instances not in this map use DEFAULT_INSTANCE_GROUPS. */
    private final Map<String, List<String>> instanceGroups = new ConcurrentHashMap<>();

    {
        Map<String, Object> dns1 = new HashMap<>();
        dns1.put("domainName", "web01.xregion.net");
        dns1.put("targetIp", "3.27.235.135");
        dns1.put("ttl", 60);
        dns1.put("status", "SYNCED");
        dnsStore.add(dns1);

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

    private String getCurrentUsername() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return "admin";
    }

    private boolean visibleTo(Map<String, Object> sg, String username) {
        Object owner = sg.get("owner");
        return SYSTEM_OWNER.equals(owner) || username.equalsIgnoreCase(String.valueOf(owner));
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
                .dnsRecords(new ArrayList<>(dnsStore))
                .build();
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
            return instanceGroups.getOrDefault(instanceId.trim(), DEFAULT_INSTANCE_GROUPS).stream()
                    .map(securityGroups::get)
                    .filter(Objects::nonNull)
                    .filter(sg -> visibleTo(sg, user))
                    .map(this::copyOf)
                    .collect(Collectors.toList());
        }
        return securityGroups.values().stream()
                .filter(sg -> visibleTo(sg, user))
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
        boolean created;

        if (request.getGroupId() != null && !request.getGroupId().isBlank()) {
            sg = securityGroups.get(request.getGroupId().trim());
            if (sg == null || !visibleTo(sg, user)) {
                throw new ResourceNotFoundException("Không tìm thấy Security Group: " + request.getGroupId());
            }
            created = false;
        } else {
            if (request.getName() == null || request.getName().isBlank()) {
                throw new AppException("Cần nhập tên khi tạo Security Group mới");
            }
            String name = request.getName().trim();
            boolean duplicate = securityGroups.values().stream()
                    .anyMatch(g -> visibleTo(g, user) && name.equalsIgnoreCase(String.valueOf(g.get("name"))));
            if (duplicate) {
                throw new ConflictException("Đã có Security Group tên [" + name + "]");
            }
            sg = new LinkedHashMap<>();
            sg.put("groupId", "sg-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10));
            sg.put("name", name);
            sg.put("description", request.getDescription() != null ? request.getDescription().trim() : "");
            sg.put("region", request.getRegion() != null && !request.getRegion().isBlank() ? request.getRegion() : "all");
            sg.put("owner", user);
            sg.put("inboundRules", new CopyOnWriteArrayList<Map<String, Object>>());
            sg.put("outboundRules", allowAllOutbound());
            sg.put("createdAt", System.currentTimeMillis());
            created = true;
        }

        String groupId = String.valueOf(sg.get("groupId"));
        List<Map<String, Object>> inbound = (List<Map<String, Object>>) sg.get("inboundRules");
        List<Map<String, Object>> outbound = (List<Map<String, Object>>) sg.get("outboundRules");
        int added = addRules(inbound, request.getInboundRules(), user) + addRules(outbound, request.getOutboundRules(), user);

        if (created) {
            securityGroups.put(groupId, sg);
            auditLogService.logAction("SG_CREATE", "SECURITY_GROUP", groupId,
                    "Created security group " + sg.get("name") + " with " + added + " rule(s)");
        } else if (added > 0) {
            auditLogService.logAction("SG_RULE_ADD", "SECURITY_GROUP", groupId,
                    "Added " + added + " rule(s) to " + sg.get("name"));
        }

        String attachTo = request.getAttachInstanceId();
        if (attachTo != null && !attachTo.isBlank()) {
            String instanceId = attachTo.trim();
            List<String> current = new ArrayList<>(instanceGroups.getOrDefault(instanceId, DEFAULT_INSTANCE_GROUPS));
            if (!current.contains(groupId)) {
                current.add(groupId);
                instanceGroups.put(instanceId, current);
                auditLogService.logAction("SG_ATTACH", "INSTANCE", instanceId, "Attached security group " + groupId);
            }
        }

        Map<String, Object> result = copyOf(sg);
        result.put("rulesAdded", added);
        return result;
    }

    /**
     * Thay toàn bộ danh sách Security Group gắn vào máy ảo (giống "Change security groups" trên EC2).
     * Một máy phải luôn có ít nhất một nhóm.
     */
    public List<Map<String, Object>> setInstanceSecurityGroups(String instanceId, List<String> groupIds) {
        String user = getCurrentUsername();
        if (groupIds == null || groupIds.isEmpty()) {
            throw new AppException("Máy ảo phải gắn ít nhất một Security Group");
        }
        List<String> ids = groupIds.stream().map(String::trim).filter(s -> !s.isEmpty()).distinct().collect(Collectors.toList());
        for (String id : ids) {
            Map<String, Object> sg = securityGroups.get(id);
            if (sg == null || !visibleTo(sg, user)) {
                throw new ResourceNotFoundException("Không tìm thấy Security Group: " + id);
            }
        }
        if (ids.size() > 5) {
            throw new AppException("Mỗi máy ảo gắn tối đa 5 Security Group");
        }
        List<String> before = instanceGroups.getOrDefault(instanceId, DEFAULT_INSTANCE_GROUPS);
        instanceGroups.put(instanceId, ids);
        auditLogService.logAction("SG_CHANGE", "INSTANCE", instanceId, "Security groups " + before + " -> " + ids);
        return getSecurityGroups(instanceId);
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
            if (SYSTEM_OWNER.equals(addedBy) && !ownsGroup) {
                throw new ConflictException("Đây là rule mặc định của nhóm dùng chung " + sg.get("name") + ", không thể xóa.");
            }
            if (!ownsGroup && !user.equalsIgnoreCase(addedBy)) {
                throw new ConflictException("Bạn chỉ xóa được rule do chính mình thêm.");
            }
            rules.remove(r);
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
                copy.put("deletable", ownsGroup || (!SYSTEM_OWNER.equals(addedBy) && user.equalsIgnoreCase(addedBy)));
                copy.put("system", SYSTEM_OWNER.equals(addedBy));
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
