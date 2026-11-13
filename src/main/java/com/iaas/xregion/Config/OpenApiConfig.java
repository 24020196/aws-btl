package com.iaas.xregion.Config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    private static final String SECURITY_SCHEME_NAME = "BearerAuth";

    @Bean
    public OpenAPI customOpenAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("XRegion Cloud Management API")
                        .version("1.0.0")
                        .description("Tài liệu API quản trị tài nguyên máy ảo, hạ tầng mạng và di trú xuyên vùng (Cross-Region Migration) giữa Region A (us-east-1) và Region B (ap-southeast-2).")
                        .contact(new Contact()
                                .name("XRegion Engineering Team")
                                .email("admin@xregion.local")))
                .addSecurityItem(new SecurityRequirement().addList(SECURITY_SCHEME_NAME))
                .components(new Components()
                        .addSecuritySchemes(SECURITY_SCHEME_NAME,
                                new SecurityScheme()
                                        .name(SECURITY_SCHEME_NAME)
                                        .type(SecurityScheme.Type.HTTP)
                                        .scheme("bearer")
                                        .bearerFormat("JWT")
                                        .description("Nhập JWT Access Token để xác thực các API bảo mật (không cần gõ tiền tố 'Bearer ')")));
    }
}
