# Runbook Ánh Xạ 1-1 Hạ Tầng Region B (`ap-southeast-2`) sang Region A (`us-east-1`)

Tài liệu này tổng hợp toàn bộ các cấu hình cần thiết, giá trị ánh xạ thực tế và quy trình kiểm chứng để triển khai hoặc khôi phục 1-1 hạ tầng **XRegion** từ **Region B (`ap-southeast-2` - Sydney)** sang **Region A (`us-east-1` - N. Virginia)**.

---

## 1. Hạ tầng Mạng VPC & ENI (`us-east-1`)

Để khớp hoàn toàn với snapshot OpenStack từ Region B mà **không cần re-IP OpenStack**, VPC tại Region A phải sử dụng cùng dải CIDR `10.20.0.0/16` và cùng quy hoạch IP nội bộ.

| Thành phần | Tên / Mô tả | Giá trị thực tế (`us-east-1`) | Ghi chú cấu hình |
| :--- | :--- | :--- | :--- |
| **VPC** | `10.20.0.0/16` | `vpc-0c9e2dc8fa012a40b` | `EnableDnsHostnames: true`, `EnableDnsSupport: true` |
| **Internet Gateway** | `RegionA-igw` | `igw-03e28bc3c56a930a4` | Gắn vào `vpc-0c9e2dc8fa012a40b` |
| **Public Subnet** | `RegionA-publicSubnet1` | `subnet-0123913e3357df916` | CIDR `10.20.1.0/24`, AZ `us-east-1a` |
| **Public Route Table** | Route Table Public | `rtb-0bbc388cf499e0f5d` | `0.0.0.0/0 -> igw-03e28bc3c56a930a4` |
| **NAT Gateway** | NAT Gateway | `nat-0c026dd26fee01ec2` | Đặt tại `RegionA-publicSubnet1`, EIP: `72.44.58.97` (`available`) |
| **Private Subnet** | `RegionA-privateSubnet1` | `subnet-0909efd155bc3b18e` | CIDR `10.20.10.0/24`, AZ `us-east-1a` |
| **Private Route Table** | Route Table Private | `rtb-04cb3cf3fbd29b37d` | `0.0.0.0/0 -> nat-0c026dd26fee01ec2` |
| **Security Group** | `RegionA-securityGroup` | `sg-06ed3f375ea95f881` | All Traffic (`-1`) từ `0.0.0.0/0` cho cả Ingress & Egress |
| **Primary ENI (`ens5`)** | `DeviceIndex: 0` (Private) | `eni-061b06c52aab778be` | Primary IP: `10.20.10.183`, Secondary VIP: `10.20.10.250`, `SourceDestCheck: false` |
| **Secondary ENI (`ens6`)** | `DeviceIndex: 1` (Public/NAT) | `eni-0ed6a1623d49ebe3a` | Private IP: `10.20.1.253`, gắn Public EIP cố định: `44.212.151.241`, `SourceDestCheck: false` |

---

## 2. Compute & Snapshot EC2 (`RegionA-tempEC2`)

1. **Tạo Root Volume từ Snapshot Region B**:
   - Nguồn snapshot đã copy sang `us-east-1`: `snap-0c31987a8314b634f`.
   - Tạo EBS Volume tại AZ `us-east-1a`:
     - Volume ID: `vol-059ace59232c27ec5`
     - Dung lượng & loại: `80 GB`, `gp3`, IOPS `3000`, Throughput `125 MB/s`
     - Tag: `Name=RegionA-tempEC2-Root-snap0c31`
2. **Dừng an toàn EC2 cũ** (nếu thay thế host):
   - Chuyển EC2 cũ (`i-054f3fe75f9160889`) sang trạng thái `stopped` trước khi khởi chạy host mới dùng lại IP `10.20.10.183`.
3. **Khởi chạy EC2 Host mới (`RegionA-tempEC2`)**:
   - **Instance ID**: `i-07738a186534cb5ba`
   - **Instance Type**: `m7i-flex.xlarge` (**Nested Virtualization: `enabled`**)
   - **Root Device (`/dev/sda1`)**: `vol-059ace59232c27ec5`
   - **Network Interfaces**:
     - `DeviceIndex: 0`: `eni-061b06c52aab778be` (`10.20.10.183`, VIP `10.20.10.250`)
     - `DeviceIndex: 1`: `eni-0ed6a1623d49ebe3a` (`10.20.1.253`, Public EIP `44.212.151.241`)
   - **IAM Instance Profile**: `SSMInstanceRole`
   - **Tags**: `Name=RegionA-tempEC2`, `Project=xregion`
4. **Xác nhận trạng thái EC2**:
   - Instance State: `running`
   - Status Checks: `2/2 passed` (`InstanceStatus: ok`, `SystemStatus: ok`, `AttachedEbsStatus: ok`)
   - SSM PingStatus: `Online` (`ComputerName: ip-10-20-10-183`, Ubuntu 24.04)

---

## 3. Cấu hình OS & Kolla OpenStack trên EC2

Thực hiện qua SSM trên `i-07738a186534cb5ba`:

### 3.1. Persistent udev rule cho Secondary ENI (`ens6`)
- Đảm bảo interface của Secondary ENI (`eni-0ed6a1623d49ebe3a`, ví dụ MAC `02:ff:d8:91:45:1f`) luôn được đặt tên là `ens6` thông qua file `/etc/udev/rules.d/70-persistent-net.rules`.
- Mục đích: Giúp Open vSwitch bridge `br-ex` gắn kết trực tiếp được `Port ens6` / `Interface ens6`, tránh lỗi missing device khi khởi động lại hoặc khôi phục từ snapshot.

### 3.2. Cấu hình Cinder EBS Backend
- Cập nhật `/etc/kolla/cinder-volume-ebs/cinder.conf` (tên option chuẩn theo `cinder_ebs.py`):
  - `xregion_ebs_region = us-east-1`
  - `xregion_ebs_host_id = i-07738a186534cb5ba` (`<NEW_EC2_ID>`)
- Cập nhật `/etc/kolla/cinder-volume-ebs/xregion-aws-config`:
  - `region = us-east-1`

### 3.3. Patch `ebs_backend.py` trong container `cinder_volume_ebs`
- Đường dẫn trong container: `/var/lib/kolla/venv/lib/python3.12/site-packages/storage/ebs_backend.py`
- Nguyên nhân: Driver gốc khóa cứng `if region != "ap-southeast-2": raise ValueError("Unexpected storage account or region")`, gây lỗi `DriverNotInitialized` khi chạy tại `us-east-1`.
- Khắc phục: Cập nhật điều kiện kiểm tra để hỗ trợ cả 2 vùng: `region not in ("ap-southeast-2", "us-east-1")`.
- Khởi động lại container `cinder_volume_ebs` và kiểm tra log xác nhận:
  - `Driver initialization completed successfully`
  - `Driver post RPC initialization completed successfully`
- Đảm bảo daemon `tgtd` đang chạy trên container `tgtd` với portal `10.20.10.183:3260`, chia sẻ socket `/run/tgtd/socket.0` với `cinder_volume_ebs`.

### 3.4. Dọn dẹp Volume kẹt & Khởi tạo Warm Pool Boot Volumes
1. **Dọn dẹp trạng thái cũ**:
   - Tách an toàn các volume 1GB cũ khỏi EC2 cũ đã dừng, xóa các volume `error` trên OpenStack.
   - Cập nhật các bản ghi request kẹt trong DynamoDB sang `DELETED` để tránh lỗi 404 tại `checked_volume` trong `AllocateResource`.
2. **Tạo mới 2 Boot Volume chuẩn 1-1 cho Warm Pool (Bắt buộc qua Cinder)**:
   - **Quan trọng**: Phải tạo qua Cinder (`XRegion-CinderPoolManager` hoặc `openstack volume create --size 1 --image <image_id> ...`) để `XRegionEbsDriver.copy_image_to_volume` gọi `self.local_path(volume)` -> `self.backend.attach(...)` **tự động attach EBS vào EC2 `i-07738a186534cb5ba`** và ghi dữ liệu image lên đĩa, sẵn sàng tạo iSCSI export `tgtadm` khi Nova boot.
   - Cấp phát 2 volumes **1GB gp3**, **encrypted Virginia KMS**, `bootable=True`, từ Glance image `c66c2ab2-68fe-40bb-8f55-d2e5ba1c944d` (Alpine Linux), gắn tag `StorageHostId=i-07738a186534cb5ba`:
     - Volume 1: Cinder `550a926c-cd57-4d01-bad9-285f79316097` `<->` AWS EBS `vol-051fc0989543b5fe4` (attached `/dev/sdf`, NVMe `nvme1n1`)
     - Volume 2: Cinder `6ed50d53-e33e-465b-8f3c-d9f9536b0f22` `<->` AWS EBS `vol-02fd730262427cbbf` (attached `/dev/sdg`, NVMe `nvme2n1`)
   - (Tương tự cho 2 volume Cirros `831dc24b-9d29-4cb6-8154-9de2d0fd268f` trên `nvme3n1`, `nvme4n1`).
   - Cả 2 volume đạt trạng thái OpenStack `available`, `bootable=True` và đã attach vật lý vào `i-07738a186534cb5ba`.
3. **Đồng bộ DynamoDB `XRegion-Volumes`**:
   - Ghi 2 bản ghi `EBS-POOL#35a88a30-5cd3-4667-af20-23da29771057` và `EBS-POOL#9a720861-75c3-4a3b-8dad-cadd8bbf25c0` với `status: "AVAILABLE"`, `image_id: "c66c2ab2-68fe-40bb-8f55-d2e5ba1c944d"` (đảm bảo `AVAILABLE count >= 2`).

### 3.5. Cấu hình Network Gateway (`/etc/xregion-network/config.json`) cho `gateway.py`
- File `/etc/xregion-network/config.json` được sử dụng bởi `/usr/local/libexec/xregion-network/gateway.py`, systemd `xregion-network.service` / `xregion-network.timer` và SSM Document `XRegion-NetworkGateway` (khi thực thi `ApplyNatMapping` / `CheckNatCommand`).
- Khi khôi phục từ snapshot Region B, file này vẫn chứa cấu hình cũ của `ap-southeast-2`:
  ```json
  {"region": "ap-southeast-2", "host_id": "i-056d7f3dd24156234", "eni_id": "eni-091eaee3e69e3f42d", "eni_mac": "02:ff:e3:85:1a:d3", "primary_ip": "10.20.1.253", "table": "XRegion-NetworkMappings"}
  ```
- **Cập nhật chuẩn hóa 1-1 cho Region A (`us-east-1`)**:
  ```json
  {"region": "us-east-1", "host_id": "i-07738a186534cb5ba", "eni_id": "eni-0ed6a1623d49ebe3a", "eni_mac": "02:ff:d8:91:45:1f", "primary_ip": "10.20.1.253", "table": "XRegion-NetworkMappings"}
  ```
- **Xóa cache cũ và chạy Reconcile**:
  - Xóa file cache `/var/lib/xregion-network/last-applied.json`.
  - Chạy lệnh thực nghiệm:
    ```bash
    /opt/xregion-network-venv/bin/python /usr/local/libexec/xregion-network/gateway.py RECONCILE
    ```
  - Xác nhận stdout trả về `{"schema_version": 1, "operation": "RECONCILE", "status": "SUCCEEDED", ...}`:
    - Đảm bảo `gateway.py` đọc/ghi đúng bảng DynamoDB `XRegion-NetworkMappings` tại `us-east-1` và cập nhật `applied_generation` (tránh lỗi `RuntimeError: Gateway generation not confirmed` tại bước `CheckNatCommand`).
    - Tự động đồng bộ MAC của OVS bridge `br-ex` sang đúng MAC của `ens6` (`02:ff:d8:91:45:1f`), ngăn `xregion-network.timer` ghi đè MAC cũ của Region B lên `br-ex`.

---

## 4. IAM Roles & Policies (5 Roles cần cập nhật)

Trong tổng số 12 IAM Roles của XRegion (Account `291634989063`), **7 Roles đã khớp sẵn** (`EventBridge-StepFunctions-ExecutionRole`, `openstack_lambda_vpc_execution_role`, `openstack_step_functions_role`, `XRegion-APIGatewayCloudWatchRole`, `XRegion-ApiGatewayToEventBridgeRole`, `XRegion-InstanceRecovery-ExecutionRole`, `XRegion-SecurityGroupSyncRole`).

Cần cập nhật **5 Roles** sau cho `us-east-1` (giữ nguyên toàn bộ quyền hiện có của `ap-southeast-2`):

| IAM Role | Inline Policy cần sửa | Thay đổi bắt buộc cho `us-east-1` |
| :--- | :--- | :--- |
| **`XRegion-CinderEbsRole`** | `CinderEbsOwnedVolumes` | - Thay `i-054f3fe75f9160889` -> `i-07738a186534cb5ba` trên toàn bộ 9 statements (`CreateOwnedEncryptedGp3Virginia`, `TagOnlyAtCreation`, `OwnVolumeLifecycle`, `MarkSingleResizeOnce`, `AttachOnlyToStorageHost`, `SnapshotOwnedSource`, `CreateOwnedSnapshot`, `DeleteOwnedSnapshot`, `RestoreOwnedSnapshot`).<br>- Bổ sung root volume mới `vol-059ace59232c27ec5` vào statement Deny `NeverMutateRoot`. |
| **`XRegion-NetworkLambdaRole`** | `XRegion-NetworkV1` | - Thay EC2 ID `i-054f3fe75f9160889` -> `i-07738a186534cb5ba` (cho `ssm:SendCommand`).<br>- Thay Secondary ENI ID `eni-0403544b8996a3b5a` -> `eni-0ed6a1623d49ebe3a` (cho `ec2:AssignPrivateIpAddresses`, `UnassignPrivateIpAddresses`, `AssociateAddress`, `DisassociateAddress`, `CreateTags`, `DeleteTags`). |
| **`DB-AccessRole`** | `XRegion-NetworkV1` | - Thay EC2 ID `i-054f3fe75f9160889` -> `i-07738a186534cb5ba` và Secondary ENI ID `eni-0403544b8996a3b5a` -> `eni-0ed6a1623d49ebe3a` (tương tự `XRegion-NetworkLambdaRole`). |
| **`SSMInstanceRole`** | `XRegion-GatewayMappings`<br>`XRegion-NetworkCommandLogs` | - `XRegion-GatewayMappings`: bổ sung ARN DynamoDB `us-east-1` (`XRegion-NetworkMappings` & `gateway_host_id-index`).<br>- `XRegion-NetworkCommandLogs`: bổ sung ARN CloudWatch Logs `us-east-1` (`/xregion/network/ssm:*`). |
| **`XRegion-InstanceRecovery-Role`** | `InstanceRecovery` | - Bổ sung `arn:aws:lambda:us-east-1:291634989063:function:XRegion-InstanceRecovery`. |

- **Kiểm chứng read-back**: Xác nhận `staleEC2=False`, `staleENI=False`, `us-east-1=True` trên cả 6 inline policies.

---

## 5. Lambda, Step Functions & EventBridge

### 5.1. Step Functions (4/4 State Machines)
- `LaunchInstance`, `LifecycleInstance`, `MigrateInstance`, `TerminateInstance` sử dụng role `openstack_step_functions_role`, trạng thái `ACTIVE`, khớp 100% states với `ap-southeast-2` và trỏ 100% tài nguyên `us-east-1`.

### 5.2. Lambda VPC Config (20/32 hàm gắn VPC)
- Chuyển toàn bộ **20 hàm gắn VPC** từ VPC cũ (`vpc-02c7d26a539293275`, `subnet-04bea2c49919460fc`, `sg-007ef3a0b94d53ce9`) sang:
  - **VPC**: `vpc-0c9e2dc8fa012a40b`
  - **Subnet**: `subnet-0909efd155bc3b18e` (`RegionA-privateSubnet1`)
  - **Security Group**: `sg-06ed3f375ea95f881` (`RegionA-securityGroup`)
- Danh sách 20 hàm gắn VPC:
  - `CinderPoolManager`, `InstanceLifecycle`, `InstanceRecovery`, `KeySyncManager`
  - `LaunchInstance-{AllocateResource, AssignSecurityGroup, BootNova, ExtendVolume}`
  - `Migrate-{Rollback, StopSource}`
  - `Network-{CheckCommand, Commit, Dispatch, Release, Reserve}`
  - `ScheduledEbsSnapshot`, `SyncSecurityGroup`
  - `TerminateInstance-{DeleteNova, DeleteSecurityGroup, DeleteVolume}`
- **12/32 hàm còn lại**: giữ nguyên không gắn VPC (`HasVpc: false` khớp 1-1 Region B).
- Chờ toàn bộ 20 hàm đạt `LastUpdateStatus=Successful` (khởi tạo Hyperplane ENI).

### 5.3. Lambda Environment Variables (28 hàm)
Cập nhật các biến môi trường trỏ về hạ tầng mới:
- `PUBLIC_SUBNET_ID`: `subnet-0123913e3357df916`
- `OPENSTACK_PUBLIC_ENI`: `eni-0ed6a1623d49ebe3a`
- `GATEWAY_HOST_ID`: `i-07738a186534cb5ba`
- `KEYSTONE_URL`, `NOVA_URL`, `NEUTRON_URL`, `CINDER_URL`, `GLANCE_URL`: trỏ IP `10.20.10.183` (khớp 1-1 kiểu IP chính trên `ens5` như Region B)
- `NETWORK_ADMISSION`: đặt `open` cho `XRegion-CinderPoolManager`, `XRegion-ScheduledEbsSnapshot` và 6 hàm `XRegion-Migrate-*` (khớp 1-1 Region B)
- Kiểm chứng read-back: `Total=32, NewVpcCount=20, StaleCount=0`.

### 5.4. EventBridge Rules & Scheduler (10 Rules + 1 Schedule)
- **7 Rules có sẵn (`ENABLED`)**: `XRegion-BackendEventRule`, `XRegion-InstanceLaunchRule`, `XRegion-InstanceLifecycleRule`, `XRegion-InstanceTerminateRule`, `XRegion-NovaSyncCatalogRule`, `XRegion-SecurityGroupSync`, `XRegion-SnapshotCleanerRule`.
- **3 Rules tạo mới (`ENABLED`)** kèm Lambda invoke permissions (để đạt đủ 10/10 Rules khớp 1-1 Region B):
  1. `XRegion-InstanceMigrationRule` (Pattern `xregion.backend.migration`/`instance` -> `stateMachine:MigrateInstance`)
  2. `XRegion-ScheduledEbsSnapshotRule` (`cron(0,30 * * * ? *)` -> `XRegion-ScheduledEbsSnapshot`)
  3. `XRegion-SnapshotCrossRegionCopyRule` (`cron(15,45 * * * ? *)` -> `XRegion-SnapshotCrossRegionCopy`)
- **1 EventBridge Scheduler tạo mới**:
  1. `XRegion-InstanceRecovery-Schedule` (`rate(5 minutes)`, trạng thái **`DISABLED`**, target `XRegion-InstanceRecovery`, role `XRegion-InstanceRecovery-Role`).

### 5.5. SSM Documents & SSM Parameters
- **SSM Documents (`Owner=Self`)**: Kiểm tra đối chiếu và đồng bộ 1-1 toàn bộ SSM Documents `XRegion-*` từ Region B (`ap-southeast-2`) sang Region A (`us-east-1`), đặc biệt là **`XRegion-NetworkGateway`** (`DocumentType: Command`, `JSON`, `SchemaVersion: 2.2`, gọi `/opt/xregion-network-venv/bin/python /usr/local/libexec/xregion-network/gateway.py ...`), nhằm tránh lỗi `InvalidDocument` khi `network_runtime.py` (`dispatch`) gọi `ssm:SendCommand`. Xác nhận `Status=Active`.
- **SSM Parameters (`/xregion/...`)**: Đối chiếu và đồng bộ đầy đủ các tham số `/xregion/...` giữa `ap-southeast-2` và `us-east-1` (`/xregion/ap-southeast-2/launch/admission` <-> `/xregion/us-east-1/launch/admission` = `{"mode": "open"}`).

---

## 6. Quy trình Dọn dẹp Tàn dư & Xử lý sự cố thường gặp

Khi một lần chạy E2E hoặc Launch bị fail giữa chừng, cần dọn sạch cả hạ tầng OpenStack/AWS lẫn các bảng lock DynamoDB trước khi chạy lại:

1. **Dọn dẹp Nova VM & Network trên EC2 / ENI**:
   - Xóa máy ảo failed trên OpenStack (`openstack server delete <nova_id>`).
   - Unassign secondary private IP (ví dụ `10.20.1.10`) khỏi Secondary ENI `eni-0ed6a1623d49ebe3a`.
   - Disassociate EIP (nếu đang gắn) và xóa toàn bộ các tag `ClaimedBy`, `ReservationId`, `NovaId` trên các EIP thuộc pool (`18.233.62.182`, `3.231.87.226`).
2. **Dọn dẹp Lock kẹt trong DynamoDB `XRegion-NetworkReservations` & `XRegion-NetworkMappings` (`us-east-1`)**:
   - **Lưu ý quan trọng**: Hàm `check_pool()` kiểm tra `not get(RES, "resource_key", "EIP#" + a["AllocationId"])`. Nếu chỉ gỡ tag `ClaimedBy` trên EC2 mà không xóa bản ghi trong `XRegion-NetworkReservations`, Step Function sẽ vẫn báo lỗi `PoolNotReady: No unclaimed xregion EIP in reserve pool`.
   - Cần quét và xóa sạch các bản ghi lock kẹt (`EIP#...`, `PRIVATEIP#...`, `LEASE#...`) trong bảng `XRegion-NetworkReservations` và bản ghi mapping mồ côi của Nova VM lỗi trong `XRegion-NetworkMappings` tại `us-east-1`.
3. **Kiểm tra luồng Attach EBS vào Storage Host EC2 (`i-07738a186534cb5ba`)**:
   - Đảm bảo `cinder_volume_ebs` (`xregion-aws-config`, `ebs_backend.py`) và quyền `XRegion-CinderEbsRole` / `SSMInstanceRole` / KMS key Virginia (`d3bdbb93-...`) cho phép attach volume vào `i-07738a186534cb5ba` không bị kẹt ở bước `BootNova`.

---

## 7. Checklist Kiểm chứng & Nghiệm thu

Trước khi chạy E2E Test, xác nhận toàn bộ các tiêu chí sau đều đạt:

- [ ] **EC2 & SSM**: `i-07738a186534cb5ba` đang `running`, Status Checks `2/2 passed`, SSM `PingStatus=Online`.
- [ ] **Kolla Containers**: `37/37` containers (MariaDB, RabbitMQ, Keystone, Nova, Neutron, Glance, Cinder, Horizon, OVN, v.v.) đều `Up` và `healthy`.
- [ ] **OVS Bridge & Network Gateway Config**: `ovs-vsctl show` xác nhận `Bridge br-ex` có `Port ens6` / `Interface ens6` (MAC `02:ff:d8:91:45:1f`); `/etc/xregion-network/config.json` trỏ đúng `region: us-east-1`, `host_id: i-07738a186534cb5ba`, `eni_id: eni-0ed6a1623d49ebe3a`, `eni_mac: 02:ff:d8:91:45:1f` và lệnh `gateway.py RECONCILE` trả về `SUCCEEDED`.
- [ ] **OpenStack Network Agents**: `openstack network agent list` hiển thị `neutron-ovn-metadata-agent` và `ovn-controller` trên `ip-10-20-10-183` có `Alive: :-)` và `State: UP`.
- [ ] **OpenStack Compute & Storage**:
  - `nova-scheduler`, `nova-conductor`, `nova-compute`: `State: up`, `Status: enabled`; Hypervisor `ip-10-20-10-183` (`QEMU`) `State: up`.
  - `cinder-volume ip-10-20-10-183@aws-ebs`: `State: up`, `Status: enabled`; log `cinder_volume_ebs` xác nhận `Driver initialization completed successfully` và attach volume vào `i-07738a186534cb5ba` hoạt động bình thường.
- [ ] **Warm Pool Volumes**: DynamoDB `XRegion-Volumes` có `AVAILABLE >= 2` (2 boot volume 1GB gp3 encrypted KMS Virginia, `bootable=True`, tag `StorageHostId=i-07738a186534cb5ba`).
- [ ] **EIP Pool & Network Reservations**: Có `>= 2` EIPs unassociated, không có tag `ClaimedBy` (`18.233.62.182`, `3.231.87.226`) và **không còn bản ghi lock kẹt (`EIP#...`, `PRIVATEIP#...`, `LEASE#...`) trong `XRegion-NetworkReservations`**.
- [ ] **SSM Documents & Parameters**: SSM Document `XRegion-NetworkGateway` (`Status=Active`, `SchemaVersion=2.2`) đã tồn tại tại `us-east-1`; `/xregion/us-east-1/launch/admission` = `{"mode": "open"}`.
- [ ] **Lambda & IAM**: 20/20 hàm Lambda gắn VPC đạt `LastUpdateStatus=Successful`; read-back IAM `staleEC2=False`, `staleENI=False`, `us-east-1=True`.
- [ ] **Chạy kiểm thử nghiệm thu E2E**:
  ```bash
  python -u -m pytest tests/apiTest/test_instance_lifecycle_rea_e2e.py -v -s -p no:warnings
  ```
