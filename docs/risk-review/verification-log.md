# Nhật ký kiểm chứng — luồng riêng `xrverify`

File này ghi **quy trình và kết quả kiểm chứng bằng thao tác thật**, để lần sau tiếp tục đúng chỗ.
Không thay thế `current-version-risks.md` (danh mục) hay `decision-log.md` (quyết định).

## Quy tắc cố định (chủ dự án chốt 2026-11-10)

1. **Không kết luận lỗi từ dữ liệu tồn đọng** có nguồn gốc không xác định (có thể do phiên bản backend
   của dev khác tạo ra).
2. **Chỉ xác thực trên tài nguyên do chính lần kiểm chứng tạo ra** — instance, keypair, SG riêng.
3. **Không tái hiện được thì ghi `NOT_REPRODUCED` và bỏ qua**, không sửa code để "phòng" lỗi chưa
   chứng minh, không mở lại mục đã bác bỏ.
4. **Chỉ thao tác bình thường**: không chủ động gây timeout, không gửi trùng, không tạo xung đột,
   không tắt host, không đổi cấu hình dùng chung.
5. Log lịch sử chỉ dùng để **chọn kịch bản**, không dùng làm bằng chứng. Log **phát sinh trong lần
   chạy mới** được dùng, nhưng phải đối chiếu trạng thái tài nguyên thật.
6. Lỗi tái hiện → xác định nguyên nhân có bằng chứng → sửa → **chạy lại cùng kịch bản**.
7. Chấp nhận mất dữ liệu VM thử nghiệm; **không** xóa tài nguyên dùng chung.

## Luồng riêng đã dựng

| Hạng mục | Giá trị |
| --- | --- |
| User xác thực | `xrverify` / `usr-xrverify`, role `USER` |
| Credential | `%TEMP%\xr-verify-cred.txt` (mật khẩu sinh ngẫu nhiên, không dùng lại mật khẩu người khác) |
| Token | `%TEMP%\xr-verify-token.txt` — **đã xoá sau khi kết thúc** |
| Keypair | `key-xrverify-20261110-3b1fb2b0` |
| Instance thử | `i-16438b0a` (`xrverify-inst-01`) |
| Nova | `4795d12d-d4e5-4cf4-82d5-a03be0c918a5` |
| EIP / EBS | `eipalloc-0b55c44fdf90cd75f` (`13.54.177.162`) / `vol-0dd45acf6b2b4156f` |
| SG (1-1) | `4795d12d-d4e5-4cf4-82d5-a03be0c918a5`, `owner=system` |
| Backend dùng để kiểm chứng | `mvn spring-boot:run` trên **mã trong repo**, `http://localhost:8080` |
| Log backend | `%TEMP%\xr-boot1.log` |

Lưu ý: backend chạy từ mã trên đĩa (`VERSION_LOCAL`), **không phải** bản đang phục vụ người dùng —
commit gần nhất `5f8f7c8` (2026-11-09). Không có đường deploy backend trong phiên.

## Kết quả lần chạy 2026-11-10 (17:17–17:49)

### Luồng bình thường — PASS

| Bước | Thời điểm | Kết quả |
| --- | --- | --- |
| Đăng ký + đăng nhập | 17:16 | PASS |
| Tạo keypair | 17:17:00 | PASS — RSA 2048 |
| Tạo instance | 17:17:26 | PASS — HTTP 202, `PENDING` |
| Launch hoàn tất | 17:25 | PASS — `RUNNING`, Nova `ACTIVE`, DDB `RUNNING` (khớp cả 3 nguồn) |
| STOP | 17:27:31 | PASS — `STOPPING` → `STOPPED` trong ~30s |
| START | 17:28:53 | PASS — `PENDING` → `RUNNING` trong ~17s |
| REBOOT | 17:30:46 | PASS — `REBOOTING` → `RUNNING` |

Thời gian launch ~8 phút do SFN poll `XRegion-Network-Verify` lặp lại; đây là đặc tính hiện tại,
chưa kết luận là lỗi.

### Dọn dẹp — PASS (đã kiểm chứng từng tài nguyên)

| Tài nguyên | Kết quả |
| --- | --- |
| Terminate qua UI/API | PASS — `SHUTTING_DOWN` 17:45:30 → `TERMINATED` 17:45:51 |
| DynamoDB `i-16438b0a` | `TERMINATED` |
| Bảng Nova | `4795d12d-…` = `TERMINATED` |
| EBS `vol-0dd45acf6b2b4156f` | **đã xóa** (`InvalidVolume.NotFound`) |
| EIP `eipalloc-0b55c44fdf90cd75f` | **đã giải phóng** (không còn association) |
| EIP pool row | `DELETED` |
| ENI `eni-091eaee3e69e3f42d` | **không xóa — thuộc tài nguyên dùng chung** `RegionB-SecondaryENI-Public`, còn IP của máy khác (15.134.59.23, 13.236.216.123). Đúng nguyên tắc: không xóa tài nguyên dùng chung |

Ghi chú: `XRegion-Instances` từ 39 → **40** bản ghi vì bản ghi của phiên kiểm chứng **được giữ lại có
chủ đích** ở trạng thái `TERMINATED` để truy vết. Đây là quyết định "giữ để truy vết", không phải rác.
Nếu muốn dọn hẳn, cần một chính sách retention riêng (xem XR-RISK-003).


### XR-RISK-002 — `NOT_REPRODUCED`

Trạng thái DynamoDB, bảng Nova và Nova thật **khớp nhau** qua toàn bộ vòng đời stop/start/reboot.
Không tái hiện lệch. Theo quy tắc 3: **bỏ qua, không sửa code**. Các trường hợp lệch thấy trong dữ liệu
tồn đọng (`i-a6d8494b`, `i-ed5ee75f`) không dùng làm căn cứ.

### XR-RISK-003 — `NOT_REPRODUCED`

Bản ghi `PENDING` chuyển sang `RUNNING` bình thường; không để lại bản ghi mồ côi.

### XR-RISK-001 — **`REPRODUCED`** (nguyên nhân gốc đã xác định)

- **Hiện tượng:** `GET /api/network/security-groups?instanceId=i-16438b0a` trả `data: []` dù máy
  `RUNNING` và SG 1-1 tồn tại với đủ rule SSH/ICMP/egress.
- **Nguyên nhân:** `sync_dynamodb.py:105` ghi `"owner": {"S": "system"}`;
  `NetworkService.getSecurityGroups()` lọc bằng `visibleTo()` → `owner.equalsIgnoreCase(username)`
  ⇒ `system` không bao giờ khớp tên người dùng.
- **Phạm vi dữ liệu:** 14/271 SG có `owner=system` ⇒ các máy này không xem/sửa được firewall của mình.
- **Hướng sửa (chưa làm, chờ chọn):**
  - **A.** Backend: cho phép xem SG `owner=system` **khi** chứng minh SG thuộc instance của user
    (phải kiểm qua bảng instance, nếu không sẽ lộ SG người khác). Không cần deploy AWS.
  - **B.** Lambda: ghi `owner` = username chủ máy + migration 14 bản ghi. Đúng gốc nhưng phải deploy.
- **Ràng buộc:** không được nới `visibleTo` thành "cho xem mọi SG system".

## Việc tiếp theo (lần sau)

1. Chọn hướng sửa A hoặc B cho XR-RISK-001.
2. Nếu chọn A: sửa `NetworkService`, thêm test ownership, chạy lại đúng kịch bản trên instance mới.
3. Nếu chọn B: cập nhật `sync_dynamodb.py`, deploy Lambda, migration dữ liệu, rồi kiểm chứng lại.
4. Các mục **chưa kiểm chứng**: 004 (cảnh báo kẹt), 005 (xác nhận phía server), 006–007 (gửi trùng /
   xung đột — không chủ động gây), 008 (đổi ID — không chủ động gây), 010 (payload sai), 011 (giới hạn pool).
5. Harness `test_api_gateway_e2e.py` chưa dùng cho lần này vì có rollback đụng cấu hình Lambda/rule
   dùng chung; vẫn là giới hạn đã biết.

## Cách dựng lại luồng (rút gọn)

```powershell
# 1. Backend từ mã trong repo, tắt job nền tránh cảnh báo rác từ dữ liệu cũ
$env:XREGION_STUCK_TASK_ENABLED='false'; $env:XREGION_SG_SYNC_ENABLED='false'
mvn spring-boot:run -Dspring-boot.run.jvmArguments=-Dxregion.stuck-task.enabled=false

# 2. Tài khoản riêng (không dùng mật khẩu của người khác)
POST /api/auth/register  {"username":"xrverify","password":"<sinh ngẫu nhiên>","role":"USER"}
POST /api/auth/login     -> Bearer token

# 3. Keypair riêng, rồi tạo instance
POST /api/keys            {"name":"key-xrverify-<ngày>"}
POST /api/instances       {"name":"xrverify-inst-NN","flavor":"m1.tiny","imageId":"<Ubuntu-24.04>",...}

# 4. Vòng đời
POST /api/instances/{id}/actions  {"action":"STOP"|"START"|"REBOOT"|"TERMINATE"}
```

Tên tài nguyên luôn có tiền tố `xrverify-` để nhận diện và dọn đúng của mình.
