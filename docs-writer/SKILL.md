---
name: aws-skill
description: >-
  Quản lý và kiểm tra tài nguyên AWS bằng AWS CLI, làm việc cùng AWS Toolkit trong VS Code.
  Chỉ vận hành khi người dùng yêu cầu dùng aws-skill hoặc $aws-skill cho một tác vụ cụ thể.
---

# AWS Toolkit và AWS CLI trong Codex

Chỉ vận hành khi người dùng yêu cầu dùng skill này cho một tác vụ. Hỏi cách dùng hoặc sửa tài liệu skill không cho phép chạy AWS hay triển khai Lambda.

## File tạm ngoài workspace

- Không tạo thư mục scratch, payload JSON, script trung gian hoặc ZIP triển khai trong workspace.
- Ưu tiên tham số inline được quote đúng shell. Khi cần file, tạo thư mục riêng trong OS Temp (`$env:TEMP` trên Windows), theo quyền filesystem của phiên.
- Chỉ dọn file trung gian do tác vụ tạo. Giữ bản sao lưu cần khôi phục đến khi nghiệm thu; không xóa thay đổi có sẵn.
- Trước khi xóa đệ quy, kiểm tra đường dẫn tuyệt đối nằm trong thư mục tạm của tác vụ.

## Grill-Me và Plan

Áp dụng [quy trình duyệt kế hoạch](../always-plan-and-grillme/SKILL.md). Có thể khảo sát chỉ đọc để chuẩn bị kế hoạch.

- Ghi rõ account/profile, region, tài nguyên, thay đổi, kiểm tra và khôi phục. Chia theo phần việc khi cần và xác định phần nào đã được duyệt.
- Dùng công cụ hỏi có sẵn hoặc chat để làm rõ quyết định ảnh hưởng phạm vi/quyền. Chờ người dùng duyệt trước khi thay đổi; không phụ thuộc nút duyệt của IDE.
- Sau khi duyệt, thực hiện hết phạm vi đó. Chỉ xin duyệt bổ sung khi mở rộng phạm vi hoặc quyền; xử lý lỗi kỹ thuật thông thường trong quyền đã có.

## 1. Nguyên tắc An toàn & Xác thực (Authentication First)

Trước khi thực hiện bất kỳ lệnh tạo hay sửa đổi tài nguyên nào, luôn luôn kiểm tra thông tin danh tính và quyền hạn:

```bash
# Kiểm tra tài khoản và IAM Identity hiện tại
aws sts get-caller-identity

# Kiểm tra Region mặc định đang thao tác
aws configure get region
```

Nếu chưa đăng nhập hoặc profile không đúng:
- Trong **AWS Toolkit (VS Code)**: Mở sidebar AWS > Nhấp vào **"Select Region"** hoặc **"Connect to AWS"** để nạp profile/SSO credentials.
- Trong **CLI**: Xuất biến môi trường hoặc chỉ định `--profile <tên_profile>` / `--region <region>`.

Credentials của Toolkit không tự bảo đảm CLI dùng cùng danh tính. Thực hiện STS với đúng profile sẽ dùng cho tác vụ; truyền region rõ ràng, nhất là khi làm việc nhiều region. Không in credentials ra log. Kiểm tra danh tính không thay thế việc xác minh quyền thao tác cần thiết.

---

## 2. Thao tác qua AWS Toolkit for VS Code

Codex có thể đọc/sửa file Lambda mà Toolkit tải xuống khi đường dẫn và quyền của phiên cho phép. Dùng đường dẫn IDE cung cấp để xác định đúng file, function và region.

- Không giả định có công cụ điều khiển giao diện AWS Explorer hoặc Command Palette. Dùng công cụ thực có trong phiên; AWS CLI là đường thực thi khi được cấp quyền.
- Lưu file tải xuống trong Temp không đồng nghĩa đã cập nhật Lambda trên AWS. Khi người dùng yêu cầu triển khai, xác minh function/region, handler và nội dung gói trước khi cập nhật theo kế hoạch đã duyệt.
- Khi phải hướng dẫn thao tác giao diện cho người dùng, mô tả rõ đó là bước người dùng thực hiện; không báo đã thao tác Toolkit nếu chưa có bằng chứng.

---

## 3. Tạo & Chỉnh sửa Tài nguyên bằng AWS CLI

Kết hợp AWS CLI để tự động hóa chính xác các tài nguyên cốt lõi trong dự án:

### 3.1. Quản lý Mạng (VPC, Subnet, Security Group)
```bash
# Lấy danh sách VPC
aws ec2 describe-vpcs --query "Vpcs[*].{VpcId:VpcId,Cidr:CidrBlock,State:State,Name:Tags[?Key=='Name'].Value|[0]}" --output table

# Mở cổng Security Group an toàn (Ví dụ cổng 80 cho HTTP)
aws ec2 authorize-security-group-ingress \
    --group-id <sg-xxxx> \
    --protocol tcp \
    --port 80 \
    --cidr 10.0.0.0/16
```

### 3.2. Quản lý EC2 Instances
```bash
# Lấy thông tin các instance đang chạy
aws ec2 describe-instances \
    --filters "Name=instance-state-name,Values=running" \
    --query "Reservations[*].Instances[*].{InstanceId:InstanceId,PrivateIp:PrivateIpAddress,PublicIp:PublicIpAddress,Type:InstanceType,Name:Tags[?Key=='Name'].Value|[0]}" \
    --output table

# Khởi động / Dừng instance
aws ec2 stop-instances --instance-ids <instance-id>
aws ec2 start-instances --instance-ids <instance-id>
```

### 3.3. Quản lý DynamoDB & S3
```bash
# Liệt kê S3 Buckets
aws s3 ls

# Đồng bộ thư mục lên S3
aws s3 sync ./dist s3://my-bucket-name/dist/

# Kiểm tra bảng DynamoDB
aws dynamodb list-tables
aws dynamodb describe-table --table-name <table-name>
```

---

## 4. Quy trình Kiểm thử & Nghiệm thu (Verification Checklist)

Mỗi khi tạo mới hoặc cập nhật tài nguyên:
1. **Kiểm tra trạng thái sẵn sàng**: Đảm bảo tài nguyên chuyển sang trạng thái `available`, `running` hoặc `ACTIVE`.
2. **Kiểm tra Tagging**: Đảm bảo tài nguyên có gắn thẻ phân loại (ví dụ: `Environment=Dev/Prod`, `Project=xregion`).
3. **Kiểm tra Chi phí & Dọn dẹp**:
   - Dọn tài nguyên tạm do tác vụ tạo theo phạm vi đã duyệt. Tài nguyên không gắn hoặc snapshot cũ chỉ là đối tượng cần xem xét; không tự suy ra được phép xóa tài nguyên có sẵn.
4. **Kiểm tra Cây thư mục Workspace**:
   - Xác nhận tác vụ không để file tạm, payload hay ZIP trong workspace. So sánh `git status --short` trước/sau để bảo toàn thay đổi có sẵn; kiểm tra cả đường dẫn bị Git bỏ qua khi có liên quan.

---

## 5. Quy chuẩn Tích hợp OpenStack & Lambda (OpenStack Service Project Standard)

Khi xây dựng, cấu hình hoặc gỡ lỗi bất kỳ hàm AWS Lambda nào tương tác trực tiếp với cụm OpenStack nội bộ (Nova, Cinder, Neutron, Keystone, Glance):

### 5.1. Bắt buộc sử dụng OpenStack Project: `service`
- **Mục tiêu**: Toàn bộ tài nguyên máy ảo, volume, keypair và security group được điều phối tập trung dưới Project **`service`** (Project ID: `d3bf05331973481891385d066d3eba3e`).
- **Biến môi trường bắt buộc trên Lambda**:
  ```bash
  OS_PROJECT_NAME="service"     # BẮT BUỘC: Không sử dụng 'admin' cho project scope
  OS_USERNAME="admin"
  OS_PASSWORD="12345678"
  KEYSTONE_URL="http://10.20.10.183:5000/v3"
  NOVA_URL="http://10.20.10.183:8774/v2.1"
  CINDER_URL="http://10.20.10.183:8776/v3"
  NEUTRON_URL="http://10.20.10.183:9696/v2.0"
  DEFAULT_AZ="ap-southeast-2a"
  EC2_HOST_ID="i-056d7f3dd24156234"
  NETWORK_ID="77e93c67-be12-4a0c-98f0-64d543833a62"
  ```

### 5.2. Cấu trúc Keystone Authentication Scope
Mọi hàm Lambda khi xin Token từ Keystone (`/v3/auth/tokens`) phải luôn truyền scope về `service`:
```python
"scope": {
    "project": {
        "name": os.environ.get("OS_PROJECT_NAME", "service"),
        "domain": {"name": "Default"}
    }
}
```
