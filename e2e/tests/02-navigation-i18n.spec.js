// Module 02: Khung chung mọi trang — sidebar, header, ngôn ngữ, giao diện điện thoại
const { test, expect } = require('@playwright/test');
const { createUser, createInstance, loginPage, watchPage, vietnameseLines } = require('./helpers');

const PAGES = [
  { path: '/index.html', active: '/index.html' },
  { path: '/instances.html', active: '/instances.html' },
  { path: '/launch.html', active: '/launch.html' },
  { path: '/account-tokens.html', active: '/account-tokens.html' }
];

test.describe('Module 02: Điều hướng và ngôn ngữ', () => {
  let user, vm;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'nav');
    vm = await createInstance(request, user, { name: 'nav-vm' });
  });

  for (const p of PAGES) {
    test(`Sidebar ở ${p.path}: đủ 4 mục, đúng mục đang sáng, không lỗi JS`, async ({ page }) => {
      const w = watchPage(page);
      await loginPage(page, user);
      await page.goto(p.path);
      await expect(page.locator('#appSidebar .sidebar-item')).toHaveCount(4);
      await expect(page.locator('#appSidebar .sidebar-item.active')).toHaveAttribute('href', p.active);
      expect(w.errors).toEqual([]);
      expect(w.nativeDialogs).toEqual([]);
    });
  }

  test('Bấm từng mục sidebar thì sang đúng trang', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/index.html');
    for (const href of ['/instances.html', '/launch.html', '/account-tokens.html', '/index.html']) {
      await page.click(`#appSidebar .sidebar-item[href="${href}"]`);
      await expect(page).toHaveURL(new RegExp(href.replace('.', '\\.')));
    }
  });

  test('Thu gọn sidebar được và vẫn giữ sau khi tải lại trang', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instances.html');
    await page.click('#appSidebar .sidebar-collapse-btn');
    await expect(page.locator('#appSidebar')).toHaveClass(/collapsed/);
    await page.reload();
    await expect(page.locator('#appSidebar')).toHaveClass(/collapsed/);
    await page.click('#appSidebar .sidebar-collapse-btn');
    await expect(page.locator('#appSidebar')).not.toHaveClass(/collapsed/);
  });

  test('Đổi ngôn ngữ ở header: đổi ngay trên trang và giữ khi sang trang khác', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instances.html');
    await expect(page.locator('#userBadgeContainer')).toContainText('Đăng xuất');
    await page.selectOption('#userBadgeContainer .header-lang-select', 'en');
    await expect(page.locator('#userBadgeContainer')).toContainText('Sign out');
    await expect(page.locator('#appSidebar .sidebar-item[href="/instances.html"]')).toContainText('Instances');

    await page.click('#appSidebar .sidebar-item[href="/account-tokens.html"]');
    await expect(page.locator('#userBadgeContainer')).toContainText('Sign out');
    await expect(page.locator('#userBadgeContainer .header-lang-select')).toHaveValue('en');

    await page.selectOption('#userBadgeContainer .header-lang-select', 'vi');
    await expect(page.locator('#userBadgeContainer')).toContainText('Đăng xuất');
  });

  const EN_PAGES = [
    ['/index.html', []],
    ['/instances.html', ['#instanceTableBody', '.toast-container']],
    ['/launch.html', ['#flavorMatrixBody', '#instImage', '.toast-container']],
    ['/account-tokens.html', ['#apiTokensTableBody', '.toast-container']]
  ];
  for (const [path, ignore] of EN_PAGES) {
    test(`English ở ${path}: không còn chữ tiếng Việt trong khung trang`, async ({ page }) => {
      await loginPage(page, user, 'en');
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const left = await vietnameseLines(page.locator('body'), ignore);
      expect(left, `Chữ tiếng Việt còn sót ở ${path}`).toEqual([]);
    });
  }

  test('Điện thoại 390px: nút menu mở sidebar, bấm nền tối để đóng', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginPage(page, user);
    await page.goto('/instances.html');
    const toggle = page.locator('#sidebarMobileToggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('#appSidebar')).toHaveClass(/open/);
    await page.mouse.click(380, 600); // bấm vào nền tối bên phải sidebar
    await expect(page.locator('#appSidebar')).not.toHaveClass(/open/);
  });

  for (const path of ['/index.html', '/instances.html', '/launch.html', '/account-tokens.html', 'detail', 'edit']) {
    test(`Điện thoại 390px: ${path} không bị kéo ngang`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await loginPage(page, user);
      const url = path === 'detail' ? `/instance-detail.html?id=${vm.id}`
        : path === 'edit' ? `/instance-edit.html?id=${vm.id}&section=tags` : path;
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${url} rộng hơn màn hình ${overflow}px`).toBeLessThanOrEqual(1);
    });
  }
});
