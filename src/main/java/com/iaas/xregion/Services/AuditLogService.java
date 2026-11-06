package com.iaas.xregion.Services;

import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentLinkedDeque;

@Slf4j
@Service
public class AuditLogService {

    private final Deque<Map<String, Object>> inMemoryLogs = new ConcurrentLinkedDeque<>();

    public AuditLogService() {
        // Pre-populate with startup audit log
        logAction("STARTUP", "SYSTEM", "xregion", "Application started connected to AWS Cloud DynamoDB");
    }

    @Async
    public void logAction(String action, String resourceType, String resourceId, String details) {
        String username = "admin";
        try {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth != null && auth.getName() != null) {
                username = auth.getName();
            }
        } catch (Exception ignored) {}

        long now = System.currentTimeMillis();
        Map<String, Object> payload = new HashMap<>();
        payload.put("username", username);
        payload.put("action", action);
        payload.put("resourceType", resourceType);
        payload.put("resourceId", resourceId);
        payload.put("details", details);
        payload.put("timestamp", now);

        inMemoryLogs.addFirst(payload);
        // Keep at most 200 logs
        while (inMemoryLogs.size() > 200) {
            inMemoryLogs.pollLast();
        }

        log.info("Audit: User [{}] performed [{}] on {} [{}]", username, action, resourceType, resourceId);
    }

    public List<Map<String, Object>> getLogs(int limit) {
        return inMemoryLogs.stream().limit(limit).toList();
    }
}
