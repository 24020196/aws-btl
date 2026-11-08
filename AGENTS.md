# Quy tắc Codex cho dự án xregion

## Phạm vi

Các hướng dẫn này áp dụng cho dự án hiện tại. Giữ nguyên thay đổi có sẵn của người dùng. `GEMINI.md` phục vụ Antigravity; đây là hướng dẫn tương ứng cho Codex.

## Grill-Me và Plan Mode trước thay đổi

- Áp dụng [always-plan-and-grillme](.agents/skills/always-plan-and-grillme/SKILL.md) trước khi sửa code, cấu hình hoặc tài nguyên.
- Dùng quy trình Plan Mode trong skill trên: khảo sát trước, làm rõ quyết định còn thiếu bằng `request_user_input` khi khả dụng, rồi trình bày kế hoạch hoàn chỉnh trong khối `<proposed_plan>`.
- Skill không tự chuyển chế độ phiên. Khi cần lập kế hoạch mới ngoài Plan Mode, hướng dẫn dùng `/plan`; trong Plan Mode không sửa file hoặc thay đổi tài nguyên.
- Khi phiên chuyển sang chế độ thực thi và người dùng yêu cầu triển khai kế hoạch đã chấp thuận, thực hiện ngay trong phạm vi đó, không hỏi duyệt lại bằng từ khóa.
- Chỉ hỏi bổ sung khi thiếu quyết định cần thiết hoặc thay đổi phạm vi/quyền; không hỏi lại thông tin đã xác nhận. Lỗi kỹ thuật thông thường được xử lý trong phạm vi đã chấp thuận.

## Skill nghiệp vụ chỉ gọi đích danh

| Skill | Công việc |
| --- | --- |
| [aws-skill](.agents/skills/aws-skill/SKILL.md) | AWS CLI và làm việc cùng AWS Toolkit |
| [ec2-skill](.agents/skills/ec2-skill/SKILL.md) | EC2 qua SSM, Ubuntu và OpenStack |
| [team-skill](.agents/skills/team-skill/SKILL.md) | Hai agent Backend và AWS sau khi duyệt kế hoạch |
| [tunnel-skill](.agents/skills/tunnel-skill/SKILL.md) | Tunnel SSM tới Horizon ở localhost:8888 |

- Chỉ vận hành 4 skill trên khi người dùng yêu cầu dùng skill tương ứng bằng tên, ví dụ `$aws-skill` hoặc `dùng aws-skill kiểm tra Lambda ...`.
- Việc hỏi cách dùng, đọc, sửa hoặc cài skill không phải yêu cầu vận hành AWS, mở tunnel, tạo goal hoặc khởi chạy đội agent.
- Khi người dùng gọi `team-skill` để làm việc, việc đó cho phép điều phối hai agent theo kế hoạch đã duyệt; các yêu cầu khác không tự kích hoạt đội agent.
- **Ngoại lệ cho `tunnel-skill`**: khi được gọi để mở tunnel và chế độ phiên cho phép thực thi, bỏ qua bước lập kế hoạch và Grill-Me, thực hiện ngay trong quyền của phiên; không tạo/sửa file để vận hành tunnel. Ngoại lệ này không vượt giới hạn Plan Mode: khi vẫn ở Plan Mode, chỉ khảo sát hoặc lập kế hoạch, không mở tunnel.

## File tạm và công cụ

- Không tạo payload JSON, ZIP triển khai, script trung gian hoặc thư mục scratch trong workspace. Đây không phải hạn chế đối với mã nguồn, test hoặc cấu hình cần bàn giao.
- Ưu tiên tham số inline được quote đúng shell. Khi cần file tạm, dùng thư mục riêng trong `$env:TEMP` (Windows) hoặc thư mục tạm hệ điều hành khác, theo quyền filesystem của phiên.
- Giữ bản sao lưu cần khôi phục tới khi nghiệm thu; chỉ xóa file tạm do tác vụ tạo. Kiểm tra đường dẫn tuyệt đối trước khi xóa đệ quy, không dọn thay đổi có sẵn của người dùng.
- AWS Toolkit và AWS CLI có thể dùng nguồn credentials khác nhau. Xác minh STS, profile và region của CLI trước khi thay đổi AWS; file Lambda mở trong Toolkit chưa chứng minh mã đã được triển khai.
- Chỉ sử dụng công cụ thật sự có trong phiên. Không giả định có quyền điều khiển giao diện AWS Toolkit hoặc lệnh đặc biệt từ IDE khác.

## Nghiệm thu

Chạy kiểm tra phù hợp thay đổi, báo rõ kết quả thực đo và phần chưa kiểm chứng. Kiểm tra diff và bảo toàn các file ngoài phạm vi. `.agents` hiện bị Git bỏ qua; kiểm tra trực tiếp file skill, không coi `git diff` là đủ.
