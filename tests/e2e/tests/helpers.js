// Tiện ích dùng chung cho các file test Playwright trên môi trường AWS thật.
const { expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VI_CHARS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

const STATE_FILE = path.join(os.tmpdir(), 'xregion-e2e', 'state.json');

/** Đọc state phiên làm việc từ file tạm. */
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`[e2e] Không tìm thấy file state tại ${STATE_FILE}. global-setup đã chạy chưa?`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

/** Cập nhật state phiên làm việc vào file tạm. */
function saveState(patch) {
  const current = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const updated = { ...current, ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/** Đăng ký một tài khoản mới qua API và trả về { username, password, token }. */
async function createUser(request, prefix = 'e2e') {
  const username = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const password = 'Passw0rd!e2e';
  const res = await request.post('/api/auth/register', {
    data: { username, password, email: `${username}@test.local`, fullName: 'E2E Test User' }
  });
  expect(res.ok(), `Đăng ký ${username} thất bại: ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return { username, password, token: body.data.token };
}

/** Gọi API backend kèm token Bearer. */
async function api(request, user, method, apiPath, data) {
  const res = await request.fetch(`/api${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${user.token}` },
    data
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore non-JSON */ }
  return { status: res.status(), body, data: body && body.data };
}

/** Chờ máy về đúng trạng thái (gọi API định kỳ, tối đa timeoutMs). */
async function waitForStatus(request, user, id, status, timeoutMs = 480_000) {
  await expect.poll(async () => {
    const res = await api(request, user, 'GET', `/instances/${id}`);
    return res.data?.status;
  }, {
    message: `Máy ${id} chưa về trạng thái ${status} sau ${timeoutMs}ms`,
    timeout: timeoutMs,
    intervals: [2000, 5000, 10000]
  }).toBe(status);
}

/** Mở trang đã đăng nhập sẵn bằng token trong localStorage. */
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
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
  });
  page.on('dialog', d => {
    nativeDialogs.push(d.message());
    d.dismiss().catch(() => {});
  });
  return { errors, nativeDialogs };
}

/** Lọc các dòng chữ tiếng Việt còn sót trong vùng chọn. */
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

module.exports = {
  loadState,
  saveState,
  createUser,
  api,
  waitForStatus,
  loginPage,
  watchPage,
  vietnameseLines
};
