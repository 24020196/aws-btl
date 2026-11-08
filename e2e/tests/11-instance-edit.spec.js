// Module 11: Trang chỉnh sửa máy ảo (instance-edit.html?id=...&section=...)
const { test, expect } = require('@playwright/test');
const { createUser, api, createInstance, loginPage, watchPage } = require('./helpers');

const SECTIONS = ['instance-type', 'security-groups', 'elastic-ip', 'dns', 'storage', 'key-pair', 'tags', 'cooldown'];

test.describe('Module 11: Chỉnh sửa máy ảo', () => {
  let user, vm;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'edit');
    vm = await createInstance(request, user, { name: 'edit-vm' });
  });

  test.beforeEach(async ({ page }) => {
    await loginPage(page, user);
  });

  test('Mỗi ?section chỉ mở đúng một khung, có tiêu đề riêng, breadcrumb về trang chi tiết', async ({ page }) => {
    const w = watchPage(page);
    const titles = new Set();
    for (const sec of SECTIONS) {
      await page.goto(`/instance-edit.html?id=${vm.id}&section=${sec}`);
      await expect(page.locator(`#panel-${sec}`)).toHaveClass(/active/);
      await expect(page.locator('.ec2-sec-panel.active')).toHaveCount(1);
      await expect(page.locator('#editRoInstanceId')).toHaveText(vm.id);
      titles.add((await page.locator('#editPageTitle').innerText()).trim());
    }
    expect(titles.size, 'Mỗi khung một tiêu đề khác nhau').toBe(SECTIONS.length);
    await expect(page.locator('#editBreadcrumbDetailLink')).toHaveAttribute('href', `/instance-detail.html?id=${encodeURIComponent(vm.id)}`);
    await expect(page.locator('#btnCancelEditInstance')).toHaveAttribute('href', `/instance-detail.html?id=${encodeURIComponent(vm.id)}`);
    expect(w.errors).toEqual([]);
  });

  test('section không hợp lệ thì mở khung Loại máy', async ({ page }) => {
    await page.goto(`/instance-edit.html?id=${vm.id}&section=khong-co`);
    await expect(page.locator('#panel-instance-type')).toHaveClass(/active/);
  });

  test('Đổi loại máy khi máy đang chạy: ô chọn và nút Lưu bị khóa', async ({ page }) => {
    await page.goto(`/instance-edit.html?id=${vm.id}&section=instance-type`);
    await expect(page.locator('#editCurrentFlavorDisplay')).toHaveText(vm.flavor);
    await expect(page.locator('#editInstFlavor')).toBeDisabled();
    await expect(page.locator('#btnSaveEditInstance')).toBeDisabled();
  });

  test('Ổ EBS: giảm dung lượng thì hiện cảnh báo và khóa Lưu, tăng lại thì mở', async ({ page }) => {
    await page.goto(`/instance-edit.html?id=${vm.id}&section=storage`);
    const input = page.locator('#editInstEbsSize');
    await expect(input).toHaveValue(/\d+/);
    const current = Number(await input.inputValue());
    await input.fill(String(current - 5));
    await expect(page.locator('#ebsDownsizeWarning')).toBeVisible();
    await expect(page.locator('#btnSaveEditInstance')).toBeDisabled();
    await input.fill(String(current + 10));
    await expect(page.locator('#ebsDownsizeWarning')).toBeHidden();
    await expect(page.locator('#btnSaveEditInstance')).toBeEnabled();
  });

  test('Đổi tên (Tags): lưu xong về trang chi tiết và hiện tên mới', async ({ page, request }) => {
    const w = watchPage(page);
    await page.goto(`/instance-edit.html?id=${vm.id}&section=tags`);
    await expect(page.locator('#editInstName')).toHaveValue('edit-vm');
    await page.fill('#editInstName', 'edit-vm-renamed');
    await page.click('#btnSaveEditInstance');
    await page.waitForURL(new RegExp(`instance-detail\\.html\\?id=${vm.id}`));
    await expect(page.locator('body')).toContainText('edit-vm-renamed');
    const r = await api(request, user, 'GET', `/instances/${vm.id}`);
    expect(r.data.name).toBe('edit-vm-renamed');
    expect(w.errors).toEqual([]);
  });

  // PUT /instances/{id} chưa lưu cooldownSeconds (InstanceService.updateInstance): bật lại khi backend làm xong
  test.fixme('Thời gian cooldown: lưu 600 giây thì API trả về 600', async ({ page, request }) => {
    await page.goto(`/instance-edit.html?id=${vm.id}&section=cooldown`);
    await page.fill('#editInstCooldown', '600');
    await page.click('#btnSaveEditInstance');
    await page.waitForURL(/instance-detail\.html/);
    const r = await api(request, user, 'GET', `/instances/${vm.id}`);
    expect(r.data.cooldownSeconds).toBe(600);
  });

  test('ID không tồn tại: hiện thông báo lỗi, không vỡ trang', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/instance-edit.html?id=i-khongtontai&section=tags');
    await expect(page.locator('#apiErrorBanner')).toBeVisible();
    expect(w.errors.filter(e => !/404|Failed to load|không tìm thấy|not found/i.test(e))).toEqual([]);
  });
});
