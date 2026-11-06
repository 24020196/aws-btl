package com.iaas.xregion;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@EnableAsync
public class XRegionApplication {

    public static void main(String[] args) {
        SpringApplication.run(XRegionApplication.class, args);
    }
}

