package com.iaas.xregion.Entity;

public enum MigrationStep {
    STOP_SOURCE_VM(1, "Stop Source Instance & Flush Cache"),
    CREATE_EBS_SNAPSHOT(2, "Create EBS Snapshot (gp3)"),
    COPY_SNAPSHOT_CROSS_REGION(3, "Cross-Region Snapshot Copy"),
    CREATE_TARGET_VOLUME(4, "Provision Target Volume from Snapshot"),
    BOOT_TARGET_VM(5, "Launch NovaVM in Target Region"),
    ROUTE53_DNS_CUTOVER(6, "Route 53 DNS Automated Cutover"),
    COMPLETED(7, "Migration Successfully Completed"),
    ROLLED_BACK(-1, "Rolled Back Due to Error");

    private final int stepNumber;
    private final String description;

    MigrationStep(int stepNumber, String description) {
        this.stepNumber = stepNumber;
        this.description = description;
    }

    public int getStepNumber() {
        return stepNumber;
    }

    public String getDescription() {
        return description;
    }
}

