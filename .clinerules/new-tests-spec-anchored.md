---
paths:
  - "src/test/java/**/*.java"
  - "tests/serverless/**/*.py"
  - "tests/e2e/**/*.js"
---

# Quy ước viết test mới cho xregion

Rule này bật khi đang làm việc với file test. Nhắc lại giới hạn nền: **chỉ tạo file test mới
khi người dùng yêu cầu rõ**; nếu chưa có tín hiệu cấp quyền sửa trong lượt hiện tại thì chỉ
xuất diff trong chat.

## 1. Neo vào đặc tả, không tự suy diễn

- Mỗi test phải truy được về một mục trong `docs/specs/` (`SPEC-01`…`SPEC-07`) hoặc
  `docs/specs/serverless/` (`SPEC-SF-00`…`SPEC-SF-05`); ghi mã Spec hoặc mã rủi ro
  (`XR-RISK-xxx`) trong Javadoc/docstring của class test.
- Không bịa trạng thái máy ảo, ngưỡng thời gian, mã lỗi hay payload mới ngoài Spec đã `APPROVED`.
- Thiếu đặc tả → Pause Protocol, không viết test theo giả định.
- Chỉ kiểm chứng hành vi **đang tồn tại** trong mã nguồn; nếu muốn test hành vi chưa có thì phải
  nêu rõ là đề xuất, không tự thêm code để test xanh.

## 2. Backend Java (`src/test/java/com/iaas/xregion/**`)

- JUnit 5 + AssertJ (`assertThat`, `assertThatThrownBy`) + Mockito; tên file `<Lớp>bổsungTest.java`
  theo lớp được test, package khớp package của lớp đó (ví dụ `service` cho `Services`).
- Không dùng `@SpringBootTest` cho unit test thuần: mock `DynamoDbTable`, `SsmClient`,
  `KeyService`… như `LaunchAdmissionServiceTest` (dùng `RETURNS_DEEP_STUBS` cho `PageIterable`).
- `@DisplayName` viết tiếng Việt, mô tả hành vi; mỗi test một hành vi, tối đa vài assertion cùng
  chủ đề.
- Tôn trọng bất biến nghiệp vụ: không mock để "lách" fail-closed, rollback, hard delete hay các
  ràng buộc trong `business-scope-guard`.

## 3. Serverless Python (`tests/serverless/**`)

- pytest thuần, không gọi AWS thật: dùng `monkeypatch`, fake client và fixture trong chính file,
  đặt tên `test_<chủ_đề>.py`, hàm `test_<hành_vi>`.
- Test phải chạy offline, không phụ thuộc credentials hay region thật.

## 4. UI e2e (`tests/e2e/**`)

- Playwright với cấu trúc `NN-<chủ-đề>.spec.js` hiện có, dùng helper chung trong `helpers.js`.
- Không hard-code dữ liệu máy ảo thật; dùng dữ liệu do `global-setup.js` chuẩn bị.

## 5. Sau khi tạo test

- Chạy đúng file test vừa tạo và báo kết quả thực đo (số pass/fail, thời gian).
- Nếu môi trường không chạy được (thiếu `mvn`/`java` trong PATH, thiếu credentials), báo rõ là
  chưa kiểm chứng được thay vì ngầm định "đã pass".
- Không sửa mã nguồn để làm test xanh khi người dùng chỉ yêu cầu tạo test.
