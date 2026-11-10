# Project Rules: Always Plan & Grill-Me Protocol (BẮT BUỘC VĨNH VIỄN)

> [!IMPORTANT]
> **QUY TẮC BẤT BIẾN (IMMUTABLE MANDATE)**:
> Mọi yêu cầu từ người dùng trong toàn bộ dự án này — **kể cả khi người dùng KHÔNG nhắc đến các từ khóa "plan" hay "grill me"** — ĐỀU BẮT BUỘC phải tuân thủ nghiêm ngặt và tuần tự quy trình chuẩn bị trước khi thực thi. Tuyệt đối không được bỏ qua hoặc tự ý code / cấu hình hạ tầng trước khi có sự phê duyệt rõ ràng từ người dùng.

---

## 0. Phase 0: Spec-First & Scope Guard (Bắt buộc kiểm tra Đặc tả Nghiệp vụ)
- **Đọc tài liệu chuẩn trước khi hành động**: Trước khi Grill-Me hoặc lập Plan, Agent BẮT BUỘC phải đối soát nghiệp vụ với bộ tài liệu trong `docs/specs/` và `docs/specs/serverless/` (`SPEC-00` đến `SPEC-07`, `SPEC-SF-00` đến `SPEC-SF-05`).
- **Cấm tự suy diễn (Zero-Speculation)**: Tuyệt đối không tự bịa enum, không tự sinh luồng xử lý và không tự viết test case ngoài phạm vi đã định nghĩa trong Spec.
- **Kích hoạt Pause Protocol khi chưa có Spec**: Nếu nghiệp vụ chưa được ghi rõ trong Spec, Agent BẮT BUỘC phải tạm ngưng ngay và thông báo người dùng cập nhật Spec (tăng version), không được tự ý tiếp tục.

---

## 1. Phase 1: Grill-Me First (Luôn phản biện và làm rõ yêu cầu)
- **Không vội vàng code hay chạy lệnh ngay**: Dù yêu cầu có vẻ đơn giản, luôn phải rà soát các phương án kỹ thuật, ràng buộc môi trường và rủi ro tiềm ẩn.
- **Chủ động hỏi lại (Grill-Me)**:
  - Sử dụng công cụ `ask_question` hoặc câu hỏi ngắn gọn, trúng trọng tâm.
  - Luôn đưa ra các phương án lựa chọn cụ thể (A, B, C) kèm khuyến nghị `(Recommended)`.
  - Làm rõ mục tiêu (Definition of Done), phạm vi ảnh hưởng (file, module, dịch vụ liên quan), và ràng buộc dữ liệu (AWS, DynamoDB, OpenStack, Local).

---

## 2. Phase 2: Lập kế hoạch chi tiết (Plan Artifact)
- Sau khi đã thống nhất ý định qua Grill-Me, **bắt buộc tạo Markdown Plan Artifact** trong thư mục brain với metadata:
  ```json
  "ArtifactMetadata": {
    "Summary": "Kế hoạch chi tiết triển khai...",
    "UserFacing": true,
    "RequestFeedback": true
  }
  ```
- **Nội dung bắt buộc trong Plan**:
  1. Kiến trúc / Cách tiếp cận (Mermaid Diagram nếu có nhiều luồng).
  2. Danh sách file & tài nguyên sẽ thay đổi kèm giải thích.
  3. Thứ tự từng bước thực hiện cụ thể.
  4. Kịch bản kiểm thử & Tiêu chí nghiệm thu rõ ràng.
  5. Phương án rollback an toàn nếu phát sinh lỗi.
- **Ràng buộc phê duyệt**: **CHỈ BẮT ĐẦU SỬA CODE / CHẠY LỆNH SAU KHI NGƯỜI DÙNG BẤM "PROCEED" HOẶC ĐỒNG Ý TRỰC TIẾP**.

---

## 3. Phase 3: Thực thi có kiểm soát & Tự kiểm tra
- Thực hiện chính xác theo các bước đã cam kết trong bản Plan đã duyệt.
- Sau mỗi bước quan trọng, thực thi lệnh xác minh tính toàn vẹn (compile, test, curl, status check).
- Luôn tuân thủ quy chuẩn **Zero-Workspace File Pollution**: Tuyệt đối không để file tạm, zip, json trung gian trong workspace.

---

## 4. Ngoại lệ Duy nhất Được Phê Duyệt (Approved Exception)
- **Khi người dùng gọi đích danh `tunnel-skill`**: Miễn trừ quy trình Plan & Grill-Me để thực thi mở đường hầm SSM port-forwarding ngay lập tức, sau đó báo cáo trực tiếp URL và thông tin đăng nhập OpenStack Horizon.
