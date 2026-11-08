// Module 04: Trang danh sách máy ảo (instances.html)
// Không test Start / Stop / Reboot / Terminate thật (API /actions đang được sửa) — chỉ test giao diện quanh nó.
const { test, expect } = require('@playwright/test');
const { createUser, createInstance, loginPage, watchPage, vietnameseLines } = require('./helpers');

const row = (page, id) => page.locator(`#instanceTableBody tr:has(input[value="${id}"])`);

test.describe('Module 04: Danh sách máy ảo', () => {
  let user, a, b, c;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'list');
    a = await createInstance(request, user, { name: 'alpha-web', region: 'ap-southeast-2' });
    b = await createInstance(request, user, { name: 'beta-db', region: 'ap-southeast-2', flavor: 'm1.medium' });
    c = await createInstance(request, user, { name: 'gamma-api', region: 'us-east-1' });
  });

  test.beforeEach(async ({ page }) => {
    await loginPage(page, user);
  });

  test('Bảng có đủ 3 máy, ô KPI đúng số, phân trang "1-3 of 3"', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/instances.html');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
    await expect(page.locator('#statTotalInstances')).toHaveText('3');
    await expect(page.locator('#statRunningInstances')).toHaveText('3');
    await expect(page.locator('#statStoppedInstances')).toHaveText('0');
    await expect(page.locator('#statPendingInstances')).toHaveText('0');
    await expect(page.locator('#paginationInfo')).toHaveText('1-3 of 3');
    await expect(row(page, c.id)).toContainText('gamma-api');
    expect(w.errors).toEqual([]);
  });

  test('Tìm kiếm theo tên, theo ID, theo IP; không khớp thì hiện dòng trống', async ({ page }) => {
    await page.goto('/instances.html');
    await page.fill('#instanceSearchInput', 'beta');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(1);
    await expect(row(page, b.id)).toBeVisible();

    await page.fill('#instanceSearchInput', c.id);
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(1);
    await expect(row(page, c.id)).toBeVisible();

    if (a.publicIp) {
      await page.fill('#instanceSearchInput', a.publicIp);
      await expect(row(page, a.id)).toBeVisible();
    }

    await page.fill('#instanceSearchInput', 'khong-co-may-nao');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(0);
    await expect(page.locator('#instanceTableBody')).toContainText('Không tìm thấy');

    await page.fill('#instanceSearchInput', '');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
  });

  test('Lọc theo trạng thái: Đang chạy ra 3 máy, Đã dừng ra 0', async ({ page }) => {
    await page.goto('/instances.html');
    await page.selectOption('#instanceStatusFilter', 'RUNNING');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
    await page.selectOption('#instanceStatusFilter', 'STOPPED');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(0);
    await page.selectOption('#instanceStatusFilter', 'ALL');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
  });

  test('Chưa chọn máy: khóa Kết nối, Trạng thái, Hành động; chọn 1 máy thì mở cả ba', async ({ page }) => {
    await page.goto('/instances.html');
    await expect(page.locator('#btnConnectInstance')).toBeDisabled();
    await expect(page.locator('#btnInstanceStateMenu')).toBeDisabled();
    await expect(page.locator('#btnActionsMenu')).toBeDisabled();

    await row(page, a.id).locator('.row-checkbox').check();
    await expect(page.locator('#selectionBanner')).toHaveClass(/active/);
    await expect(page.locator('#selectionText')).toContainText('1');
    await expect(page.locator('#btnConnectInstance')).toBeEnabled();
    await expect(page.locator('#btnInstanceStateMenu')).toBeEnabled();
    await expect(page.locator('#btnActionsMenu')).toBeEnabled();
  });

  test('Chọn 2 máy: Kết nối / Hành động bị khóa, khung dưới chuyển sang tóm tắt hàng loạt', async ({ page }) => {
    await page.goto('/instances.html');
    await row(page, a.id).locator('.row-checkbox').check();
    await row(page, b.id).locator('.row-checkbox').check();
    await expect(page.locator('#selectionText')).toContainText('2');
    await expect(page.locator('#btnConnectInstance')).toBeDisabled();
    await expect(page.locator('#btnActionsMenu')).toBeDisabled();
    await expect(page.locator('#btnInstanceStateMenu')).toBeEnabled();
    await expect(page.locator('#instanceSplitPane')).toHaveClass(/active/);
    await expect(page.locator('#splitTabsBar')).toBeHidden();
    await expect(page.locator('#paneTabBulk')).toHaveClass(/active/);
    await expect(page.locator('#splitPaneTitle')).toContainText('2');
  });

  test('Ô chọn tất cả: chọn hết rồi bỏ hết', async ({ page }) => {
    await page.goto('/instances.html');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
    await page.check('#masterCheckbox');
    await expect(page.locator('#instanceTableBody .row-checkbox:checked')).toHaveCount(3);
    await expect(page.locator('#selectionText')).toContainText('3');
    await page.uncheck('#masterCheckbox');
    await expect(page.locator('#instanceTableBody .row-checkbox:checked')).toHaveCount(0);
    await expect(page.locator('#instanceSplitPane')).not.toHaveClass(/active/);
  });

  test('Bấm vào dòng: mở khung tóm tắt 4 tab, đổi tab được, link sang trang chi tiết', async ({ page }) => {
    await page.goto('/instances.html');
    await row(page, b.id).locator('td').nth(5).click();
    await expect(page.locator('#instanceSplitPane')).toHaveClass(/active/);
    await expect(page.locator('#splitPaneTitle')).toContainText(b.id);
    await expect(page.locator('#splitTabsBar .split-tab-btn')).toHaveCount(4);
    await expect(page.locator('#paneTabDetails')).toHaveClass(/active/);
    await expect(page.locator('#paneTabDetails')).toContainText('m1.medium');

    for (const tab of ['tabSecurity', 'tabNetworking', 'tabStorage', 'tabDetails']) {
      await page.click(`#splitTabsBar .split-tab-btn[onclick*="${tab}"]`);
      const pane = page.locator('#pane' + tab.charAt(0).toUpperCase() + tab.slice(1));
      await expect(pane).toHaveClass(/active/);
      await expect(page.locator(`#splitTabsBar .split-tab-btn[onclick*="${tab}"]`)).toHaveClass(/active/);
    }
    // Cùng nhóm riêng "<tên-máy>-sg" như tab Security ở trang chi tiết (trước đây hiện "sg-default")
    await page.click('#splitTabsBar .split-tab-btn[onclick*="tabSecurity"]');
    await expect(page.locator('#paneTabSecurity')).toContainText('beta-db-sg');
    await expect(page.locator('#paneTabSecurity')).toContainText(/sg-[0-9a-f]{10}/);
    await expect(page.locator('#paneTabSecurity')).toContainText('TCP 22');

    await expect(page.locator('#splitPaneViewDetailLink')).toHaveAttribute('href', `/instance-detail.html?id=${encodeURIComponent(b.id)}`);
    await page.click('#splitPaneViewDetailLink');
    await expect(page).toHaveURL(new RegExp(`instance-detail\\.html\\?id=${b.id}`));
  });

  test('Cột Security group hiện tên nhóm riêng của từng máy, không còn "sg-default"', async ({ page }) => {
    await page.goto('/instances.html');
    await expect(row(page, a.id)).toContainText('alpha-web-sg');
    await expect(row(page, b.id)).toContainText('beta-db-sg');
    await expect(row(page, c.id)).toContainText('gamma-api-sg');
    await expect(page.locator('#instanceTableBody')).not.toContainText('sg-default');
  });

  test('Link Instance ID mở trang chi tiết', async ({ page }) => {
    await page.goto('/instances.html');
    await row(page, c.id).locator(`a[href*="instance-detail.html?id="]`).click();
    await expect(page).toHaveURL(new RegExp(`instance-detail\\.html\\?id=${c.id}`));
  });

  test('Nút copy cạnh Instance ID và trong hộp Kết nối: chép đúng nội dung, hiện thông báo', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const w = watchPage(page);
    await page.goto('/instances.html');
    await row(page, a.id).locator('button[title="Copy ID"]').click();
    await expect(page.locator('#toastContainer')).toContainText(a.id);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(a.id);

    await row(page, a.id).locator('.row-checkbox').check();
    await page.click('#btnConnectInstance');
    await expect(page.locator('#connectModal')).toHaveClass(/active/);
    await expect(page.locator('#connCmdIp')).toContainText('ssh -i "e2e-key.pem" ubuntu@');
    await expect(page.locator('#connCmdDns')).toContainText('alpha-web.xregion.net');
    await page.click('button[onclick="copyConnectCmd(\'connCmdIp\')"]');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('ssh -i "e2e-key.pem" ubuntu@');
    expect(w.errors).toEqual([]);
  });

  test('Menu Trạng thái: máy đang chạy thì khóa Khởi động, mở Dừng / Khởi động lại / Xóa', async ({ page }) => {
    await page.goto('/instances.html');
    await row(page, a.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');
    const menu = page.locator('#instanceStateDropdown');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[onclick*="\'START\'"]')).toBeDisabled();
    await expect(menu.locator('[onclick*="\'STOP\'"]')).toBeEnabled();
    await expect(menu.locator('[onclick*="\'REBOOT\'"]')).toBeEnabled();
    await expect(menu.locator('[onclick*="\'TERMINATE\'"]')).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('Hộp xác nhận Xóa: phải gõ đúng tên máy mới bấm được; chọn nhiều máy thì gõ "terminate"; bấm Hủy không gửi lệnh', async ({ page }) => {
    const w = watchPage(page);
    const actionCalls = [];
    page.on('request', r => { if (/\/actions$/.test(r.url())) actionCalls.push(r.url()); });
    await page.goto('/instances.html');

    await row(page, a.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');
    await page.click('#instanceStateDropdown [onclick*="TERMINATE"]');
    const ok = page.locator('#confirmModal [data-act="ok"]');
    await expect(ok).toBeDisabled();
    await page.fill('#confirmInput', 'alpha');
    await expect(ok).toBeDisabled();
    await page.fill('#confirmInput', 'alpha-web');
    await expect(ok).toBeEnabled();
    await page.click('#confirmModal [data-act="cancel"]');
    await expect(page.locator('#confirmModal')).not.toHaveClass(/active/);

    await row(page, b.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');
    await page.click('#instanceStateDropdown [onclick*="TERMINATE"]');
    await expect(page.locator('#confirmModal')).toContainText('2');
    await page.fill('#confirmInput', 'alpha-web');
    await expect(ok).toBeDisabled();
    await page.fill('#confirmInput', 'terminate');
    await expect(ok).toBeEnabled();
    await page.keyboard.press('Escape');

    expect(actionCalls, 'Bấm Hủy thì không gọi API').toEqual([]);
    expect(w.nativeDialogs).toEqual([]);
  });

  test('Hộp xác nhận Dừng máy dùng hộp của trang (không dùng confirm() trình duyệt)', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/instances.html');
    await row(page, a.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');
    await page.click('#instanceStateDropdown [onclick*="\'STOP\'"]');
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await expect(page.locator('#confirmModal')).toContainText('alpha-web');
    await page.click('#confirmModal [data-act="cancel"]');
    expect(w.nativeDialogs).toEqual([]);
  });

  test('Menu Hành động có link Chỉnh sửa và Fast Migrate trỏ đúng máy', async ({ page }) => {
    await page.goto('/instances.html');
    await row(page, c.id).locator('.row-checkbox').check();
    await page.click('#btnActionsMenu');
    const menu = page.locator('#actionsDropdown');
    await expect(menu).toBeVisible();
    await expect(menu.locator(`[href*="instance-edit.html?id=${c.id}"]`).first()).toBeAttached();
    await expect(menu.locator(`[href*="${c.id}"][href*="#migration"]`).first()).toBeAttached();
  });

  test('Nút Làm mới tải lại bảng, không lỗi JS', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/instances.html');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
    const reload = page.waitForResponse(r => /\/api\/instances$/.test(r.url()));
    await page.click('#btnRefreshInstances');
    await reload;
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(3);
    expect(w.errors).toEqual([]);
  });

  test('English: bảng, menu và khung tóm tắt không còn chữ tiếng Việt', async ({ page }) => {
    const p2 = await page.context().newPage();
    await loginPage(p2, user, 'en');
    await p2.goto('/instances.html');
    await row(p2, a.id).locator('td').nth(5).click();
    await p2.click('#btnActionsMenu');
    const left = await vietnameseLines(p2.locator('body'), ['.toast-container']);
    expect(left).toEqual([]);
    await p2.close();
  });
});
