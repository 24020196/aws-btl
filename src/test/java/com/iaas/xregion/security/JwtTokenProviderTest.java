package com.iaas.xregion.security;

import com.iaas.xregion.Security.CustomUserDetails;
import com.iaas.xregion.Security.JwtTokenProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;

import static org.assertj.core.api.Assertions.assertThat;

class JwtTokenProviderTest {

    private static final String SECRET = "XRegionEnterpriseSecretKeyWithAtLeast256BitsLengthForSecureHMACSHA256Tokens";
    private JwtTokenProvider jwtTokenProvider;

    @BeforeEach
    void setUp() {
        jwtTokenProvider = new JwtTokenProvider(SECRET, 24);
    }

    @Test
    @DisplayName("generateToken produces a valid token and getUsernameFromJwt extracts subject")
    void testGenerateAndParseToken() {
        CustomUserDetails userDetails = CustomUserDetails.builder()
                .username("testadmin")
                .password("password123")
                .fullName("Test Administrator")
                .role("ROLE_ADMIN")
                .active(true)
                .build();

        Authentication auth = new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());

        String token = jwtTokenProvider.generateToken(auth);

        assertThat(token).isNotBlank();
        assertThat(jwtTokenProvider.validateToken(token)).isTrue();
        assertThat(jwtTokenProvider.getUsernameFromJwt(token)).isEqualTo("testadmin");
    }

    @Test
    @DisplayName("validateToken returns false for malformed or empty tokens")
    void testValidateInvalidToken() {
        assertThat(jwtTokenProvider.validateToken("invalid.token.structure")).isFalse();
        assertThat(jwtTokenProvider.validateToken("")).isFalse();
        assertThat(jwtTokenProvider.validateToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9")).isFalse();
    }

    @Test
    @DisplayName("validateToken returns false when signature does not match secret")
    void testSignatureMismatchReturnsFalse() {
        // Token signed with a different secret
        JwtTokenProvider otherProvider = new JwtTokenProvider(
                "DifferentSecretKeyWithAtLeast256BitsLengthForSecureHMACSHA256Tokens12345", 24);
        CustomUserDetails userDetails = CustomUserDetails.builder()
                .username("testuser")
                .password("pass")
                .fullName("User")
                .role("ROLE_USER")
                .active(true)
                .build();
        Authentication auth = new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());
        String tokenFromOther = otherProvider.generateToken(auth);

        assertThat(jwtTokenProvider.validateToken(tokenFromOther)).isFalse();
    }

    @Test
    @DisplayName("validateToken returns false for expired tokens")
    void testExpiredToken() {
        // Expiration of 0 hours results in immediate or past expiry
        JwtTokenProvider expiredProvider = new JwtTokenProvider(SECRET, 0);

        CustomUserDetails userDetails = CustomUserDetails.builder()
                .username("expiredUser")
                .password("pass")
                .fullName("Expired")
                .role("ROLE_USER")
                .active(true)
                .build();
        Authentication auth = new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities());

        // Token generated with 0 expiration ms
        String token = expiredProvider.generateToken(auth);

        // When validating with the standard provider or expired provider, it should be expired or invalid
        assertThat(jwtTokenProvider.validateToken(token)).isFalse();
    }

    @Test
    @DisplayName("getExpirationMs returns correct calculation")
    void testGetExpirationMs() {
        assertThat(jwtTokenProvider.getExpirationMs()).isEqualTo(24 * 3600 * 1000L);
    }
}
