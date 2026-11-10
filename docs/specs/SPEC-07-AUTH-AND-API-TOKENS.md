# SPEC-07: Xác Thực & Quản Trị API Token Dài Hạn (Authentication & API Tokens)

> **Phiên bản**: `1.0.0`  
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`  
> **Ngày phê duyệt**: `2026-11-10`  
> **Tài liệu cha**: [SPEC-00: Agent Scope Guard](SPEC-00-AGENT-SCOPE-GUARD.md)

---

## 1. Cơ Chế Xác Thực Người Dùng (User Authentication)

Hệ thống Control Plane Backend Spring Boot 3.2 áp dụng kiến trúc xác thực không trạng thái (Stateless Authentication) dựa trên JSON Web Token (JWT) và Spring Security:

### 1.1. Chuẩn Hóa Tài Khoản & Mật Khẩu
- **Lưu trữ tài khoản**: Bảng DynamoDB `XRegion-Users` với khóa chính `user_id` và chỉ mục phụ toàn cục `GSI: username-index`.
- **Mã hóa mật khẩu**: Bắt buộc sử dụng thuật toán **BCrypt (Strength 10)**. Tuyệt đối không lưu mật khẩu dạng plaintext.
- **Phân quyền truy cập (Role-Based Access Control - RBAC)**:
  - `ROLE_ADMIN`: Có quyền xem và quản trị tất cả các máy ảo, volume, khóa SSH và security group trong toàn hệ thống.
  - `ROLE_USER`: Chỉ được xem và thao tác trên các tài nguyên do chính tài khoản của mình tạo (`owner == currentUser`).

### 1.2. JWT Token Ngắn Hạn Cho Web Dashboard (Short-lived JWT)
- **Đăng nhập**: `POST /api/auth/login` với username/password.
- **Thời hạn token**: Mặc định 24 giờ (`86400000 ms`).
- **Cấu trúc Claim**: Chứa `sub: username`, `role: ROLE_...`, `iat: issued_at`, `exp: expiration`.
- **Định dạng gửi kèm request**: Header `Authorization: Bearer <JWT_TOKEN>`.

---

## 2. Quản Trị API Token Dài Hạn (Long-lived JWT API Tokens)

Để phục vụ các công cụ tự động hóa, CI/CD, script quản trị hoặc các hệ thống bên ngoài gọi trực tiếp vào Backend:

### 2.1. Bản Chất Kỹ Thuật
- **Cơ chế token**: API Token sử dụng cơ chế **JWT Token có thời hạn dài (Long-lived JWT Token)** được ký số điện tử bởi `JwtTokenProvider` của Backend.
- **Hạn sử dụng**: Hỗ trợ các mốc linh hoạt theo lựa chọn của người dùng:
  - `1 tháng`, `3 tháng`, `6 tháng`, `12 tháng`, hoặc `0` (Không thời hạn / Vĩnh viễn).

### 2.2. Lưu Trữ & Tra Cứu Trong DynamoDB
Bản ghi API Token được lưu trữ trực tiếp trong trường danh sách `api_tokens` của bản ghi người dùng tại bảng DynamoDB `XRegion-Users`:
```json
{
  "tokenId": "tok-a1b2c3d4",
  "name": "CI-CD-Deploy-Token",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "createdAt": 1731234567890,
  "expiresAt": 1733826567890,
  "durationMonths": 1,
  "active": true
}
```

### 2.3. Quy Trình Thu Hồi Token (Token Revocation)
1. **Yêu cầu thu hồi**: Người dùng gọi `DELETE /api/auth/tokens/{tokenId}` từ Dashboard hoặc API.
2. **Hành vi hệ thống**:
   - Backend tìm bản ghi token tương ứng trong mảng `api_tokens` của user và cập nhật cờ `active = false`.
   - Lưu lại bản ghi user vào DynamoDB.
   - Ghi nhật ký vào `AuditLogService` (`action = REVOKE_API_TOKEN`).
3. **Hiệu lực tức thì**: Ngay sau khi cờ `active` chuyển sang `false`, bộ lọc `JwtAuthenticationFilter` sẽ từ chối mọi yêu cầu tiếp theo mang token này với mã lỗi **`HTTP 401 Unauthorized`**.

---

## 3. Ràng Buộc Kiểm Thử & Chống Sai Lệch Cho Agent (Testing Constraints)

> [!WARNING]
> Khi Agent lập trình hoặc viết test case cho phần Xác thực & Token:
> 1. **CẤM TUYỆT ĐỐI**:
>    - Không được lưu private key hay secret key thô vào code hoặc git.
>    - Không được phép bypass bước kiểm tra quyền sở hữu (`isOwner`) trong `InstanceService` và `NetworkService`.
> 2. **Bộ Test Suite BẮT BUỘC phải bao quát các kịch bản**:
>    - `test_login_success_returns_valid_jwt`: Đăng nhập thành công trả về JWT hợp lệ.
>    - `test_long_lived_api_token_lifecycle`: Tạo API Token, dùng gọi API thành công, thu hồi token (`active=false`) và xác nhận bị chặn HTTP 401.
>    - `test_user_cannot_access_other_users_resources`: Tài khoản user thường không thể truy cập tài nguyên của user khác.

---

## 4. Lịch Sử Phiên Bản (Changelog)

| Ngày | Phiên Bản | Người Thay Đổi | Nội Dung |
| :--- | :--- | :--- | :--- |
| `2026-11-10` | `1.0.0` | Lead Architect / Product Owner | Ban hành tài liệu đặc tả chuẩn hóa hệ thống xác thực JWT và cơ chế quản trị Long-lived API Token. |
