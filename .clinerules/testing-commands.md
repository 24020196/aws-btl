---
paths:
  - "**"
---

# Lệnh kiểm chứng của dự án xregion (chỉ đọc & chạy test)

Đây là tài liệu tham chiếu lệnh; **không** cấp quyền sửa file. Xem `read-only-and-test-first.md`.

## 1. Backend Maven (Spring Boot 3.2.3, Java 17)

```powershell
# Chạy toàn bộ unit test
mvn -q test

# Chạy 1 lớp test
mvn -q -Dtest=LaunchAdmissionServiceScopeTest test

# Build không chạy test
mvn -q -DskipTests package
```

Báo cáo kết quả: `target/surefire-reports/*.txt`.

Nếu `mvn`/`java` **không có trong PATH** (máy hiện tại đúng là vậy), dùng JDK có sẵn:

```powershell
# JDK hợp lệ: 17..21 (dự án dùng release 17)
$jdk = 'C:\Users\tuanl\.jdks\temurin-21.0.12.1'
& "$jdk\bin\java.exe" -version

# Maven wrapper trong ~/.m2/wrapper/dists/apache-maven-3.9.16/.../bin/mvn.cmd
Get-ChildItem "$env:USERPROFILE\.m2\wrapper\dists" -Recurse -Filter mvn.cmd |
  Select-Object -First 1 -ExpandProperty FullName

# Chạy test bằng classpath đã build (không cần Maven)
$cp = 'target\test-classes;target\classes'   # + các jar trong ~\.m2\repository
& "$jdk\bin\java.exe" -cp $cp org.junit.platform.console.ConsoleLauncher `
  execute -c com.iaas.xregion.service.LaunchAdmissionServiceScopeTest
```

## 2. Serverless Python

```powershell
cd tests\serverless
python -m pytest -q test_launch_contract.py
python -m pytest -q            # toàn bộ
```

## 3. UI e2e Playwright

```powershell
cd tests\e2e
npm test                       # hoặc: npx playwright test
npx playwright test tests\05-launch.spec.js
```

## 4. Ghi nhớ

- Chỉ ghi vào `target/`, `__pycache__/`, `.pytest_cache/`, `tests/e2e/test-results/`.
- Không `npm install` ghi đè `package-lock.json` khi chưa được cấp quyền sửa.
- Không gọi AWS/OpenStack thật khi chạy test; nếu test cần credentials thì báo là chưa kiểm chứng.
