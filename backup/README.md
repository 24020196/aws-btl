# Backup AWS XRegion - Sydney

Phạm vi: tài nguyên của XRegion trong `ap-southeast-2`, account `291634989063`, cùng IAM role/policy toàn cục được chúng sử dụng. **Không backup EBS** theo yêu cầu. Mã lấy từ AWS đang triển khai, không lấy bản sửa phase 1 chưa deploy.

Snapshot hiện tại: [`snapshots/sydney-20261108T125515Z`](snapshots/sydney-20261108T125515Z).

## Nội dung

- `lambda/<tên>/deployed.zip`: gói AWS gốc, đối chiếu `CodeSha256`; `source/` là mã giải nén. Có cấu hình, policy, version, alias, trigger và concurrency hiện có.
- `stepfunctions/`: ASL và cấu hình workflow.
- `dynamodb/`: schema, index, TTL và cấu hình continuous backup; không chứa item.
- `eventbridge/`, `apigateway/`, `sqs/`, `cloudwatch/`: rule/target, API Swagger đang deploy và stage, cấu hình queue, log group và resource policy.
- `iam/`, `ec2/`: role, trust/permission policy, instance profile và cấu hình EC2/VPC/subnet/SG/route/NAT/EIP/ENI liên quan. IAM credentials và private SSH key không được xuất.
- `resource-models/`, `resource-schemas/`: mô hình resource và schema CloudFormation đọc trực tiếp từ AWS.
- `restore/template.json`: mã CloudFormation tái tạo hạ tầng và ứng dụng; không có EBS Volume, VolumeAttachment hoặc snapshot.
- `restore/private-parameters.json`: giá trị môi trường nhạy cảm tách khỏi template. Template dùng tham số `NoEcho`.
- `manifest.json`, `SHA256SUMS.json`, `validation.json`: phạm vi, thống kê, checksum và kết quả kiểm tra.

Thư mục `snapshots/` được `.gitignore` riêng loại khỏi Git vì chứa cấu hình môi trường và gói mã AWS gốc có thể có thông tin nhạy cảm. Các script và tài liệu backup vẫn có thể quản lý bằng Git.

## Chạy lại backup

Cần Python cùng `boto3`, `jsonschema` và AWS credentials có quyền đọc các dịch vụ tương ứng.

```powershell
python -B backup/export_sydney.py
python -B backup/build_restore_template.py backup/snapshots/<snapshot-moi>
python -B backup/validate_snapshot.py backup/snapshots/<snapshot-moi> --fetch-schemas
```

Exporter chỉ đọc AWS, kiểm tra account và ghi snapshot mới. `--resume --output <thu-muc>` chỉ dùng để tiếp tục snapshot chưa hoàn thành. Không có lệnh triển khai trong exporter/builder/validator. Không chỉnh sửa snapshot đã chốt checksum; tạo bản mới khi cập nhật.

Kiểm tra tính toàn vẹn mà không gọi AWS hoặc sửa file:

```powershell
python -B backup/validate_snapshot.py backup/snapshots/sydney-20261108T125515Z --verify-only
```

## Chuẩn bị khôi phục

1. Đọc `restore/limitations.json` và `validation.json`. Template được kiểm tra property bằng schema AWS và dependency; chưa tạo stack để thử. `cfn-lint`/`cfn-guard` không có sẵn, chưa thực hiện đánh giá compliance hoặc kiểm tra tài nguyên/quota ở bước tạo stack.
2. Template giữ tên Lambda/table/rule/role để tương thích hợp đồng hiện tại. Dùng trong môi trường phục hồi cùng account/region khi tên đã trống, hoặc lập quy trình import tài nguyên hiện có; không chạy tạo stack trực tiếp lên hệ thống đang có cùng tên.
3. Chuẩn bị bucket artifact riêng trong Sydney có cấu hình private và quyền đọc phù hợp cho CloudFormation. Script upload template qua S3 vì template vượt giới hạn inline 51.200 byte.
4. EC2 mặc định dùng AMI gốc ghi trong cấu hình. Do không có EBS/disk backup, AMI này **không tái tạo phần mềm OpenStack và dữ liệu đã cài trên ổ hiện tại**. Có thể truyền AMI riêng qua parameter override nếu đã có nguồn khôi phục khác. Không gắn lại 8 data volume hiện có bằng template này.
5. Giữ SSH key pair được ghi trong snapshot hoặc truyền tên key pair khác qua `RecoverySshKeyName`. Root volume do AMI tự tạo khi launch EC2; đây không phải bản sao root disk hiện tại.
6. EIP, ENI, NAT ID và API ID mới có thể khác. Template thay các dependency được nhận diện bằng `Ref/GetAtt`; sau khôi phục, kiểm tra endpoint backend, quyền caller ký SigV4 và các tham chiếu hardcode trong source Lambda/OpenStack. Backend/JAR, nội dung OpenStack, item DynamoDB, message SQS, log event CloudWatch và lịch sử execution không nằm trong backup mã/cấu hình này.

Regional NAT tự tạo ENI, route table và default IGW route; template không tạo trùng các thành phần do dịch vụ quản lý. Xem [AWS Regional NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html).

Xem kế hoạch khôi phục, không thay đổi AWS:

```powershell
python -B backup/deploy.py backup/snapshots/sydney-20261108T125515Z --artifact-bucket <bucket-artifact>
```

Chỉ khi đã review môi trường, AMI, tham số và dữ liệu cần có, thêm `--apply` để upload code/template và gửi yêu cầu tạo stack. `--parameters-file` nhận JSON theo định dạng AWS `[{"ParameterKey":"...","ParameterValue":"..."}]`. Không có bước `--apply` nào đã được chạy khi tạo backup này.
