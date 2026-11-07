# XRegion - Nền Tảng Hybrid Cloud & Cross-Region Disaster Recovery / Live Migration Control Plane

[![Spring Boot 3.2](https://img.shields.io/badge/Spring%20Boot-3.2.0-brightgreen.svg?logo=springboot)](https://spring.io/projects/spring-boot)
[![Java 17](https://img.shields.io/badge/Java-17%2B-orange.svg?logo=openjdk)](https://openjdk.org/)
[![AWS SDK v2](https://img.shields.io/badge/AWS%20SDK-v2.25%2B-232F3E.svg?logo=amazon-aws)](https://aws.amazon.com/sdk-for-java/)
[![Amazon DynamoDB](https://img.shields.io/badge/Amazon-DynamoDB-4053D6.svg?logo=amazondynamodb)](https://aws.amazon.com/dynamodb/)
[![Amazon EventBridge](https://img.shields.io/badge/Amazon-EventBridge-FF4F8B.svg?logo=amazoneventbridge)](https://aws.amazon.com/eventbridge/)
[![AWS Step Functions](https://img.shields.io/badge/AWS-Step%20Functions-FF9900.svg?logo=awslambda)](https://aws.amazon.com/step-functions/)
[![OpenStack](https://img.shields.io/badge/OpenStack-Caracal%20%2F%20Bobcat-ED1944.svg?logo=openstack)](https://www.openstack.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker)](https://www.docker.com/)

> **XRegion** là giải pháp điều khiển và quản trị hạ tầng điện toán đám mây lai (**Hybrid Cloud**) và chuyển vùng thảm họa (**Disaster Recovery / Live Migration**) quy mô doanh nghiệp. Hệ thống kết nối liền mạch giữa môi trường **Private Cloud OpenStack** (chạy trên EC2 node `i-056d7f3dd24156234`) và **AWS Public Cloud** (`ap-southeast-2` Sydney), vận hành dựa trên kiến trúc **Event-Driven Serverless** và cơ chế đồng bộ trạng thái hai chiều theo thời gian thực.

---

## 📑 Mục Lục
1. [Tổng Quan Hệ Thống](#-1-t%E1%BB%95ng-quan-h%E1%BB%87-th%E1%BB%91ng)
2. [Kiến Trúc Tổng Thể (System Architecture)](#-2-ki%E1%BA%BFn-tr%C3%BAc-t%E1%BB%95ng-th%E1%BB%83-system-architecture)
3. [Mô Hình Dữ Liệu DynamoDB (Data Model & ERD)](#-3-m%C3%B4-h%C3%ACnh-d%E1%BB%AF-li%E1%BB%87u-dynamodb-data-model--erd)
4. [Tầng Tự Động Hóa & Serverless (Automation Layer)](#-4-t%E1%BA%A7ng-t%E1%BB%B1-%C4%91%E1%BB%99ng-h%C3%B3a--serverless-automation-layer)
5. [Quy Trình & Luồng Hoạt Động (Workflows & Pipelines)](#-5-quy-tr%C3%ACnh--lu%E1%BB%93ng-ho%E1%BA%A1t-%C4%91%E1%BB%99ng-workflows--pipelines)
   - [5.1 Khởi tạo máy ảo Boot-from-Volume](#51-kh%E1%BB%9Fi-t%E1%BA%A1o-m%C3%A1y-%E1%BA%A3o-boot-from-volume)
   - [5.2 Pipeline 6 Bước Chuyển Vùng Xuyên Vùng (Fast Live Migration)](#52-pipeline-6-b%C6%B0%E1%BB%9Bc-chuy%E1%BB%83n-v%C3%B9ng-xuy%C3%AAn-v%C3%B9ng-fast-live-migration)
   - [5.3 Cơ chế Khóa nguyên tử (Atomic Conditional Lock & Cooldown)](#53-c%C6%A1-ch%E1%BA%BF-kh%C3%B3a-nguy%C3%AAn-t%E1%BB%AD-atomic-conditional-lock--cooldown)
6. [Danh Mục REST API Tham Chiếu](#-6-danh-m%E1%BB%A5c-rest-api-tham-chi%E1%BA%BFu)
7. [Cấu Hình & Biến Môi Trường (.env)](#-7-c%E1%BA%A5u-h%C3%ACnh--bi%E1%BA%BFn-m%C3%B4i-tr%C6%B0%E1%BB%9Dng-env)
8. [Hướng Dẫn Khởi Chạy & Vận Hành](#-8-h%C6%B0%E1%BB%9Bng-d%E1%BA%ABn-kh%E1%BB%9Fi-ch%E1%BA%A1y--v%E1%BA%ADn-h%C3%A0nh)
9. [Cấu Trúc Thư Mục Dự Án](#-9-c%E1%BA%A5u-tr%C3%BAc-th%C6%B0-m%E1%BB%A5c-d%E1%BB%B1-%C3%A1n)

---

## 📌 1. Tổng Quan Hệ Thống

Hệ thống **XRegion** giải quyết bài toán tính sẵn sàng cao (**High Availability**), chống thảm họa phân tán (**Disaster Recovery**), và tối ưu hóa chi phí vận hành bằng cách cho phép quản trị viên:
- **Tập trung hóa quyền điều khiển (Unified Control Plane)**: Điều phối vòng đời máy ảo OpenStack Nova và AWS EC2 trên một bảng điều khiển duy nhất.
- **Di trú trực tiếp xuyên vùng (Cross-Region Live Migration)**: Chuyển dịch máy ảo và dữ liệu EBS giữa hạ tầng Private Cloud (Sydney OpenStack) và AWS Cloud dự phòng với thời gian downtime (RTO) được kiểm soát tối thiểu.
- **Đồng bộ hóa trạng thái hai chiều (Bi-directional State Sync)**: Tự động ghi nhận mọi biến động từ mạng Neutron, máy ảo Nova, SSH Keypair và Security Group về Amazon DynamoDB thông qua EventBridge bus.
- **Tự động hóa định tuyến DNS**: Cập nhật bản ghi DNS Route 53 tức thời khi máy ảo hoán đổi địa chỉ Elastic IP / Public IP.

---

## 🏗️ 2. Kiến Trúc Tổng Thể (System Architecture)

Hệ thống được thiết kế theo mô hình **Phân tán - Hướng sự kiện (Event-Driven Hybrid Cloud)** gồm 4 phân lớp chính:
1. **Control Plane Backend & Dashboard**: Ứng dụng Spring Boot 3.2 cung cấp giao diện quản trị Single Page Application (SPA), tích hợp Spring Security JWT và AWS SDK v2 Enhanced Client.
2. **Serverless Orchestration & Event Ingestion**: API Gateway `XRegion-EventGateway` kết hợp Amazon EventBridge và AWS Step Functions điều phối tác vụ hạ tầng bất đồng bộ.
3. **Storage & Data Plane**: 6 bảng Amazon DynamoDB tối ưu hóa theo mô hình NoSQL Single-Table & Multi-Entity.
4. **OpenStack Private Cloud Node**: Máy chủ EC2 `i-056d7f3dd24156234` chạy OpenStack Services cùng daemon `nova-event-forwarder.service`.

```mermaid
graph TB
    subgraph UI_Layer ["🖥️ Lớp Giao Diện Quản Trị (Dashboard SPA)"]
        Browser["Trình duyệt Quản trị viên<br/>(TailwindCSS, Chart.js, VNC Console)"]
    end

    subgraph Backend_Layer ["☕ Lớp Control Plane Backend (Spring Boot 3.2)"]
        Security["Spring Security 6 (JWT & API Tokens)"]
        Controllers["REST Controllers (Instances, Migration, Network, Keys, Volumes)"]
        Services["Core Services (InstanceService, MigrationService, NetworkService)"]
        DynClient["AWS SDK v2 DynamoDbEnhancedClient"]
        EBGwClient["EventBridgeGatewayClient (IAM SigV4 / Bearer Token)"]
        
        Browser <-->|HTTPS / REST API| Controllers
        Controllers --> Security
        Controllers --> Services
        Services --> DynClient
        Services --> EBGwClient
    end

    subgraph Serverless_Layer ["⚡ Lớp Tự Động Hóa & Serverless (AWS ap-southeast-2)"]
        ApiGw["API Gateway: XRegion-EventGateway<br/>(Stage: prod, Edge-Optimized, Tracing)"]
        EventBridge["Amazon EventBridge Bus: default"]
        
        EBGwClient -->|POST /prod/events| ApiGw
        ApiGw -->|PutEvents| EventBridge

        subgraph EventBridge_Rules ["EventBridge Rules"]
            BackendRule["XRegion-BackendEventRule<br/>(Lọc sự kiện từ Backend)"]
            NovaRule["XRegion-NovaStatusRule<br/>(Lọc sự kiện từ OpenStack)"]
        end

        EventBridge --> BackendRule
        EventBridge --> NovaRule

        subgraph Step_Functions ["Step Functions State Machine"]
            SFN["OpenStack-NovaVM-EBS-Provisioner<br/>(Tạo EBS -> Gắn Volume -> Boot Nova VM)"]
        end

        BackendRule --> SFN

        subgraph Lambda_Workers ["AWS Lambda Functions Execution"]
            L1["XRegion-NovaLifecycleManager<br/>(Start / Stop / Reboot / Terminate)"]
            L2["XRegion-KeySyncManager<br/>(Import SSH Key vào Nova / EC2)"]
            L3["XRegion-SecurityGroupManager<br/>(Đồng bộ Neutron Security Groups)"]
            L4["XRegion-SyncNovaToDynamoDB<br/>(Cập nhật State vào DDB)"]
            L5["XRegion-SyncKeyToDynamoDB<br/>(Đồng bộ Key vào DDB)"]
            L6["XRegion-SyncSGToDynamoDB<br/>(Đồng bộ Security Group vào DDB)"]
            L7["XRegion-AutoAssignEIP<br/>(Tự động cấp Elastic IP)"]
        end

        BackendRule --> L1
        BackendRule --> L2
        BackendRule --> L3
        NovaRule --> L4
        NovaRule --> L5
        NovaRule --> L6
        NovaRule --> L7
    end

    subgraph Data_Layer ["🗄️ CSDL Amazon DynamoDB (AWS ap-southeast-2)"]
        T_Inst[("XRegion-Instances<br/>PK: instance_id")]
        T_User[("XRegion-Users<br/>PK: user_id | GSI: username")]
        T_Key[("XRegion-Keys<br/>PK: key_id")]
        T_SG[("XRegion-SecurityGroups<br/>PK: group_id")]
        T_Vol[("XRegion-Volumes<br/>PK: volume_id")]
        T_Mig[("XRegion-Migrations<br/>PK: instance_id | SK: migration_id")]

        DynClient <-->|CRUD & Conditional Lock| T_Inst
        DynClient <-->|Auth & Keys| T_User
        DynClient <-->|Keys| T_Key
        DynClient <-->|Rules| T_SG
        DynClient <-->|Volumes| T_Vol
        DynClient <-->|Pipeline State| T_Mig

        L4 -->|Ghi trạng thái thực| T_Inst
        L5 -->|Ghi SSH Keys| T_Key
        L6 -->|Ghi SG Rules| T_SG
        L7 -->|Ghi Elastic IP| T_Inst
    end

    subgraph OpenStack_Node ["☁️ OpenStack Node (EC2 i-056d7f3dd24156234)"]
        ForwarderDaemon["nova-event-forwarder.service<br/>(Python OpenStack SDK Daemon)"]
        Nova["OpenStack Nova Compute"]
        Neutron["OpenStack Neutron Networking"]
        Cinder["OpenStack Cinder / EBS Volume Attachment"]

        L1 -->|Nova API / SSH| Nova
        SFN -->|Boot from Volume| Nova
        SFN -->|Attach EBS Volume| Cinder
        L3 -->|Neutron API| Neutron
        Nova --> ForwarderDaemon
        Neutron --> ForwarderDaemon
        ForwarderDaemon -->|POST /prod/events| ApiGw
    end
```

---

## 🗄️ 3. Mô Hình Dữ Liệu DynamoDB (Data Model & ERD)

Toàn bộ thông tin cấu hình, trạng thái thời gian thực và lịch sử chuyển vùng được lưu trữ trên **6 bảng DynamoDB chuyên biệt**, tối ưu hóa truy vấn thông qua Partition Key, Sort Key và Global Secondary Index (GSI):

### 3.1 Chi Tiết Các Bảng Dữ Liệu

| Tên Bảng DynamoDB | Khóa Chính (PK / SK) | Chỉ Mục Phụ (GSI) | Các Trường Thuộc Tính Chính | Chức Năng Kỹ Thuật |
| :--- | :--- | :--- | :--- | :--- |
| **`XRegion-Instances`** | **PK**: `instance_id` (String) | `username-index`<br>(PK: `username`) | `instance_name`, `user_id`, `key_id`, `volume_id`, `security_group_id`, `current_region`, `current_status`, `flavor`, `private_ip`, `elastic_ip`, `migration_lock`, `dns` | Lưu trữ metadata và trạng thái thực của toàn bộ máy ảo. Hỗ trợ khóa nguyên tử `migration_lock` chống xung đột. |
| **`XRegion-Users`** | **PK**: `user_id` (String) | `username-index`<br>(PK: `username`) | `username`, `password` (BCrypt), `full_name`, `role`, `active`, `created_at`, `api_tokens` (List), `ssh_keys` (List) | Quản lý người dùng, phân quyền Role, cấp phát API Token Bearer và danh bạ SSH Keypair của cá nhân. |
| **`XRegion-Keys`** | **PK**: `key_id` (String) | - | `key_name`, `key_type`, `public_key`, `fingerprint`, `target_regions`, `created_by`, `created_at` | Lưu public key và đồng bộ với OpenStack Nova Keypair và AWS EC2 Key Pairs. |
| **`XRegion-SecurityGroups`**| **PK**: `group_id` (String) | - | `group_name`, `description`, `inbound_rules` (List Map), `outbound_rules` (List Map), `created_by` | Lưu bộ quy tắc tường lửa mạng (Ports 22, 80, 443, CIDR Blocks), đồng bộ với OpenStack Neutron Security Group. |
| **`XRegion-Volumes`** | **PK**: `volume_id` (String) | `instance-index`<br>(PK: `instance_id`) | `volume_name`, `size_gb`, `volume_type` (gp3), `status`, `attached_instance_id`, `device`, `snapshot_id`, `region` | Quản lý EBS volumes đính kèm máy ảo, trạng thái tháo rời và snapshot sao chép liên vùng. |
| **`XRegion-Migrations`** | **PK**: `instance_id` (String)<br>**SK**: `migration_id` (String) | - | `source_region`, `dest_region`, `status`, `copy_progress` (0-100), `started_at`, `completed_at`, `downtime_seconds` (RTO), `step_logs` (List), `error_message` | Theo dõi 6 bước chuyển vùng Live Migration, copyProgress, RTO downtime, step logs phục vụ kiểm toán. |

### 3.2 Sơ Đồ Thực Thể - Quan Hệ (ERD Diagram)

```mermaid
erDiagram
    XREGION_USERS ||--o{ XREGION_INSTANCES : "owns / provisions"
    XREGION_USERS ||--o{ XREGION_KEYS : "generates & imports"
    XREGION_USERS ||--o{ XREGION_SECURITY_GROUPS : "configures"
    
    XREGION_KEYS ||--o{ XREGION_INSTANCES : "injected into (key_id)"
    XREGION_SECURITY_GROUPS ||--o{ XREGION_INSTANCES : "protects (security_group_id)"
    XREGION_VOLUMES ||--o{ XREGION_INSTANCES : "attached as root/data (volume_id)"
    
    XREGION_INSTANCES ||--o{ XREGION_MIGRATIONS : "has migration history (instance_id)"

    XREGION_USERS {
        string user_id PK
        string username "GSI: username-index"
        string password "BCrypt Hash"
        string full_name
        string role "ADMIN / USER"
        boolean active
        long created_at
        list api_tokens "Name, TokenHash, Expiry"
        list ssh_keys "KeyName, Fingerprint"
    }

    XREGION_INSTANCES {
        string instance_id PK
        string username "GSI: username-index"
        string user_id FK
        string key_id FK
        string volume_id FK
        string security_group_id FK
        string instance_name
        string current_region "ap-southeast-2 / openstack"
        string current_status "PENDING / ACTIVE / SHUTOFF / MIGRATING"
        string flavor "m1.small / m1.medium / c5.large"
        string private_ip
        string elastic_ip
        boolean migration_lock "Atomic Concurrency Guard"
        string dns "Route 53 A-Record"
    }

    XREGION_KEYS {
        string key_id PK
        string key_name
        string key_type "RSA-2048 / ED25519"
        string public_key "OpenSSH Format"
        string fingerprint "SHA256"
        list target_regions
        string created_by
    }

    XREGION_SECURITY_GROUPS {
        string group_id PK
        string group_name
        string description
        list inbound_rules "Port, Protocol, Source CIDR"
        list outbound_rules "Port, Protocol, Dest CIDR"
        string created_by
    }

    XREGION_VOLUMES {
        string volume_id PK
        string attached_instance_id FK "GSI: instance-index"
        string volume_name
        int size_gb
        string volume_type "gp3"
        string status "AVAILABLE / IN_USE"
        string snapshot_id
        string region
    }

    XREGION_MIGRATIONS {
        string instance_id PK
        string migration_id SK
        string source_region
        string dest_region
        string status "TRIGGERED / IN_PROGRESS / COMPLETED / FAILED"
        int copy_progress "0 to 100 %"
        long started_at
        long completed_at
        long downtime_seconds "RTO Recovery Time"
        list step_logs "Timestamped execution trace"
        string error_message
    }
```

---

## ⚙️ 4. Tầng Tự Động Hóa & Serverless (Automation Layer)

Hệ thống ứng dụng kiến trúc **Serverless Event-Driven** nhằm đảm bảo tính phi trạng thái (stateless), mở rộng linh hoạt và độc lập giữa lớp Web Control Plane và lớp thực thi hạ tầng.

### 4.1 AWS API Gateway: `XRegion-EventGateway`
- **Giao thức & Endpoint**: `POST https://oqp7jmg7je.execute-api.ap-southeast-2.amazonaws.com/prod/events`
- **Loại hình triển khai**: **EDGE-Optimized** (tối ưu tốc độ qua mạng lưới toàn cầu CloudFront Edge).
- **Cơ chế xác thực kép (Dual-Mode Authentication)**:
  1. **Bearer Token Authorizer**: Kiểm tra mã API Token theo chuẩn `xreg_<base64_username>_<secret>` được sinh từ Dashboard và đối soát trực tiếp trong bảng `XRegion-Users`.
  2. **AWS IAM SigV4**: Sử dụng IAM Credentials ký số cho các giao dịch nội bộ từ Backend hoặc dịch vụ tự động hóa.
- **Giám sát**: Bật **CloudWatch Logs INFO & Data Tracing**, tự động lưu vết toàn bộ payload request/response và **Detailed Metrics** phục vụ kiểm toán.

### 4.2 Amazon EventBridge & Quy Tắc Định Tuyến (Rules)
- **Bus**: `default`
- **Rule 1: `XRegion-BackendEventRule`**: Lắng nghe mọi yêu cầu phát ra từ Backend Spring Boot:
  - Source: `xregion.backend.instance`, `xregion.backend.key`, `xregion.backend.security`, `xregion.backend.migration`
  - Đích đến: AWS Step Functions và các AWS Lambda Workers tương ứng (`XRegion-NovaLifecycleManager`, `XRegion-KeySyncManager`, `XRegion-SecurityGroupManager`).
- **Rule 2: `XRegion-NovaStatusRule`**: Lắng nghe sự kiện giám sát từ hạ tầng OpenStack:
  - Source: `xregion.openstack.nova`, `xregion.openstack.neutron`
  - Đích đến: Các Lambda Function đồng bộ dữ liệu vào DynamoDB (`XRegion-SyncNovaToDynamoDB`, `XRegion-SyncKeyToDynamoDB`, `XRegion-SyncSGToDynamoDB`, `XRegion-AutoAssignEIP`).

### 4.3 Bộ Máy AWS Step Functions: `OpenStack-NovaVM-EBS-Provisioner`
Điều phối chuỗi tác vụ phức tạp khi khởi tạo máy ảo theo quy chuẩn **Boot-from-Volume**:
1. `CreateEBSVolume`: Cấp phát volume `gp3` tại AWS hoặc Cinder volume tương thích.
2. `WaitForVolumeAvailable`: Polling trạng thái volume đạt mức `available`.
3. `AttachVolumeToNova`: Đính kèm volume vào máy ảo mục tiêu trên OpenStack.
4. `BootNovaVM`: Kích hoạt máy ảo từ boot volume đính kèm.

### 4.4 Danh Mục AWS Lambda Functions

| Tên Lambda Function | Vai Trò & Nghiệp Vụ Xử Lý |
| :--- | :--- |
| **`XRegion-NovaLifecycleManager`** | Điều khiển Start/Stop/Reboot/Terminate VM trên OpenStack Nova. |
| **`XRegion-KeySyncManager`** | Nhập và đồng bộ SSH key vào Nova Keypair trên OpenStack Node và AWS EC2. |
| **`XRegion-SecurityGroupManager`** | Tạo và cấu hình Security Group, nạp Inbound/Outbound Rules trong OpenStack Neutron. |
| **`XRegion-SyncNovaToDynamoDB`** | Đồng bộ trạng thái VM thực tế (`ACTIVE`, `SHUTOFF`) từ OpenStack daemon sang DynamoDB `XRegion-Instances`. |
| **`XRegion-SyncKeyToDynamoDB`** | Đồng bộ SSH key từ OpenStack daemon sang DynamoDB `XRegion-Keys`. |
| **`XRegion-SyncSGToDynamoDB`** | Đồng bộ Security Group từ OpenStack daemon sang DynamoDB `XRegion-SecurityGroups`. |
| **`XRegion-AutoAssignEIP`** | Tự động phát hiện khi máy ảo chuyển sang trạng thái `ACTIVE` để cấp phát và gán Public IP / Elastic IP. |

### 4.5 OpenStack Daemon: `nova-event-forwarder.service`
- Chạy nền dưới dạng `systemd daemon` trên máy chủ EC2 `i-056d7f3dd24156234`.
- Sử dụng **Python OpenStack SDK**, hook vào message queue nội bộ (RabbitMQ) của OpenStack để theo dõi sự kiện biến động của Nova Compute và Neutron Networking.
- Ngay khi có sự kiện (e.g. máy ảo khởi động xong, IP được gán, VM tắt), daemon tự động đóng gói payload và gọi `POST` tới API Gateway `XRegion-EventGateway` đẩy vào EventBridge.

---

## 🔄 5. Quy Trình & Luồng Hoạt Động (Workflows & Pipelines)

### 5.1 Khởi tạo máy ảo Boot-from-Volume

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Quản trị viên
    participant UI as Dashboard SPA
    participant Backend as Spring Boot Backend
    participant DDB as DynamoDB (XRegion-Instances)
    participant APIGW as API Gateway (XRegion-EventGateway)
    participant EB as EventBridge (default bus)
    participant SFN as Step Functions (NovaVM-EBS-Provisioner)
    participant Node as OpenStack Node (EC2 i-056d7f3dd24156234)
    participant Daemon as nova-event-forwarder
    participant L_Sync as Lambda (SyncNovaToDynamoDB)
    participant L_EIP as Lambda (AutoAssignEIP)

    Admin->>UI: Điền cấu hình (Flavor, SizeGb, Key, SG) & Launch
    UI->>Backend: POST /api/instances
    Backend->>DDB: Lưu bản ghi Instance mới (current_status = PENDING)
    Backend->>APIGW: POST /prod/events (source: xregion.backend.instance, action: instance.launch)
    APIGW->>EB: PutEvents (EventBridge Bus)
    EB->>SFN: Route qua rule XRegion-BackendEventRule
    SFN->>Node: 1. Tạo EBS/Cinder gp3 -> 2. Attach -> 3. Boot Nova VM
    Note over Node: Máy ảo boot thành công, chuyển sang ACTIVE
    Node->>Daemon: RabbitMQ Notification (compute.instance.create.end)
    Daemon->>APIGW: Ingest sự kiện VM ACTIVE (source: xregion.openstack.nova)
    APIGW->>EB: PutEvents
    EB->>L_Sync: Route qua rule XRegion-NovaStatusRule
    EB->>L_EIP: Route qua rule XRegion-NovaStatusRule
    L_Sync->>DDB: Cập nhật current_status = ACTIVE, private_ip
    L_EIP->>DDB: Cấp phát & gán elastic_ip công khai
    UI->>Backend: Polling GET /api/instances
    Backend->>UI: Trả về trạng thái ACTIVE & Elastic IP
    UI->>Admin: Hiển thị máy ảo sẵn sàng & Mở nút Web Console VNC
```

---

### 5.2 Pipeline 6 Bước Chuyển Vùng Xuyên Vùng (Fast Live Migration)

Quy trình Live Migration chuyển đổi máy ảo giữa Private Cloud và AWS Cloud được thực thi tự động qua 6 bước khép kín với khả năng giám sát tiến độ thời gian thực (0% - 100%) và đo lường thời gian gián đoạn dịch vụ (**RTO**):

```mermaid
flowchart TD
    Start([Kích hoạt Chuyển Vùng X-Region]) --> Step1[Bước 1: Stop Source VM & Flush Cache]
    Step1 -->|Bật khóa nguyên tử migration_lock = true| Step2[Bước 2: Create EBS Snapshot gp3]
    Step2 -->|Snapshot hoàn tất - Tiến độ 40%| Step3[Bước 3: Cross-Region Snapshot Transfer]
    Step3 -->|Sao chép hoàn tất - Tiến độ 65%| Step4[Bước 4: Provision Target EBS Volume]
    Step4 -->|Volume sẵn sàng - Tiến độ 80%| Step5[Bước 5: Boot NovaVM in Target Region]
    Step5 -->|Target VM ACTIVE - Tiến độ 90%| Step6[Bước 6: Route 53 DNS Switchover]
    Step6 --> Success([Hoàn tất Di Trú: Đo RTO, Giải phóng Lock & Bắt đầu Cooldown])

    Step1 -.->|Lỗi| Rollback[Cơ chế Auto-Rollback: Mở lại Source VM, Giải phóng Lock]
    Step2 -.->|Lỗi| Rollback
    Step3 -.->|Lỗi| Rollback
    Step4 -.->|Lỗi| Rollback
    Step5 -.->|Lỗi| Rollback
    Step6 -.->|Lỗi| Rollback
```

#### Chi tiết 6 bước thực thi trong `MigrationService`:
1. **Bước 1 (`STOP_SOURCE_VM`)**: Đồng bộ bộ nhớ đệm (Flush Cache) và dừng máy ảo nguồn an toàn (`SHUTOFF`). Bật cờ `migration_lock = true` trên DynamoDB. Ghi nhận `sourceStoppedMs` bắt đầu bấm giờ đo lường **Downtime RTO**. Tiến độ: 20%.
2. **Bước 2 (`CREATE_EBS_SNAPSHOT`)**: Chụp ảnh tức thời (Snapshot) của EBS Volume `gp3` đang gắn với máy ảo nguồn nhằm đảm bảo toàn vẹn dữ liệu khối tại thời điểm dừng. Tiến độ: 40%.
3. **Bước 3 (`COPY_SNAPSHOT_CROSS_REGION`)**: Truyền tải dữ liệu snapshot xuyên vùng giữa AWS Region (`ap-southeast-2`) và OpenStack Storage. Tiến độ: 65%.
4. **Bước 4 (`CREATE_TARGET_VOLUME`)**: Khởi tạo EBS Volume mới tại vùng đích từ snapshot vừa được đồng bộ, thiết lập thông số IOPS và Throughput gp3 tối ưu. Tiến độ: 80%.
5. **Bước 5 (`BOOT_TARGET_VM`)**: Khởi tạo máy ảo mới tại vùng đích từ boot volume, cấp dải Private IP và Elastic IP mới, đồng bộ SSH Keypair và Security Group. Tiến độ: 90%.
6. **Bước 6 (`ROUTE53_DNS_CUTOVER`)**: Tự động chuyển đổi bản ghi DNS A-Record trên AWS Route 53 trỏ về Elastic IP mới của máy ảo tại vùng đích (TTL 60s). Dừng đồng hồ đo Downtime, lưu trữ chỉ số **RTO** (giây), giải phóng `migration_lock = false`, chuyển trạng thái `ACTIVE` và kích hoạt thời gian bảo vệ **Cooldown Timer** (300 giây chống di chuyển liên tục). Tiến độ: 100%.

---

### 5.3 Cơ chế Khóa nguyên tử (Atomic Conditional Lock & Cooldown)

Để chống lại tình trạng xung đột dữ liệu (**Race Conditions**) khi có nhiều yêu cầu di trú gửi tới cùng lúc hoặc thao tác sai khi máy ảo đang chuyển tiếp, hệ thống áp dụng cơ chế **DynamoDB Conditional Writes**:

```java
// Logic kiểm tra trạng thái chuyển tiếp và chiếm khóa nguyên tử tại MigrationService.java
if (TRANSITIONAL_STATES.contains(instance.getCurrentStatus())) {
    throw new ConflictException("Máy ảo [" + instanceId + "] đang ở trạng thái chuyển tiếp (" 
        + instance.getCurrentStatus() + "). Vui lòng đợi tiến trình hoàn tất.");
}

instance.setMigrationLock(true);
instance.setCurrentStatus("MIGRATING");

UpdateItemEnhancedRequest<InstanceEntity> lockReq = UpdateItemEnhancedRequest.builder(InstanceEntity.class)
        .item(instance)
        .conditionExpression(Expression.builder()
                .expression("attribute_exists(instance_id) AND (migration_lock = :unlocked OR attribute_not_exists(migration_lock))")
                .putExpressionValue(":unlocked", AttributeValue.fromBool(false))
                .build())
        .build();

instancesTable.updateItem(lockReq);
```

👉 **Kết quả**: Bất kỳ yêu cầu di trú nào vi phạm (máy ảo đang ở trạng thái `PENDING`, `STOPPING`, `SHUTTING_DOWN`, `TERMINATING`, `REBOOTING` hoặc `migration_lock == true`) sẽ bị từ chối ngay lập tức với mã lỗi **`HTTP 409 Conflict`**.

---

## 📡 6. Danh Mục REST API Tham Chiếu

Tất cả các API yêu cầu gắn Header: `Authorization: Bearer <JWT_TOKEN_HOAC_API_TOKEN>`.

### 6.1 Nhóm Xác Thực & Tài Khoản (Authentication & Token)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Đăng nhập hệ thống, nhận JWT Token | `{"username": "admin", "password": "..."}` |
| `POST` | `/api/auth/register` | Đăng ký tài khoản người dùng mới | `{"username": "...", "password": "...", "fullName": "..."}` |
| `GET` | `/api/auth/me` | Lấy thông tin hồ sơ tài khoản hiện tại | Trả về username, fullName, role, active, createdAt |
| `GET` | `/api/auth/tokens` | Lấy danh sách API Tokens của user | Trả về danh sách token và ngày hết hạn |
| `POST` | `/api/auth/tokens` | Tạo API Token dài hạn mới | `{"name": "CI/CD Token", "validDays": 30}` |
| `DELETE`| `/api/auth/tokens/{id}` | Thu hồi (Revoke) API Token | Xóa token khỏi bảng `XRegion-Users` |
| `POST` | `/api/auth/change-password`| Đổi mật khẩu tài khoản | `{"oldPassword": "...", "newPassword": "..."}` |
| `GET` | `/api/auth/health` | Kiểm tra trạng thái service và giờ UTC+7 | Trả về trạng thái `UP`, timestamp và múi giờ Việt Nam |

### 6.2 Nhóm Quản Trị Máy Ảo (Compute - NovaVM)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/instances` | Lấy danh sách toàn bộ máy ảo | Trả về mảng `InstanceResponse` kèm trạng thái thực và Lock |
| `GET` | `/api/instances/{id}` | Lấy chi tiết thông tin một máy ảo | Trả về IP, Volume, Key, Security Group, Lock |
| `POST` | `/api/instances` | Khởi tạo máy ảo mới (Launch Instance) | `{"name": "web-01", "flavor": "m1.medium", "image": "ubuntu-22.04", "sizeGb": 20, "keyName": "...", "securityGroup": "..."}` |
| `PUT` | `/api/instances/{id}` | Cập nhật thông tin cấu hình máy ảo | `{"instanceName": "...", "securityGroupId": "...", "flavor": "..."}` |
| `POST` | `/api/instances/{id}/actions` | Điều khiển vòng đời máy ảo | `{"action": "START" \| "STOP" \| "REBOOT" \| "TERMINATE"}` |

### 6.3 Nhóm Chuyển Vùng Thảm Họa (Cross-Region Migration)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/migrations/trigger` | **Kích hoạt quy trình chuyển vùng 6 bước** | `{"id": "i-056d7f3dd24156234"}` (Bảo vệ bằng Atomic Lock) |
| `GET` | `/api/migrations/progress/{id}` | Polling tiến trình di trú thời gian thực | Trả về step hiện tại, `copyProgress` (0-100%), log stream |
| `GET` | `/api/migrations/history/{id}` | Lấy lịch sử di trú của một máy ảo | Danh sách các lần chuyển vùng, thời gian RTO, trạng thái |
| `GET` | `/api/migrations/scenarios` | Lấy danh sách kịch bản chuyển vùng | Kịch bản định kỳ hoặc tự động theo tải |
| `POST` | `/api/migrations/scenarios` | Tạo kịch bản chuyển vùng mới | `{"name": "Auto-Sydney-OpenStack", "targetInstanceId": "...", "sourceRegion": "ap-southeast-2", "destRegion": "openstack"}` |
| `GET` | `/api/migrations/summary` | Báo cáo tóm tắt chỉ số chuyển vùng | Tổng số lần di trú, tỷ lệ thành công, RTO trung bình |

### 6.4 Nhóm Mạng, Security Groups & DNS (Network & Security)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/network` | Lấy sơ đồ mạng, VPC, Subnet, DNS | Trả về cấu trúc topo mạng Sydney & OpenStack |
| `GET` | `/api/network/security-groups` | Lấy danh sách Security Groups | Hỗ trợ param `?instanceId=...` |
| `POST` | `/api/network/security-groups` | Tạo mới hoặc cập nhật Security Group | `{"name": "web-sg", "description": "...", "inboundRules": [...]}` |
| `PUT` | `/api/network/security-groups/instances/{id}` | Gán danh sách Security Group cho máy ảo | `{"groupIds": ["sg-default", "sg-web-public"]}` |
| `DELETE`| `/api/network/security-groups/{gid}/rules/{rid}`| Xóa một rule tường lửa khỏi SG | Xóa rule và đồng bộ sang OpenStack Neutron |
| `POST` | `/api/network/dns` | Cắt chuyển bản ghi Route 53 DNS thủ công | `{"domainName": "web01.xregion.net", "targetIp": "3.27.x.x", "ttl": 60}` |

### 6.5 Nhóm Lưu Trữ & Ổ Đĩa (Storage - EBS / Cinder)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/volumes` | Lấy danh sách toàn bộ ổ đĩa lưu trữ | Trạng thái `AVAILABLE`, `IN_USE` |
| `GET` | `/api/volumes/{id}` | Lấy chi tiết ổ đĩa | Kích thước GB, loại ổ đĩa, máy ảo đang gắn |
| `POST` | `/api/volumes` | Cấp phát ổ đĩa EBS gp3 độc lập | `{"name": "data-vol", "sizeGb": 50, "volumeType": "gp3"}` |
| `POST` | `/api/volumes/{id}/attach` | Gắn ổ đĩa vào máy ảo | `{"instanceId": "i-xxx", "device": "/dev/vdb"}` |
| `POST` | `/api/volumes/{id}/detach` | Tháo rời ổ đĩa khỏi máy ảo | Ngắt kết nối ổ đĩa an toàn |
| `POST` | `/api/volumes/cross-region-copy`| Sao chép Snapshot ổ đĩa liên vùng | `{"volumeId": "vol-xxx", "targetRegion": "ap-southeast-2"}` |
| `DELETE`| `/api/volumes/{id}` | Xóa ổ đĩa lưu trữ | Giải phóng tài nguyên |

### 6.6 Nhóm Quản Trị Khóa SSH (SSH Key Pairs)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/keys` | Lấy danh bạ SSH Key Pairs của user | Trả về Fingerprint, loại mã hóa |
| `GET` | `/api/keys/{name}` | Lấy chi tiết thông tin key | Tải file `.pem` hoặc xem Public Key |
| `POST` | `/api/keys` | Tạo mới SSH Key Pair (Tự sinh RSA/ED25519) | `{"keyName": "dev-key", "keyType": "RSA-2048"}` |
| `DELETE`| `/api/keys/{name}` | Xóa Key Pair khỏi hệ thống & OpenStack | Đồng bộ lệnh xóa qua EventBridge |

### 6.7 Nhóm Quản Trị Ảnh Hệ Điều Hành & Snapshot (OS Images)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/images` | Lấy danh mục ảnh OS Glance có sẵn | Trả về Ubuntu, Debian, Rocky, Windows Server |
| `POST` | `/api/images/snapshot` | Tạo ảnh Glance Snapshot từ máy ảo | `{"instanceId": "i-xxx", "name": "Backup-Web-Prod"}` |
| `DELETE`| `/api/images/{id}` | Xóa ảnh hệ điều hành Glance | Giải phóng bộ nhớ Glance / S3 |

### 6.8 Nhóm Giám Sát Hiệu Năng & Viễn Đo (Metrics & Telemetry)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/metrics/instances/{id}` | Lấy biểu đồ hiệu năng máy ảo | Hỗ trợ tham số `?hours=1` (CPU %, RAM %, Network IOPS, Disk Read/Write) |

### 6.9 Nhóm Nhật Ký Kiểm Toán & Truy Vết (Audit Logs)
| Method | Endpoint | Mô Tả | Payload Yêu Cầu / Ghi Chú |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/logs` | Lấy danh sách lịch sử truy vết hệ thống | Hỗ trợ tham số `?limit=50` (Action, Actor, Resource, Timestamp) |

---

## ⚙️ 7. Cấu Hình & Biến Môi Trường (.env)

Hệ thống đọc cấu hình từ các biến môi trường thông qua file `.env` hoặc tham số khởi chạy hệ thống:

```ini
# ==============================================================================
# XREGION CONTROL PLANE CONFIGURATION (.env)
# ==============================================================================

# 1. Cấu hình Cổng & Profile Chạy Ứng Dụng
SERVER_PORT=8080
SPRING_PROFILES_ACTIVE=cloud

# 2. Thông Tin Xác Thực AWS Cloud (Sydney ap-southeast-2)
AWS_REGION=ap-southeast-2
AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX
AWS_SECRET_ACCESS_KEY=YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY

# 3. Điểm Cuối AWS API Gateway Event Ingestion (EventBridge Bus)
AWS_APIGATEWAY_EVENT_ENDPOINT=https://oqp7jmg7je.execute-api.ap-southeast-2.amazonaws.com/prod/events
AWS_APIGATEWAY_API_TOKEN=xreg_YWRtaW4_enterpriseSecretTokenForEventBridgeGateway8899

# 4. Bảng Amazon DynamoDB Chính Thức Qua Table ARN
DYNAMODB_INSTANCES_TABLE_ARN=arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Instances
DYNAMODB_MIGRATIONS_TABLE_ARN=arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Migrations
DYNAMODB_USERS_TABLE_ARN=arn:aws:dynamodb:ap-southeast-2:291634989063:table/XRegion-Users

# 5. DynamoDB Endpoint (Để trống để tự động kết nối HTTPS tới AWS Cloud; điền http://localhost:8000 khi chạy Local)
DYNAMODB_ENDPOINT=

# 6. Bảo Mật Spring Security & JWT Token
JWT_SECRET=XRegionEnterpriseSecretKeyWithAtLeast256BitsLengthForSecureHMACSHA256Tokens
JWT_EXPIRATION_HOURS=24
```

---

## 🚀 8. Hướng Dẫn Khởi Chạy & Vận Hành

### Cách 1: Khởi chạy môi trường Container bằng Docker Compose
Dành cho việc đóng gói và triển khai ứng dụng độc lập trên máy chủ hoặc máy trạm:

```bash
# 1. Di chuyển vào thư mục dự án
cd xregion

# 2. Khởi động ứng dụng bằng Docker Compose (đọc cấu hình từ file .env)
docker compose up -d --build

# 3. Theo dõi log ứng dụng
docker compose logs -f app
```
- **Web Dashboard**: `http://localhost:8080`
- **Tài khoản mặc định**: `admin` / `admin123`
- **Kiểm tra trạng thái hệ thống**:
  ```bash
  curl http://localhost:8080/api/auth/health
  ```

---

### Cách 2: Khởi chạy Hybrid Live Cloud bằng Maven (Kết nối trực tiếp AWS)
Yêu cầu: Máy trạm đã cài đặt **Java 17+**, **Maven 3.9+**, và cấu hình đầy đủ file `.env`.

```bash
# 1. Đảm bảo file .env đã nạp đúng AWS_ACCESS_KEY_ID và SECRET_ACCESS_KEY
# 2. Biên dịch và khởi chạy ứng dụng Spring Boot
mvn spring-boot:run
```

---

### Cách 3: Vận hành Daemon OpenStack trên Node EC2 (`i-056d7f3dd24156234`)
Khi bảo trì hoặc triển khai cập nhật daemon `nova-event-forwarder`:

```bash
# 1. Đăng nhập vào OpenStack Node qua SSM Session Manager hoặc SSH
aws ssm start-session --target i-056d7f3dd24156234 --region ap-southeast-2

# 2. Kiểm tra trạng thái daemon forwarder
sudo systemctl status nova-event-forwarder.service

# 3. Khởi động lại service sau khi cấu hình
sudo systemctl restart nova-event-forwarder.service

# 4. Kiểm tra luồng nhật ký sự kiện gửi về EventBridge
sudo journalctl -u nova-event-forwarder.service -f -n 50
```

---

## 📁 9. Cấu Trúc Thư Mục Dự Án

```text
xregion/
├── pom.xml                                  # Quản lý dependencies (Spring Boot 3.2, AWS SDK v2, JJWT, Lombok)
├── Dockerfile                               # Multi-stage Docker build (Maven Builder -> JRE Alpine Runtime)
├── docker-compose.yml                       # Khởi chạy Docker container App với cấu hình biến môi trường
├── .env.example                             # File mẫu cấu hình biến môi trường
├── README.md                                # Tài liệu kỹ thuật dự án toàn diện
└── src/main/
    ├── java/com/iaas/xregion/
    │   ├── XRegionApplication.java         # Điểm khởi chạy ứng dụng Spring Boot & Schedule Tasks
    │   ├── Client/                          # Lớp Client tích hợp dịch vụ ngoài
    │   │   ├── AwsSigV4Interceptor.java    # Ký số AWS IAM SigV4 cho HTTP REST Requests
    │   │   ├── BearerTokenInterceptor.java  # Gắn Header xác thực Bearer Token
    │   │   ├── EventBridgeGatewayClient.java# Ingest sự kiện vào API Gateway / EventBridge Bus
    │   │   └── Model/                       # Payload Request & Response của EventBridge
    │   │       ├── EventBridgeEventRequest.java
    │   │       └── EventBridgeEventResponse.java
    │   ├── Config/                          # Cấu hình hệ thống
    │   │   ├── ApiGatewayClientConfig.java  # Khởi tạo RestClient kết nối API Gateway
    │   │   ├── DynamoDbConfig.java          # Phân giải Table ARN, trích xuất AWS Region & Bảng
    │   │   ├── DynamoDbTableInitializer.java# Khởi tạo bảng dữ liệu và nạp tài khoản admin mặc định
    │   │   └── TimeSyncUtil.java            # Tiện ích đồng bộ thời gian chuẩn GMT+7
    │   ├── Controllers/                     # Lớp REST API Endpoints
    │   │   ├── AuthController.java          # /api/auth (Login, Register, Tokens, Me, Health)
    │   │   ├── InstanceController.java      # /api/instances (Launch, Actions, Update, List)
    │   │   ├── MigrationController.java     # /api/migrations (Trigger, Progress, History, Summary)
    │   │   ├── NetworkController.java       # /api/network (Security Groups, Rules, DNS Cutover)
    │   │   ├── KeyController.java           # /api/keys (Tạo, Import, Xóa SSH Keypairs)
    │   │   ├── VolumeController.java        # /api/volumes (Cấp phát, Attach, Detach, Copy)
    │   │   ├── ImageController.java         # /api/images (Danh mục ảnh OS Glance & Snapshot)
    │   │   ├── MonitoringController.java    # /api/metrics (Hiệu năng CPU, RAM, Network IOPS)
    │   │   └── AuditLogController.java      # /api/logs (Lịch sử truy vết thao tác hệ thống)
    │   ├── Entity/                          # DynamoDbBean Entities
    │   │   ├── InstanceEntity.java          # Ánh xạ bảng XRegion-Instances
    │   │   ├── UserEntity.java              # Ánh xạ bảng XRegion-Users
    │   │   ├── MigrationEntity.java         # Ánh xạ bảng XRegion-Migrations
    │   │   ├── KeyPairItem.java             # Cấu trúc SSH Keypair lưu trong User/Key
    │   │   ├── ApiTokenItem.java            # Cấu trúc API Token Bearer
    │   │   ├── InstanceStatus.java          # Enum trạng thái máy ảo (ACTIVE, SHUTOFF, MIGRATING...)
    │   │   ├── MigrationStep.java           # Enum 6 bước của tiến trình chuyển vùng
    │   │   ├── RegionType.java              # Enum các vùng hạ tầng (Sydney, OpenStack)
    │   │   ├── ScenarioStatus.java          # Enum trạng thái kịch bản chuyển vùng
    │   │   └── VolumeStatus.java            # Enum trạng thái ổ đĩa (AVAILABLE, IN_USE)
    │   ├── Exceptions/                      # Xử lý ngoại lệ tập trung
    │   │   ├── AppException.java
    │   │   ├── ConflictException.java       # Ném lỗi HTTP 409 khi xung đột khóa hoặc trạng thái
    │   │   ├── ResourceNotFoundException.java
    │   │   └── GlobalExceptionHandler.java  # Định dạng phản hồi lỗi JSON chuẩn hóa
    │   ├── Model/                           # DTOs Request & Response
    │   │   ├── Request/                     # Payload yêu cầu (Launch, Migrate, Key, SG...)
    │   │   └── Response/                    # Payload phản hồi (ApiResponse, Instance, Metrics...)
    │   ├── Security/                        # Tầng bảo mật hệ thống
    │   │   ├── SecurityConfig.java          # Cấu hình Spring Security 6 (Stateless JWT, CORS)
    │   │   ├── JwtTokenProvider.java        # Sinh & xác thực JWT Token (HMAC-SHA256)
    │   │   ├── JwtAuthenticationFilter.java # Bộ lọc chặn và giải mã Token trên mỗi Request
    │   │   ├── CustomUserDetails.java       # UserDetails triển khai cho Spring Security
    │   │   └── UserDetailsServiceImpl.java  # Nạp thông tin user từ DynamoDB
    │   └── Services/                        # Tầng nghiệp vụ xử lý cốt lõi
    │       ├── InstanceService.java         # Nghiệp vụ máy ảo, polling trạng thái EC2
    │       ├── MigrationService.java        # Điều phối Pipeline 6 bước di trú, Atomic Lock & RTO
    │       ├── NetworkService.java          # Quản trị Security Group, Inbound/Outbound Rules, DNS
    │       ├── KeyService.java              # Quản lý SSH Keypair, sinh khóa RSA/ED25519
    │       ├── VolumeService.java           # Quản lý EBS volumes và snapshot sao chép
    │       ├── AuthService.java             # Xác thực đăng nhập, mã hóa BCrypt, cấp API Token
    │       ├── ImageService.java            # Quản trị catalog ảnh hệ điều hành Glance
    │       ├── MonitoringService.java       # Thu thập viễn đo, hiệu năng và thống kê chi phí
    │       └── AuditLogService.java         # Ghi nhận và lưu vết nhật ký kiểm toán hệ thống
    └── resources/
        ├── application.yaml                 # Cấu hình mặc định Spring Boot, Port, ARNs, Logging
        └── static/                          # Giao diện Web SPA Dark Theme
            ├── login.html                   # Giao diện Đăng nhập
            ├── register.html                # Giao diện Đăng ký tài khoản
            ├── instances.html               # Quản lý danh sách máy ảo & Polling trạng thái
            ├── instance-detail.html         # Chi tiết máy ảo, Security Groups & Pipeline Di trú
            ├── launch.html                  # Trình khởi tạo máy ảo Boot-from-Volume
            ├── instance-edit.html           # Điều chỉnh cấu hình và đổi Security Group
            ├── account-tokens.html          # Quản lý mã API Tokens và đổi mật khẩu
            ├── index.html                   # Trang điều hướng tổng quan
            ├── css/dashboard.css            # Dark mode UI stylesheet (#0a0f1d, #162032, Cyan/Emerald)
            └── js/                          # Javascript xử lý tương tác, WebSocket & Polling
                ├── app.js                   # Logic ứng dụng chính, tương tác REST API
                ├── instance-detail.js       # Xử lý riêng giao diện chi tiết, SG & Migration Polling
                └── overview.js              # Xử lý số liệu thống kê tổng quan
```

---

## 🛡️ Bản Quyền & Giấy Phép
Dự án được phát triển và duy trì bởi **Nhóm 5 - Chuyên đề Hạ tầng Đám mây Lai & Điều khiển Đa vùng (Hybrid & Cross-Region IaaS)**. Mọi quyền được bảo lưu.
