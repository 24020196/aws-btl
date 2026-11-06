package com.iaas.xregion.Security;

import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class UserDetailsServiceImpl implements UserDetailsService {

    private final String encodedAdminPass = new BCryptPasswordEncoder().encode("admin123");

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
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
