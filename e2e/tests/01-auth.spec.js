// Module 01: Đăng nhập, đăng ký, đăng xuất (login.html, register.html)
const { test, expect } = require('@playwright/test');
const { createUser, loginPage, watchPage } = require('./helpers');

test.describe('Module 01: Đăng nhập / Đăng ký / Đăng xuất', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'auth');
  });

  test('Trang đăng nhập mở không lỗi JS, có chọn ngôn ngữ và nút Đăng nhập', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/login.html');
    await expect(page.locator('#xrLangSelect')).toBeVisible();
    await expect(page.locator('#authUsername')).toBeVisible();
    await expect(page.locator('#loginBtn')).toBeEnabled();
    expect(w.errors).toEqual([]);
  });

  test('Ô "Hiển thị mật khẩu" đổi kiểu ô mật khẩu', async ({ page }) => {
    await page.goto('/login.html');
    await expect(page.locator('#authPassword')).toHaveAttribute('type', 'password');
    await page.check('#showPasswordCheck');
    await expect(page.locator('#authPassword')).toHaveAttribute('type', 'text');
    await page.uncheck('#showPasswordCheck');
    await expect(page.locator('#authPassword')).toHaveAttribute('type', 'password');
  });

  test('"Tài khoản mẫu?" mở hộp gợi ý và bấm tự điền admin / admin123', async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('#authUsername', '');
    await page.fill('#authPassword', '');
    await page.click('a[onclick="toggleTroubleBox()"]');
    await expect(page.locator('#troubleHintBox')).toBeVisible();
    await page.click('#troubleHintBox a[onclick="fillDefaultAdminCredentials()"]');
    await expect(page.locator('#authUsername')).toHaveValue('admin');
    await expect(page.locator('#authPassword')).toHaveValue('admin123');
  });

  test('Sai mật khẩu: hiện hộp lỗi và vẫn ở trang đăng nhập', async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('#authUsername', user.username);
    await page.fill('#authPassword', 'sai-mat-khau');
    await page.click('#loginBtn');
    await expect(page.locator('#loginErrorBox')).toBeVisible();
    await expect(page.locator('#loginErrorBox')).toContainText('Lỗi đăng nhập');
    await expect(page).toHaveURL(/login\.html/);
    await expect(page.locator('#loginBtn')).toBeEnabled();
  });

  test('Đăng nhập đúng: chuyển sang danh sách máy ảo, header có tên và nút Đăng xuất', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/login.html');
    await page.fill('#authUsername', user.username);
    await page.fill('#authPassword', user.password);
    await page.click('#loginBtn');
    await page.waitForURL(/instances\.html/);
    await expect(page.locator('#userBadgeContainer')).toContainText('Đăng xuất');
    expect(await page.evaluate(() => !!localStorage.getItem('xregion_jwt'))).toBeTruthy();
    expect(w.errors).toEqual([]);
  });

  test('Đã đăng nhập mà mở lại trang đăng nhập thì tự về danh sách máy ảo', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/login.html');
    await page.waitForURL(/instances\.html/);
  });

  test('Chưa đăng nhập mà mở trang trong: chuyển về đăng nhập, giữ trang muốn mở ở ?redirect', async ({ page }) => {
    for (const path of ['/index.html', '/instances.html', '/launch.html', '/account-tokens.html']) {
      await page.goto(path);
      await expect(page).toHaveURL(/login\.html\?redirect=/);
      expect(new URL(page.url()).searchParams.get('redirect')).toBe(path);
    }
  });

  test('Đăng nhập xong thì quay lại đúng trang đã muốn mở', async ({ page }) => {
    await page.goto('/account-tokens.html');
    await expect(page).toHaveURL(/login\.html\?redirect=/);
    await page.fill('#authUsername', user.username);
    await page.fill('#authPassword', user.password);
    await page.click('#loginBtn');
    await page.waitForURL(u => u.pathname === '/account-tokens.html');
  });

  test('?redirect trỏ ra trang web khác thì bỏ qua, về danh sách máy ảo', async ({ page }) => {
    await page.goto('/login.html?redirect=' + encodeURIComponent('//evil.example.com/x'));
    await page.fill('#authUsername', user.username);
    await page.fill('#authPassword', user.password);
    await page.click('#loginBtn');
    await page.waitForURL(u => u.host.startsWith('localhost') && u.pathname === '/instances.html');
  });

  test('Đăng xuất từ header: xóa token, về trang đăng nhập, "Ghi nhớ tài khoản" điền sẵn tên', async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('#authUsername', user.username);
    await page.fill('#authPassword', user.password);
    await expect(page.locator('#rememberAccountBox')).toBeChecked();
    await page.click('#loginBtn');
    await page.waitForURL(/instances\.html/);

    await page.click('#userBadgeContainer button[onclick="logout()"]');
    await page.waitForURL(/login\.html/);
    expect(await page.evaluate(() => localStorage.getItem('xregion_jwt'))).toBeNull();
    await expect(page.locator('#authUsername')).toHaveValue(user.username);
  });

  test('Đăng ký: mật khẩu nhập lại không khớp thì báo lỗi, không gửi đi', async ({ page }) => {
    await page.goto('/register.html');
    await page.fill('#regFullName', 'E2E Register');
    await page.fill('#regUsername', `reg${Date.now().toString(36)}`);
    await page.fill('#regPassword', 'Passw0rd!1');
    await page.fill('#regConfirmPassword', 'Passw0rd!2');
    await page.click('#regBtn');
    await expect(page.locator('#registerErrorBox')).toBeVisible();
    await expect(page.locator('#registerErrorBox')).toContainText('không trùng khớp');
    await expect(page).toHaveURL(/register\.html/);
  });

  test('Đăng ký thành công: về trang đăng nhập có sẵn tên, đăng nhập được bằng tài khoản mới', async ({ page }) => {
    const username = `reg${Date.now().toString(36)}`;
    await page.goto('/register.html');
    await page.fill('#regFullName', 'E2E Register');
    await page.fill('#regUsername', username);
    await page.fill('#regPassword', 'Passw0rd!1');
    await page.fill('#regConfirmPassword', 'Passw0rd!1');
    await page.click('#regBtn');
    await page.waitForURL(/login\.html/);
    await expect(page.locator('#authUsername')).toHaveValue(username);

    await page.fill('#authPassword', 'Passw0rd!1');
    await page.click('#loginBtn');
    await page.waitForURL(/instances\.html/);
  });

  test('Đăng ký trùng tên đăng nhập: hiện lỗi từ server', async ({ page }) => {
    await page.goto('/register.html');
    await page.fill('#regFullName', 'Dup');
    await page.fill('#regUsername', user.username);
    await page.fill('#regPassword', 'Passw0rd!1');
    await page.fill('#regConfirmPassword', 'Passw0rd!1');
    await page.click('#regBtn');
    await expect(page.locator('#registerErrorBox')).toBeVisible();
    await expect(page).toHaveURL(/register\.html/);
  });

  test('Đổi ngôn ngữ ở trang đăng nhập sang English: chữ trên form đổi theo', async ({ page }) => {
    await page.goto('/login.html');
    await page.selectOption('#xrLangSelect', 'en');
    await expect(page.locator('#loginBtn')).toContainText(/Sign in/i);
    await page.selectOption('#xrLangSelect', 'vi');
    await expect(page.locator('#loginBtn')).toContainText(/Đăng nhập/i);
  });
});
