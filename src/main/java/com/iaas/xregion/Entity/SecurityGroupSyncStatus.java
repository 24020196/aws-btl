package com.iaas.xregion.Entity;

/**
 * Trạng thái đồng bộ cấu hình Security Group xuống hạ tầng mạng.
 * Cấu hình mong muốn (DynamoDB) và trạng thái đã áp dụng (Neutron / AWS) là hai thứ khác nhau:
 * lưu thành công không có nghĩa firewall đã mở cổng.
 */
public final class SecurityGroupSyncStatus {

    /** Revision mới nhất đã được hạ tầng xác nhận. */
    public static final String SYNCED = "SYNCED";
    /** Đã lưu cấu hình nhưng chưa có bằng chứng hạ tầng áp dụng. */
    public static final String PENDING_SYNC = "PENDING_SYNC";
    /** Lần đồng bộ gần nhất thất bại; giữ lỗi để người dùng biết firewall chưa khớp. */
    public static final String SYNC_FAILED = "SYNC_FAILED";
    /** Worker đang áp dụng: dùng để hiển thị tiến trình, không phải bằng chứng firewall đã khớp. */
    public static final String SYNCING = "SYNCING";
    /** Máy không còn tài nguyên mạng để áp dụng (chưa khởi tạo xong / đã xóa). */
    public static final String SYNC_NOT_APPLICABLE = "SYNC_NOT_APPLICABLE";
    /** Chưa thể nhận quản lý toàn bộ firewall: nhóm dùng chung, mapping thiếu/lệch hoặc dữ liệu legacy cần đối chiếu. */
    public static final String SYNC_BLOCKED = "SYNC_BLOCKED";

    private SecurityGroupSyncStatus() {
    }
}
