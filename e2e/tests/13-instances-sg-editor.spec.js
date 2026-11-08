// Module 13: Nút "Security group" ở trang Máy ảo — xem / thêm / xóa inbound, outbound rule của máy đang chọn
const { test, expect } = require('@playwright/test');
const { createUser, api, createInstance, loginPage, watchPage, vietnameseLines } = require('./helpers');

const row = (page, id) => page.locator(`#instanceTableBody tr:has(input[value="${id}"])`);
const groupOf = async (request, user, id) =>
  (await api(request, user, 'GET', `/network/security-groups?instanceId=${id}`)).data[0];

test.describe('Module 13: Sửa Security Group từ trang Máy ảo', () => {
  let user, a, b;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'sge');
    a = await createInstance(request, user, { name: 'sge-a' });
    b = await createInstance(request, user, { name: 'sge-b' });
  });

  test.beforeEach(async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/instances.html');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(2);
  });

  test('Nút nằm cạnh Làm mới, chỉ sáng khi chọn đúng 1 máy', async ({ page }) => {
    const btn = page.locator('#btnEditSecurityGroup');
    await expect(page.locator('#btnRefreshInstances + #btnEditSecurityGroup')).toHaveCount(1);
    await expect(btn).toBeDisabled();
    await row(page, a.id).locator('.row-checkbox').check();
    await expect(btn).toBeEnabled();
    await row(page, b.id).locator('.row-checkbox').check();
    await expect(btn).toBeDisabled();
    await row(page, b.id).locator('.row-checkbox').uncheck();
    await expect(btn).toBeEnabled();
  });

  test('Mở hộp: hiện đúng nhóm của máy và các rule hiện tại', async ({ page, request }) => {
    const w = watchPage(page);
    const g = await groupOf(request, user, a.id);
    await row(page, a.id).locator('.row-checkbox').check();
    await page.click('#btnEditSecurityGroup');
    const modal = page.locator('#sgEditModal');
    await expect(modal).toHaveClass(/active/);
    await expect(page.locator('#sgeTarget')).toContainText(g.groupId);
    await expect(page.locator('#sgeTarget')).toContainText('sge-a-sg');
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(g.inboundRules.length);
    await expect(page.locator('#lfwOutboundBody tr')).toHaveCount(g.outboundRules.length);
    await expect(page.locator('#lfwInboundCount')).toHaveText(`(${g.inboundRules.length})`);
    await expect(page.locator('#sgeDetailLink')).toHaveAttribute('href', `/instance-detail.html?id=${a.id}#security`);
    expect(w.errors).toEqual([]);
  });

  test('Thêm inbound + outbound, xóa một rule rồi Lưu: server có đúng bộ rule mới, máy kia không đổi', async ({ page, request }) => {
    const w = watchPage(page);
    const before = await groupOf(request, user, a.id);
    const bBefore = await groupOf(request, user, b.id);
    await row(page, a.id).locator('.row-checkbox').check();
    await page.click('#btnEditSecurityGroup');
    await expect(page.locator('#sgeSaveBtn')).toBeEnabled();

    // Thêm inbound Custom TCP 8443 trong VPC
    await page.click('#sgeAddIn');
    await expect(page.locator('#lfwRuleModal')).toHaveClass(/active/);
    await page.selectOption('#lfwType', 'custom-tcp');
    await page.fill('#lfwFrom', '8443');
    await page.fill('#lfwTo', '8443');
    await page.click('#lfwVpcChip');
    await expect(page.locator('#lfwCidr')).toHaveValue('10.0.0.0/16');
    await page.fill('#lfwDesc', 'api noi bo');
    await page.click('#lfwSubmitBtn');
    await expect(page.locator('#lfwRuleModal')).not.toHaveClass(/active/);
    await expect(page.locator('#sgEditModal')).toHaveClass(/active/);
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(before.inboundRules.length + 1);

    // Thêm outbound HTTPS tới 0.0.0.0/0
    await page.click('#sgeAddOut');
    await page.selectOption('#lfwType', 'https');
    await page.click('#lfwSubmitBtn');
    await expect(page.locator('#lfwOutboundBody tr')).toHaveCount(before.outboundRules.length + 1);

    // Xóa rule SSH (22) ở inbound
    await page.locator('#lfwInboundBody tr', { has: page.locator('select option[value="ssh"]:checked') })
      .locator('.lfw-del button').click();
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(before.inboundRules.length);

    const put = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(`/security-groups/instances/${a.id}`));
    await page.click('#sgeSaveBtn');
    expect((await put).ok()).toBeTruthy();
    await expect(page.locator('#sgEditModal')).not.toHaveClass(/active/);
    await expect(page.locator('#toastContainer')).toContainText('sge-a-sg');

    const after = await groupOf(request, user, a.id);
    expect(after.groupId).toBe(before.groupId);
    expect(after.inboundRules.some(r => r.fromPort === 8443 && r.cidr === '10.0.0.0/16' && r.description === 'api noi bo')).toBeTruthy();
    expect(after.inboundRules.some(r => r.fromPort === 22)).toBeFalsy();
    expect(after.outboundRules.some(r => r.protocol === 'tcp' && r.fromPort === 443)).toBeTruthy();

    const bAfter = await groupOf(request, user, b.id);
    expect(bAfter.inboundRules.map(r => r.fromPort).sort()).toEqual(bBefore.inboundRules.map(r => r.fromPort).sort());

    // Mở lại thấy đúng bộ rule đã lưu
    const cb = row(page, a.id).locator('.row-checkbox');
    if (!(await cb.isChecked())) await cb.check();
    await page.click('#btnEditSecurityGroup');
    // Mô tả nằm trong ô nhập nên kiểm theo giá trị ô
    await expect.poll(() => page.locator('#lfwInboundBody input[aria-label="Description"]').evaluateAll(els => els.map(e => e.value)))
      .toContain('api noi bo');
    await expect(page.locator('#lfwInboundBody .lfw-port')).toHaveValue('8443');
    expect(w.errors).toEqual([]);
    expect(w.nativeDialogs).toEqual([]);
  });

  test('Thêm rule trùng thì báo lỗi, không thêm', async ({ page }) => {
    await row(page, b.id).locator('.row-checkbox').check();
    await page.click('#btnEditSecurityGroup');
    await expect(page.locator('#sgeSaveBtn')).toBeEnabled();
    const n = await page.locator('#lfwInboundBody tr').count();
    await page.click('#sgeAddIn');
    await page.selectOption('#lfwType', 'ssh'); // máy mới có sẵn SSH 22 từ 0.0.0.0/0
    await page.fill('#lfwCidr', '0.0.0.0/0');
    await page.click('#lfwSubmitBtn');
    await expect(page.locator('#toastContainer')).toContainText(/đã có|already/);
    await expect(page.locator('#lfwRuleModal')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#lfwRuleModal')).not.toHaveClass(/active/);
    await expect(page.locator('#sgEditModal')).toHaveClass(/active/); // Esc chỉ đóng hộp trên cùng
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(n);
  });

  test('Đóng khi còn thay đổi chưa lưu: hỏi xác nhận; Hủy thì giữ hộp, Bỏ thay đổi thì đóng và không gửi gì', async ({ page }) => {
    const puts = [];
    page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/security-groups/instances/')) puts.push(r.url()); });
    await row(page, b.id).locator('.row-checkbox').check();
    await page.click('#btnEditSecurityGroup');
    await expect(page.locator('#sgeSaveBtn')).toBeEnabled();
    await page.locator('#lfwInboundBody tr .lfw-del button').first().click();

    await page.click('#sgeCancelBtn');
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await page.click('#confirmModal [data-act="cancel"]');
    await expect(page.locator('#sgEditModal')).toHaveClass(/active/);

    await page.click('#sgeCancelBtn');
    await page.click('#confirmModal [data-act="ok"]');
    await expect(page.locator('#sgEditModal')).not.toHaveClass(/active/);
    expect(puts).toEqual([]);
  });

  test('CIDR sai thì không lưu, báo lỗi', async ({ page }) => {
    await row(page, b.id).locator('.row-checkbox').check();
    await page.click('#btnEditSecurityGroup');
    await expect(page.locator('#sgeSaveBtn')).toBeEnabled();
    await page.locator('#lfwInboundBody tr input[list="lfwCidrList"]').first().fill('10.0.0.0/99');
    await page.locator('#lfwInboundBody tr input[list="lfwCidrList"]').first().dispatchEvent('change');
    await page.click('#sgeSaveBtn');
    await expect(page.locator('#toastContainer')).toContainText(/CIDR/);
    await expect(page.locator('#sgEditModal')).toHaveClass(/active/);
  });

  test('English và điện thoại 390px: không sót chữ Việt, hộp không tràn ngang', async ({ page }) => {
    const p2 = await page.context().newPage();
    await p2.setViewportSize({ width: 390, height: 844 });
    await loginPage(p2, user, 'en');
    await p2.goto('/instances.html');
    await row(p2, a.id).locator('.row-checkbox').check();
    await p2.click('#btnEditSecurityGroup');
    await expect(p2.locator('#sgeSaveBtn')).toBeEnabled();
    await expect(p2.locator('#sgeSaveBtn')).toHaveText('Save changes');
    const left = await vietnameseLines(p2.locator('#sgEditModal'), ['#lfwInboundBody', '#lfwOutboundBody']);
    expect(left).toEqual([]);
    const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await p2.close();
  });
});
