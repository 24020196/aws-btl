package com.iaas.xregion.Entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.NoArgsConstructor;
import lombok.Setter;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;

/**
 * Maps to live AWS DynamoDB table: XRegion-Images
 * Primary Key: image_id (S)
 */
@DynamoDbBean
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ImageEntity {

    private String imageId;
    private String imageName;
    private Long sizeBytes;

    @DynamoDbPartitionKey
    @DynamoDbAttribute("image_id")
    public String getImageId() {
        return imageId;
    }

    @DynamoDbAttribute("image_name")
    public String getImageName() {
        return imageName;
    }

    @DynamoDbAttribute("size_bytes")
    public Long getSizeBytes() {
        return sizeBytes;
    }
}
