package com.iaas.xregion.Exceptions;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

/** Không lưu được Security Group xuống DynamoDB: không được báo thành công cho người dùng. */
@ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
public class SecurityGroupPersistenceException extends RuntimeException {
    public SecurityGroupPersistenceException(String message, Throwable cause) {
        super(message, cause);
    }
}
