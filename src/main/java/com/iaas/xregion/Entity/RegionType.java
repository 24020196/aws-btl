package com.iaas.xregion.Entity;

public enum RegionType {
    SYDNEY("ap-southeast-2", "Sydney (Region A)"),
    VIRGINIA("us-east-1", "N. Virginia (Region B)");

    private final String code;
    private final String displayName;

    RegionType(String code, String displayName) {
        this.code = code;
        this.displayName = displayName;
    }

    public String getCode() {
        return code;
    }

    public String getDisplayName() {
        return displayName;
    }

    public static RegionType fromCode(String code) {
        for (RegionType r : values()) {
            if (r.code.equalsIgnoreCase(code)) return r;
        }
        return SYDNEY;
    }
}

