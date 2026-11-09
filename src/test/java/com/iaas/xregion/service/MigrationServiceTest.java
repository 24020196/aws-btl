package com.iaas.xregion.service;

import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.MigrationEntity;
import com.iaas.xregion.Exceptions.ConflictException;
import com.iaas.xregion.Services.*;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class MigrationServiceTest {
    @Test
    @SuppressWarnings("unchecked")
    void natMigrationIsRejectedBeforeLockOrMigrationRecord() {
        DynamoDbTable<InstanceEntity> instances = mock(DynamoDbTable.class);
        DynamoDbTable<MigrationEntity> migrations = mock(DynamoDbTable.class);
        NovaLookup lookup = mock(NovaLookup.class);
        InstanceEntity instance = InstanceEntity.builder().instanceId("i-1")
                .username("user").currentStatus("RUNNING").networkMode("linux_nat_v1").build();
        when(instances.getItem(any(Key.class))).thenReturn(instance);
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("user", "unused", List.of()));
        try {
            MigrationService service = new MigrationService(instances, migrations,
                    mock(AuditLogService.class), mock(NetworkService.class), lookup);
            assertThatThrownBy(() -> service.triggerMigration("i-1"))
                    .isInstanceOf(ConflictException.class);
            verify(instances).getItem(any(Key.class));
            verifyNoMoreInteractions(instances);
            verifyNoInteractions(migrations);
        } finally {
            SecurityContextHolder.clearContext();
        }
    }
}
