package com.iaas.xregion.Model;

import lombok.Value;

/**
 * Kết quả ghi cấu hình Security Group và phát yêu cầu đồng bộ.
 * accepted=false: dữ liệu đã lưu nhưng không có yêu cầu đồng bộ mới (worker đang xử lý revision này).
 * eventPublished=false: chưa phát được sự kiện, lần sửa kế tiếp sẽ phát lại revision mới nhất.
 */
@Value
public class SecurityGroupSyncResult {
    boolean accepted;
    boolean eventPublished;
    long revision;
    String syncStatus;

    public static SecurityGroupSyncResult of(boolean accepted, boolean eventPublished, long revision, String syncStatus) {
        return new SecurityGroupSyncResult(accepted, eventPublished, revision, syncStatus);
    }
}
