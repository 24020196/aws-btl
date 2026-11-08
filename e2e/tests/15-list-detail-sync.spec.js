// Module 15: Trang danh sách và trang chi tiết đồng bộ với nhau — Lực
const { test, expect } = require('@playwright/test');
const { createUser, createInstance, loginPage, watchPage } = require('./helpers');

async function selectRow(page, id) {
  await page.locator(`#instanceTableBody tr:has(input[value="${id}"]) .row-checkbox`).check();
}

test.describe('Module 15: Đồng bộ trang Máy ảo và trang chi tiết', () => {
  let user, vm;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'sync');
    vm = await createInstance(request, user, { name: 'sync-vm' });
  });

  test('Badge trạng thái giống nhau ("Đang chạy") ở trang chủ, danh sách và chi tiết', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/index.html');
    await expect(page.locator('#overviewInstanceTableBody .ec2-state').first()).toHaveText(/Đang chạy/);
    await page.goto('/instances.html');
    await expect(page.locator(`#instanceTableBody tr:has(input[value="${vm.id}"]) .ec2-state`)).toHaveText(/Đang chạy/);
    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await expect(page.locator('#detStatusBadge')).toHaveText(/Đang chạy/);
  });

  test('Menu Trạng thái máy ảo: cùng tên mục và cùng quy tắc khóa ở hai trang', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instances.html');
    await selectRow(page, vm.id);
    await page.click('#btnInstanceStateMenu');
    const listItems = page.locator('#instanceStateDropdown [onclick^="handleBulkAction"]');
    const listNames = (await listItems.allInnerTexts()).map(s => s.trim());
    await expect(listItems.nth(0)).toBeDisabled(); // Start khi máy đang chạy

    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await page.click('#stateMenuBtn');
    const detailItems = page.locator('#stateMenuList [role=menuitem]');
    const detailNames = (await detailItems.allInnerTexts()).map(s => s.trim());
    await expect(detailItems.nth(0)).toBeDisabled();
    expect(listNames).toEqual(detailNames);
  });

  test('Menu Hành động: hai trang có cùng các nhóm và mục con', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instances.html');
    await selectRow(page, vm.id);
    await page.click('#btnActionsMenu');
    const listGroups = (await page.locator('#actionsDropdown .ec2-actions-group').allInnerTexts()).map(s => s.replace(/\s+/g, ' ').trim());

    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await page.click('#ec2ActionsBtn');
    const detailGroups = (await page.locator('#ec2ActionsList .ec2-actions-group').allInnerTexts()).map(s => s.replace(/\s+/g, ' ').trim());
    expect(listGroups).toEqual(detailGroups);
  });

  test('Hộp Kết nối: cùng nội dung ở hai trang', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instances.html');
    await selectRow(page, vm.id);
    await page.click('#btnConnectInstance');
    const listText = (await page.locator('#connectModal .modal-card').innerText()).replace(/\s+/g, ' ');

    await page.goto(`/instance-detail.html?id=${vm.id}`);
    await page.locator('#detailActionButtons button', { hasText: 'Kết nối' }).click();
    const detailText = (await page.locator('#connectModal .modal-card').innerText()).replace(/\s+/g, ' ');
    expect(listText).toBe(detailText);
  });

  test('Xóa máy ở trang danh sách dùng hộp xác nhận của trang, không dùng confirm() trình duyệt', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/instances.html');
    await selectRow(page, vm.id);
    await page.click('#btnInstanceStateMenu');
    await page.click('#instanceStateDropdown button[onclick*="TERMINATE"]');
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await expect(page.locator('#confirmModal [data-act="ok"]')).toBeDisabled();
    await page.click('#confirmModal [data-act="cancel"]');
    expect(w.nativeDialogs).toEqual([]);
    expect(w.errors).toEqual([]);
  });
});
