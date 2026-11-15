package com.iaas.xregion.config;

import com.iaas.xregion.Config.AwsAccountGuard;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.services.sts.StsClient;
import software.amazon.awssdk.services.sts.model.GetCallerIdentityRequest;
import software.amazon.awssdk.services.sts.model.GetCallerIdentityResponse;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class AwsAccountGuardTest {
    private static final String ACCOUNT = "348498387626";

    @Test
    void rejectsOldCredentialsEvenWhenConfiguredAccountIsCorrect() {
        StsClient sts = mock(StsClient.class);
        when(sts.getCallerIdentity(any(GetCallerIdentityRequest.class))).thenReturn(
                GetCallerIdentityResponse.builder().account("291634989063")
                        .arn("arn:aws:iam::291634989063:user/lam").build());
        var error = assertThrows(IllegalStateException.class, () -> AwsAccountGuard.verifyIdentity(sts, ACCOUNT));
        assertTrue(error.getMessage().contains("expected " + ACCOUNT));
        assertTrue(error.getMessage().contains("credentials belong to 291634989063"));
    }

    @Test
    void acceptsAssumedRoleInConfiguredAccount() {
        StsClient sts = mock(StsClient.class);
        when(sts.getCallerIdentity(any(GetCallerIdentityRequest.class))).thenReturn(
                GetCallerIdentityResponse.builder().account(ACCOUNT)
                        .arn("arn:aws:sts::" + ACCOUNT + ":assumed-role/backend/test").build());
        assertDoesNotThrow(() -> AwsAccountGuard.verifyIdentity(sts, ACCOUNT));
    }

    @Test
    void rejectsUnverifiableIdentity() {
        StsClient sts = mock(StsClient.class);
        when(sts.getCallerIdentity(any(GetCallerIdentityRequest.class)))
                .thenThrow(new IllegalStateException("STS unavailable"));
        assertThrows(IllegalStateException.class, () -> AwsAccountGuard.verifyIdentity(sts, ACCOUNT));
    }

    @Test
    void rejectsInvalidExpectedAccountBeforeContactingAws() {
        StsClient sts = mock(StsClient.class);
        assertThrows(IllegalStateException.class, () -> AwsAccountGuard.verifyIdentity(sts, ""));
        verifyNoInteractions(sts);
    }

    @Test
    void checksAccountAndRegionOfTableConfiguration() {
        String arn = "arn:aws:dynamodb:ap-southeast-2:" + ACCOUNT + ":table/XRegion-Instances";
        assertDoesNotThrow(() -> AwsAccountGuard.requireTableArn(arn, ACCOUNT, "ap-southeast-2"));
        assertThrows(IllegalStateException.class,
                () -> AwsAccountGuard.requireTableArn(arn, "291634989063", "ap-southeast-2"));
        assertThrows(IllegalStateException.class,
                () -> AwsAccountGuard.requireTableArn(arn, ACCOUNT, "us-east-1"));
        assertThrows(IllegalStateException.class,
                () -> AwsAccountGuard.requireTableArn("XRegion-Instances", ACCOUNT, "ap-southeast-2"));
    }
}
