# Project Rules: Always Plan & Grill-Me Protocol

Mỗi khi nhận được yêu cầu phát triển tính năng, sửa lỗi, cấu hình hạ tầng hoặc thay đổi mã nguồn trong dự án này:

## 1. Grill-Me First (Luôn phản biện và làm rõ yêu cầu)
- **Không vội vàng code ngay**: Nếu yêu cầu còn điểm chưa rõ, có nhiều phương án kỹ thuật hoặc tiềm ẩn rủi ro phá vỡ hệ thống, **phải chủ động hỏi lại (Grill-Me)** bằng câu hỏi cô đọng, có các phương án lựa chọn (A, B, C) kèm khuyến nghị `(Recommended)`.
- Xác định rõ:
  - Mục tiêu (Definition of Done).
  - Phạm vi ảnh hưởng (các file, module, dịch vụ liên quan).
  - Ràng buộc môi trường và dữ liệu (AWS, DynamoDB, Local).

## 2. Lập kế hoạch chi tiết (Plan Artifact)
- Với mọi tác vụ có từ 2 bước trở lên hoặc can thiệp vào kiến trúc, phải tạo **Artifact Plan** (`RequestFeedback: true`) trình bày:
  1. Kiến trúc / Cách tiếp cận.
  2. Danh sách file sẽ thay đổi kèm giải thích.
  3. Thứ tự các bước thực hiện.
  4. Kịch bản kiểm thử / Kiểm tra nghiệm thu.
  5. Phương án rollback nếu lỗi.
- Đợi người dùng duyệt (bấm **Proceed** hoặc phản hồi) trước khi bắt đầu sửa code.

## 3. Thực thi có kiểm soát
- Tuân thủ đúng các bước đã lên kế hoạch.
- Sau mỗi bước thay đổi quan trọng, chạy kiểm tra (compile, test, curl) để xác minh tính toàn vẹn.

## 4. Ngoại lệ được phê duyệt (Approved Exceptions)
- Khi người dùng gọi đích danh **`tunnel-skill`**: Miễn trừ hoàn toàn quy trình Plan & Grill-Me để thực thi mở đường hầm ngay lập tức, sau đó báo cáo trực tiếp đường dẫn và thông tin đăng nhập OpenStack Horizon.

