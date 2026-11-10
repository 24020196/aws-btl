package com.iaas.xregion.Model.Request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

/**
 * Body of POST /api/network/security-groups.
 * - groupId empty  -> create a new Security Group (name required).
 * - groupId exists -> append the given rules to that Security Group.
 */
@Data
public class SecurityGroupRequest {

    private String groupId;

    @Pattern(regexp = "^$|^[a-zA-Z0-9._-]{2,64}$", message = "Tên Security Group chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới (2-64 ký tự)")
    private String name;

    private String description;

    private String region;

    /** Optional: attach the (new or existing) group to this instance. */
    private String attachInstanceId;

    /** Kiểu gọi cũ "đổi nhóm" (không còn hỗ trợ). Có trường này thì API báo lỗi thay vì ghi đè rule thành rỗng. */
    private java.util.List<String> groupIds;

    /**
     * Revision client đang hiển thị. Có giá trị thì backend chỉ ghi khi bảng vẫn ở đúng revision đó,
     * tránh trường hợp hai người sửa cùng lúc và bản sau âm thầm ghi đè bản trước.
     */
    private Long expectedRevision;

    /**
     * null = client không gửi trường này (khác với [] là chủ ý bỏ hết rule). Backend từ chối null thay vì
     * coi như danh sách rỗng, nếu không một payload thiếu trường sẽ vô tình xóa toàn bộ rule của nhóm.
     */
    @Valid
    private List<Rule> inboundRules;

    @Valid
    private List<Rule> outboundRules;

    @Data
    public static class Rule {
        @NotBlank(message = "Giao thức là bắt buộc")
        @Pattern(regexp = "(?i)tcp|udp|icmp|all", message = "Giao thức phải là tcp, udp, icmp hoặc all")
        private String protocol = "tcp";

        @Min(value = 0, message = "Cổng phải từ 0 đến 65535")
        @Max(value = 65535, message = "Cổng phải từ 0 đến 65535")
        private int fromPort;

        @Min(value = 0, message = "Cổng phải từ 0 đến 65535")
        @Max(value = 65535, message = "Cổng phải từ 0 đến 65535")
        private int toPort;

        @NotBlank(message = "Nguồn/đích (CIDR) là bắt buộc")
        @Pattern(regexp = "^(?!sg-)(?:(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)/(?:3[0-2]|[12]?\\d)$|^sg-[0-9a-f]{8,32}$",
                message = "Nguồn/đích phải là CIDR IPv4 hợp lệ (vd 0.0.0.0/0) hoặc mã Security Group (sg-...)")
        private String cidr = "0.0.0.0/0";

        private String description;
    }
}
