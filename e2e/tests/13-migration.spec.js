// Module 13: Chuyển vùng (tab Migration, snapshot, lỗi theo ngôn ngữ) — Lực
const { test, expect } = require('@playwright/test');
const { createUser, api, createInstance, loginPage, watchPage } = require('./helpers');

test.describe('Module 13: Fast Migrate X-Region', () => {
  let user, vm;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'mig');
    vm = await createInstance(request, user, { name: 'mig-vm', region: 'ap-southeast-2' });
  });

  test('Bấm Fast Migrate: hộp xác nhận có downtime/IP/cooldown, rồi tự cuộn tới 6 bước và chạy tới Hoàn tất', async ({ page }) => {
    test.setTimeout(90_000);
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}#migration`);
    await page.click('#btnMigrateTab');
    await expect(page.locator('#migrateModal')).toHaveClass(/active/);
    await expect(page.locator('#migrateModalFacts .mig-fact')).toHaveCount(3);
    await page.click('#btnConfirmMigrate');

    // Khung 6 bước nằm trọn trong màn hình sau khi tự cuộn
    const card = page.locator('#migPipelineCard');
    await expect(card).toBeInViewport({ ratio: 0.9 });

    await expect(page.locator('#logStatus')).toHaveText('Hoàn tất', { timeout: 60_000 });
    await expect(page.locator('#detPipeline .det-step.done')).toHaveCount(6);
    expect(w.errors).toEqual([]);
  });

  test('Sau khi chuyển: máy ở us-east-1, có 2 snapshot (nguồn + bản sao), vẫn giữ Security Group', async ({ request, page }) => {
    const inst = (await api(request, user, 'GET', `/instances/${vm.id}`)).data;
    expect(inst.region).toBe('us-east-1');
    const snaps = (await api(request, user, 'GET', `/migrations/snapshots?instanceId=${vm.id}`)).data;
    expect(snaps).toHaveLength(2);
    expect(snaps.map(s => s.region).sort()).toEqual(['ap-southeast-2', 'us-east-1']);
    const sg = (await api(request, user, 'GET', `/network/security-groups?instanceId=${vm.id}`)).data;
    expect(sg[0].name).toBe('mig-vm-sg');

    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}#storage`);
    await expect(page.locator('#snapCount')).toHaveText('(2)');
  });

  test('Đang cooldown: nút Fast Migrate bị khóa, API trả lỗi đúng ngôn ngữ (?lang=en / vi)', async ({ page, request }) => {
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vm.id}#migration`);
    await expect(page.locator('#btnMigrateTab')).toBeDisabled();
    const en = await api(request, user, 'POST', '/migrations/trigger?lang=en', { id: vm.id });
    expect(en.status).toBe(409);
    expect(en.body.message).toMatch(/cooldown/i);
    const vi = await api(request, user, 'POST', '/migrations/trigger?lang=vi', { id: vm.id });
    expect(vi.body.message).toMatch(/thời gian Cooldown/);
  });
});
