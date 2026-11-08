// Module 05: Trang khởi tạo máy ảo (launch.html) — vùng, hệ điều hành, cấu hình, ô tóm tắt
// Bước 6 (Firewall) nằm ở 09-launch-firewall. Tạo Key Pair thật cần AWS nên không test ở đây.
const { test, expect } = require('@playwright/test');
const { createUser, api, loginPage, watchPage } = require('./helpers');

/** Local chưa tạo được key pair thật: thêm một lựa chọn key chỉ để test. */
async function useTestKey(page) {
  await page.evaluate(() => {
    const s = document.getElementById('instKeyPair');
    s.add(new Option('e2e-key', 'e2e-key', true, true));
    s.dispatchEvent(new Event('change'));
  });
}

test.describe('Module 05: Khởi tạo máy ảo', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = await createUser(request, 'launch');
  });

  test.beforeEach(async ({ page }) => {
    await loginPage(page, user);
  });

  test('Mặc định: Sydney + Ubuntu được chọn, ô tóm tắt khớp, không lỗi JS', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/launch.html');
    await expect(page.locator('#optRegionA')).toHaveClass(/selected/);
    await expect(page.locator('#instRegion')).toHaveValue('ap-southeast-2');
    await expect(page.locator('#sumRegionText')).toHaveText('Region A (Sydney)');
    // Thẻ OS được vẽ lại từ API /images (id="optOs-<imageId>")
    await expect(page.locator('#optOs-img-u22')).toHaveClass(/selected/);
    await expect(page.locator('#instImage')).toHaveValue('img-u22');
    await expect(page.locator('#sumOsText')).toContainText('Ubuntu');
    await expect(page.locator('#flavorMatrixBody tr').first()).toBeVisible();
    expect(w.errors).toEqual([]);
  });

  test('Chọn vùng N. Virginia: thẻ sáng, ô ẩn và ô tóm tắt đổi theo', async ({ page }) => {
    await page.goto('/launch.html');
    await page.click('#optRegionB');
    await expect(page.locator('#optRegionB')).toHaveClass(/selected/);
    await expect(page.locator('#optRegionA')).not.toHaveClass(/selected/);
    await expect(page.locator('#instRegion')).toHaveValue('us-east-1');
    await expect(page.locator('#sumRegionText')).toHaveText('Region B (N. Virginia)');
  });

  test('Chọn từng hệ điều hành (lấy từ API /images): chỉ một thẻ sáng, ô tóm tắt đổi tên OS', async ({ page, request }) => {
    const images = (await api(request, user, 'GET', '/images')).data;
    expect(images.length).toBeGreaterThan(0);
    await page.goto('/launch.html');
    await expect(page.locator('[id^="optOs-"]')).toHaveCount(images.length);
    for (const img of [...images].reverse()) {
      const card = page.locator(`#optOs-${img.id}`);
      await card.click();
      await expect(card).toHaveClass(/selected/);
      await expect(page.locator('.option-card.selected[id^="optOs-"]')).toHaveCount(1);
      await expect(page.locator('#instImage')).toHaveValue(img.id);
      await expect(page.locator('#sumOsText')).toContainText(img.name);
    }
  });

  test('Đổi loại máy và dung lượng ổ: ô tóm tắt cấu hình đổi, dòng tương ứng trong bảng được tô', async ({ page }) => {
    await page.goto('/launch.html');
    // Danh sách loại máy tải từ API /flavors: chờ có đủ rồi mới chọn
    await expect.poll(() => page.locator('#instFlavor option').count()).toBeGreaterThan(1);
    const options = await page.locator('#instFlavor option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
    const pick = options[options.length - 1];
    await page.selectOption('#instFlavor', pick);
    await page.fill('#instEbsSize', '40');
    await page.locator('#instEbsSize').dispatchEvent('input');
    await expect(page.locator('#sumSpecsText')).toContainText('40 GB Root Disk');
    const rowId = `row-${pick.replace('.', '-')}`;
    const bg = await page.locator(`#${rowId}`).evaluate(el => el.style.background);
    expect(bg).toContain('rgba');
  });

  test('Chọn key pair: ô tóm tắt hiện tên key', async ({ page }) => {
    await page.goto('/launch.html');
    await useTestKey(page);
    await expect(page.locator('#sumKeyText')).toHaveText('e2e-key');
  });

  test('Bỏ trống tên máy thì không gửi form', async ({ page }) => {
    const posts = [];
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/instances$/.test(r.url())) posts.push(r.url()); });
    await page.goto('/launch.html');
    await page.fill('#instName', '');
    await page.click('#btnLaunchInstance');
    expect(await page.locator('#instName').evaluate(el => el.validity.valid)).toBe(false);
    await expect(page).toHaveURL(/launch\.html/);
    expect(posts).toEqual([]);
  });

  test('Tạo máy ở N. Virginia, Alpine, loại m1.small: gửi đúng lựa chọn, về danh sách thấy máy mới', async ({ page, request }) => {
    const w = watchPage(page);
    let sent = null;
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/instances$/.test(r.url())) sent = r.postDataJSON(); });
    await page.goto('/launch.html');
    await useTestKey(page);
    await page.fill('#instName', 'launch-ui-vm');
    await page.click('#optRegionB');
    await page.click('#optOs-img-alp320');
    await page.selectOption('#instFlavor', 'm1.small');
    const flavor = 'm1.small';
    await page.click('#btnLaunchInstance');
    await page.waitForURL(/instances\.html/, { timeout: 20_000 });
    await expect(page.locator('#instanceTableBody')).toContainText('launch-ui-vm');

    expect(sent).toMatchObject({ name: 'launch-ui-vm', region: 'us-east-1', flavor, imageId: 'img-alp320', keyPairName: 'e2e-key' });

    const vm = (await api(request, user, 'GET', '/instances')).data.find(i => i.name === 'launch-ui-vm');
    expect(vm).toBeTruthy();
    expect(vm.flavor).toBe(flavor);
    expect(w.errors).toEqual([]);

    // Bấm Back của trình duyệt không mở lại form đã gửi (tránh tạo trùng)
    await page.goBack();
    await page.waitForURL(/instances\.html/);
  });

  // Backend tạo máy (PR #28/#29) chưa gửi vùng trong sự kiện instance.launch và không lưu vùng ở bảng Instances,
  // nên chọn N. Virginia vẫn ra Sydney; ảnh hệ điều hành cũng luôn là img-u22. Bật lại khi backend sửa xong.
  test.fixme('Máy tạo ở N. Virginia với ảnh Alpine: API trả đúng vùng và ảnh đã chọn', async ({ request }) => {
    const vm = (await api(request, user, 'GET', '/instances')).data.find(i => i.name === 'launch-ui-vm');
    expect(vm.region).toBe('us-east-1');
    expect(vm.imageId).toBe('img-alp320');
  });

  test('English: nhãn trên trang Launch đổi sang tiếng Anh', async ({ page }) => {
    const p2 = await page.context().newPage();
    await loginPage(p2, user, 'en');
    await p2.goto('/launch.html');
    await expect(p2.locator('#btnLaunchInstance')).toContainText(/Launch/i);
    await expect(p2.locator('#sumKeyText')).toContainText('Default');
    await p2.close();
  });
});
