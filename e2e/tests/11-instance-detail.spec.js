// Module 11: Trang chi tiết máy ảo (instance-detail.html) — Lực
const { test, expect } = require('@playwright/test');
const { createUser, createInstance, loginPage, watchPage, vietnameseLines } = require('./helpers');

test.describe('Module 11: Instance summary', () => {
  let user, vm;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'det');
    vm = await createInstance(request, user, { name: 'detail-vm' });
  });

  test('Tiêu đề "Tóm tắt máy ảo i-xxx (tên)" và breadcrumb EC2 › Máy ảo › i-xxx', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await expect(page.locator('#detInstanceId')).toHaveText(vm.id);
    await expect(page.locator('#detInstanceName')).toHaveText('(detail-vm)');
    await expect(page.locator('#breadcrumbInstanceId')).toHaveText(vm.id);
    await expect(page.locator('#sumId')).toHaveText(vm.id);
    expect(w.errors).toEqual([]);
  });

  test('Đủ 6 tab và mở đúng tab theo #hash', async ({ page }) => {
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}#networking`);
    await expect(page.locator('#tab-networking')).toHaveClass(/active/);
    for (const tab of ['details', 'security', 'networking', 'storage', 'monitoring', 'migration']) {
      await page.click(`#tabBtn-${tab}`);
      await expect(page.locator(`#tab-${tab}`)).toHaveClass(/active/);
      await expect(page).toHaveURL(new RegExp(`#${tab}$`));
    }
  });

  test('Menu Trạng thái máy ảo: máy đang chạy thì khóa "Khởi động máy ảo"', async ({ page }) => {
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await page.click('#stateMenuBtn');
    const items = page.locator('#stateMenuList [role=menuitem]');
    await expect(items.nth(0)).toBeDisabled();   // Start
    await expect(items.nth(1)).toBeEnabled();    // Stop
  });

  test('Xóa máy dùng hộp xác nhận của trang (phải gõ tên máy), không dùng confirm() trình duyệt', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await page.click('#stateMenuBtn');
    await page.locator('#stateMenuList [role=menuitem]').last().click();
    const ok = page.locator('#confirmModal [data-act="ok"]');
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await expect(ok).toBeDisabled();
    await page.fill('#confirmInput', 'detail-vm');
    await expect(ok).toBeEnabled();
    await page.click('#confirmModal [data-act="cancel"]');
    await expect(page.locator('#confirmModal')).not.toHaveClass(/active/);
    expect(w.nativeDialogs).toEqual([]);
  });

  test('ID không tồn tại: hiện trang "Không tìm thấy máy ảo" có nút về danh sách', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instance-detail.html?id=i-khongco');
    await expect(page.locator('.det-empty-title')).toContainText('Không tìm thấy máy ảo');
    await expect(page.locator('.det-empty a[href="/instances.html"]')).toBeVisible();
  });

  test('Đổi sang English ngay trên trang: mọi tab đều không còn chữ tiếng Việt', async ({ page }) => {
    await loginPage(page, user, 'vi');
    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await expect(page.locator('#detInstanceId')).toHaveText(vm.id);
    await page.selectOption('.header-lang-select', 'en');
    for (const tab of ['details', 'security', 'networking', 'storage', 'monitoring', 'migration']) {
      await page.click(`#tabBtn-${tab}`);
      await page.waitForTimeout(500);
      // Bảng rule là dữ liệu (mô tả rule do người dùng / nhóm cũ đặt) nên không tính
      const left = await vietnameseLines(page.locator('main'), ['#inboundRulesBody', '#outboundRulesBody']);
      expect(left, `Tab ${tab}`).toEqual([]);
    }
  });
});
