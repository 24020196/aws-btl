package com.iaas.xregion.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Entity.FlavorEntity;
import com.iaas.xregion.Entity.ImageEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.LaunchUnavailableException;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import com.iaas.xregion.Services.KeyService;
import com.iaas.xregion.Services.LaunchAdmissionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable;
import software.amazon.awssdk.services.ssm.SsmClient;
import software.amazon.awssdk.services.ssm.model.GetParameterRequest;
import software.amazon.awssdk.services.ssm.model.GetParameterResponse;
import software.amazon.awssdk.services.ssm.model.Parameter;

import java.util.function.Consumer;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@SuppressWarnings("unchecked")
class LaunchAdmissionServiceTest {
    SsmClient ssm = mock(SsmClient.class);
    DynamoDbTable<ImageEntity> images = mock(DynamoDbTable.class);
    DynamoDbTable<FlavorEntity> flavors = mock(DynamoDbTable.class);
    KeyService keys = mock(KeyService.class);
    LaunchAdmissionService service = new LaunchAdmissionService(ssm, new ObjectMapper(), images, flavors, keys);
    LaunchInstanceRequest request;

    @BeforeEach void setup() {
        request = new LaunchInstanceRequest();
        request.setName("test"); request.setRegion("ap-southeast-2"); request.setFlavor("m1.tiny");
        request.setImageId("fd249548-1863-4d30-b809-732108cab057"); request.setKeyPairName("my-key");
    }
    void config(String json) {
        when(ssm.getParameter(any(Consumer.class))).thenReturn(GetParameterResponse.builder()
                .parameter(Parameter.builder().value(json).build()).build());
    }
    void catalogs() {
        when(images.getItem(any(Key.class))).thenReturn(ImageEntity.builder().imageId(request.getImageId()).build());
        PageIterable<FlavorEntity> pages = mock(PageIterable.class, RETURNS_DEEP_STUBS);
        when(flavors.scan()).thenReturn(pages);
        when(pages.items().stream()).thenReturn(Stream.of(FlavorEntity.builder().flavorName("m1.tiny").build()));
    }
    @Test void maintenanceRejectsBeforeCatalogs() {
        config("{\"mode\":\"maintenance\"}");
        assertThatThrownBy(() -> service.validate(request, "lam")).isInstanceOf(LaunchUnavailableException.class);
        verifyNoInteractions(images, flavors, keys);
    }
    @Test void unreadableConfigurationFailsClosed() {
        when(ssm.getParameter(any(Consumer.class))).thenThrow(new IllegalStateException("transport"));
        assertThatThrownBy(() -> service.validate(request, "lam")).isInstanceOf(LaunchUnavailableException.class);
        verifyNoInteractions(images, flavors, keys);
    }
    @Test void invalidModeFailsClosed() {
        config("{\"mode\":\"invalid\"}");
        assertThatThrownBy(() -> service.validate(request, "lam")).isInstanceOf(LaunchUnavailableException.class);
    }
    @Test void placeholderImageRejected() {
        config("{\"mode\":\"open\"}"); request.setImageId("img-u22");
        assertThatThrownBy(() -> service.validate(request, "lam")).isInstanceOf(AppException.class);
        verifyNoInteractions(images, flavors, keys);
    }
    @Test void openChecksCatalogAndKeyOwnership() {
        config("{\"mode\":\"open\"}"); catalogs(); service.validate(request, "lam");
        verify(keys).getKeyPair("my-key");
    }
    @Test void virginiaRegionAllowedAndChecksCatalog() {
        request.setRegion("us-east-1");
        config("{\"mode\":\"open\"}"); catalogs(); service.validate(request, "lam");
        verify(keys).getKeyPair("my-key");
    }
    @Test void unsupportedRegionRejected() {
        request.setRegion("eu-west-1");
        assertThatThrownBy(() -> service.validate(request, "lam")).isInstanceOf(AppException.class)
                .hasMessageContaining("Unsupported launch region");
    }
    @Test void invalidDiskSizeZeroRejected() {
        request.setEbsSizeGb(0);
        assertThatThrownBy(() -> service.validate(request, "lam")).isInstanceOf(AppException.class)
                .hasMessageContaining("invalid disk size");
    }
    @Test void exactCanaryExceptionStillChecksCatalog() {
        config("{\"mode\":\"maintenance\",\"canary\":{\"username\":\"lam\",\"name\":\"test\",\"key_id\":\"my-key\"}}");
        catalogs(); service.validate(request, "lam"); verifyNoInteractions(keys);
    }
    @Test void wrongCanaryUserRejected() {
        config("{\"mode\":\"maintenance\",\"canary\":{\"username\":\"lam\",\"name\":\"test\",\"key_id\":\"my-key\"}}");
        assertThatThrownBy(() -> service.validate(request, "other")).isInstanceOf(LaunchUnavailableException.class);
    }

    @Test void multiRegionSsmResolverRoutesByRegion() {
        SsmClient ssmVirginia = mock(SsmClient.class);
        SsmClient ssmSydney = mock(SsmClient.class);
        java.util.Map<String, SsmClient> map = java.util.Map.of(
                "us-east-1", ssmVirginia,
                "ap-southeast-2", ssmSydney
        );
        LaunchAdmissionService multiService = new LaunchAdmissionService(
                map::get, new ObjectMapper(), images, flavors, keys
        );

        when(ssmVirginia.getParameter(any(Consumer.class))).thenReturn(GetParameterResponse.builder()
                .parameter(Parameter.builder().value("{\"mode\":\"open\"}").build()).build());
        when(ssmSydney.getParameter(any(Consumer.class))).thenReturn(GetParameterResponse.builder()
                .parameter(Parameter.builder().value("{\"mode\":\"open\"}").build()).build());

        catalogs();
        request.setRegion("us-east-1");
        multiService.validate(request, "lam");
        verify(ssmVirginia, times(1)).getParameter(any(Consumer.class));
        verify(ssmSydney, never()).getParameter(any(Consumer.class));

        catalogs();
        request.setRegion("ap-southeast-2");
        multiService.validate(request, "lam");
        verify(ssmSydney, times(1)).getParameter(any(Consumer.class));
    }

    @Test void rejectsDiskSizeExceeding5Gb() {
        request.setEbsSizeGb(6);
        assertThatThrownBy(() -> service.validate(request, "lam"))
                .isInstanceOf(AppException.class)
                .hasMessageContaining("5 GiB");
        verifyNoInteractions(ssm, images, flavors, keys);
    }
}
