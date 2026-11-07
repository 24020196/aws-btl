package com.iaas.xregion.Security;

import com.iaas.xregion.Entity.UserEntity;
import com.iaas.xregion.Services.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.Optional;

@Slf4j
@Service
@RequiredArgsConstructor
public class UserDetailsServiceImpl implements UserDetailsService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder = new BCryptPasswordEncoder();
    private final String encodedAdminPass = passwordEncoder.encode("admin123");

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        if ("admin".equalsIgnoreCase(username)) {
            String pass = encodedAdminPass;
            String fullName = "IaaS Super Administrator";
            try {
                Optional<UserEntity> userOpt = userRepository.findByUsername("admin");
                if (userOpt.isPresent()) {
                    UserEntity u = userOpt.get();
                    if (u.getPassword() != null && (u.getPassword().startsWith("$2a$") || u.getPassword().startsWith("$2b$") || u.getPassword().startsWith("$2y$"))) {
                        pass = u.getPassword();
                    }
                    if (u.getFullName() != null && !u.getFullName().trim().isEmpty()) {
                        fullName = u.getFullName();
                    }
                }
            } catch (Exception e) {
                log.warn("Could not query admin entity from DynamoDB: {}", e.getMessage());
            }

            return CustomUserDetails.builder()
                    .username("admin")
                    .password(pass)
                    .fullName(fullName)
                    .role("ROLE_ADMIN")
                    .active(true)
                    .build();
        }

        try {
            Optional<UserEntity> userOpt = userRepository.findByUsername(username);
            if (userOpt.isPresent()) {
                UserEntity user = userOpt.get();
                return CustomUserDetails.builder()
                        .username(user.getUsername() != null ? user.getUsername() : username)
                        .password(user.getPassword())
                        .fullName(user.getFullName() != null ? user.getFullName() : user.getUsername())
                        .role(user.getRole() != null ? user.getRole() : "ROLE_USER")
                        .active(user.getActive() == null || user.getActive())
                        .build();
            }
        } catch (Exception e) {
            log.warn("Could not query user [{}] from DynamoDB: {}", username, e.getMessage());
        }

        throw new UsernameNotFoundException("User not found: " + username);
    }
}
