// Module 07: Security Group riêng của từng máy (tab Security) — Lực
const { test, expect } = require('@playwright/test');
const { createUser, api, createInstance, loginPage, watchPage } = require('./helpers');

test.describe('Module 07: Security Group riêng của máy', () => {
  let user, vmA, vmB;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'sg');
    vmA = await createInstance(request, user, { name: 'sg-a' });
    vmB = await createInstance(request, user, { name: 'sg-b' });
  });

  test('Mỗi máy có đúng một nhóm riêng <tên-máy>-sg, hai máy khác nhóm', async ({ request }) => {
    const a = await api(request, user, 'GET', `/network/security-groups?instanceId=${vmA.id}`);
    const b = await api(request, user, 'GET', `/network/security-groups?instanceId=${vmB.id}`);
    expect(a.data).toHaveLength(1);
    expect(a.data[0].name).toBe('sg-a-sg');
    expect(a.data[0].groupId).not.toBe(b.data[0].groupId);
  });

  test('Không tạo / đổi nhóm được (chỉ thêm, xóa rule)', async ({ request }) => {
    const create = await api(request, user, 'POST', '/network/security-groups', { name: 'shared', description: 'x' });
    expect(create.status).toBe(400);
    const legacy = await api(request, user, 'PUT', `/network/security-groups/instances/${vmA.id}`, { groupIds: ['sg-default'] });
    expect(legacy.status).toBe(400);
  });

  test('Tài khoản khác không thấy và không sửa được nhóm của máy này', async ({ request }) => {
    const other = await createUser(request, 'sgx');
    const r = await api(request, other, 'GET', `/network/security-groups?instanceId=${vmA.id}`);
    expect(r.status).toBe(404);
    const list = await api(request, other, 'GET', '/network/security-groups');
    expect(list.data).toEqual([]);
  });

  test('Tab Security: thêm inbound rule qua hộp thoại, lọc, rồi xóa bằng hộp xác nhận', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto(`/instance-detail.html?id=${vmA.id}#security`);
    await expect(page.locator('#sgChips')).toContainText('sg-a-sg');
    await expect(page.locator('#sgChips')).not.toContainText('dùng chung');
    const before = await page.locator('#inboundRulesBody tr').count();

    await page.click("button[onclick=\"openAddRuleModal('inbound')\"]");
    await expect(page.locator('#addRuleModal')).toHaveClass(/active/);
    await page.selectOption('#ruleType', 'custom-tcp');
    await page.fill('#ruleFromPort', '8443');
    await page.fill('#ruleToPort', '8443');
    await page.fill('#ruleCidr', '10.0.0.0/16');
    await page.fill('#ruleDesc', 'e2e api');
    await page.click('#addRuleModal button[type=submit]');
    await expect(page.locator('#inboundRulesBody tr')).toHaveCount(before + 1);
    await expect(page.locator('#inboundRulesBody')).toContainText('8443');

    await page.fill('#ruleFilter', '8443');
    await expect(page.locator('#inboundRulesBody tr')).toHaveCount(1);
    await expect(page.locator('#inboundCount')).toHaveText(`(1/${before + 1})`);

    await page.locator('#inboundRulesBody tr', { hasText: '8443' }).getByRole('button').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await page.click('#confirmModal [data-act="ok"]');
    await page.fill('#ruleFilter', '');
    await expect(page.locator('#inboundRulesBody tr')).toHaveCount(before);
    expect(w.nativeDialogs).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  test('Thêm rule ở máy A không ảnh hưởng máy B', async ({ request }) => {
    const ga = (await api(request, user, 'GET', `/network/security-groups?instanceId=${vmA.id}`)).data[0];
    await api(request, user, 'POST', '/network/security-groups', {
      groupId: ga.groupId, inboundRules: [{ protocol: 'tcp', fromPort: 9000, toPort: 9000, cidr: '10.0.0.0/16' }]
    });
    const gb = (await api(request, user, 'GET', `/network/security-groups?instanceId=${vmB.id}`)).data[0];
    expect(gb.inboundRules.some(r => r.fromPort === 9000)).toBeFalsy();
  });
});
