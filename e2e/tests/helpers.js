// Tiện ích dùng chung cho các file test: tạo tài khoản + máy ảo qua API, đăng nhập sẵn cho trang.
const { expect } = require('@playwright/test');

const VI_CHARS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/** Đăng ký một tài khoản mới (mỗi lần chạy một tên khác) và trả về { username, token }. */
async function createUser(request, prefix = 'e2e') {
  const username = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const password = 'Passw0rd!e2e';
  const res = await request.post('/api/auth/register', {
    data: { username, password, email: `${username}@test.local`, fullName: 'E2E Test' }
  });
  expect(res.ok(), `Đăng ký ${username} thất bại: ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return { username, password, token: body.data.token };
}

/** Gọi API kèm token. */
async function api(request, user, method, path, data) {
  const res = await request.fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${user.token}` },
    data
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* không có JSON */ }
  return { status: res.status(), body, data: body && body.data };
}

/** Tạo máy ảo qua API (giống bấm Launch), trả về object máy. */
async function createInstance(request, user, opts = {}) {
  const name = opts.name || `vm-${Date.now().toString(36)}`;
  const r = await api(request, user, 'POST', '/instances', {
    name,
    region: opts.region || 'ap-southeast-2',
    flavor: opts.flavor || 'm1.small',
    imageId: opts.imageId || 'img-u22',
    keyPairName: opts.keyPairName || 'e2e-key',
    ebsSizeGb: 10,
    domainName: opts.domainName || `${name}.xregion.net`
  });
  expect(r.status, `Tạo máy thất bại: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  if (opts.waitRunning === false) return r.data;
  // Máy mới PENDING tới khi "Step Function giả" (global-setup.js) ghi bản ghi Nova ACTIVE
  await waitForStatus(request, user, r.data.id, 'RUNNING');
  // Sự kiện tạo máy chưa mang vùng nên máy luôn ở Sydney: muốn máy ở N. Virginia thì chuyển vùng sang
  if (opts.region === 'us-east-1') await migrateTo(request, user, r.data.id, 'us-east-1');
  return (await api(request, user, 'GET', `/instances/${r.data.id}`)).data;
}

/** Fast Migrate qua API rồi chờ máy chạy lại ở vùng đích. */
async function migrateTo(request, user, id, region) {
  const t = await api(request, user, 'POST', '/migrations/trigger', { id });
  expect(t.status, `Chuyển vùng thất bại: ${JSON.stringify(t.body)}`).toBeLessThan(300);
  await expect.poll(async () => {
    const d = (await api(request, user, 'GET', `/instances/${id}`)).data || {};
    return `${d.region}/${d.status}`;
  }, { message: `Máy ${id} chưa chuyển xong sang ${region}`, timeout: 40_000, intervals: [1000] }).toBe(`${region}/RUNNING`);
}

/** Chờ máy về đúng trạng thái (gọi API mỗi giây, tối đa timeoutMs). */
async function waitForStatus(request, user, id, status, timeoutMs = 20_000) {
  await expect.poll(async () => (await api(request, user, 'GET', `/instances/${id}`)).data?.status,
    { message: `Máy ${id} chưa về ${status}`, timeout: timeoutMs, intervals: [500, 1000] }).toBe(status);
}

/** Mở trang đã đăng nhập sẵn bằng token (không qua form login) với ngôn ngữ chọn trước. */
async function loginPage(page, user, lang = 'vi') {
  await page.addInitScript(([token, username, l]) => {
    localStorage.setItem('xregion_jwt', token);
    localStorage.setItem('xregion_user', username);
    localStorage.setItem('xregion_jwt_expires_at', String(Date.now() + 3600 * 1000));
    if (!sessionStorage.getItem('e2eLangSet')) {
      localStorage.setItem('xregion_lang', l);
      sessionStorage.setItem('e2eLangSet', '1');
    }
  }, [user.token, user.username, lang]);
}

/** Theo dõi lỗi JS và hộp confirm()/alert() mặc định của trình duyệt trên trang. */
function watchPage(page) {
  const errors = [];
  const nativeDialogs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { nativeDialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return { errors, nativeDialogs };
}

/**
 * Các dòng chữ tiếng Việt còn sót trong vùng chọn (bỏ qua tên lựa chọn ngôn ngữ).
 * ignore: selector các vùng chứa DỮ LIỆU người dùng (vd. bảng rule) — dữ liệu không phải dịch.
 */
async function vietnameseLines(locator, ignore = []) {
  const text = await locator.evaluate((root, sels) => {
    const clone = root.cloneNode(true);
    sels.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));
    clone.querySelectorAll('[hidden], .det-panel:not(.active)').forEach(el => el.remove());
    document.body.appendChild(clone);
    const out = clone.innerText;
    clone.remove();
    return out;
  }, ignore);
  return [...new Set(text.split('\n').map(s => s.trim()).filter(s => VI_CHARS.test(s) && !/Tiếng Việt/.test(s)))];
}

module.exports = { createUser, api, createInstance, migrateTo, waitForStatus, loginPage, watchPage, vietnameseLines };
