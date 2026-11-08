// Module 12: Tài khoản & API Token (account-tokens.html)
const { test, expect } = require('@playwright/test');
const { createUser, loginPage, watchPage } = require('./helpers');

test.describe('Module 12: Tài khoản & API Token', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'tok');
  });

  test.beforeEach(async ({ page }) => {
    await loginPage(page, user);
  });

  test('Hồ sơ hiện đúng tên đăng nhập, họ tên, quyền; chưa có token thì hiện dòng trống', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/account-tokens.html');
    await expect(page.locator('#profUsername')).toHaveText(user.username);
    await expect(page.locator('#profFullName')).toHaveText('E2E Test');
    await expect(page.locator('#profRole')).toContainText('ROLE_');
    await expect(page.locator('#apiTokensTableBody')).toContainText('Chưa có API Token');
    expect(w.errors).toEqual([]);
  });

  test('Tạo token: hiện mã một lần, có dòng mới trong bảng', async ({ page }) => {
    await page.goto('/account-tokens.html');
    await page.fill('#tokenName', 'ci-deploy');
    await page.selectOption('#tokenDuration', '0');
    await page.click('#createTokenForm button[type="submit"]');
    await expect(page.locator('#tokenDisplayBox')).toBeVisible();
    const code = (await page.locator('#newGeneratedTokenCode').innerText()).trim();
    expect(code.length).toBeGreaterThan(20);
    await expect(page.locator('#tokenName')).toHaveValue('');
    const tokenRow = page.locator('#apiTokensTableBody tr', { hasText: 'ci-deploy' });
    await expect(tokenRow).toBeVisible();
    await expect(tokenRow).toContainText('Hoạt động');
    await expect(tokenRow.locator('code').first()).toHaveText(/^tok-/); // cột Token ID có mã thật, không phải "-"
    await expect(tokenRow).toContainText('Không thời hạn');
  });

  // Server chưa nhận API Token (xreg_...) ở header Authorization, chỉ nhận JWT: bật lại khi backend làm xong
  test.fixme('API Token vừa tạo dùng gọi API được (Authorization: Bearer xreg_...)', async ({ request }) => {
    const r = await request.post('/api/auth/login', { data: { username: user.username, password: user.password } });
    const jwt = (await r.json()).data.token;
    const created = await request.post('/api/auth/tokens', { headers: { Authorization: `Bearer ${jwt}` }, data: { name: 'cli', durationMonths: 1 } });
    const code = (await created.json()).data.token;
    const me = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${code}` } });
    expect(me.ok()).toBeTruthy();
  });

  test('Thu hồi token: hộp xác nhận của trang, Hủy thì giữ nguyên, Thu hồi thì đổi trạng thái', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/account-tokens.html');
    await page.fill('#tokenName', 'to-revoke');
    await page.click('#createTokenForm button[type="submit"]');
    const tokenRow = page.locator('#apiTokensTableBody tr', { hasText: 'to-revoke' });
    await expect(tokenRow).toContainText('Hoạt động');

    await tokenRow.locator('button[onclick^="revokeToken"]').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await page.click('#confirmModal [data-act="cancel"]');
    await expect(tokenRow).toContainText('Hoạt động');

    await tokenRow.locator('button[onclick^="revokeToken"]').click();
    await page.click('#confirmModal [data-act="ok"]');
    await expect(tokenRow).toContainText('Đã thu hồi');
    await expect(tokenRow.locator('button[onclick^="revokeToken"]')).toHaveCount(0);
    expect(w.nativeDialogs).toEqual([]);
  });

  test('Đổi mật khẩu: đăng nhập được bằng mật khẩu mới, mật khẩu cũ bị từ chối', async ({ page, request }) => {
    const u = await createUser(request, 'pwd');
    const p2 = await page.context().newPage();
    await loginPage(p2, u);
    await p2.goto('/account-tokens.html');
    await p2.fill('#oldPassword', u.password);
    await p2.fill('#newPassword', 'NewPassw0rd!');
    await p2.click('#changePasswordForm button[type="submit"]');
    await expect(p2.locator('#oldPassword')).toHaveValue('');

    const okNew = await request.post('/api/auth/login', { data: { username: u.username, password: 'NewPassw0rd!' } });
    expect(okNew.ok()).toBeTruthy();
    const okOld = await request.post('/api/auth/login', { data: { username: u.username, password: u.password } });
    expect(okOld.ok()).toBeFalsy();
    await p2.close();
  });

  test('Đổi mật khẩu với mật khẩu cũ sai: báo lỗi cho người dùng', async ({ page }) => {
    const messages = [];
    page.on('dialog', d => { messages.push(d.message()); d.dismiss().catch(() => {}); });
    await page.goto('/account-tokens.html');
    await page.fill('#oldPassword', 'sai-mat-khau');
    await page.fill('#newPassword', 'Whatever1!');
    await page.click('#changePasswordForm button[type="submit"]');
    // Hiện tại trang báo lỗi bằng alert() của trình duyệt (chưa dùng hộp thông báo của trang)
    await expect.poll(() => messages.join(' | ') || page.locator('#toastContainer').innerText()).toMatch(/thất bại|sai|incorrect|wrong/i);
  });

  test('English: hồ sơ và bảng token đổi sang tiếng Anh', async ({ page }) => {
    const p2 = await page.context().newPage();
    await loginPage(p2, user, 'en');
    await p2.goto('/account-tokens.html');
    await expect(p2.locator('#userBadgeContainer')).toContainText('Sign out');
    await expect(p2.locator('#apiTokensTableBody')).toContainText(/Active|Revoked/);
    await p2.close();
  });
});
