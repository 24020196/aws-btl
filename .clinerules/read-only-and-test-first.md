# QUY TẮC BẤT BIẾN: Cline KHÔNG ĐƯỢC SỬA (Read-Only & Test-First)

> **Độ ưu tiên**: CAO NHẤT trong workspace này. Khi mâu thuẫn với `AGENTS.md`, `GEMINI.md`,
> `docs/specs/*` hoặc bất kỳ rule/skill nào khác, **rule này thắng**. Cụ thể: mệnh lệnh
> "triển khai ngay kế hoạch đã duyệt" trong `AGENTS.md` **không** phải là quyền sửa file.
>
> **Phạm vi**: toàn bộ workspace `xregion` (mã nguồn Java, serverless/Lambda, test, cấu hình,
> tài nguyên AWS/OpenStack, file tạm).

## 1. Mặc định: CHỈ ĐỌC

Được phép:

- Đọc, tìm kiếm, phân tích mã nguồn, tài liệu `docs/specs/`, log, trạng thái Git (lệnh chỉ đọc).
- Chạy build/compile và chạy test để xác minh (Maven, pytest, Playwright).
- Ghi **artifact build/cache** vào thư mục đã bị Git bỏ qua: `target/`, `**/__pycache__/`,
  `.pytest_cache/`, `tests/e2e/test-results/`.

Bị cấm tuyệt đối khi chưa được cấp quyền ở Mục 2:

- Tạo, sửa, xóa, đổi tên, di chuyển **bất kỳ** file/thư mục nào trong workspace (kể cả file
  test, file rule, file tài liệu, `.env`, `pom.xml`, `package.json`).
- Chạy các lệnh ghi: `git add/commit/checkout/reset/clean/stash`, `mvn` có mục tiêu ghi ngoài
  `target/`, script tạo/xóa file, `Set-Content`, `Remove-Item`, `npm install` trong repo...
- Can thiệp AWS (Lambda, Step Functions, DynamoDB, SSM, IAM, EventBridge...), AWS Toolkit,
  OpenStack/OpenStack Horizon: không deploy, không xóa, không tạo, không sửa tham số.
- Tạo payload JSON, ZIP triển khai, script trung gian hay thư mục scratch trong workspace
  (dùng `$env:TEMP` khi thật sự cần).

Mọi thay đổi muốn đề xuất **BẮT BUỘC** trình bày dưới dạng **diff Markdown trong chat**, kèm
đường dẫn tuyệt đối, để người dùng tự áp dụng hoặc cấp quyền.

## 2. Điều kiện duy nhất để được ghi

Chỉ khi **chính lượt nhắn hiện tại** của người dùng chứa tín hiệu cấp quyền tường minh:

- `CHO PHÉP SỬA`, `FIX`, `IMPLEMENT`, hoặc câu tương đương nêu rõ "sửa/tạo <đường dẫn>".

Quy tắc thực thi quyền:

- Quyền **chỉ có hiệu lực trong lượt đó** và **chỉ trong phạm vi được nêu**. Hết lượt (hoặc sang
  chủ đề mới) → quay lại read-only, không suy diễn quyền cũ.
- Quyền không bao giờ mở rộng sang: xóa file có sẵn, `git push`, hay thay đổi tài nguyên
  AWS/OpenStack, trừ khi người dùng nêu đích danh.
- Được phép ghi đúng phần tối thiểu để hoàn thành yêu cầu; cấm "tiện tay" refactor, format lại
  file khác, đổi tên biến ngoài phạm vi.
- Nếu phát hiện cần sửa ngoài phạm vi đã cấp: dừng, nêu rõ file/hành động cần thêm quyền, chờ
  người dùng trả lời. Không tự mở rộng.

## 3. Test: chỉ tạo khi được yêu cầu, và phải bám Spec

- **Không tự sinh test case mới** khi người dùng không yêu cầu; không "nhân tiện" thêm test vào
  file test có sẵn.
- **Mệnh lệnh tạo rule KHÔNG bao gồm quyền tạo test.** Câu như "tạo rule X, tạo test Y" được
  hiểu là *nội dung của rule*, không phải lệnh viết test cho dự án.
- **Plan Mode thắng mọi rule/skill khác**: khi lượt nhắn ở chế độ plan, tuyệt đối không tạo/sửa
  file (kể cả rule, test, tài liệu) và không chạy lệnh ghi; chỉ xuất diff trong chat.
- Chọn phương án trong câu hỏi làm rõ **không** phải tín hiệu cấp quyền; quyền chỉ đến từ
  `CHO PHÉP SỬA` / `FIX` / `IMPLEMENT` kèm phạm vi, trong lượt act.
- File test mới chỉ được tạo khi người dùng yêu cầu rõ (ví dụ: "tạo test mới cho X"). Tạo file
  mới **không** được kéo theo việc sửa mã nguồn hay sửa test cũ.
- Trước khi viết test: đọc Spec tương ứng trong `docs/specs/` và
  `docs/specs/serverless/`. Nếu hành vi chưa được đặc tả → **Pause Protocol** theo
  `docs/specs/SPEC-00-AGENT-SCOPE-GUARD.md`, không tự bịa enum/trạng thái/ngưỡng.
- **Cấm sửa test đang có để "cho xanh"**, cấm nới lỏng assertion, cấm `@Disabled` để né lỗi.
  Test đỏ là thông tin, phải báo lại nguyên nhân.

## 4. Trước khi tuyên bố hoàn thành

- Báo cáo trung thực: file đã tạo/sửa kèm đường dẫn, lệnh đã chạy, **kết quả thực đo**
  (pass/fail, số test), phần **chưa kiểm chứng được** và lý do.
- Xác nhận không có thay đổi ngoài phạm vi (`git status`), không xóa/dọn thay đổi có sẵn của
  người dùng.
- Không tuyên bố đã triển khai AWS nếu chỉ mới sửa file local.
