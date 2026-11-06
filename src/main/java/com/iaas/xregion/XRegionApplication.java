package com.iaas.xregion;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.io.File;
import java.nio.file.Files;
import java.util.List;

@SpringBootApplication
@EnableScheduling
@EnableAsync
public class XRegionApplication {

    public static void main(String[] args) {
        // Vô hiệu hóa triệt để RestartClassLoader của DevTools để tránh xung đột ClassCastException với AWS DynamoDB SDK
        System.setProperty("spring.devtools.restart.enabled", "false");
        loadDotEnv();
        SpringApplication.run(XRegionApplication.class, args);
    }

    private static void loadDotEnv() {
        File envFile = new File(".env");
        if (!envFile.exists()) {
            return;
        }
        try {
            List<String> lines = Files.readAllLines(envFile.toPath());
            for (String line : lines) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("#") || !trimmed.contains("=")) {
                    continue;
                }
                int idx = trimmed.indexOf('=');
                String key = trimmed.substring(0, idx).trim();
                String value = trimmed.substring(idx + 1).trim();

                if ((value.startsWith("\"") && value.endsWith("\"")) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.substring(1, value.length() - 1);
                }

                if (System.getProperty(key) == null && System.getenv(key) == null) {
                    System.setProperty(key, value);
                }
            }
            System.out.println(">>> [Dotenv] Đã tự động nạp cấu hình từ .env thành công.");
        } catch (Exception e) {
            System.err.println(">>> [Dotenv] Không thể nạp file .env: " + e.getMessage());
        }
    }
}

