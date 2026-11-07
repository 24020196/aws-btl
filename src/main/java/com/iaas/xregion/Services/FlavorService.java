package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.FlavorEntity;
import com.iaas.xregion.Model.Response.FlavorResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class FlavorService {

    private final DynamoDbTable<FlavorEntity> flavorsTable;

    public List<FlavorResponse> getAllFlavors() {
        List<FlavorResponse> list = new ArrayList<>();
        try {
            List<FlavorEntity> entities = flavorsTable.scan().items().stream().collect(Collectors.toList());
            if (!entities.isEmpty()) {
                for (FlavorEntity f : entities) {
                    int vcpu = f.getVcpus() != null ? f.getVcpus() : 1;
                    int ram = f.getRamMb() != null ? f.getRamMb() : 512;
                    int disk = f.getDiskGb() != null ? f.getDiskGb() : 10;
                    String name = f.getFlavorName() != null ? f.getFlavorName() : f.getFlavorId();

                    String ramDisp = ram >= 1024 ? (ram / 1024) + " GB" : ram + " MB";
                    String series;
                    if (name.startsWith("m1")) {
                        series = "Tiêu chuẩn (m1)";
                    } else if (name.startsWith("h1")) {
                        series = "Hiệu năng cao (h1)";
                    } else {
                        series = "Điện toán đám mây";
                    }

                    list.add(FlavorResponse.builder()
                            .id(f.getFlavorId())
                            .name(name)
                            .vcpus(vcpu)
                            .ramMb(ram)
                            .diskGb(disk)
                            .ramDisplay(ramDisp)
                            .series(series)
                            .build());
                }
            }
        } catch (Exception e) {
            log.warn("Không thể quét bảng DynamoDB XRegion-Flavors: {}", e.getMessage());
        }

        // Fallback mặc định nếu chưa có dữ liệu trong DynamoDB
        if (list.isEmpty()) {
            list.add(new FlavorResponse("1", "m1.tiny", 1, 1024, 10, "1 GB", "Tiêu chuẩn (m1)"));
            list.add(new FlavorResponse("2", "m1.small", 1, 2048, 10, "2 GB", "Tiêu chuẩn (m1)"));
            list.add(new FlavorResponse("3", "m1.medium", 2, 4096, 10, "4 GB", "Tiêu chuẩn (m1)"));
            list.add(new FlavorResponse("4", "m1.large", 4, 8192, 10, "8 GB", "Tiêu chuẩn (m1)"));
            list.add(new FlavorResponse("5", "h1.medium", 8, 16384, 10, "16 GB", "Hiệu năng cao (h1)"));
            list.add(new FlavorResponse("6", "h1.large", 16, 32768, 10, "32 GB", "Hiệu năng cao (h1)"));
            list.add(new FlavorResponse("7", "h1.xlarge", 32, 65536, 10, "64 GB", "Hiệu năng cao (h1)"));
        }

        // Sắp xếp: m1 trước, h1 sau; trong cùng dòng sắp theo vcpus và ramMb
        return list.stream()
                .sorted(Comparator.comparing((FlavorResponse f) -> f.getName().startsWith("h1") ? 1 : 0)
                        .thenComparingInt(FlavorResponse::getVcpus)
                        .thenComparingInt(FlavorResponse::getRamMb))
                .collect(Collectors.toList());
    }
}
