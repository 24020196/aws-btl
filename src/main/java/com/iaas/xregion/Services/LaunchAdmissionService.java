package com.iaas.xregion.Services;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iaas.xregion.Entity.FlavorEntity;
import com.iaas.xregion.Entity.ImageEntity;
import com.iaas.xregion.Exceptions.AppException;
import com.iaas.xregion.Exceptions.LaunchUnavailableException;
import com.iaas.xregion.Model.Request.LaunchInstanceRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.services.ssm.SsmClient;

import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

@Service
public class LaunchAdmissionService {
    public static final Set<String> SUPPORTED_REGIONS = Set.of("us-east-1", "ap-southeast-2");
    public static final String PARAMETER = "/xregion/ap-southeast-2/launch/admission";
    public static final int MAX_EBS_SIZE_GB = 5;

    public static String parameterNameForRegion(String region) {
        return "/xregion/" + region + "/launch/admission";
    }

    private final Function<String, SsmClient> ssmClientResolver;
    private final ObjectMapper objectMapper;
    private final DynamoDbTable<ImageEntity> imagesTable;
    private final DynamoDbTable<FlavorEntity> flavorsTable;
    private final KeyService keyService;

    @Autowired
    public LaunchAdmissionService(Function<String, SsmClient> ssmClientResolver,
                                  ObjectMapper objectMapper,
                                  DynamoDbTable<ImageEntity> imagesTable,
                                  DynamoDbTable<FlavorEntity> flavorsTable,
                                  KeyService keyService) {
        this.ssmClientResolver = ssmClientResolver;
        this.objectMapper = objectMapper;
        this.imagesTable = imagesTable;
        this.flavorsTable = flavorsTable;
        this.keyService = keyService;
    }

    public LaunchAdmissionService(SsmClient ssmClient,
                                  ObjectMapper objectMapper,
                                  DynamoDbTable<ImageEntity> imagesTable,
                                  DynamoDbTable<FlavorEntity> flavorsTable,
                                  KeyService keyService) {
        this(region -> ssmClient, objectMapper, imagesTable, flavorsTable, keyService);
    }

    public void validate(LaunchInstanceRequest request, String username) {
        String region = request.getRegion() != null ? request.getRegion().trim() : "";
        if (!SUPPORTED_REGIONS.contains(region) || request.getEbsSizeGb() < 1 || request.getEbsSizeGb() > MAX_EBS_SIZE_GB) {
            throw new AppException("Unsupported launch region or invalid disk size (1-" + MAX_EBS_SIZE_GB + " GiB)");
        }

        JsonNode config;
        try {
            String paramName = parameterNameForRegion(region);
            SsmClient client = ssmClientResolver.apply(region);
            config = objectMapper.readTree(client.getParameter(b -> b.name(paramName)).parameter().value());
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
