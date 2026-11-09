# Khôi phục size Cinder và admission — 09/11/2026

Giờ trong báo cáo là UTC+7. Profile `btl`, account `291634989063`, region `ap-southeast-2`.

## Thay đổi và bằng chứng

- Đã gửi quota EIP 15: request `f99aa28cd9c9427cb5608ee938bc2f719lFRxvDm`. Lần đọc lúc 11:54 đã thấy quota có hiệu lực 15, trong khi trạng thái request còn PENDING; giữ riêng hai bằng chứng.
- Source/config/ZIP và revisions trước–sau nằm trong `C:\Users\tuanl\AppData\Local\Temp\xregion-size-admission-20261109-113907`. Artifact có thể chứa bí mật; không đưa vào Git.
- Giữ nguyên CinderPoolManager/EIPPoolManager và target EventBridge. Không tối ưu image, số lượng hoặc size pool. Ubuntu 10 GiB, Alpine 1 GiB, ba volume/image.
- Log host xác nhận hai lỗi extend lịch sử có `read only metadata which needs check first`; một lần khác bị scheduler `NoValidBackend`. Không coi `VFree=0` là đủ bằng chứng hết thin pool.
- Host hiện có loop writable, thin pool data 62.81%, metadata 26.74%. Không resize storage hoặc restart host/Docker.
- ExtendVolume được quản lý/deploy như standalone có shared runtime; GET size thật, kiểm tra ownership, lưu deadline 300 giây và dấu trước POST, workflow poll mỗi năm giây. Không báo thành công từ 202 hoặc bỏ qua lỗi storage/DynamoDB.
- BootNova kiểm tra receipt và size Cinder. AllocateResource lấy original size từ Cinder và kiểm tra flavor/key trước claims. Sync lưu confirmed size riêng requested size; lỗi sync có execution fence.
- Backend và CheckPool dùng parameter `/xregion/ap-southeast-2/launch/admission`. Backend đã được đo trả HTTP503 maintenance mà không tạo record. Giữ 202/PENDING không chứa IP/volume giả.
- Backend đã bỏ image mẫu khỏi fallback launch catalog; kiểm tra UUID, catalog, region, size và ownership key trước ghi record/event.
- Backend mới chạy ẩn trên localhost:8080, PID ghi trong `backend.pid`; JAR backup/log trong artifact.

## Canary đang nghiệm thu

- Instance `i-915edff1`, tên `ping-test-size-20261109-115136`, Ubuntu 24.04, m1.tiny, yêu cầu 12 GiB.
- Nova `7cbb33ad-c1cb-4574-999f-b66e654e526f`; Cinder `80dbbd15-f606-4f06-8ca0-a24011355b4e`, key `cinder-80dbbd15-f60`.
- Guest `192.168.100.19`, frontend `10.20.1.11`, EIP `52.62.141.42`.
- Launch ARN `arn:aws:states:ap-southeast-2:291634989063:execution:LaunchInstance:6ea99599-f165-d9ec-5c08-1b4e496bd81f_e84c4ed3-3103-1836-3509-a1c6af85dd2f`.
- Cinder/DynamoDB xác nhận size 12; LV thực 12884901888 byte. Guest filesystem chưa được xác nhận.
- POST đầu bị HTTP503 do operator dùng username lam trong khi session thuộc admin. Đã đối soát không có instance/event cấp phát, sửa ngoại lệ sang identity thực và gửi lại cùng logical request với marker riêng. Chỉ có một canary được tiếp nhận; không xóa marker hoặc gửi thêm launch.
- Bản ghi trạng thái cuối phải đọc từ artifact `canary-launch-status.json`, `canary-terminate-status.json`, `final-verification.json`, `admission-after.json`, `admission-monitor.json`; nội dung phía trên không thay thế trạng thái live.

## Kiểm tra và tiếp tục an toàn

- 82 Python tests và 35 Java tests liên quan đã pass; JavaScript syntax và diff whitespace đã kiểm tra.
- Operator: `python -B serverless/launch-contract/deployment/size_admission.py --directory <artifact> <action>`.
- Không chạy lại `deploy` hoặc `launch` trên thư mục này. Các action đọc trạng thái/tiếp tục: `status`, `connectivity`, `terminate`, `terminate-status`, `replenish`, `verify`, `finish`, `monitor`.
- Chỉ terminate canary sau launch SUCCEEDED và connectivity đạt; cleanup lỗi giữ claims, không reset owner hoặc xóa theo prefix.
- `finish` chỉ mở khi nghiệm thu có bằng chứng, quota >=15 và pool đạt target; `monitor` theo dõi 30 phút và đóng admission nếu có workflow mới FAILED/TIMED_OUT/ABORTED.
- Không tự replay FAILED lịch sử, không xóa dd hoặc canary cũ. Rollback code/config/ASL cần kiểm tra execution đang dùng contract mới; rollback không khôi phục volume canary đã xóa.

## K?t qu? nghi?m thu th?c ?o

- Launch **SUCCEEDED**: 2026-11-09T11:53:46.782000+07:00 ? 2026-11-09T12:01:27.925000+07:00. Backend RUNNING, requested/confirmed size ??u 12 GiB.
- Terminate **SUCCEEDED**: 2026-11-09T12:10:51.876000+07:00 ? 2026-11-09T12:11:26.262000+07:00. Backend TERMINATED.
- Terminate ARN `arn:aws:states:ap-southeast-2:291634989063:execution:TerminateInstance:3a004d96-2f8b-9b39-3130-72633242d455_ce987291-a517-8304-0cae-137d0988a6f9`.
- L?n ?o k?t n?i cu?i: ping 10/10, 0% loss, trung b?nh 238 ms; TCP22 tr? OpenSSH banner. Hai l?n ?o gi?a l?c boot c? 9/10; raw evidence ???c gi?, kh?ng thay ??i SG/timeout ?? ?p k?t qu?. Cloud-init ho?n t?t l?c 12:06:58.
- Ch?a nghi?m thu SSH ??ng nh?p b?ng private key v? filesystem trong guest. Cinder/LV 12 GiB ?? ???c x?c minh ??c l?p.
- Host x?c nh?n Nova/port/SG/volume 404, LV/NAT/frontend ?? d?n; claims tr? ??ng owner, EIP v? pool. dd v? canary c? gi? nguy?n.
- Pool ph?t sinh m?t volume thay th? `344f0826-baca-4e04-83d5-f162bbcfa266` v? m?t EIP d? ph?ng m?i; ??y l? pool refill, kh?ng ph?i canary b? s?t. Target/logic pool v? EventBridge targets kh?ng thay ??i.
- Quota request ?? **APPROVED**, gi? tr? c? hi?u l?c **15**. Admission ?? **open**, ngo?i l? canary ?? g?. ?ang theo d?i 30 ph?t; ch? coi ho?n t?t khi `admission-monitor.json` c? `complete=true`.
- Backend ?? ki?m ch?ng HTTP503 maintenance kh?ng t?o record; sau open, image m?u/region sai/size ?m tr? HTTP400, instance inventory kh?ng ??i.

### M? Lambda sau deploy

| Function | CodeSha256 | RevisionId |
|---|---|---|
| XRegion-LaunchInstance-CheckPool | `3ePUTOPJtfA+RfgFSX5kY9+gJR6peKjEqXQVjHyOHQE=` | `104db3d5-67e1-4f0e-b49b-f7335eadaeb6` |
| XRegion-LaunchInstance-AllocateResource | `tKhJ8f5wVanDngQl/onVafFElrRB9qiq7bu1tKH5A9I=` | `c97079f4-a9f2-4de6-ab92-08894385bcc5` |
| XRegion-LaunchInstance-ExtendVolume | `7EiVRk950liZoOfAtU97dYkT0J+36tH1z3O36oZorFc=` | `4f0c8945-7088-485b-8135-418a901cdcb1` |
| XRegion-LaunchInstance-BootNova | `VXaEHn82TCea4yzWgVxarJe6rahwrIXrjaxPi8JKZJw=` | `c583ebd3-9856-434e-8582-0e42ae8584dd` |
| XRegion-LaunchInstance-SyncDynamoDB | `hW/OZRdCKi2HS9r/T5unse4bLWN4zeIsXFPpH6sI7f8=` | `f7f31a88-23fe-4f4b-a9b1-773a4e0ca5e8` |
