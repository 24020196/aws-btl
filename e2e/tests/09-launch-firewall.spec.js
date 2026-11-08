// Module 09: Trang Launch — bước 6 Firewall (Security group) — Lực
const { test, expect } = require('@playwright/test');
const { createUser, api, loginPage, watchPage } = require('./helpers');

test.describe('Module 09: Launch – Firewall (security group)', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'lfw');
  });

  test('Mặc định: inbound SSH, outbound All traffic; bấm Thêm rule mở hộp thoại (không tự thêm HTTPS)', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/launch.html');
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(1);
    await expect(page.locator('#lfwInboundBody select')).toHaveValue('ssh');
    await expect(page.locator('#lfwOutboundBody select')).toHaveValue('all');
    await page.click("button[onclick=\"lfwAdd('inbound')\"]");
    await expect(page.locator('#lfwRuleModal')).toHaveClass(/active/);
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(w.errors).toEqual([]);
  });

  test('Hộp thoại: thêm Custom TCP 8000-8100 trong VPC, chặn rule trùng, cập nhật ô tóm tắt', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/launch.html');
    await page.click("button[onclick=\"lfwAdd('inbound')\"]");
    await page.selectOption('#lfwType', 'custom-tcp');
    await page.fill('#lfwFrom', '8000');
    await page.fill('#lfwTo', '8100');
    await page.click('#lfwVpcChip');
    await expect(page.locator('#lfwCidr')).toHaveValue('10.0.0.0/16');
    await page.click('#lfwSubmitBtn');
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(2);
    await expect(page.locator('#sumSgText')).toContainText('2 inbound');

    // Thêm lại đúng rule đó -> bị từ chối, hộp thoại vẫn mở
    await page.click("button[onclick=\"lfwAdd('inbound')\"]");
    await page.selectOption('#lfwType', 'custom-tcp');
    await page.fill('#lfwFrom', '8000');
    await page.fill('#lfwTo', '8100');
    await page.click('#lfwVpcChip');
    await page.click('#lfwSubmitBtn');
    await expect(page.locator('#toastContainer')).toContainText('đã có');
    await expect(page.locator('#lfwInboundBody tr')).toHaveCount(2);
  });

  test('Cảnh báo khi mở cổng không phải HTTP/HTTPS cho 0.0.0.0/0', async ({ page }) => {
    await loginPage(page, user);
    await page.goto('/launch.html');
    await page.click("button[onclick=\"lfwAdd('inbound')\"]");
    await page.selectOption('#lfwType', 'mysql');
    await expect(page.locator('#lfwModalWarn')).toBeVisible();
    await page.selectOption('#lfwType', 'https');
    await expect(page.locator('#lfwModalWarn')).toBeHidden();
  });

  test('Tạo máy: rule soạn ở bước 6 được ghi vào Security Group riêng của máy', async ({ page, request }) => {
    await loginPage(page, user);
    await page.goto('/launch.html');
    // Local chưa tạo được key pair thật: thêm một lựa chọn key chỉ để test
    await page.evaluate(() => {
      const s = document.getElementById('instKeyPair');
      s.add(new Option('e2e-key', 'e2e-key', true, true));
      s.dispatchEvent(new Event('change'));
    });
    await page.fill('#instName', 'lfw-vm');
    await page.click("button[onclick=\"lfwAdd('inbound')\"]");
    await page.selectOption('#lfwType', 'https');
    await page.click('#lfwSubmitBtn');
    await page.click('#btnLaunchInstance');
    await page.waitForURL(/instances\.html/, { timeout: 20_000 });

    const vm = (await api(request, user, 'GET', '/instances')).data.find(i => i.name === 'lfw-vm');
    expect(vm, 'Máy lfw-vm đã được tạo').toBeTruthy();
    const sg = (await api(request, user, 'GET', `/network/security-groups?instanceId=${vm.id}`)).data[0];
    expect(sg.name).toBe('lfw-vm-sg');
    expect(sg.inboundRules.map(r => r.fromPort).sort((a, b) => a - b)).toEqual([22, 443]);
  });
});
