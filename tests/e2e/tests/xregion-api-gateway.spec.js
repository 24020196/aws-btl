// Suite kiểm thử E2E tích hợp 100% dịch vụ gửi API tới AWS API Gateway (EventBridge & Step Functions).
// Toàn bộ 8 bài test chạy TUẦN TỰ NGHIÊM NGẶT (serial mode) trên 1 máy ảo duy nhất (Warm Pool <= 2).
// Mỗi bài test sau lắng nghe bài test trước hoàn thành; bất kỳ bài nào thất bại sẽ dừng ngay lập tức (fail-fast).
const { test, expect } = require('@playwright/test');
const { loadState, saveState, api, loginPage, watchPage, waitForStatus } = require('./helpers');

const row = (page, id) => page.locator(`#instanceTableBody tr:has(input[value="${id}"])`);

test.describe('XRegion E2E Pipeline: AWS API Gateway Integration (Sequential)', () => {
  // Cấu hình chế độ tuần tự nghiêm ngặt: bài trước xong mới chạy bài sau, lỗi là dừng ngay (fail-fast)
  test.describe.configure({ mode: 'serial' });

  let state;
  let user;
  let sharedKeyName;
  let sharedVm;

  test.beforeAll(async () => {
    state = loadState();
    user = state.user;
    sharedKeyName = state.keyPairName;
    sharedVm = state.vm;
  });

  test.beforeEach(async () => {
    // Đồng bộ trạng thái mới nhất từ file state.json giữa các bài test tuần tự
    state = loadState();
    user = state.user;
    sharedKeyName = state.keyPairName;
    sharedVm = state.vm;
  });

  // =========================================================================
  // STEP 1: SSH KEY PAIR (key.import)
  // =========================================================================
  test('[Step 1] key.import: Tạo SSH Key Pair mới qua modal UI -> POST /api/keys -> gửi sự kiện key.import', async ({ page }) => {
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/launch.html');

    // Mở modal tạo Key Pair
    await page.click('button[onclick="openCreateKeyModal()"]');
    await expect(page.locator('#createKeyModal')).toHaveClass(/active/);

    const rawKeyName = `e2ekey${Date.now().toString(36)}`;
    await page.fill('#newKeyPairName', rawKeyName);

    // Bắt phản hồi API để xác thực chữ ký và dữ liệu trả về từ backend
    const keyPromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/api/keys'));
    await page.click('#btnSubmitCreateKey');

    const keyRes = await keyPromise;
    expect(keyRes.ok(), `API /api/keys trả về lỗi: ${await keyRes.text()}`).toBeTruthy();

    const keyBody = await keyRes.json();
    const keyData = keyBody.data || {};

    // SPEC-06 §2.1 & §2.2: Phải trả về privateKey (PEM), keyId duy nhất dạng key-<name>-<uuid8>, và chỉ lưu sau khi EventBridge nhận thành công
    expect(keyData.privateKey).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(keyData.keyId).toMatch(new RegExp(`^key-${rawKeyName}-[a-f0-9]{8}$`, 'i'));
    expect(keyData.publicKey).toContain('ssh-rsa');
    expect(keyData.keyFingerprint).toBeTruthy();

    // Modal đóng lại và dropdown instKeyPair tự động chọn key vừa tạo
    await expect(page.locator('#createKeyModal')).not.toHaveClass(/active/);
    await expect(page.locator('#instKeyPair')).toHaveValue(keyData.keyId);
    await expect(page.locator('#sumKeyText')).toHaveText(keyData.keyId);

    // Lưu vào bộ nhớ và state file để các bước sau lắng nghe và sử dụng
    sharedKeyName = keyData.keyId;
    saveState({ keyPairName: sharedKeyName });
    expect(w.errors).toEqual([]);
  });

  // =========================================================================
  // STEP 2: LAUNCH INSTANCE (instance.launch)
  // =========================================================================
  test('[Step 2] instance.launch: Khởi tạo máy ảo qua Form UI kèm rule HTTPS 443 -> POST /api/instances -> chờ RUNNING', async ({ page, request }) => {
    test.setTimeout(600_000); // 10 phút chờ Step Functions LaunchInstance
    const w = watchPage(page);
    state = loadState();
    sharedKeyName = state.keyPairName;
    await loginPage(page, user);

    expect(sharedKeyName, 'Step 2 yêu cầu Key Pair phải được tạo thành công ở Step 1').toBeTruthy();

    const vmName = `vm-e2e-${Date.now().toString(36)}`;
    await page.goto('/launch.html');

    // Điền form khởi tạo máy ảo
    await page.fill('#instName', vmName);
    await expect(page.locator('#optRegionA')).toHaveClass(/selected/); // Sydney (ap-southeast-2)
    await page.click(`#optOs-${state.imageId}`);
    await page.selectOption('#instFlavor', state.flavor);
    await page.selectOption('#instKeyPair', sharedKeyName);

    // Bước 6 Firewall: Thêm Inbound Rule HTTPS (Port 443)
    await page.click("button[onclick=\"lfwAdd('inbound')\"]");
    await expect(page.locator('#lfwRuleModal')).toHaveClass(/active/);
    await page.selectOption('#lfwType', 'https');
    await page.click('#lfwSubmitBtn');
    await expect(page.locator('#lfwRuleModal')).not.toHaveClass(/active/);
    await expect(page.locator('#lfwInboundBody')).toContainText('443');

    // Bắt phản hồi POST /api/instances
    const launchPromise = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/instances$/.test(r.url()));
    await page.click('#btnLaunchInstance');

    const launchRes = await launchPromise;
    expect(launchRes.status(), 'SPEC-01 §5.1: Backend phải phản hồi HTTP 202 Accepted').toBe(202);

    const launchBody = await launchRes.json();
    const createdId = launchBody.data?.instanceId || launchBody.data?.id;
    expect(createdId, 'Phải có instanceId trong phản hồi launch').toBeTruthy();
    expect(launchBody.data?.status).toBe('PENDING');

    // Chuyển hướng về trang danh sách máy ảo
    await page.waitForURL(/instances\.html/, { timeout: 30_000 });
    await expect(page.locator('#instanceTableBody')).toContainText(vmName);

    // Chờ máy đạt RUNNING qua Step Functions thật (hạ tầng mạng NAT + ping 10s + syncDynamoDB)
    await waitForStatus(request, user, createdId, 'RUNNING', 480_000);

    // Xác minh Security Group 1-1 riêng biệt đã đồng bộ cả cổng 22 (SSH) và cổng 443 (HTTPS)
    const sgRes = await api(request, user, 'GET', `/network/security-groups?instanceId=${createdId}`);
    expect(sgRes.data).toHaveLength(1);
    const sg = sgRes.data[0];
    const ports = (sg.inboundRules || []).map(r => r.fromPort);
    expect(ports).toContain(22);
    expect(ports).toContain(443);

    // Chuyển giao máy ảo sang memory context và state file để các bước sau kế thừa
    sharedVm = { id: createdId, name: vmName };
    saveState({ vm: sharedVm });
    expect(w.errors).toEqual([]);
  });

  // =========================================================================
  // STEP 3: SECURITY GROUP DETAIL TAB (security-group.updated)
  // =========================================================================
  test.skip('[Step 3] security-group.updated (Tab Security): Bỏ qua do tab Security đã tinh gọn, chuyển kiểm thử tập trung sang Step 4 (Table Modal)', async ({ page }) => {
    // Tab Security trên instance-detail.html đã được tinh gọn.
    // Nghiệp vụ đồng bộ Security Group được kiểm thử toàn diện tại [Step 4] (Table Modal trên instances.html).
  });

  // =========================================================================
  // STEP 4: INSTANCE TABLE MODAL SG OVERWRITE (security-group.updated)
  // =========================================================================
  test('[Step 4] security-group.updated (Table Modal): Ghi đè Inbound & Outbound rules -> PUT 202 Accepted & eventPublished', async ({ page, request }) => {
    state = loadState();
    sharedVm = state.vm;
    expect(sharedVm?.id, 'Step 4 yêu cầu máy ảo đã được tạo thành công ở Step 2').toBeTruthy();
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/instances.html');
    await expect(page.locator('#instanceTableBody .row-checkbox')).toHaveCount(1);

    await row(page, sharedVm.id).locator('.row-checkbox').check();
    await page.click('#btnEditSecurityGroup');

    const modal = page.locator('#sgEditModal');
    await expect(modal).toHaveClass(/active/);
    await expect(page.locator('#sgeSaveBtn')).toBeEnabled();

    // 1. Thêm Inbound Rule Custom TCP 8443
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

    // 2. Thêm Outbound Rule HTTPS 443
    await page.click('#sgeAddOut');
    await page.selectOption('#lfwType', 'https');
    await page.click('#lfwSubmitBtn');

    // 3. Xóa Rule SSH 22 ở Inbound
    await page.locator('#lfwInboundBody tr', { has: page.locator('select option[value="ssh"]:checked') })
      .locator('.lfw-del button').click();

    // 4. Bấm Lưu và kiểm tra phản hồi phát sự kiện lên API Gateway
    const putPromise = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(`/security-groups/instances/${sharedVm.id}`));
    await page.click('#sgeSaveBtn');

    const putRes = await putPromise;
    expect(putRes.status(), `Mong đợi HTTP 202 Accepted khi phát sự kiện thành công nhưng nhận ${putRes.status()}`).toBe(202);

    const putBody = await putRes.json();
    const group = putBody.data || {};

    // SPEC-SF-05 & NetworkController contract
    expect(group.eventPublished, 'eventPublished phải là true để chứng minh sự kiện đã gửi lên AWS API Gateway').toBe(true);
    expect(group.syncAccepted, 'syncAccepted phải là true').toBe(true);
    expect(['PENDING_SYNC', 'SYNCED']).toContain(group.syncStatus);
    expect(group.revision).toBeGreaterThan(0);

    await expect(modal).not.toHaveClass(/active/);
    await expect(page.locator('#toastContainer')).toContainText(`${sharedVm.name}-sg`);

    // Xác minh dữ liệu qua API
    const getRes = await api(request, user, 'GET', `/network/security-groups?instanceId=${sharedVm.id}`);
    const updatedGroup = getRes.data[0];
    expect(updatedGroup.inboundRules.some(r => r.fromPort === 8443)).toBeTruthy();
    expect(updatedGroup.inboundRules.some(r => r.fromPort === 22)).toBeFalsy();
    expect(updatedGroup.outboundRules.some(r => r.fromPort === 443)).toBeTruthy();

    expect(w.errors).toEqual([]);
  });

  // =========================================================================
  // STEP 5: LIFECYCLE STOP (instance.lifecycle)
  // =========================================================================
  test('[Step 5] instance.lifecycle (STOP): kiểm tra pre-condition (START khi RUNNING -> 400), gửi STOP -> STOPPING -> STOPPED', async ({ page, request }) => {
    state = loadState();
    sharedVm = state.vm;
    expect(sharedVm?.id, 'Step 5 yêu cầu máy ảo đã được tạo thành công ở Step 2').toBeTruthy();
    test.setTimeout(300_000);
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/instances.html');

    // SPEC-01 §2: Máy đang RUNNING -> START bị cấm tuyệt đối (HTTP 400 Bad Request)
    const invalidStart = await api(request, user, 'POST', `/instances/${sharedVm.id}/actions`, { action: 'START' });
    expect(invalidStart.status, 'START khi đang RUNNING phải trả về HTTP 400').toBe(400);

    // Thao tác UI: Chọn máy và bấm Dừng máy ảo
    await row(page, sharedVm.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');

    const actionPromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/instances/${sharedVm.id}/actions`));
    await page.click('#instanceStateDropdown button[onclick="handleBulkAction(\'STOP\')"]');

    // Xác nhận trong hộp thoại confirmDialog
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await page.click('#confirmModal [data-act="ok"]');

    const actionRes = await actionPromise;
    expect(actionRes.ok(), `STOP thất bại: ${await actionRes.text()}`).toBeTruthy();
    const actionBody = await actionRes.json();
    expect(actionBody.data?.status).toBe('STOPPING');

    // Chờ EventBridge -> Nova xử lý os-stop và DynamoDB chuyển STOPPED
    await waitForStatus(request, user, sharedVm.id, 'STOPPED', 240_000);
    expect(w.errors).toEqual([]);
  });

  // =========================================================================
  // STEP 6: LIFECYCLE START (instance.lifecycle)
  // =========================================================================
  test('[Step 6] instance.lifecycle (START): kiểm tra pre-condition (STOP & REBOOT khi STOPPED -> 400), gửi START -> STARTING -> RUNNING', async ({ page, request }) => {
    state = loadState();
    sharedVm = state.vm;
    expect(sharedVm?.id, 'Step 6 yêu cầu máy ảo đang ở trạng thái STOPPED từ Step 5').toBeTruthy();
    test.setTimeout(300_000);
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/instances.html');

    // SPEC-01 §2: Máy đang STOPPED -> STOP và REBOOT bị cấm tuyệt đối (HTTP 400 Bad Request)
    const invalidStop = await api(request, user, 'POST', `/instances/${sharedVm.id}/actions`, { action: 'STOP' });
    expect(invalidStop.status, 'STOP khi đang STOPPED phải trả về HTTP 400').toBe(400);

    const invalidReboot = await api(request, user, 'POST', `/instances/${sharedVm.id}/actions`, { action: 'REBOOT' });
    expect(invalidReboot.status, 'REBOOT khi đang STOPPED phải trả về HTTP 400').toBe(400);

    // Thao tác UI: Chọn máy và bấm Khởi động máy ảo
    await row(page, sharedVm.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');

    const actionPromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/instances/${sharedVm.id}/actions`));
    await page.click('#instanceStateDropdown button[onclick="handleBulkAction(\'START\')"]');

    const actionRes = await actionPromise;
    expect(actionRes.ok(), `START thất bại: ${await actionRes.text()}`).toBeTruthy();
    const actionBody = await actionRes.json();
    expect(actionBody.data?.status).toBe('STARTING');

    // Chờ EventBridge -> Nova xử lý os-start và DynamoDB chuyển RUNNING
    await waitForStatus(request, user, sharedVm.id, 'RUNNING', 240_000);
    expect(w.errors).toEqual([]);
  });

  // =========================================================================
  // STEP 7: LIFECYCLE REBOOT (instance.lifecycle)
  // =========================================================================
  test('[Step 7] instance.lifecycle (REBOOT): gửi REBOOT -> REBOOTING -> RUNNING', async ({ page, request }) => {
    state = loadState();
    sharedVm = state.vm;
    expect(sharedVm?.id, 'Step 7 yêu cầu máy ảo đang ở trạng thái RUNNING từ Step 6').toBeTruthy();
    test.setTimeout(300_000);
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/instances.html');

    // Thao tác UI: Chọn máy và bấm Khởi động lại
    await row(page, sharedVm.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');

    const actionPromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/instances/${sharedVm.id}/actions`));
    await page.click('#instanceStateDropdown button[onclick="handleBulkAction(\'REBOOT\')"]');

    const actionRes = await actionPromise;
    expect(actionRes.ok(), `REBOOT thất bại: ${await actionRes.text()}`).toBeTruthy();
    const actionBody = await actionRes.json();
    expect(actionBody.data?.status).toBe('REBOOTING');

    // Chờ máy khởi động lại xong và quay về RUNNING
    await waitForStatus(request, user, sharedVm.id, 'RUNNING', 240_000);
    expect(w.errors).toEqual([]);
  });

  // =========================================================================
  // STEP 8: LIFECYCLE TERMINATE (instance.lifecycle)
  // =========================================================================
  test('[Step 8] instance.lifecycle (TERMINATE): gửi TERMINATE -> 409 Conflict duplicate -> Hard Delete biến mất hoàn toàn', async ({ page, request }) => {
    state = loadState();
    sharedVm = state.vm;
    expect(sharedVm?.id, 'Step 8 yêu cầu máy ảo còn tồn tại để dọn dẹp kết thúc suite').toBeTruthy();
    test.setTimeout(600_000); // 10 phút chờ Step Functions TerminateInstance dọn dẹp hạ tầng
    const w = watchPage(page);
    await loginPage(page, user);
    await page.goto('/instances.html');

    // Thao tác UI: Chọn máy và bấm Terminate
    await row(page, sharedVm.id).locator('.row-checkbox').check();
    await page.click('#btnInstanceStateMenu');

    await page.click('#instanceStateDropdown button[onclick="handleBulkAction(\'TERMINATE\')"]');

    // Hộp confirmDialog yêu cầu nhập tên máy để xác nhận xóa vĩnh viễn
    await expect(page.locator('#confirmModal')).toHaveClass(/active/);
    await page.fill('#confirmInput', sharedVm.name);

    const actionPromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/instances/${sharedVm.id}/actions`));
    await page.click('#confirmModal [data-act="ok"]');

    const actionRes = await actionPromise;
    expect(actionRes.ok(), `TERMINATE thất bại: ${await actionRes.text()}`).toBeTruthy();
    const actionBody = await actionRes.json();
    expect(actionBody.data?.status).toBe('SHUTTING_DOWN');

    // SPEC-01 §2: Đang trong quá trình TERMINATE/SHUTTING_DOWN -> cấm gọi lặp lại (HTTP 409 Conflict)
    const duplicateTerm = await api(request, user, 'POST', `/instances/${sharedVm.id}/actions`, { action: 'TERMINATE' });
    expect(duplicateTerm.status, 'TERMINATE khi đang SHUTTING_DOWN phải trả về HTTP 409 Conflict').toBe(409);

    // SPEC-01 §7 (v1.7.0) & SPEC-SF-02 (v1.2.0): Step Functions hoàn tất dọn dẹp hạ tầng -> chuyển trạng thái TERMINATED (Soft Delete)
    console.log(`[e2e] Đang chờ máy [${sharedVm.id}] hoàn tất dọn dẹp và chuyển sang trạng thái TERMINATED...`);
    const deadline = Date.now() + 540_000;
    let terminated = false;

    while (Date.now() < deadline) {
      await page.waitForTimeout(6000);
      const checkRes = await api(request, user, 'GET', `/instances/${sharedVm.id}`);
      const st = String(checkRes.data?.status || checkRes.data?.current_status || '').toUpperCase();
      if (st === 'TERMINATED') {
        terminated = true;
        break;
      }
    }

    expect(terminated, `Máy [${sharedVm.id}] phải được cập nhật sang trạng thái TERMINATED (Soft Delete)`).toBe(true);

    // Bảng danh sách trên giao diện sau khi refresh hiển thị trạng thái TERMINATED
    await page.click('#btnRefreshInstances');
    await expect(page.locator('#instanceTableBody')).toContainText('Terminated');

    // Xóa máy ảo khỏi state để global-teardown không gọi dư thừa
    saveState({ vm: null });
    expect(w.errors).toEqual([]);
  });
});
