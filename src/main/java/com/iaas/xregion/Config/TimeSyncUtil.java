package com.iaas.xregion.Config;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * Tiện ích đồng bộ thời gian chuẩn UTC giữa AWS DynamoDB (Epoch Seconds),
 * Backend Spring Boot và Giao diện Web Dashboard (Epoch Milliseconds / UTC+7).
 */
public final class TimeSyncUtil {

    public static final ZoneId VIETNAM_ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    private static final DateTimeFormatter VN_FORMATTER =
            DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm:ss").withZone(VIETNAM_ZONE);

    // Ngưỡng phân biệt Epoch Seconds (10 chữ số) và Epoch Milliseconds (13 chữ số)
    private static final long MILLIS_THRESHOLD = 10_000_000_000L;

    private TimeSyncUtil() {
    }

    /**
     * Lấy thời gian chuẩn UTC hiện tại theo giây (10 chữ số) để lưu xuống DynamoDB
     * (Đồng bộ 100% với AWS Lambda Python `int(time.time())` và `cooldown_seconds`).
     */
    public static long nowEpochSeconds() {
        return Instant.now().getEpochSecond();
    }

    /**
     * Lấy thời gian chuẩn UTC hiện tại theo mili-giây (13 chữ số) cho JavaScript Dashboard.
     */
    public static long nowEpochMillis() {
        return Instant.now().toEpochMilli();
    }

    /**
     * Tự động chuẩn hóa mọi giá trị timestamp từ DynamoDB (dù lưu 10 chữ số giây hay 13 chữ số mili-giây)
     * về chuẩn Epoch Seconds (10 chữ số).
     */
    public static long toEpochSeconds(Long rawTimestamp) {
        if (rawTimestamp == null || rawTimestamp <= 0) {
            return nowEpochSeconds();
        }
        return rawTimestamp >= MILLIS_THRESHOLD ? (rawTimestamp / 1000L) : rawTimestamp;
    }

    /**
     * Tự động chuẩn hóa mọi giá trị timestamp từ DynamoDB (dù lưu 10 chữ số giây hay 13 chữ số mili-giây)
     * về chuẩn Epoch Milliseconds (13 chữ số) để trả về cho Web Dashboard (`new Date(ms)`).
     */
    public static long toEpochMillis(Long rawTimestamp) {
        if (rawTimestamp == null || rawTimestamp <= 0) {
            return nowEpochMillis();
        }
        return rawTimestamp < MILLIS_THRESHOLD ? (rawTimestamp * 1000L) : rawTimestamp;
    }

    /**
     * Định dạng hiển thị thời gian theo múi giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7).
     */
    public static String formatVietnamTime(Long rawTimestamp) {
        long millis = toEpochMillis(rawTimestamp);
        return VN_FORMATTER.format(Instant.ofEpochMilli(millis));
    }

    /**
     * Tính số giây Cooldown còn lại trước khi cho phép chuyển vùng tiếp theo.
     */
    public static long getRemainingCooldownSeconds(Long lastMigrationTimestamp, Integer cooldownSeconds) {
        if (lastMigrationTimestamp == null || lastMigrationTimestamp <= 0 || cooldownSeconds == null || cooldownSeconds <= 0) {
            return 0L;
        }
        long lastSec = toEpochSeconds(lastMigrationTimestamp);
        long elapsedSec = nowEpochSeconds() - lastSec;
        return Math.max(0L, cooldownSeconds - elapsedSec);
    }
}

