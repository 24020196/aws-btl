// Module 10: EC2 Dashboard (index.html) — Lực
const { test, expect } = require('@playwright/test');
const { createUser, createInstance, loginPage, watchPage, vietnameseLines } = require('./helpers');

test.describe('Module 10: EC2 Dashboard', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'dash');
    await createInstance(request, user, { name: 'dash-a', region: 'ap-southeast-2' });
    await createInstance(request, user, { name: 'dash-b', region: 'us-east-1' });
  });

  test('Bố cục EC2 Dashboard: sidebar, breadcrumb, tiêu đề và nút Khởi tạo', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/index.html');
    await expect(page.locator('#appSidebar a[aria-current="page"], #appSidebar .active').first()).toBeVisible();
    await expect(page.locator('.breadcrumb')).toContainText('EC2');
    await expect(page.locator('.page-title')).toContainText('Bảng điều khiển EC2');
    await expect(page.locator('.page-actions a[href="/launch.html"]')).toBeVisible();
    expect(w.errors, 'Không có lỗi JS').toEqual([]);
  });

  test('Ô Resources hiện số liệu thật của tài khoản (2 máy, 2 vùng)', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/index.html');
    await expect(page.locator('#resInstances')).toHaveText('2');
    await expect(page.locator('#regionAInstanceCount')).toHaveText('1');
    await expect(page.locator('#regionBInstanceCount')).toHaveText('1');
    for (const id of ['#resVolumes', '#resKeys', '#resSgs', '#resSnapshots', '#resEips']) {
      await expect(page.locator(id), `${id} đã có số`).toHaveText(/^\d+$/);
    }
    await expect(page.locator('#resSgs')).toHaveText('2'); // mỗi máy một Security Group riêng
  });

  test('Bảng máy ảo có link sang trang chi tiết', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/index.html');
    const link = page.locator('#overviewInstanceTableBody a[href*="instance-detail.html?id="]').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/instance-detail\.html\?id=i-/);
  });

  test('Chế độ English: không còn chữ tiếng Việt', async ({ page }) => {
    await loginPage(page, user, 'en');
    await page.goto('/index.html');
    await expect(page.locator('.page-title')).toContainText('EC2 Dashboard');
    await expect(page.locator('#resInstances')).toHaveText('2');
    expect(await vietnameseLines(page.locator('main'))).toEqual([]);
  });

  test('Điện thoại 390px: không bị kéo ngang', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginPage(page, user);
    await page.goto('/index.html');
    await expect(page.locator('#resInstances')).toHaveText('2');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});
