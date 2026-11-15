# SPEC-09: Danh Mục Flavor và Image Được Hỗ Trợ

> **Phiên bản**: `1.1.0`<br>
> **Trạng thái**: `APPROVED (CHÍNH THỨC)`<br>
> **Cập nhật lần cuối**: `2026-11-15`<br>
> **Tác giả / Người phê duyệt**: Chủ dự án (yêu cầu trực tiếp; xác nhận tên `mini`)<br>
> **Tài liệu cha**: [SPEC-00](SPEC-00-AGENT-SCOPE-GUARD.md)

## 1. Danh mục duy nhất

Quy định áp dụng cho UI, API, dữ liệu catalog, Warm Pool, Launch và Migration tại cả `us-east-1` và `ap-southeast-2`.

| Loại | Danh mục được hỗ trợ | Mặc định |
| :--- | :--- | :--- |
| Flavor | Chính xác 2 loại: `tiny`, `mini` | `tiny` (giữ tên kỹ thuật hiện tại `m1.tiny`) |
| Image | Chính xác 1 image: `cirros-0.6.2-x86_64` | `cirros-0.6.2-x86_64` |

Thông số đã được chủ dự án xác nhận, áp dụng giống nhau tại hai vùng:

| Flavor logic | Tên Nova | ID Nova | vCPU | RAM (MiB) | Root disk (GiB) |
| :--- | :--- | :--- | ---: | ---: | ---: |
| `tiny` | `m1.tiny` | `1` | 1 | 1024 | 1 |
| `mini` | `m1.mini` | `2` | 1 | 2048 | 1 |

- Tên Glance phải chính xác là `cirros-0.6.2-x86_64`, trạng thái `active`; mỗi host chỉ có một image chưa bị xóa.
- UUID CirrOS Virginia: `831dc24b-9d29-4cb6-8154-9de2d0fd268f`; Sydney: `8f3dcc28-0ca1-4ed8-899c-c92eae02fef0`. Giữ nguyên UUID và nội dung khi chuẩn hóa tên.

- Tên đã xác nhận là `mini`, không phải `miny`.
- Không cung cấp thêm flavor `small`, `medium`, `large` hoặc các loại khác ngoài hai loại đã nêu.
- Không cung cấp Alpine, Ubuntu hoặc image/version khác ngoài `cirros-0.6.2-x86_64`.
- Tên và ID flavor phải đúng bảng trên; `mini` ánh xạ tới `m1.mini` ID `2`, không ánh xạ tới `m1.small` hoặc `m1.medium`. UUID Glance phải đối chiếu đúng vùng.
- UUID Glance của `cirros-0.6.2-x86_64` có thể khác giữa hai vùng. Một image logic không có nghĩa là dùng chung một UUID ở mọi vùng. Không hardcode UUID của vùng nguồn làm image launch tại vùng đích.

## 2. Hợp đồng UI, API và dữ liệu

- UI/API tại mỗi vùng chỉ đưa ra hai lựa chọn flavor `tiny`, `mini` và một lựa chọn image `cirros-0.6.2-x86_64`.
- Tên/ID gửi trong request phải ánh xạ chính xác tới flavor hoặc image thuộc danh mục được hỗ trợ trong vùng được chọn.
- Nếu request không gửi flavor, áp dụng mặc định `m1.tiny` theo SPEC-05. Flavor rỗng hoặc nằm ngoài danh mục không hợp lệ; không âm thầm chuyển sang một flavor khác.
- `imageId` vẫn là UUID bắt buộc, tồn tại trong catalog và thuộc `cirros-0.6.2-x86_64` tại đúng vùng. Không fallback sang một UUID cũ hoặc hệ điều hành khác.
- Dữ liệu của nhiều vùng có thể chứa các UUID riêng cho cùng image logic; mỗi vùng chỉ công bố một lựa chọn `cirros-0.6.2-x86_64`, không hiển thị chúng thành nhiều hệ điều hành.
- Catalog đang triển khai có dữ liệu ngoài phạm vi trên phải được ghi nhận là chưa khớp đặc tả. Việc cập nhật spec không tự cho phép xóa image, flavor, volume hoặc máy ảo đang có.

## 3. Warm Pool và pipeline

- Pool Manager chỉ bù boot volume cho `cirros-0.6.2-x86_64` trong đúng vùng, dung lượng boot pool `1 GiB`; giới hạn `AVAILABLE + CREATING <= 5` mỗi vùng theo SPEC-SF-03.
- Launch chỉ cấp phát volume có `image_id` khớp UUID CirrOS đã xác minh ở vùng đích và khớp backend `aws-ebs` / `aws-ebs-gp3`.
- Migration bảo toàn dữ liệu đĩa và flavor nguồn trong hai loại `tiny`/`mini`; vùng đích phải có ánh xạ flavor tương ứng. Không dùng fallback `m1.medium` hoặc tự thay đổi cấu hình máy.
- Không tự chuyển một máy đang chạy hệ điều hành khác thành CirrOS khi sửa catalog.

## 4. Nghiệm thu

- Nghiệm thu catalog trực tiếp trên Nova/Glance của hai EC2 tách khỏi nghiệm thu toàn hệ thống. Đợt chuẩn hóa host không đồng nghĩa DynamoDB/backend đã đồng bộ hoặc API test đã đạt.
- So sánh UUID, checksum và hash CirrOS trước–sau; đối chiếu VM, flavor VM tham chiếu, volume, attachment, snapshot và mạng. Bảo toàn cấu hình EC2 và giữ bản sao Alpine đã kiểm tra checksum, đọc lại được cho tới khi nghiệm thu xong cả hai host.

- Kiểm tra danh mục tại cả hai vùng: đúng hai flavor logic `tiny`, `mini` và đúng một image logic `cirros-0.6.2-x86_64`.
- API test chọn UUID image theo vùng từ catalog và volume pool hợp lệ; không dùng UUID cố định từ môi trường/vùng khác.
- Kiểm tra flavor mặc định khi bỏ qua trường; kiểm tra từ chối flavor rỗng/ngoài danh mục và image không hợp lệ.
- Lifecycle và migration giữ nguyên kiểm tra trạng thái cuối, khóa migration và dọn dẹp tài nguyên.
- Chỉ công bố nghiệm thu theo đặc tả này khi cấu hình triển khai và các bài test liên quan cùng đáp ứng; kết quả chạy trước thời điểm cập nhật không tự chứng minh catalog mới đã được triển khai.

## 5. Lịch sử phiên bản

| Ngày | Phiên bản | Người xác nhận | Nội dung |
| :--- | :--- | :--- | :--- |
| `2026-11-15` | `1.0.0` | Chủ dự án (yêu cầu trực tiếp) | Giới hạn hai flavor `tiny`/`mini` và một image `CirrOS-0.6.2`; áp dụng đồng bộ UI/API, catalog, pool và pipeline hai vùng. |
| `2026-11-15` | `1.1.0` | Chủ dự án (kế hoạch đã duyệt) | Xác nhận tên cirros-0.6.2-x86_64; m1.tiny ID 1: 1 vCPU/1024 MiB/1 GiB, m1.mini ID 2: 1 vCPU/2048 MiB/1 GiB; UUID theo vùng và giới hạn nghiệm thu catalog host. |
