package com.iaas.xregion.Services;

import com.iaas.xregion.Entity.InstanceEntity;
import com.iaas.xregion.Entity.NovaEntity;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;

/**
 * Từ khi bảng XRegion-Instances chỉ còn giữ trạng thái, tên / vùng / IP / ổ đĩa của máy nằm ở bản ghi Nova
 * đang chạy (bảng XRegion-Nova). Lớp này đọc bản ghi Nova đó để Security Group và Migration dùng đúng dữ liệu.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class NovaLookup {

    private final DynamoDbTable<NovaEntity> novaTable;

    /** Bản ghi Nova đang chạy của máy: theo active_nova_id, chưa có thì tìm qua chỉ mục instance_id-index. */
    public NovaEntity find(InstanceEntity inst) {
        if (inst == null || novaTable == null) {
            return null;
        }
        try {
            if (inst.getActiveNovaId() != null && !inst.getActiveNovaId().isBlank()) {
                NovaEntity n = novaTable.getItem(Key.builder().partitionValue(inst.getActiveNovaId()).build());
                if (n != null) {
                    return n;
                }
            }
            for (var page : novaTable.index("instance_id-index").query(r -> r.queryConditional(
                    QueryConditional.keyEqualTo(Key.builder().partitionValue(inst.getInstanceId()).build())))) {
                for (NovaEntity n : page.items()) {
                    if (n != null) {
                        return n;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Không đọc được bản ghi Nova của máy [{}]: {}", inst.getInstanceId(), e.getMessage());
        }
        return null;
    }

    /** Điền tên, vùng, loại máy, IP, ổ đĩa, key của máy từ bản ghi Nova (các trường này không còn lưu ở bảng Instances). */
    public InstanceEntity fill(InstanceEntity inst) {
        NovaEntity n = find(inst);
        if (n == null) {
            return inst;
        }
        if (n.getInstanceName() != null) inst.setInstanceName(n.getInstanceName());
        if (n.getRegion() != null) inst.setCurrentRegion(n.getRegion());
        if (n.getFlavor() != null) inst.setFlavor(n.getFlavor());
        if (n.getPrivateIp() != null) inst.setPrivateIp(n.getPrivateIp());
        if (n.getElasticIp() != null) inst.setElasticIp(n.getElasticIp());
        if (n.getVolumeId() != null) inst.setVolumeId(n.getVolumeId());
        if (n.getEbsVolumeId() != null) inst.setEbsVolumeId(n.getEbsVolumeId());
        if (n.getKeyId() != null) inst.setKeyId(n.getKeyId());
        inst.setNetworkMode(n.getNetworkMode());
        return inst;
    }

    /** Sau khi chuyển vùng: ghi vùng và IP mới vào bản ghi Nova để trang danh sách / chi tiết hiện đúng. */
    public void saveLocation(InstanceEntity inst, String region, String privateIp, String elasticIp) {
        NovaEntity n = find(inst);
        if (n == null) {
            return;
        }
        n.setRegion(region);
        if (privateIp != null) n.setPrivateIp(privateIp);
        if (elasticIp != null) n.setElasticIp(elasticIp);
        try {
            novaTable.putItem(n);
        } catch (Exception e) {
            log.warn("Không ghi được vùng mới vào bản ghi Nova [{}]: {}", n.getNovaId(), e.getMessage());
        }
    }
}
