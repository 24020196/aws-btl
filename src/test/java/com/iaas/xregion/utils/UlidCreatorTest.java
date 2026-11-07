package com.iaas.xregion.utils;

import com.iaas.xregion.Utils.UlidCreator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class UlidCreatorTest {

    private static final String CROCKFORD_BASE32_REGEX = "^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$";

    @Test
    @DisplayName("nextUlid produces 26-character valid Crockford Base32 string")
    void testNextUlidFormat() {
        String ulid = UlidCreator.nextUlid();

        assertThat(ulid).isNotNull();
        assertThat(ulid).hasSize(26);
        assertThat(ulid).matches(CROCKFORD_BASE32_REGEX);
    }

    @Test
    @DisplayName("generate with specific timestamp encodes correct 10-char prefix")
    void testGenerateWithTimestamp() {
        long fixedTimestamp = 1700000000000L;
        String ulid1 = UlidCreator.generate(fixedTimestamp);
        String ulid2 = UlidCreator.generate(fixedTimestamp);

        assertThat(ulid1).hasSize(26);
        assertThat(ulid2).hasSize(26);
        // The first 10 characters encode the 48-bit timestamp, which must match exactly for the same timestamp
        assertThat(ulid1.substring(0, 10)).isEqualTo(ulid2.substring(0, 10));
    }

    @Test
    @DisplayName("ULIDs are lexicographically sortable across increasing timestamps")
    void testMonotonicOrdering() throws InterruptedException {
        long t1 = 1600000000000L;
        long t2 = 1700000000000L;
        long t3 = 1800000000000L;

        String ulid1 = UlidCreator.generate(t1);
        String ulid2 = UlidCreator.generate(t2);
        String ulid3 = UlidCreator.generate(t3);

        assertThat(ulid1.compareTo(ulid2)).isLessThan(0);
        assertThat(ulid2.compareTo(ulid3)).isLessThan(0);
    }

    @Test
    @DisplayName("Rapid successive calls produce unique ULIDs")
    void testUniqueness() {
        Set<String> ulids = new HashSet<>();
        int count = 1000;
        for (int i = 0; i < count; i++) {
            ulids.add(UlidCreator.nextUlid());
        }
        assertThat(ulids).hasSize(count);
    }
}
