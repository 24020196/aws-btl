package com.iaas.xregion.Utils;

import java.security.SecureRandom;

/**
 * Tiện ích sinh Universally Unique Lexicographically Sortable Identifier (ULID)
 * - 48 bit Unix timestamp (mili-giây)
 * - 80 bit randomness (SecureRandom)
 * - 26 ký tự chuẩn Crockford Base32 (0-9, A-Z ngoại trừ I, L, O, U)
 * - Tự động sắp xếp theo thời gian tăng dần (Lexicographically Sortable)
 */
public final class UlidCreator {

    private static final char[] ENCODING_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private UlidCreator() {
    }

    /**
     * Sinh ULID mới với timestamp hiện tại (System.currentTimeMillis())
     */
    public static String nextUlid() {
        return generate(System.currentTimeMillis());
    }

    /**
     * Sinh ULID với timestamp chỉ định (dùng để di trú dữ liệu cũ theo created_at gốc)
     */
    public static String generate(long timestamp) {
        char[] chars = new char[26];

        // 1. Encode 48-bit timestamp thành 10 ký tự Crockford Base32
        chars[0] = ENCODING_CHARS[(int) ((timestamp >>> 45) & 0x1F)];
        chars[1] = ENCODING_CHARS[(int) ((timestamp >>> 40) & 0x1F)];
        chars[2] = ENCODING_CHARS[(int) ((timestamp >>> 35) & 0x1F)];
        chars[3] = ENCODING_CHARS[(int) ((timestamp >>> 30) & 0x1F)];
        chars[4] = ENCODING_CHARS[(int) ((timestamp >>> 25) & 0x1F)];
        chars[5] = ENCODING_CHARS[(int) ((timestamp >>> 20) & 0x1F)];
        chars[6] = ENCODING_CHARS[(int) ((timestamp >>> 15) & 0x1F)];
        chars[7] = ENCODING_CHARS[(int) ((timestamp >>> 10) & 0x1F)];
        chars[8] = ENCODING_CHARS[(int) ((timestamp >>> 5) & 0x1F)];
        chars[9] = ENCODING_CHARS[(int) (timestamp & 0x1F)];

        // 2. Sinh 80-bit ngẫu nhiên (10 bytes)
        byte[] entropy = new byte[10];
        RANDOM.nextBytes(entropy);

        // 3. Encode 80-bit randomness (10 bytes) thành 16 ký tự Crockford Base32
        encode80BitsRandomness(entropy, chars, 10);

        return new String(chars);
    }

    private static void encode80BitsRandomness(byte[] entropy, char[] chars, int offset) {
        // Block 1: bytes 0..4 (40 bits) -> 8 ký tự Base32
        long b1 = ((long) (entropy[0] & 0xFF) << 32)
                | ((long) (entropy[1] & 0xFF) << 24)
                | ((long) (entropy[2] & 0xFF) << 16)
                | ((long) (entropy[3] & 0xFF) << 8)
                | ((long) (entropy[4] & 0xFF));

        chars[offset]     = ENCODING_CHARS[(int) ((b1 >>> 35) & 0x1F)];
        chars[offset + 1] = ENCODING_CHARS[(int) ((b1 >>> 30) & 0x1F)];
        chars[offset + 2] = ENCODING_CHARS[(int) ((b1 >>> 25) & 0x1F)];
        chars[offset + 3] = ENCODING_CHARS[(int) ((b1 >>> 20) & 0x1F)];
        chars[offset + 4] = ENCODING_CHARS[(int) ((b1 >>> 15) & 0x1F)];
        chars[offset + 5] = ENCODING_CHARS[(int) ((b1 >>> 10) & 0x1F)];
        chars[offset + 6] = ENCODING_CHARS[(int) ((b1 >>> 5) & 0x1F)];
        chars[offset + 7] = ENCODING_CHARS[(int) (b1 & 0x1F)];

        // Block 2: bytes 5..9 (40 bits) -> 8 ký tự Base32
        long b2 = ((long) (entropy[5] & 0xFF) << 32)
                | ((long) (entropy[6] & 0xFF) << 24)
                | ((long) (entropy[7] & 0xFF) << 16)
                | ((long) (entropy[8] & 0xFF) << 8)
                | ((long) (entropy[9] & 0xFF));

        chars[offset + 8]  = ENCODING_CHARS[(int) ((b2 >>> 35) & 0x1F)];
        chars[offset + 9]  = ENCODING_CHARS[(int) ((b2 >>> 30) & 0x1F)];
        chars[offset + 10] = ENCODING_CHARS[(int) ((b2 >>> 25) & 0x1F)];
        chars[offset + 11] = ENCODING_CHARS[(int) ((b2 >>> 20) & 0x1F)];
        chars[offset + 12] = ENCODING_CHARS[(int) ((b2 >>> 15) & 0x1F)];
        chars[offset + 13] = ENCODING_CHARS[(int) ((b2 >>> 10) & 0x1F)];
        chars[offset + 14] = ENCODING_CHARS[(int) ((b2 >>> 5) & 0x1F)];
        chars[offset + 15] = ENCODING_CHARS[(int) (b2 & 0x1F)];
    }
}
