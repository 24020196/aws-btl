package com.iaas.xregion.Config;

import software.amazon.awssdk.services.sts.StsClient;
import software.amazon.awssdk.services.sts.model.GetCallerIdentityRequest;

/** Reject credentials and resource ARNs belonging to another AWS account. */
public final class AwsAccountGuard {
    private AwsAccountGuard() {
    }

    public static void requireAccountId(String expectedAccount) {
        if (expectedAccount == null || !expectedAccount.matches("[0-9]{12}")) {
            throw new IllegalStateException("AWS_ACCOUNT_ID must contain exactly 12 digits");
        }
    }

    public static void verifyIdentity(StsClient sts, String expectedAccount) {
        requireAccountId(expectedAccount);
        var identity = sts.getCallerIdentity(GetCallerIdentityRequest.builder().build());
        if (!expectedAccount.equals(identity.account())) {
            throw new IllegalStateException("AWS account mismatch: expected " + expectedAccount
                    + " but credentials belong to " + identity.account() + " (" + identity.arn()
                    + "). Update AWS credentials; changing AWS_ACCOUNT_ID does not change their identity.");
        }
    }

    public static void requireTableArn(String arn, String expectedAccount, String expectedRegion) {
        requireAccountId(expectedAccount);
        String prefix = "arn:aws:dynamodb:" + expectedRegion + ":" + expectedAccount + ":table/";
        if (arn == null || !arn.startsWith(prefix) || arn.length() == prefix.length()
                || arn.substring(prefix.length()).contains("/")) {
            throw new IllegalStateException("DynamoDB ARN must belong to account " + expectedAccount
                    + " in region " + expectedRegion + ": " + arn);
        }
    }
}
