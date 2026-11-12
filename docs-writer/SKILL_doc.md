---
name: docs-serverless-report
description: >-
  Khảo sát mã nguồn thực tế và đối chiếu thông số hạ tầng AWS (chế độ Read-Only) để viết báo cáo
  chuyên sâu về Phân hệ Điều phối Serverless, An ninh & CSDL Đám mây của dự án XRegion (gồm AWS Lambda,
  AWS Step Functions, Amazon API Gateway, Amazon EventBridge, AWS IAM và Amazon DynamoDB / Global Replication).
  Bao gồm kết quả kiến trúc, 5 bước triển khai tự động hóa, giải pháp sao lưu & DR qua CloudFormation (backup/),
  kịch bản kiểm thử Pytest/Playwright và đánh giá hiệu năng thực nghiệm. Chỉ vận hành khi người dùng yêu cầu
  dùng skill này hoặc @SKILL_doc.md cho một tác vụ cụ thể.
---

# Viết Báo cáo Phân hệ Điều phối Serverless, An ninh & CSDL Đám mây (`aws-btl`)

Chỉ vận hành khi người dùng yêu cầu dùng skill này cho một tác vụ. Tuyệt đối không chỉnh sửa mã nguồn nghiệp vụ, không thay đổi cấu hình hạ tầng và không chạy lệnh ghi/xóa trên AWS.

## Phạm vi Trách nhiệm & Ranh giới Hệ thống

Skill này được thiết kế chuyên biệt để viết báo cáo kỹ thuật tập trung vào **6 dịch vụ AWS cốt lõi** mà bạn phụ trách:
1. **AWS Lambda**: 9 hàm worker xử lý tác vụ hạ tầng và điều phối logic (`serverless/launch-contract/`).
2. **AWS Step Functions**: 3 State Machines điều phối bất đồng bộ (`LaunchInstance`, `TerminateInstance`, `LifecycleInstance`).
3. **Amazon API Gateway**: Cổng tiếp nhận sự kiện `XRegion-EventGateway` (HTTP API v2, xác thực SigV4 / Bearer).
4. **Amazon EventBridge**: Bus sự kiện `default` cùng các quy tắc định tuyến sự kiện (`BackendEventRule`, `NovaStatusRule`).
5. **AWS IAM**: Hệ thống phân quyền Least-Privilege (Execution Roles, SigV4 Authorizers, Service Roles).
6. **Amazon DynamoDB & Global Data Plane**: 6 bảng NoSQL, mô hình khóa chính/phụ, khóa nguyên tử và sao lưu liên tục (PITR).

> [!NOTE]
> Các phân hệ khác (như ứng dụng Backend Spring Boot hay Máy ảo OpenStack trên EC2) được coi là **các tác nhân tích hợp ngoại vi (External Upstream/Downstream Actors)** — là bên phát sinh sự kiện gửi vào API Gateway hoặc bên tiếp nhận chỉ thị điều phối từ Lambda, không nằm trong phạm vi cài đặt/triển khai chi tiết của báo cáo này.

## File tạm ngoài workspace

- Không tạo file nháp, file JSON kết quả truy vấn AWS CLI hay script trung gian trong workspace `aws-btl`.
- Khi cần lưu tạm dữ liệu lớn từ AWS CLI hoặc log kiểm thử để tổng hợp, tạo thư mục riêng trong OS Temp (`$env:TEMP` trên Windows) và xóa sạch sau khi hoàn tất.

## Grill-Me và Plan

Áp dụng [quy trình duyệt kế hoạch](../always-plan-and-grillme/SKILL.md). Chỉ khảo sát chỉ đọc mã nguồn và hạ tầng để lập kế hoạch.

- Ghi rõ:
  1. Danh sách thư mục/file sẽ đọc trong `aws-btl` (`serverless/`, `backup/`, `tests/serverless/`, `tests/e2e/`, `docs/specs/serverless/`, `docs/risk-review/`).
  2. Danh sách lệnh AWS CLI chỉ đọc (`--profile xregion`) sẽ chạy đối với 6 dịch vụ trên để đối chiếu tài nguyên thực tế.
  3. Đường dẫn file báo cáo sẽ tạo/cập nhật trong `docs/` (ví dụ: `docs/bao-cao-phan-he-serverless-dynamodb.md`) và dàn ý chi tiết.
- Chờ người dùng duyệt kế hoạch trước khi chạy lệnh CLI hoặc ghi file báo cáo.

---

## 1. Quy tắc An toàn & Ranh giới Đọc/Ghi (Strict Read-Only)

- **Chỉ được phép ĐỌC**:
  - Mã nguồn và cấu hình trong `aws-btl`:
    - `serverless/launch-contract/`: Các file máy trạng thái (`*.asl.json`), mã nguồn 9 hàm Lambda, runtime dispatcher (`network_runtime.py`), storage adapter Cinder-EBS và script triển khai tự động `deployment/deploy.py`.
    - `backup/`: Phân hệ Sao lưu & Diễn tập Phục hồi Thảm họa cho 6 dịch vụ trên (`export_sydney.py`, `build_restore_template.py`, `validate_snapshot.py`, `deploy.py`, `README.md`).
    - `tests/`: Bộ kiểm thử Pytest Serverless trong `tests/serverless/` và kịch bản Playwright E2E cho API Gateway trong `tests/e2e/tests/xregion-api-gateway.spec.js`.
    - `docs/specs/serverless/`: Bộ đặc tả chuẩn `SPEC-SF-00` đến `SPEC-SF-06` và các đặc tả liên quan (`SPEC-01`, `SPEC-06`, `SPEC-07`).
    - `docs/risk-review/`: Nhật ký đo lường thực chứng `verification-log.md` (thời gian chạy Step Functions, độ trễ Lambda, kiểm chứng khóa DynamoDB), `decision-log.md` và `current-version-risks.md`.
    - Cấu hình môi trường mẫu: `.env.example`, `gateway-resources.json`.
  - Hạ tầng AWS qua các lệnh CLI chỉ đọc (`describe-*`, `list-*`, `get-*`) với `--profile xregion`.
- **Bảo mật thông tin nhạy cảm (Zero-Secret Leakage - Cực kỳ quan trọng)**:
  - **Tuyệt đối không đọc nội dung bí mật từ file `.env` thật** để đưa vào báo cáo; chỉ dùng `.env.example` làm mẫu minh họa danh sách biến môi trường.
  - Mọi giá trị thật của Access Key, Secret Key, Token, SigV4 Secret, mật khẩu cơ sở dữ liệu hoặc mật khẩu OpenStack (`OS_PASSWORD`) nếu xuất hiện trong kết quả CLI đều bắt buộc phải thay bằng `<REDACTED>`.
- **Chỉ được phép GHI / SỬA**:
  - Các file báo cáo định dạng Markdown (`.md`) nằm trong thư mục `docs/` theo kế hoạch đã duyệt (ví dụ: `docs/bao-cao-phan-he-serverless-dynamodb.md`).
  - Nghiêm cấm sửa đổi bất kỳ file nào trong `serverless/`, `backup/`, `tests/` hoặc tài nguyên trên AWS.

---

## 2. Quy trình Khảo sát Dữ liệu Đầu vào (3 Trục Song Song)

### 2.1. Trục 1: Khảo sát mã nguồn thực tế của 6 dịch vụ trong workspace `aws-btl`
Đọc và đối chiếu thông tin từ các thành phần Serverless, Data & Security:
1. **Amazon API Gateway (`XRegion-EventGateway`) & Amazon EventBridge**:
   - Khảo sát cấu hình HTTP API v2: Endpoint, route `POST /prod/events`, cơ chế xác thực kép (AWS IAM SigV4 cho Backend nội bộ và Bearer Token cho dịch vụ bên ngoài theo `SPEC-07`).
   - Cấu hình tích hợp Direct AWS Service: Định tuyến trực tiếp sự kiện từ API Gateway vào EventBridge default bus mà không cần lớp trung gian EC2.
   - EventBridge Rules: `XRegion-BackendEventRule` (lọc sự kiện từ backend để kích hoạt Step Functions / Lambda) và `XRegion-NovaStatusRule` (lọc sự kiện thay đổi trạng thái từ forwarder).
2. **AWS Step Functions State Machines (`serverless/launch-contract/`)**:
   - `LaunchInstance.asl.json`: Pipeline 6 bước cấp phát máy ảo Boot-from-Volume (Cấp đĩa Cinder/EBS -> Khởi tạo Nova -> Chờ máy Active -> Gán Elastic IP -> Gán Security Group 1-1 -> Đồng bộ bản ghi vào DynamoDB).
   - `TerminateInstance.asl.json`: Pipeline thu hồi tài nguyên an toàn (Gỡ EIP -> Xóa máy ảo -> Xóa SG 1-1 -> Giải phóng đĩa EBS/Cinder -> Cập nhật DynamoDB).
   - `LifecycleInstance.asl.json`: Pipeline Start / Stop / Reboot máy ảo có đồng bộ trạng thái hai chiều.
3. **AWS Lambda Functions (9 Worker Functions)**:
   - Các hàm phục vụ khởi tạo: `XRegion-LaunchInstance-BootNova`, `XRegion-LaunchInstance-AssignSecurityGroup`, `XRegion-LaunchInstance-ExtendVolume`, `XRegion-LaunchInstance-SyncDynamoDB`.
   - Các hàm phục vụ vòng đời & bảo mật: `XRegion-SyncSecurityGroup`, `XRegion-TerminateInstance-DeleteVolume`, `XRegion-InstanceLifecycle`.
   - Các hàm quản trị tài nguyên & tự phục hồi: `XRegion-CinderPoolManager`, `XRegion-EIPPoolManager`, `XRegion-InstanceRecovery` (`recovery_worker.py` & `recovery_policy.py`).
   - Script tự động hóa triển khai gói mã nguồn: `serverless/launch-contract/deployment/deploy.py`.
4. **Amazon DynamoDB & Global Data Plane**:
   - 6 bảng CSDL cốt lõi: `XRegion-Instances`, `XRegion-Users`, `XRegion-Keys`, `XRegion-SecurityGroups`, `XRegion-Volumes`, `XRegion-Migrations` (và bảng mở rộng `XRegion-Nova`).
   - Thiết kế lược đồ NoSQL: Khóa chính (PK), Khóa sắp xếp (SK), Chỉ mục thứ cấp toàn cục (GSI `username-index`).
   - Cơ chế Khóa nguyên tử chống xung đột dữ liệu:
     - Khóa điều kiện `migration_lock` chống hiện tượng Split-Brain khi di trú máy ảo xuyên vùng (`SPEC-03`).
     - Quản lý phiên bản tăng dần `revision` / `applied_revision` chống ghi đè lạc hậu trên Security Group (`SPEC-06`, `SPEC-SF-05`).
   - Cơ chế bảo vệ dữ liệu: Kích hoạt Point-in-Time Recovery (PITR / Continuous Backup) và khả năng mở rộng Global Tables đa vùng.
5. **AWS IAM & An ninh Đám mây (Least-Privilege Architecture)**:
   - Lambda Execution Roles: Phân tách quyền chặt chẽ (chỉ cấp quyền ghi trên bảng DynamoDB được chỉ định, quyền ghi log CloudWatch, quyền kết nối VPC ENI).
   - Step Functions Execution Role: Quyền thực thi các hàm Lambda trong state machine.
   - API Gateway Execution Role: Quyền `events:PutEvents` vào EventBridge default bus.
6. **Phân hệ Sao lưu & Tự động hóa Phục hồi Thảm họa (`backup/`)**:
   - Là giải pháp **Disaster Recovery (DR) & CloudFormation Synthesizer** cho chính 6 dịch vụ trên tại Sydney (`ap-southeast-2`, account `291634989063`):
     - `backup/export_sydney.py`: Xuất toàn bộ gói zip Lambda, ASL Step Functions, schema/indexes DynamoDB, rules EventBridge, đặc tả API Gateway và IAM roles ra snapshot.
     - `backup/build_restore_template.py`: Phân tích snapshot và tự động tổng hợp ra CloudFormation template độc lập `restore/template.json` (tự động tách thông số nhạy cảm ra `restore/private-parameters.json` có cờ `NoEcho`).
     - `backup/validate_snapshot.py`: Kiểm định tính toàn vẹn checksum SHA-256 (`SHA256SUMS.json`) và xác thực thuộc tính qua AWS CloudFormation resource schemas.
     - `backup/deploy.py`: Diễn tập lập kế hoạch khôi phục (preview) hoặc triển khai stack CloudFormation phục hồi hạ tầng Serverless & Data (`--apply` qua S3 artifact bucket).

### 2.2. Trục 2: Đối chiếu Hạ tầng Thực tế qua AWS CLI Read-Only (`--profile xregion`)
Trích xuất trạng thái và cấu hình thực tế của 6 dịch vụ trên AWS Sydney (`ap-southeast-2`) làm số liệu minh chứng:

```bash
# 1. Xác minh danh tính IAM và Region
aws sts get-caller-identity --profile xregion
aws configure get region --profile xregion

# 2. Liệt kê và kiểm tra thông số 6 bảng Amazon DynamoDB
aws dynamodb list-tables --profile xregion --output table
aws dynamodb describe-table --table-name XRegion-Instances --profile xregion --query "Table.{Name:TableName,Status:TableStatus,Items:ItemCount,Bytes:TableSizeBytes,Keys:KeySchema}" --output json
aws dynamodb describe-continuous-backups --table-name XRegion-Instances --profile xregion

# 3. Liệt kê API Gateway v2 & EventBridge Rules
aws apigatewayv2 get-apis --profile xregion --query "Items[*].{Name:Name,ApiId:ApiId,Protocol:ProtocolType,Endpoint:ApiEndpoint}" --output table
aws apigatewayv2 get-routes --api-id <api-id> --profile xregion --output table
aws events list-rules --profile xregion --query "Rules[*].{Name:Name,State:State,EventBusName:EventBusName}" --output table

# 4. Liệt kê các State Machines của AWS Step Functions
aws stepfunctions list-state-machines --profile xregion --query "stateMachines[*].{Name:name,Arn:stateMachineArn,Type:type,Status:status}" --output table
aws stepfunctions describe-state-machine --state-machine-arn <sfn-arn> --profile xregion --query "{Name:name,Status:status,Type:type,RoleArn:roleArn}" --output json

# 5. Liệt kê các hàm AWS Lambda thuộc dự án XRegion
aws lambda list-functions --profile xregion --query "Functions[?starts_with(FunctionName, 'XRegion')].{Name:FunctionName,Runtime:Runtime,Memory:MemorySize,Timeout:Timeout,Role:Role}" --output table

# 6. Liệt kê các IAM Roles phục vụ Serverless & Step Functions
aws iam list-roles --profile xregion --query "Roles[?contains(RoleName, 'XRegion') || contains(RoleName, 'Lambda') || contains(RoleName, 'StepFunctions')].{RoleName:RoleName,Arn:Arn,CreateDate:CreateDate}" --output table
```

### 2.3. Trục 3: Đối soát Bộ Đặc tả Serverless Chuẩn (`docs/specs/serverless/`)
Bắt buộc đối soát với các tài liệu chuẩn kỹ thuật:
- `SPEC-SF-00`: Quy chế quản trị Serverless Scope Guard (Step Functions & Lambda).
- `SPEC-SF-01`: Quy trình khởi tạo máy ảo Step Function (Launch Pipeline 6 bước).
- `SPEC-SF-02`: Quy trình hủy máy ảo Step Function (Terminate Pipeline).
- `SPEC-SF-03`: Quản lý Cinder Pool và EIP Pool Manager.
- `SPEC-SF-04` & `SPEC-06`: Hệ thống tự phục hồi lỗi bền vững (`recovery_worker.py`).
- `SPEC-SF-05`: Đồng bộ hóa nhóm bảo mật theo cơ chế số nguyên Revision.
- `SPEC-SF-06`: Quy trình quản trị vòng đời máy ảo (Lifecycle Pipeline).
- `SPEC-07`: Xác thực API Token và chữ ký IAM SigV4 qua API Gateway.

---

## 3. Cấu trúc Bắt buộc của Báo cáo "Kết quả thực hiện"

Báo cáo xuất ra trong `docs/` phải tổ chức đầy đủ theo 2 phần lớn dưới đây, tập trung 100% vào 6 dịch vụ bạn phụ trách:

### Phần 1: Kết quả Giải pháp & Quy trình Triển khai Tầng Serverless, Dữ liệu & An ninh
1. **Tổng quan kiến trúc Serverless Event-Driven, Data & Security Plane**:
   - Trình bày kiến trúc hướng sự kiện (Event-Driven) tích hợp liền mạch giữa Ingestion Layer (API Gateway), Event Routing (EventBridge), Workflow Orchestration (Step Functions), Compute Execution (Lambda) và Data Plane (DynamoDB).
   - Nêu rõ vai trò của AWS IAM trong việc cô lập và bảo mật tài nguyên theo nguyên tắc Least-Privilege.
   - Sơ đồ tương tác luồng dữ liệu chi tiết (Mermaid flowchart) thể hiện rõ luồng sự kiện từ khi API Gateway nhận request đến khi Lambda cập nhật DynamoDB.
2. **Bảng tổng hợp chi tiết tài nguyên AWS đã triển khai**:
   - Bảng đối chiếu cấu hình thực tế trích xuất từ AWS CLI: Tên hàm Lambda (Runtime, Memory, Timeout, Handler), ARN Step Functions, Route & Endpoint API Gateway, Danh sách EventBridge Rules/Targets, Thông số 6 bảng DynamoDB (PK, SK, GSI, PITR status), và các IAM Execution Roles.
3. **Quy trình triển khai tầng Serverless & Data lõi tuần tự (Deployment Steps — 5 Bước)**:
   - Trình bày mạch lạc, chi tiết 5 bước chuẩn kỹ thuật để đưa toàn bộ tầng Serverless & Data vào hoạt động:
     - **Bước 1 — Khởi tạo CSDL Amazon DynamoDB**: Tạo 6 bảng với đúng Partition Key, Sort Key, GSI `username-index`, cấu hình TTL và kích hoạt Continuous Backups (PITR).
     - **Bước 2 — Thiết lập IAM Roles & Quyền hạn Least-Privilege**: Tạo Execution Roles cho 9 hàm Lambda, State Machine Role cho Step Functions và Service Role cho API Gateway PutEvents.
     - **Bước 3 — Cấu hình Cổng thu nạp sự kiện (API Gateway & EventBridge)**: Tạo HTTP API `XRegion-EventGateway`, tạo route `POST /prod/events`, cấu hình integration chuyển tiếp vào EventBridge default bus và thiết lập 2 EventBridge Rules.
     - **Bước 4 — Đóng gói và triển khai các hàm AWS Lambda**: Cách chạy script tự động hóa `python -B serverless/launch-contract/deployment/deploy.py` để đóng gói source code, tích hợp `network_runtime.py` và cập nhật cấu hình biến môi trường trên Lambda.
     - **Bước 5 — Định nghĩa, nạp ASL và kích hoạt Step Functions**: Đăng ký 3 State Machines (`LaunchInstance.asl.json`, `TerminateInstance.asl.json`, `LifecycleInstance.asl.json`) với Step Functions và liên kết IAM Role.
4. **Giải pháp Sao lưu & Tự động hóa Phục hồi Thảm họa cho Serverless & Data (`backup/`)**:
   - Trình bày cách phân hệ `backup/` bảo vệ và tái tạo 6 dịch vụ trên:
     - **Xuất Snapshot**: Cách chạy `python -B backup/export_sydney.py` để trích xuất snapshot toàn bộ Lambda, Step Functions, DynamoDB, EventBridge, API Gateway và IAM.
     - **Tổng hợp CloudFormation Template**: Cách chạy `python -B backup/build_restore_template.py <snapshot-dir>` để tự động tổng hợp ra file mẫu khôi phục `restore/template.json` và `restore/private-parameters.json`.
     - **Kiểm định Snapshot**: Cách chạy `python -B backup/validate_snapshot.py <snapshot-dir> --fetch-schemas` để xác thực toàn vẹn checksum SHA-256 và schema AWS.
     - **Diễn tập Triển khai Khôi phục (DR Dry-Run & Apply)**: Cách dùng `python -B backup/deploy.py <snapshot-dir> --artifact-bucket <bucket>` để xem trước kế hoạch khôi phục hoặc triển khai tái lập toàn bộ hạ tầng Serverless & Data qua CloudFormation.

### Phần 2: Thí nghiệm, Kiểm thử và Đánh giá Hiệu năng Serverless & Data
1. **Thiết lập môi trường & Danh mục kịch bản kiểm thử chuyên sâu**:
   - Danh mục kịch bản kiểm thử Pytest Serverless trong `tests/serverless/`:
     - Khởi tạo máy ảo & Rollback: `test_launch_contract.py`, `test_launch_rollback.py`.
     - Vòng đời máy ảo & Tự phục hồi: `test_lifecycle.py`, `test_recovery_worker.py`, `test_recovery_policy.py`.
     - An ninh mạng & Nhóm bảo mật: `test_sg_sync.py`, `test_nat_v1.py`, `test_network.py`.
     - Lưu trữ đĩa & Pool quản lý: `test_ebs_backend.py`, `test_ebs_cutover.py`.
   - Danh mục kịch bản kiểm thử End-to-End API Gateway Playwright trong `tests/e2e/tests/xregion-api-gateway.spec.js`.
2. **Kết quả thực nghiệm & Số liệu đo lường thực chứng**:
   - Trích xuất bảng số liệu thực tế từ nhật ký kiểm chứng `docs/risk-review/verification-log.md`:
     - Thời gian thực thi từng bước trong Step Functions State Machine (thời gian cấp volume Cinder, thời gian chờ boot Nova, thời gian gán EIP/SG và thời gian đồng bộ DynamoDB).
     - Độ trễ phản hồi của API Gateway và thời gian khởi động (Cold start vs Warm start) của các hàm Lambda.
     - Hiệu năng cơ chế khóa nguyên tử DynamoDB (`migration_lock` và `revision` condition expression): minh chứng ngăn ngừa triệt để hiện tượng ghi đè dữ liệu hoặc xung đột trạng thái (Zero Race Conditions / Split-Brain) trong các thử nghiệm đồng thời.
   - Phân tích ý nghĩa kỹ thuật của từng nhóm thông số.
3. **Đánh giá kết quả, hạn chế và hướng phát triển**:
   - **Ưu điểm đạt được**: Tính bất đồng bộ cao, khả năng co giãn tự động không cần máy chủ, kiến trúc bảo mật phân tầng chặt chẽ và dữ liệu nhất quán cao.
   - **Hạn chế & Rủi ro còn tồn tại**: Trích dẫn trung thực từ `docs/risk-review/current-version-risks.md` (ví dụ: giới hạn hạn ngạch đồng thời của Lambda, thời gian chờ Step Functions execution, độ trễ cold-start khi Lambda gắn VPC).
   - **Đề xuất giải pháp cải tiến**: Nâng cấp DynamoDB Global Tables đa vùng (Active-Active Replication), áp dụng Lambda Provisioned Concurrency / SnapStart, và mở rộng Step Functions Distributed Map cho các tác vụ xử lý hàng loạt.

---

## 4. Quy trình Nghiệm thu Báo cáo (Verification Checklist)

Trước khi kết thúc tác vụ viết báo cáo:
1. **Xác nhận tính xác thực 100%**:
   - Mọi tên hàm Lambda, ARN Step Functions, ID API Gateway, EventBridge Rule, tên bảng DynamoDB và IAM Role đều khớp chính xác với codebase `serverless/` và kết quả truy vấn `--profile xregion`.
   - Phân hệ `backup/` được mô tả đúng bản chất là giải pháp Disaster Recovery & CloudFormation Synthesizer bảo vệ chính 6 dịch vụ trên.
2. **Kiểm tra an toàn bảo mật (Zero-Secret Leakage)**:
   - Rà soát toàn bộ file báo cáo vừa tạo để đảm bảo không lọt bất kỳ giá trị nào từ file `.env` thật, IAM Secret Keys hay SigV4 signing secrets; tất cả thông tin nhạy cảm đã được chuyển thành `<REDACTED>`.
3. **Kiểm tra nguyên trạng mã nguồn (Zero Workspace Pollution)**:
   - Chạy `git status --short` để xác nhận **không có file mã nguồn hay cấu hình nào bị sửa (`M`) hay xóa (`D`) ngoài ý muốn**, chỉ có file tài liệu báo cáo mới được thêm trong `docs/` và file tài liệu skill `docs-writer/SKILL_doc.md`.
