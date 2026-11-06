package com.iaas.xregion.Security;

import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class UserDetailsServiceImpl implements UserDetailsService {

    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();
    private final Map<String, CustomUserDetails> userStore = new ConcurrentHashMap<>();

    public UserDetailsServiceImpl() {
        // Default Super Administrator
        userStore.put("admin", CustomUserDetails.builder()
                .username("admin")
                .password(passwordEncoder.encode("admin123"))
                .fullName("IaaS Super Administrator")
                .role("ROLE_ADMIN")
                .active(true)
                .build());
    }

    public synchronized void registerUser(String username, String rawPassword, String fullName, String role) {
        if (userStore.containsKey(username.toLowerCase())) {
            throw new IllegalArgumentException("Tên đăng nhập [" + username + "] đã tồn tại trên hệ thống.");
        }
        String assignedRole = (role != null && !role.trim().isEmpty()) ? role : "ROLE_ADMIN";
        if (!assignedRole.startsWith("ROLE_")) {
            assignedRole = "ROLE_" + assignedRole.toUpperCase();
        }

        CustomUserDetails user = CustomUserDetails.builder()
                .username(username.toLowerCase())
                .password(passwordEncoder.encode(rawPassword))
                .fullName(fullName != null && !fullName.trim().isEmpty() ? fullName : username)
                .role(assignedRole)
                .active(true)
                .build();
        userStore.put(username.toLowerCase(), user);
    }

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        CustomUserDetails user = userStore.get(username.toLowerCase());
        if (user != null) {
            return user;
        }
        throw new UsernameNotFoundException("User not found: " + username);
    }
}
