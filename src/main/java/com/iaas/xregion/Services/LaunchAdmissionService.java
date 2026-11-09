package com.iaas.xregion.Services;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Entity.FlavorEntity;
import com.iaas.xregion.Entity.ImageEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.LaunchUnavailableException;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.services.ssm.SsmClient;

import java.util.UUID;

@Service
@RequiredArgsConstructor
public class LaunchAdmissionService {
    public static final String PARAMETER = "/xregion/ap-southeast-2/launch/admission";
    private final SsmClient ssmClient;
    private final ObjectMapper objectMapper;
    private final DynamoDbTable<ImageEntity> imagesTable;
    private final DynamoDbTable<FlavorEntity> flavorsTable;
    private final KeyService keyService;

    public void validate(LaunchInstanceRequest request, String username) {
        JsonNode config;
        try {
            config = objectMapper.readTree(ssmClient.getParameter(b -> b.name(PARAMETER)).parameter().value());
        } catch (Exception ex) {
            throw new LaunchUnavailableException("Launch admission is unavailable; please try later");
        }
        JsonNode canary = config.path("canary");
        boolean scoped = "maintenance".equals(config.path("mode").asText())
                && username.equals(canary.path("username").asText())
                && request.getName().trim().equals(canary.path("name").asText())
                && request.getKeyPairName().equals(canary.path("key_id").asText());
        if (!"open".equals(config.path("mode").asText()) && !scoped) {
            throw new LaunchUnavailableException("Launch is unavailable during maintenance");
        }
        if (!"ap-southeast-2".equals(request.getRegion()) || request.getEbsSizeGb() < 1) {
            throw new AppException("Unsupported launch region or invalid disk size");
        }
        try { UUID.fromString(request.getImageId()); }
        catch (IllegalArgumentException ex) { throw new AppException("A real image UUID is required"); }
        if (imagesTable.getItem(Key.builder().partitionValue(request.getImageId()).build()) == null) {
            throw new AppException("Unknown launch image");
        }
        boolean knownFlavor = flavorsTable.scan().items().stream()
                .anyMatch(f -> request.getFlavor().equals(f.getFlavorName()) || request.getFlavor().equals(f.getFlavorId()));
        if (!knownFlavor) throw new AppException("Unknown launch flavor");
        if (!scoped) keyService.getKeyPair(request.getKeyPairName());
    }
}
