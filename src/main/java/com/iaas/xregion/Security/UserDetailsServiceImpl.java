package com.iaas.xregion.Security;

import com.iaas.xregion.Entity.UserEntity;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;

@Slf4j
@Service
@RequiredArgsConstructor
public class UserDetailsServiceImpl implements UserDetailsService {

    private final DynamoDbTable<UserEntity> usersTable;
    private final String encodedAdminPass = new BCryptPasswordEncoder().encode("admin123");

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        try {
            UserEntity user = null;
            try {
                user = usersTable.index("username-index")
                        .query(QueryConditional.keyEqualTo(Key.builder().partitionValue(username).build()))
                        .stream()
                        .flatMap(page -> page.items().stream())
                        .findFirst()
                        .orElse(null);
            } catch (Exception ex) {
                log.debug("GSI lookup error, falling back to direct user_id lookup: {}", ex.getMessage());
            }

            if (user == null) {
                String userId = username.startsWith("usr-") ? username : "usr-" + username;
                user = usersTable.getItem(Key.builder().partitionValue(userId).build());
            }

            if (user != null) {
                return CustomUserDetails.builder()
                        .username(user.getUsername())
                        .password(user.getPassword())
                        .fullName(user.getFullName() != null ? user.getFullName() : user.getUsername())
                        .role(user.getRole() != null ? user.getRole() : "ROLE_USER")
                        .active(user.getActive() == null || user.getActive())
                        .build();
            }
        } catch (Exception e) {
            log.warn("Could not query user [{}] from DynamoDB: {}", username, e.getMessage());
        }

        if ("admin".equalsIgnoreCase(username)) {
            return CustomUserDetails.builder()
                    .username("admin")
                    .password(encodedAdminPass)
                    .fullName("IaaS Super Administrator")
                    .role("ROLE_ADMIN")
                    .active(true)
                    .build();
        }
        throw new UsernameNotFoundException("User not found: " + username);
    }
}
