package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.UserEntity;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Repository;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbIndex;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;

import java.util.Iterator;
import java.util.Optional;
import java.util.UUID;

@Slf4j
@Repository
@RequiredArgsConstructor
public class UserRepository {

    private final DynamoDbTable<UserEntity> usersTable;

    public Optional<UserEntity> findByUsername(String username) {
        if (username == null || username.trim().isEmpty()) {
            return Optional.empty();
        }
        String cleanUser = username.trim();

        // 1. Try finding by user_id = "usr-" + cleanUser.toLowerCase() (Standard Convention in XRegion-Users)
        try {
            UserEntity user = usersTable.getItem(Key.builder().partitionValue("usr-" + cleanUser.toLowerCase()).build());
            if (user != null) {
                return Optional.of(user);
            }
        } catch (Exception e) {
            log.debug("Lookup by usr- prefix failed: {}", e.getMessage());
        }

        // 2. Try finding by user_id = cleanUser directly
        try {
            UserEntity user = usersTable.getItem(Key.builder().partitionValue(cleanUser).build());
            if (user != null) {
                return Optional.of(user);
            }
        } catch (Exception e) {
            log.debug("Lookup by exact user_id failed: {}", e.getMessage());
        }

        // 3. Query GSI 'username-index'
        try {
            DynamoDbIndex<UserEntity> index = usersTable.index("username-index");
            if (index != null) {
                Iterator<UserEntity> it = index.query(QueryConditional.keyEqualTo(Key.builder().partitionValue(cleanUser).build()))
                        .stream()
                        .flatMap(page -> page.items().stream())
                        .iterator();
                if (it.hasNext()) {
                    return Optional.of(it.next());
                }
            }
        } catch (Exception e) {
            log.debug("Query username-index failed: {}", e.getMessage());
        }

        // 4. Fallback: Scan table
        try {
            return usersTable.scan().items().stream()
                    .filter(u -> cleanUser.equalsIgnoreCase(u.getUsername()) || cleanUser.equalsIgnoreCase(u.getUserId()))
                    .findFirst();
        } catch (Exception e) {
            log.debug("Fallback scan failed: {}", e.getMessage());
        }

        return Optional.empty();
    }

    public void save(UserEntity user) {
        if (user.getUserId() == null || user.getUserId().trim().isEmpty()) {
            String uname = user.getUsername() != null ? user.getUsername().trim().toLowerCase() : UUID.randomUUID().toString();
            user.setUserId("usr-" + uname);
        }
        usersTable.putItem(user);
    }
}

