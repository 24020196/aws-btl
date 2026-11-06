// XRegion Console - client-side logic
// Talks to the Spring Boot REST API under /api. Public function names are kept
// from the previous version so inline handlers and teammates' code keep working.

const API_BASE = '/api';

// Region A / Region B follow the report (Bảng phân dải mạng, Báo cáo tiến độ 2).
// Change here if the team swaps the regions; every label and color reads from this map.
const REGIONS = {
  'us-east-1': { key: 'A', label: 'Region A', city: 'N. Virginia', tz: 'America/New_York', cls: 'a', priceFactor: 0.75 },
  'ap-southeast-2': { key: 'B', label: 'Region B', city: 'Sydney', tz: 'Australia/Sydney', cls: 'b', priceFactor: 1.0 }
};
const REGION_CODES = Object.keys(REGIONS);

const TABS = {
  compute: 'Máy ảo',
  storage: 'Ổ đĩa & snapshot',
  images: 'Image',
  network: 'Mạng & DNS',
  migration: 'Chuyển vùng',
  monitoring: 'Giám sát & nhật ký',
  launch: 'Tạo máy ảo',
  instance: 'Chi tiết máy ảo'
};
// Pages that are not in the sidebar highlight their parent item.
const NAV_PARENT = { launch: 'compute', instance: 'compute' };

// OpenStack flavors: standard m1 and high-performance h1 series (list from anhtd/ui).
// hourly is a demo estimate in USD before the region price factor.
const FLAVORS = {
  'm1.tiny': { series: 'm1', cpu: 1, ram: 0.5, hourly: 0.01 },
  'm1.small': { series: 'm1', cpu: 1, ram: 2, hourly: 0.04 },
  'm1.medium': { series: 'm1', cpu: 2, ram: 4, hourly: 0.08 },
  'm1.large': { series: 'm1', cpu: 4, ram: 8, hourly: 0.16 },
  'm1.xlarge': { series: 'm1', cpu: 8, ram: 16, hourly: 0.32 },
  'h1.medium': { series: 'h1', cpu: 8, ram: 16, hourly: 0.38 },
  'h1.large': { series: 'h1', cpu: 16, ram: 32, hourly: 0.76 },
  'h1.xlarge': { series: 'h1', cpu: 32, ram: 64, hourly: 1.52 },
  'c5.large': { series: 'legacy', cpu: 4, ram: 8, hourly: 0.16 }
};
const DEFAULT_FLAVOR = { m1: 'm1.medium', h1: 'h1.medium' };

const OS_IMAGES = [
  { id: 'img-u22', name: 'Ubuntu', version: '22.04 LTS' },
  { id: 'img-deb12', name: 'Debian', version: '12 Bookworm' },
  { id: 'img-rocky9', name: 'Rocky Linux', version: '9' },
  { id: 'img-alp319', name: 'Alpine Linux', version: '3.19' }
];
const OS_NAMES = Object.fromEntries(OS_IMAGES.map(o => [o.id, `${o.name} ${o.version}`]));

function fmtRam(gb) {
  return gb < 1 ? `${gb * 1024} MB` : `${gb} GB`;
}

const STATUS_VIEW = {
  ACTIVE: { cls: 'ok', text: 'Đang chạy' },
  SHUTOFF: { cls: 'off', text: 'Đã dừng' },
  STOPPED: { cls: 'off', text: 'Đã dừng' },
  MIGRATING: { cls: 'warn', text: 'Đang chuyển vùng' },
  BUILD: { cls: 'warn', text: 'Đang tạo' },
  CREATING: { cls: 'warn', text: 'Đang tạo' },
  ERROR: { cls: 'bad', text: 'Lỗi' },
  IN_USE: { cls: 'ok', text: 'Đang gắn' },
  AVAILABLE: { cls: 'off', text: 'Sẵn sàng' },
  SYNCED: { cls: 'ok', text: 'Đã đồng bộ' },
  PENDING: { cls: 'warn', text: 'Đang cập nhật' },
  ASSOCIATED: { cls: 'ok', text: 'Đã gắn' },
  IN_PROGRESS: { cls: 'warn', text: 'Đang chạy' },
  COMPLETED: { cls: 'ok', text: 'Hoàn tất' },
  FAILED: { cls: 'bad', text: 'Thất bại' },
  ROLLED_BACK: { cls: 'bad', text: 'Đã khôi phục' },
  IDLE: { cls: 'off', text: 'Chưa chạy' }
};

let authToken = storageGet('xregion_jwt') || '';
let performanceChart = null;
let migrationPollInterval = null;
let cachedInstances = [];
let cachedVolumes = [];
let cachedSeries = null;
let currentTab = 'compute';
let currentInstanceId = null;
let selectedFlavor = 'm1.medium';

// ---------- Small helpers ----------
function storageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
}

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function $(id) { return document.getElementById(id); }

function icon(name, cls = 'icon icon-sm') {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

function regionInfo(code) {
  return REGIONS[code] || { key: '?', label: code || 'Không rõ', city: code || '', cls: '', tz: 'UTC', priceFactor: 1 };
}

function otherRegion(code) {
  return REGION_CODES.find(r => r !== code) || REGION_CODES[0];
}

function regionTag(code, withCode = true) {
  const r = regionInfo(code);
  return `<span class="region ${r.cls}" title="${esc(r.label)} · ${esc(code)}"><i></i>${esc(r.city)}${withCode ? ` <span class="region-code">${esc(code)}</span>` : ''}</span>`;
}

function routeTag(src, dst) {
  return `<span class="route">${regionTag(src, false)}<span class="arrow">${icon('arrow')}</span>${regionTag(dst, false)}</span>`;
}

function statusTag(status) {
  const v = STATUS_VIEW[status] || { cls: '', text: status || 'Không rõ' };
  return `<span class="status ${v.cls}">${esc(v.text)}</span>`;
}

function emptyRow(cols, title, text, actionHtml = '') {
  return `<tr><td colspan="${cols}" class="empty"><strong>${esc(title)}</strong>${esc(text)}${actionHtml ? `<div>${actionHtml}</div>` : ''}</td></tr>`;
}

function setLoadingRows(tbodyId, cols, rows = 3) {
  const tbody = $(tbodyId);
  if (!tbody) return;
  let html = '';
  for (let i = 0; i < rows; i++) {
    html += '<tr>' + Array.from({ length: cols }, () => '<td><span class="skeleton"></span></td>').join('') + '</tr>';
  }
  tbody.innerHTML = html;
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- Toasts ----------
function toast(type, title, message = '') {
  const box = $('toasts');
  if (!box) return;
  const iconName = type === 'ok' ? 'check' : type === 'bad' ? 'alert' : type === 'warn' ? 'alert' : 'info';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `${icon(iconName)}<div><div class="toast-title">${esc(title)}</div>${message ? `<div class="toast-msg">${esc(message)}</div>` : ''}</div><button class="btn btn-ghost btn-sm btn-icon" aria-label="Đóng">${icon('x')}</button>`;
  el.querySelector('button').onclick = () => el.remove();
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'bad' ? 8000 : 4500);
}

// ---------- Confirm dialog (replaces window.confirm) ----------
function confirmDialog({ title, html, okLabel = 'Đồng ý', danger = false }) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmText').innerHTML = html;
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    ok.textContent = okLabel;
    ok.className = danger ? 'btn btn-danger solid' : 'btn btn-primary';
    const done = (result) => {
      ok.onclick = null;
      cancel.onclick = null;
      closeModal('confirmModal');
      resolve(result);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    openModal('confirmModal');
    ok.focus();
  });
}

// ---------- Modals ----------
function openModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.add('active');
  const first = m.querySelector('input:not([type=hidden]):not([readonly]), select, button');
  if (first && id !== 'confirmModal') setTimeout(() => first.focus(), 30);
}

function closeModal(id) {
  const m = $(id);
  if (m) m.classList.remove('active');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal-overlay.active');
  if (open.length) {
    const last = open[open.length - 1];
    if (last.id === 'confirmModal') $('confirmCancel').click();
    else closeModal(last.id);
  } else {
    toggleNav(false);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) {
    if (e.target.id === 'confirmModal') $('confirmCancel').click();
    else closeModal(e.target.id);
  }
});

// ---------- Segmented controls ----------
function initSegmented(id, onChange) {
  const group = $(id);
  if (!group) return;
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    if (onChange) onChange(btn.dataset.value);
  });
}

function segValue(id) {
  const active = document.querySelector(`#${id} button.active`);
  return active ? active.dataset.value : null;
}

function setSegValue(id, value) {
  document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

// ---------- Navigation ----------
function switchTab(tabId) {
  if (!TABS[tabId] || (tabId === 'instance' && !currentInstanceId)) tabId = 'compute';
  currentTab = tabId;
  const navTab = NAV_PARENT[tabId] || tabId;

  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tabId));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === navTab));
  $('crumbTitle').textContent = TABS[tabId];
  const hash = tabId === 'instance' ? 'vm-' + currentInstanceId : tabId;
  if (location.hash !== '#' + hash) history.replaceState(null, '', '#' + hash);
  toggleNav(false);
  window.scrollTo(0, 0);

  if (!authToken) return;
  if (tabId === 'launch') initLaunchPage();
  if (tabId === 'instance') loadInstanceDetail(currentInstanceId);
  if (tabId === 'compute') loadInstances();
  if (tabId === 'storage') loadVolumes();
  if (tabId === 'images') loadImages();
  if (tabId === 'network') loadNetwork();
  if (tabId === 'migration') { loadScenarios(); if (!cachedInstances.length) loadInstances(true); }
  if (tabId === 'monitoring') {
    loadMonitoringOverview();
    loadAuditLogs();
  }
}

function retryCurrentTab() {
  hideApiBanner();
  switchTab(currentTab);
}

function routeFromHash() {
  const h = (location.hash || '').replace('#', '');
  if (h.startsWith('vm-') && h.length > 3) {
    currentInstanceId = h.slice(3);
    return 'instance';
  }
  return TABS[h] && h !== 'instance' ? h : 'compute';
}

function toggleNav(force) {
  const app = $('app');
  const open = typeof force === 'boolean' ? force : !app.classList.contains('nav-open');
  app.classList.toggle('nav-open', open);
}

// ---------- Theme ----------
function effectiveTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeIcon() {
  const btn = $('themeToggle');
  if (btn) btn.innerHTML = icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', 'icon');
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  storageSet('xregion_theme', next);
  applyThemeIcon();
  if (cachedSeries) renderPerformanceChart(cachedSeries);
}

// ---------- API ----------
async function apiRequest(endpoint, options = {}) {
  const { silent, ...fetchOptions } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {})
  };

  let res;
  try {
    res = await fetch(API_BASE + endpoint, { ...fetchOptions, headers });
  } catch (err) {
    showApiBanner('Không kết nối được máy chủ', 'Kiểm tra backend Spring Boot đang chạy và trình duyệt mở đúng địa chỉ, rồi bấm Thử lại.');
    throw err;
  }

  if (res.status === 401) {
    authToken = '';
    storageRemove('xregion_jwt');
    showAuth('login');
    throw new Error('Phiên đăng nhập đã hết hạn.');
  }

  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }

  if (res.status >= 500) {
    const msg = data.message || `Máy chủ trả về lỗi ${res.status}.`;
    showApiBanner(`Lỗi máy chủ khi gọi ${endpoint.split('?')[0]}`, msg + ' Nếu lỗi nhắc tới DynamoDB, kiểm tra thông tin AWS trong file .env hoặc DynamoDB Local.');
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  hideApiBanner();

  if (!res.ok) {
    const msg = data.message || `Máy chủ trả về lỗi ${res.status}.`;
    if (!silent) toast(res.status === 409 ? 'warn' : 'bad', res.status === 409 ? 'Đang bị khóa' : 'Không thực hiện được', msg);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data.data;
}

// Persistent banner for backend or DynamoDB failures (idea from anhtd/ui).
function showApiBanner(title, message) {
  const b = $('apiBanner');
  if (!b) return;
  $('apiBannerTitle').textContent = title;
  $('apiBannerMsg').textContent = message;
  b.hidden = false;
}

function hideApiBanner() {
  const b = $('apiBanner');
  if (b) b.hidden = true;
}

// ---------- Auth ----------
function showAuth(mode = 'login') {
  $('authScreen').hidden = false;
  $('loginForm').hidden = mode !== 'login';
  $('registerForm').hidden = mode !== 'register';
  $('loginError').hidden = true;
  $('registerError').hidden = true;
  setTimeout(() => (mode === 'login' ? $('loginUser') : $('regUser')).focus(), 30);
}

function hideAuth() {
  $('authScreen').hidden = true;
}

function setUser(name) {
  const display = name || 'Quản trị viên';
  $('userNameDisplay').textContent = display;
  const initials = display.split(/\s+/).filter(Boolean).slice(-2).map(p => p[0]).join('').toUpperCase();
  $('userAvatar').textContent = initials || 'QT';
  storageSet('xregion_user', display);
}

function onAuthenticated(data, fallbackName) {
  authToken = data.token;
  storageSet('xregion_jwt', authToken);
  setUser(data.fullName || fallbackName);
  hideAuth();
  switchTab(currentTab);
  loadInstances(true);
}

async function submitLogin(e) {
  e.preventDefault();
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const errEl = $('loginError');
  errEl.hidden = true;

  try {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.data && data.data.token) {
      $('loginPass').value = '';
      onAuthenticated(data.data, username);
    } else {
      errEl.textContent = data.message || 'Sai tài khoản hoặc mật khẩu.';
      errEl.hidden = false;
    }
  } catch (err) {
    errEl.textContent = 'Không kết nối được máy chủ. Kiểm tra backend đang chạy rồi thử lại.';
    errEl.hidden = false;
  }
}

function logout() {
  storageRemove('xregion_jwt');
  authToken = '';
  if (migrationPollInterval) clearInterval(migrationPollInterval);
  showAuth('login');
}

function switchToRegister() { showAuth('register'); }
function switchToLogin() { showAuth('login'); }

async function submitRegister(e) {
  e.preventDefault();
  const username = $('regUser').value.trim();
  const fullName = $('regFullName').value.trim();
  const password = $('regPass').value;
  const confirmPass = $('regPassConfirm').value;
  const errEl = $('registerError');
  errEl.hidden = true;

  if (password !== confirmPass) {
    errEl.textContent = 'Hai mật khẩu không khớp. Nhập lại mật khẩu ở ô thứ hai.';
    errEl.hidden = false;
    return;
  }

  try {
    const res = await fetch(API_BASE + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, fullName })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.data && data.data.token) {
      $('registerForm').reset();
      onAuthenticated(data.data, fullName || username);
      toast('ok', 'Đã tạo tài khoản', 'Chào mừng ' + (fullName || username) + '.');
    } else {
      errEl.textContent = data.message || 'Tài khoản đã tồn tại hoặc dữ liệu không hợp lệ.';
      errEl.hidden = false;
    }
  } catch (err) {
    errEl.textContent = 'Không kết nối được máy chủ. Kiểm tra backend đang chạy rồi thử lại.';
    errEl.hidden = false;
  }
}

// ---------- Region clocks (sidebar) ----------
function renderRegionClocks() {
  const box = $('regionClocks');
  if (!box) return;
  const now = new Date();
  box.innerHTML = REGION_CODES.map(code => {
    const r = REGIONS[code];
    const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: r.tz });
    const hour = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: r.tz }));
    const daytime = hour >= 7 && hour < 19;
    const count = cachedInstances.filter(i => i.region === code).length;
    return `<div class="region-clock ${r.cls}">
      <div class="rc-line"><span class="rc-name">${esc(r.city)}</span><span class="rc-time">${time}</span></div>
      <div class="rc-line"><span class="rc-code" title="${esc(r.label)}">${esc(code)}</span><span class="rc-meta">${daytime ? 'Ngày' : 'Đêm'} · ${count} VM</span></div>
    </div>`;
  }).join('');
}

// ---------- Region selects ----------
function fillRegionSelect(selectId, selected) {
  const el = $(selectId);
  if (!el) return;
  el.innerHTML = REGION_CODES.map(code => {
    const r = REGIONS[code];
    return `<option value="${code}" ${code === selected ? 'selected' : ''}>${r.label} · ${r.city} (${code})</option>`;
  }).join('');
}

function renderRegionChoices() {
  const group = $('instRegionGroup');
  if (!group) return;
  group.innerHTML = REGION_CODES.map((code, i) => {
    const r = REGIONS[code];
    return `<label class="choice ${r.cls}">
      <input type="radio" name="instRegion" value="${code}" ${i === 0 ? 'checked' : ''} onchange="renderFlavorTable(); updateLaunchSummary()">
      <span class="choice-title">${esc(r.label)} · ${esc(r.city)}</span>
      <span class="choice-sub mono">${esc(code)}</span>
    </label>`;
  }).join('');
}

// ---------- TAB: COMPUTE ----------
async function loadInstances(silent) {
  if (!silent && !cachedInstances.length) setLoadingRows('instanceTableBody', 7);
  try {
    const instances = await apiRequest('/instances', { silent });
    cachedInstances = instances || [];

    const total = cachedInstances.length;
    const running = cachedInstances.filter(i => i.status === 'ACTIVE').length;
    const stopped = cachedInstances.filter(i => i.status === 'SHUTOFF' || i.status === 'STOPPED').length;
    const migrating = cachedInstances.filter(i => i.status === 'MIGRATING').length;
    const regionA = cachedInstances.filter(i => regionInfo(i.region).key === 'A').length;
    const regionB = cachedInstances.filter(i => regionInfo(i.region).key === 'B').length;

    $('statTotalInstances').textContent = total;
    $('statRunningInstances').textContent = running;
    $('statStoppedInstances').textContent = stopped;
    $('statMigratingInstances').textContent = migrating;
    $('statRegionACount').textContent = `${regionA} ở Region A · ${regionB} ở Region B`;
    const pa = total ? (regionA / total) * 100 : 50;
    $('statRegionSplit').innerHTML = `<span class="a" style="width:${pa}%"></span><span class="b" style="width:${total ? 100 - pa : 50}%"></span>`;
    $('navCountInstances').textContent = total || '';
    $('navCountMigrating').textContent = migrating ? migrating + ' đang chạy' : '';

    const metricSelect = $('metricVmSelect');
    if (metricSelect) {
      const prev = metricSelect.value;
      metricSelect.innerHTML = cachedInstances.map(inst =>
        `<option value="${esc(inst.id)}">${esc(inst.name)} (${esc(inst.id)})</option>`).join('');
      if (prev && cachedInstances.some(i => i.id === prev)) metricSelect.value = prev;
    }

    renderRegionClocks();
    filterInstancesUI();
  } catch (err) {
    if (!silent) $('instanceTableBody').innerHTML = emptyRow(7, 'Chưa tải được danh sách máy ảo', ' Bấm làm mới để thử lại.');
  }
}

function filterInstancesUI() {
  const tbody = $('instanceTableBody');
  if (!tbody) return;

  const q = ($('instanceSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = segValue('instanceStatusFilter') || 'ALL';
  const regionFilter = $('instanceRegionFilter')?.value || 'ALL';

  const filtered = cachedInstances.filter(inst => {
    const matchText = !q || (inst.name || '').toLowerCase().includes(q) || (inst.id || '').toLowerCase().includes(q);
    const st = inst.status === 'STOPPED' ? 'SHUTOFF' : inst.status;
    const matchStatus = statusFilter === 'ALL' || st === statusFilter;
    const matchRegion = regionFilter === 'ALL' || inst.region === regionFilter;
    return matchText && matchStatus && matchRegion;
  });

  if (!cachedInstances.length) {
    tbody.innerHTML = emptyRow(7, 'Chưa có máy ảo nào', ' Tạo máy ảo đầu tiên ở một trong hai vùng.',
      `<button class="btn btn-primary" onclick="openLaunchModal()">${icon('plus')}Tạo máy ảo</button>`);
    return;
  }
  if (!filtered.length) {
    tbody.innerHTML = emptyRow(7, 'Không có máy ảo khớp bộ lọc', ' Đổi từ khóa hoặc chọn "Tất cả".');
    return;
  }

  tbody.innerHTML = filtered.map(inst => {
    const f = FLAVORS[inst.flavor];
    const busy = inst.status === 'MIGRATING';
    const running = inst.status === 'ACTIVE';
    const target = otherRegion(inst.region);
    return `<tr>
      <td><button class="instance-link" onclick="openInstance('${esc(inst.id)}')">${esc(inst.name)}</button><div class="cell-sub">${esc(inst.id)}</div></td>
      <td>${regionTag(inst.region)}</td>
      <td><span class="tag">${esc(inst.flavor)}</span>${f ? ` <span class="panel-sub">${f.cpu} vCPU · ${fmtRam(f.ram)}</span>` : ''}</td>
      <td><div><code>${esc(inst.publicIp || 'Chưa gán')}</code></div><div class="cell-sub">${esc(inst.privateIp || '–')}</div></td>
      <td>${inst.dnsDomain ? `<span class="mono-link">${esc(inst.dnsDomain)}</span>` : '<span class="panel-sub">–</span>'}</td>
      <td>${statusTag(inst.status)}</td>
      <td>
        <div class="row-actions">
          ${running
            ? `<button class="btn btn-sm btn-icon" title="Dừng" aria-label="Dừng ${esc(inst.name)}" onclick="instanceAction('${esc(inst.id)}', 'STOP')" ${busy ? 'disabled' : ''}>${icon('stop')}</button>`
            : `<button class="btn btn-sm btn-icon" title="Khởi động" aria-label="Khởi động ${esc(inst.name)}" onclick="instanceAction('${esc(inst.id)}', 'START')" ${busy ? 'disabled' : ''}>${icon('play')}</button>`}
          <button class="btn btn-sm btn-icon" title="Khởi động lại" aria-label="Khởi động lại ${esc(inst.name)}" onclick="instanceAction('${esc(inst.id)}', 'REBOOT')" ${busy || !running ? 'disabled' : ''}>${icon('reboot')}</button>
          <button class="btn btn-sm" title="Chuyển sang ${esc(regionInfo(target).city)}" onclick="triggerDirectMigration('${esc(inst.id)}')" ${busy ? 'disabled' : ''}>${icon('migrate')}Chuyển vùng</button>
          <button class="btn btn-sm btn-icon btn-danger" title="Xóa" aria-label="Xóa ${esc(inst.name)}" onclick="instanceAction('${esc(inst.id)}', 'TERMINATE')" ${busy ? 'disabled' : ''}>${icon('trash')}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ---------- PAGE: LAUNCH ----------
function openLaunchModal() {
  switchTab('launch');
}

function initLaunchPage() {
  $('launchForm').reset();
  renderRegionChoices();
  $('instImageGroup').innerHTML = OS_IMAGES.map((os, i) => `
    <label class="os-card">
      <input type="radio" name="instImage" value="${os.id}" ${i === 0 ? 'checked' : ''} onchange="updateLaunchSummary()">
      <span class="os-badge">${esc(os.name[0])}</span>
      <span><span class="os-name">${esc(os.name)}</span><br><span class="os-ver">${esc(os.version)}</span></span>
    </label>`).join('');
  setSegValue('flavorSeries', 'm1');
  selectedFlavor = DEFAULT_FLAVOR.m1;
  renderFlavorTable();
  updateLaunchSummary();
  setTimeout(() => $('instName').focus(), 30);
}

function renderFlavorTable() {
  const series = segValue('flavorSeries') || 'm1';
  const r = regionInfo(selectedLaunchRegion());
  $('flavorTableBody').innerHTML = Object.entries(FLAVORS)
    .filter(([, f]) => f.series === series)
    .map(([name, f]) => {
      const sel = name === selectedFlavor;
      return `<tr class="${sel ? 'selected' : ''}" onclick="selectFlavor('${name}')">
        <td><input type="radio" name="instFlavor" value="${name}" ${sel ? 'checked' : ''} aria-label="${name}"></td>
        <td><span class="tag">${name}</span>${name === DEFAULT_FLAVOR[series] ? ' <span class="panel-sub">mặc định</span>' : ''}</td>
        <td class="num">${f.cpu}</td>
        <td class="num">${fmtRam(f.ram)}</td>
        <td class="num">$${(f.hourly * r.priceFactor).toFixed(3)} / giờ</td>
      </tr>`;
    }).join('');
}

function selectFlavor(name) {
  selectedFlavor = name;
  renderFlavorTable();
  updateLaunchSummary();
}

function selectedLaunchRegion() {
  const checked = document.querySelector('input[name="instRegion"]:checked');
  return checked ? checked.value : REGION_CODES[0];
}

function selectedImage() {
  const checked = document.querySelector('input[name="instImage"]:checked');
  return checked ? checked.value : OS_IMAGES[0].id;
}

function updateLaunchSummary() {
  if (!$('instEbsSize')) return;
  const region = selectedLaunchRegion();
  const r = regionInfo(region);
  const flavor = FLAVORS[selectedFlavor] || FLAVORS['m1.medium'];
  const ebsSize = parseInt($('instEbsSize').value, 10) || 10;
  const name = $('instName').value.trim();

  const ebsHourly = (ebsSize * 0.08) / 720.0;
  const totalHourly = flavor.hourly * r.priceFactor + ebsHourly;
  const totalMonthly = totalHourly * 720.0;

  $('sumNameText').textContent = name || '–';
  $('sumRegionText').innerHTML = regionTag(region);
  $('sumOsText').textContent = OS_NAMES[selectedImage()] || selectedImage();
  $('sumSpecsText').textContent = `${selectedFlavor} · ${flavor.cpu} vCPU, ${fmtRam(flavor.ram)} RAM, ${ebsSize} GB gp3`;
  $('sumDomainText').textContent = $('instDomain').value.trim() || (name ? `${name.toLowerCase()}.xregion.net` : '–');
  $('sumCostHour').textContent = '$' + totalHourly.toFixed(3);
  $('sumCostMonth').textContent = `khoảng ${fmtMoney(totalMonthly)} / tháng (720 giờ)`;
}

async function instanceAction(id, action) {
  const inst = cachedInstances.find(i => i.id === id);
  const name = inst ? inst.name : id;

  if (action === 'TERMINATE') {
    const ok = await confirmDialog({
      title: 'Xóa máy ảo?',
      html: `Máy ảo <strong>${esc(name)}</strong> và ổ EBS đi kèm sẽ bị xóa vĩnh viễn. Bản ghi DNS trỏ tới máy này sẽ ngừng hoạt động.`,
      okLabel: 'Xóa máy ảo',
      danger: true
    });
    if (!ok) return;
  }
  if (action === 'STOP') {
    const ok = await confirmDialog({
      title: 'Dừng máy ảo?',
      html: `Dịch vụ chạy trên <strong>${esc(name)}</strong> sẽ gián đoạn cho tới khi bạn khởi động lại.`,
      okLabel: 'Dừng máy ảo'
    });
    if (!ok) return;
  }

  const labels = { START: 'Đã gửi lệnh khởi động', STOP: 'Đã gửi lệnh dừng', REBOOT: 'Đã gửi lệnh khởi động lại', TERMINATE: 'Đã xóa máy ảo' };
  try {
    await apiRequest(`/instances/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    toast('ok', labels[action] || 'Đã thực hiện', name);
    await loadInstances(true);
    if (currentTab === 'instance') {
      if (action === 'TERMINATE') switchTab('compute');
      else loadInstanceDetail(id);
    }
  } catch (err) { /* toast already shown */ }
}

async function submitLaunch(e) {
  e.preventDefault();
  const body = {
    name: $('instName').value.trim(),
    region: selectedLaunchRegion(),
    flavor: selectedFlavor,
    imageId: selectedImage(),
    ebsSizeGb: parseInt($('instEbsSize').value, 10) || 10,
    domainName: $('instDomain').value.trim()
  };

  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    const created = await apiRequest('/instances', { method: 'POST', body: JSON.stringify(body) });
    toast('ok', 'Đã tạo máy ảo', `${body.name} ở ${regionInfo(body.region).city}`);
    await loadInstances(true);
    if (created && created.id) openInstance(created.id);
    else switchTab('compute');
  } catch (err) { /* toast already shown */ }
  finally { if (btn) btn.disabled = false; }
}

// ---------- PAGE: INSTANCE DETAIL ----------
function openInstance(id) {
  currentInstanceId = id;
  switchTab('instance');
}

async function loadInstanceDetail(id) {
  if (!id) return;
  $('detCrumb').textContent = id;
  let inst;
  try {
    inst = await apiRequest(`/instances/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.status === 404) {
      toast('warn', 'Không tìm thấy máy ảo', `${id} có thể đã bị xóa.`);
      switchTab('compute');
    }
    return;
  }

  const r = regionInfo(inst.region);
  const f = FLAVORS[inst.flavor];
  const busy = inst.status === 'MIGRATING';
  const running = inst.status === 'ACTIVE';
  const target = otherRegion(inst.region);

  $('detName').textContent = inst.name;
  $('detStatus').innerHTML = statusTag(inst.status);
  $('detSub').innerHTML = `${regionTag(inst.region)} · <code>${esc(inst.id)}</code>`;
  $('detActions').innerHTML = `
    ${running
      ? `<button class="btn" onclick="instanceAction('${esc(inst.id)}', 'STOP')" ${busy ? 'disabled' : ''}>${icon('stop')}Dừng</button>`
      : `<button class="btn" onclick="instanceAction('${esc(inst.id)}', 'START')" ${busy ? 'disabled' : ''}>${icon('play')}Khởi động</button>`}
    <button class="btn" onclick="instanceAction('${esc(inst.id)}', 'REBOOT')" ${busy || !running ? 'disabled' : ''}>${icon('reboot')}Khởi động lại</button>
    <button class="btn btn-primary" onclick="triggerDirectMigration('${esc(inst.id)}')" ${busy ? 'disabled' : ''}>${icon('migrate')}Chuyển sang ${esc(regionInfo(target).city)}</button>
    <button class="btn btn-danger" onclick="instanceAction('${esc(inst.id)}', 'TERMINATE')" ${busy ? 'disabled' : ''}>${icon('trash')}Xóa</button>`;

  $('detConfig').innerHTML = `
    <dt>Flavor</dt><dd><span class="tag">${esc(inst.flavor)}</span>${f ? ` ${f.cpu} vCPU · ${fmtRam(f.ram)} RAM` : ''}</dd>
    <dt>Hệ điều hành</dt><dd>${esc(inst.imageName || OS_NAMES[inst.imageId] || inst.imageId || '–')}</dd>
    <dt>Ảo hóa</dt><dd>KVM trên EC2 Bare Metal, boot từ ổ EBS gp3</dd>
    <dt>Khóa chuyển vùng</dt><dd>${busy ? statusTag('MIGRATING') : 'Không khóa, có thể chuyển vùng'}</dd>
    <dt>Cập nhật lần cuối</dt><dd>${esc(fmtTime(inst.updatedAt))}</dd>`;

  $('detNetwork').innerHTML = `
    <dt>Vùng</dt><dd>${regionTag(inst.region)}</dd>
    <dt>Elastic IP</dt><dd><code>${esc(inst.publicIp || 'Chưa gán')}</code></dd>
    <dt>IP private</dt><dd><code>${esc(inst.privateIp || '–')}</code></dd>
    <dt>Tên miền</dt><dd>${inst.dnsDomain ? `<span class="mono-link">${esc(inst.dnsDomain)}</span> · TTL 60 giây` : '–'}</dd>
    <dt>Cổng mở</dt><dd>22 (SSH), 80 (HTTP), 443 (HTTPS)</dd>`;

  $('detMigrationSub').textContent = busy
    ? `Đang chuyển từ ${r.city} sang ${regionInfo(target).city}.`
    : `Đang chạy ở ${r.city}. Lần chuyển tiếp theo sẽ đưa máy sang ${regionInfo(target).city}.`;

  setLoadingRows('detVolumes', 5, 1);
  setLoadingRows('detScenarios', 5, 1);
  const [vols, scs, metrics] = await Promise.all([
    apiRequest('/volumes', { silent: true }).catch(() => null),
    apiRequest('/migrations/scenarios', { silent: true }).catch(() => null),
    apiRequest(`/metrics/instances/${encodeURIComponent(id)}`, { silent: true }).catch(() => null)
  ]);
  if (currentInstanceId !== id) return;

  const myVols = (vols || []).filter(v => v.attachedInstanceId === id || v.attachedInstanceName === inst.name);
  $('detVolumes').innerHTML = myVols.length ? myVols.map(v => `<tr>
      <td><div class="cell-main">${esc(v.name)}</div><div class="cell-sub">${esc(v.id)}</div></td>
      <td class="num">${esc(v.sizeGb)} GB</td>
      <td><code>${esc(v.device || '–')}</code></td>
      <td>${regionTag(v.region, false)}</td>
      <td>${statusTag(v.status)}</td>
    </tr>`).join('')
    : emptyRow(5, 'Chưa có ổ dữ liệu nào được gắn', ' Ổ gốc của máy ảo do hệ thống quản lý. Gắn thêm ổ ở trang Ổ đĩa & snapshot.');

  cachedScenarios = scs || cachedScenarios;
  const mine = (scs || []).filter(s => s.targetInstanceId === id);
  $('detScenarios').innerHTML = mine.length ? mine.map(sc => `<tr>
      <td><div class="cell-main">${esc(sc.name)}</div><div class="cell-sub">${esc(sc.id)}</div></td>
      <td>${routeTag(sc.sourceRegion, sc.destRegion)}</td>
      <td>${sc.triggerType === 'SCHEDULED' ? `Theo lịch <code>${esc(sc.cronExpression)}</code>` : 'Thủ công'}</td>
      <td>${sc.status ? statusTag(sc.status) : '<span class="panel-sub">Chưa chạy</span>'}</td>
      <td><div class="row-actions"><button class="btn btn-sm btn-primary" onclick="triggerDirectMigration('${esc(sc.id)}')" ${busy ? 'disabled' : ''}>${icon('play')}Chạy ngay</button></div></td>
    </tr>`).join('')
    : emptyRow(5, 'Chưa có kịch bản nào cho máy này', ' Tạo kịch bản để chuyển vùng theo lịch hoặc khi cần.');

  const pct = v => (v === undefined || v === null) ? '–' : `${Number(v).toFixed(1)}<span class="stat-unit">%</span>`;
  const mbps = v => (v === undefined || v === null) ? '–' : `${Math.round(v)}<span class="stat-unit">Mbps</span>`;
  $('detCpu').innerHTML = pct(metrics && metrics.currentCpuUsage);
  $('detRam').innerHTML = pct(metrics && metrics.currentRamUsage);
  $('detNetIn').innerHTML = mbps(metrics && metrics.currentNetworkIn);
  $('detNetOut').innerHTML = mbps(metrics && metrics.currentNetworkOut);
}

// ---------- TAB: STORAGE ----------
async function loadVolumes() {
  setLoadingRows('volumeTableBody', 8);
  try {
    if (!cachedInstances.length) await loadInstances(true);
    const volumes = await apiRequest('/volumes');
    cachedVolumes = volumes || [];
    const tbody = $('volumeTableBody');

    if (!cachedVolumes.length) {
      tbody.innerHTML = emptyRow(8, 'Chưa có ổ đĩa nào', ' Ổ đĩa gốc của máy ảo được tạo tự động; tạo thêm ổ dữ liệu nếu cần.',
        `<button class="btn btn-primary" onclick="openModal('createVolumeModal')">${icon('plus')}Tạo ổ đĩa</button>`);
      return;
    }

    tbody.innerHTML = cachedVolumes.map(vol => {
      const attached = vol.status === 'IN_USE';
      return `<tr>
        <td><div class="cell-main">${esc(vol.name)}</div><div class="cell-sub">${esc(vol.id)}</div></td>
        <td class="num">${esc(vol.sizeGb)} GB</td>
        <td><span class="tag">${esc(vol.volumeType)}</span></td>
        <td>${esc(vol.iops)} IOPS · ${esc(vol.throughput)} MB/s</td>
        <td>${regionTag(vol.region)}</td>
        <td>${attached ? attachedCell(vol) : '<span class="panel-sub">Chưa gắn</span>'}</td>
        <td>${statusTag(vol.status)}</td>
        <td>
          <div class="row-actions">
            ${attached
              ? `<button class="btn btn-sm" onclick="detachVolume('${esc(vol.id)}')">Tháo</button>`
              : `<button class="btn btn-sm" onclick="promptAttachVolume('${esc(vol.id)}')">${icon('link')}Gắn</button>`}
            <button class="btn btn-sm" title="Sao chép snapshot sang ${esc(regionInfo(otherRegion(vol.region)).city)}" onclick="openCopySnapshotModal('${esc(vol.id)}')">${icon('copy')}Sao chép</button>
            <button class="btn btn-sm btn-icon btn-danger" title="Xóa" aria-label="Xóa ${esc(vol.name)}" onclick="deleteVolume('${esc(vol.id)}')" ${attached ? 'disabled' : ''}>${icon('trash')}</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    $('volumeTableBody').innerHTML = emptyRow(8, 'Chưa tải được danh sách ổ đĩa', ' Bấm làm mới để thử lại.');
  }
}

function attachedCell(vol) {
  const inst = cachedInstances.find(i => i.id === vol.attachedInstanceId || i.id === vol.attachedInstanceName);
  const name = inst ? inst.name : (vol.attachedInstanceName || vol.attachedInstanceId);
  const sub = [inst ? inst.id : '', vol.device || ''].filter(Boolean).join(' · ');
  return `<div class="cell-main">${esc(name)}</div>${sub ? `<div class="cell-sub">${esc(sub)}</div>` : ''}`;
}

async function submitCreateVolume(e) {
  e.preventDefault();
  const body = {
    name: $('volName').value.trim(),
    sizeGb: parseInt($('volSize').value, 10) || 20,
    region: $('volRegion').value,
    volumeType: 'gp3'
  };
  try {
    await apiRequest('/volumes', { method: 'POST', body: JSON.stringify(body) });
    closeModal('createVolumeModal');
    $('volumeForm').reset();
    fillRegionSelect('volRegion', REGION_CODES[0]);
    toast('ok', 'Đã tạo ổ đĩa', `${body.name} · ${body.sizeGb} GB`);
    loadVolumes();
  } catch (err) { /* toast already shown */ }
}

async function detachVolume(id) {
  const vol = cachedVolumes.find(v => v.id === id);
  const ok = await confirmDialog({
    title: 'Tháo ổ đĩa?',
    html: `Ổ <strong>${esc(vol ? vol.name : id)}</strong> sẽ được tháo khỏi máy ảo. Hãy unmount trong hệ điều hành trước để tránh mất dữ liệu.`,
    okLabel: 'Tháo ổ đĩa'
  });
  if (!ok) return;
  try {
    await apiRequest(`/volumes/${encodeURIComponent(id)}/detach`, { method: 'POST' });
    toast('ok', 'Đã tháo ổ đĩa');
    loadVolumes();
  } catch (err) { /* toast already shown */ }
}

async function promptAttachVolume(volId) {
  const vol = cachedVolumes.find(v => v.id === volId);
  await loadInstances(true);
  const sameRegion = cachedInstances.filter(i => !vol || i.region === vol.region);
  $('attachVolId').value = volId;
  $('attachVolDisplay').value = vol ? `${vol.name} (${vol.id})` : volId;
  $('attachInstanceSelect').innerHTML = sameRegion.length
    ? sameRegion.map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.id)})</option>`).join('')
    : '<option value="">Không có máy ảo cùng vùng</option>';
  $('attachHint').textContent = vol ? `Chỉ hiện máy ảo ở ${regionInfo(vol.region).city}, cùng vùng với ổ đĩa.` : '';
  const empty = $('attachEmpty');
  empty.hidden = sameRegion.length > 0;
  if (!sameRegion.length && vol) {
    empty.textContent = `Chưa có máy ảo nào ở ${regionInfo(vol.region).city}. Tạo máy ảo ở vùng này, hoặc sao chép ổ đĩa sang ${regionInfo(otherRegion(vol.region)).city} rồi gắn bản sao.`;
  }
  $('attachSubmit').disabled = sameRegion.length === 0;
  $('attachInstanceSelect').disabled = sameRegion.length === 0;
  openModal('attachVolumeModal');
}

async function submitAttachVolume(e) {
  e.preventDefault();
  const volId = $('attachVolId').value;
  const instanceId = $('attachInstanceSelect').value;
  if (!instanceId) return;
  try {
    await apiRequest(`/volumes/${encodeURIComponent(volId)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ instanceId, device: $('attachDevice').value || '/dev/vdb' })
    });
    closeModal('attachVolumeModal');
    toast('ok', 'Đã gắn ổ đĩa');
    loadVolumes();
  } catch (err) { /* toast already shown */ }
}

function openCopySnapshotModal(volId) {
  const vol = cachedVolumes.find(v => v.id === volId) || { id: volId, name: volId, region: REGION_CODES[0] };
  $('copyVolId').value = vol.id;
  $('copySrcRegion').value = vol.region;
  $('copyVolNameDisplay').value = `${vol.name} (${vol.id}) · ${regionInfo(vol.region).city}`;
  fillRegionSelect('copyDestRegion', otherRegion(vol.region));
  openModal('copySnapshotModal');
}

async function submitCopySnapshot(e) {
  e.preventDefault();
  const body = {
    volumeId: $('copyVolId').value,
    sourceRegion: $('copySrcRegion').value,
    destinationRegion: $('copyDestRegion').value,
    description: 'Cross-region copy triggered from UI'
  };
  if (body.sourceRegion === body.destinationRegion) {
    toast('warn', 'Chọn vùng đích khác vùng nguồn');
    return;
  }
  try {
    await apiRequest('/volumes/cross-region-copy', { method: 'POST', body: JSON.stringify(body) });
    closeModal('copySnapshotModal');
    toast('ok', 'Đã bắt đầu sao chép snapshot', `Sang ${regionInfo(body.destinationRegion).city} (${body.destinationRegion})`);
    loadVolumes();
  } catch (err) { /* toast already shown */ }
}

async function deleteVolume(id) {
  const vol = cachedVolumes.find(v => v.id === id);
  const ok = await confirmDialog({
    title: 'Xóa ổ đĩa?',
    html: `Ổ <strong>${esc(vol ? vol.name : id)}</strong> và dữ liệu trên đó sẽ bị xóa vĩnh viễn.`,
    okLabel: 'Xóa ổ đĩa',
    danger: true
  });
  if (!ok) return;
  try {
    await apiRequest(`/volumes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('ok', 'Đã xóa ổ đĩa');
    loadVolumes();
  } catch (err) { /* toast already shown */ }
}

// ---------- TAB: IMAGES ----------
async function loadImages() {
  const grid = $('imageGrid');
  grid.innerHTML = '<div class="image-card"><span class="skeleton"></span><span class="skeleton"></span></div>'.repeat(3);
  try {
    const images = await apiRequest('/images');
    if (!images || !images.length) {
      grid.innerHTML = '<div class="empty"><strong>Chưa có image nào</strong>Image hệ điều hành được nạp từ Glance khi hệ thống khởi động.</div>';
      return;
    }
    grid.innerHTML = images.map(img => `
      <article class="image-card">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="os-badge">${esc((img.osType || img.name || '?').slice(0, 1).toUpperCase())}</div>
          <div style="min-width:0">
            <h3>${esc(img.name)}</h3>
            <div class="cell-sub">${esc(img.glanceId)}</div>
          </div>
        </div>
        <div class="meta">
          <span>${esc(img.osType)} · ${esc(img.sizeGb)} GB</span>
          <span>${esc(img.visibility)}</span>
        </div>
        <div>${statusTag(img.status === 'ACTIVE' ? 'ACTIVE' : img.status)}</div>
      </article>`).join('');
  } catch (err) {
    grid.innerHTML = '<div class="empty"><strong>Chưa tải được danh sách image</strong>Bấm làm mới để thử lại.</div>';
  }
}

// ---------- TAB: NETWORK ----------
let cachedDns = [];

async function loadNetwork() {
  setLoadingRows('dnsTableBody', 6, 2);
  setLoadingRows('fipTableBody', 5, 2);
  try {
    const net = await apiRequest('/network');

    $('vpcContainer').innerHTML = (net.vpcs || []).map(vpc => {
      const r = regionInfo(vpc.region);
      return `<div class="vpc ${r.cls}">
        <div>
          <div class="vpc-name">${esc(r.label)} · ${esc(r.city)}</div>
          <div class="cell-sub">${esc(vpc.name)}</div>
        </div>
        <dl class="kv">
          <dt>Mã vùng</dt><dd>${esc(vpc.region)}</dd>
          <dt>VPC CIDR</dt><dd>${esc(vpc.cidr)}</dd>
          <dt>VPC ID</dt><dd>${esc(vpc.id)}</dd>
          <dt>Subnet</dt><dd>${esc(vpc.primarySubnetId || '–')}</dd>
        </dl>
      </div>`;
    }).join('') || '<div class="empty"><strong>Chưa có thông tin VPC</strong></div>';

    cachedDns = net.dnsRecords || [];
    $('dnsTableBody').innerHTML = cachedDns.length ? cachedDns.map((dns, i) => `
      <tr>
        <td><span class="mono-link">${esc(dns.domainName)}</span></td>
        <td><span class="tag">A</span></td>
        <td><code>${esc(dns.targetIp)}</code></td>
        <td class="num">${esc(dns.ttl)} s</td>
        <td>${statusTag(dns.status || 'SYNCED')}</td>
        <td><div class="row-actions"><button class="btn btn-sm" onclick="openDnsModal(${i})">Sửa</button></div></td>
      </tr>`).join('') : emptyRow(6, 'Chưa có bản ghi DNS', ' Bản ghi được tạo tự động khi tạo máy ảo.');

    const fips = net.floatingIps || [];
    $('fipTableBody').innerHTML = fips.length ? fips.map(f => `
      <tr>
        <td><code>${esc(f.ip)}</code></td>
        <td>${regionTag(f.region)}</td>
        <td>${f.associatedInstanceName ? `<div class="cell-main">${esc(f.associatedInstanceName)}</div><div class="cell-sub">${esc(f.associatedInstanceId)}</div>` : '<span class="panel-sub">Chưa gắn</span>'}</td>
        <td><code>${esc(f.privateIp || '–')}</code></td>
        <td>${statusTag(f.status)}</td>
      </tr>`).join('') : emptyRow(5, 'Chưa có Elastic IP', ' Elastic IP được cấp khi tạo máy ảo.');
  } catch (err) {
    $('dnsTableBody').innerHTML = emptyRow(6, 'Chưa tải được thông tin mạng', ' Bấm làm mới để thử lại.');
    $('fipTableBody').innerHTML = '';
  }
}

function openDnsModal(index) {
  const rec = typeof index === 'number' ? cachedDns[index] : null;
  $('dnsDomainInput').value = rec ? rec.domainName : '';
  $('dnsTargetIpInput').value = rec ? rec.targetIp : '';
  $('dnsTtlInput').value = rec ? rec.ttl : 60;
  openModal('dnsModal');
}

async function submitUpdateDns(e) {
  e.preventDefault();
  const body = {
    domainName: $('dnsDomainInput').value.trim(),
    targetIp: $('dnsTargetIpInput').value.trim(),
    ttl: parseInt($('dnsTtlInput').value, 10) || 60
  };
  try {
    await apiRequest('/network/dns', { method: 'POST', body: JSON.stringify(body) });
    closeModal('dnsModal');
    toast('ok', 'Đã cập nhật DNS', `${body.domainName} trỏ tới ${body.targetIp}`);
    loadNetwork();
  } catch (err) { /* toast already shown */ }
}

// ---------- TAB: MIGRATION ----------
let cachedScenarios = [];

async function loadScenarios() {
  setLoadingRows('scenarioTableBody', 7, 2);
  try {
    const scenarios = await apiRequest('/migrations/scenarios');
    cachedScenarios = scenarios || [];
    const tbody = $('scenarioTableBody');

    if (!cachedScenarios.length) {
      tbody.innerHTML = emptyRow(7, 'Chưa có kịch bản nào', ' Tạo kịch bản để chuyển vùng theo lịch hoặc khi bạn bấm chạy.',
        `<button class="btn btn-primary" onclick="openScenarioModal()">${icon('plus')}Tạo kịch bản</button>`);
      return;
    }

    tbody.innerHTML = cachedScenarios.map(sc => {
      const inst = cachedInstances.find(i => i.id === sc.targetInstanceId);
      const scheduled = sc.triggerType === 'SCHEDULED';
      const running = sc.status === 'IN_PROGRESS';
      return `<tr>
        <td><div class="cell-main">${esc(sc.name)}</div><div class="cell-sub">${esc(sc.id)}</div></td>
        <td>${inst ? `<div class="cell-main">${esc(inst.name)}</div>` : ''}<div class="cell-sub">${esc(sc.targetInstanceId)}</div></td>
        <td>${routeTag(sc.sourceRegion, sc.destRegion)}</td>
        <td>${scheduled ? `Theo lịch <code>${esc(sc.cronExpression)}</code>` : 'Thủ công'}</td>
        <td class="num">${esc(sc.cooldownMinutes)} phút</td>
        <td>${sc.status ? statusTag(sc.status) : '<span class="panel-sub">Chưa chạy</span>'}</td>
        <td><div class="row-actions"><button class="btn btn-sm btn-primary" onclick="triggerDirectMigration('${esc(sc.id)}')" ${running ? 'disabled' : ''}>${icon('play')}Chạy ngay</button></div></td>
      </tr>`;
    }).join('');
  } catch (err) {
    $('scenarioTableBody').innerHTML = emptyRow(7, 'Chưa tải được kịch bản', ' Bấm làm mới để thử lại.');
  }
}

async function openScenarioModal(preselectId) {
  if (!cachedInstances.length) await loadInstances(true);
  $('scenarioForm').reset();
  setSegValue('scTriggerType', 'MANUAL');
  $('scCronField').hidden = true;
  $('scInstanceSelect').innerHTML = cachedInstances.length
    ? cachedInstances.map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.id)}) · ${esc(regionInfo(i.region).city)}</option>`).join('')
    : '<option value="">Chưa có máy ảo</option>';
  if (typeof preselectId === 'string' && cachedInstances.some(i => i.id === preselectId)) $('scInstanceSelect').value = preselectId;
  syncScenarioRegions();
  openModal('scenarioModal');
}

function syncScenarioRegions() {
  const inst = cachedInstances.find(i => i.id === $('scInstanceSelect').value);
  const src = inst ? inst.region : REGION_CODES[0];
  fillRegionSelect('scSrcRegion', src);
  fillRegionSelect('scDstRegion', otherRegion(src));
}

async function submitCreateScenario(e) {
  e.preventDefault();
  const triggerType = segValue('scTriggerType') || 'MANUAL';
  const body = {
    name: $('scName').value.trim(),
    targetInstanceId: $('scInstanceSelect').value,
    sourceRegion: $('scSrcRegion').value,
    destRegion: $('scDstRegion').value,
    triggerType,
    cooldownMinutes: parseInt($('scCooldown').value, 10) || 60
  };
  if (triggerType === 'SCHEDULED') body.cronExpression = $('scCron').value.trim();
  if (!body.targetInstanceId) {
    toast('warn', 'Chưa chọn máy ảo', 'Tạo máy ảo trước rồi quay lại tạo kịch bản.');
    return;
  }

  try {
    await apiRequest('/migrations/scenarios', { method: 'POST', body: JSON.stringify(body) });
    closeModal('scenarioModal');
    toast('ok', 'Đã lưu kịch bản', body.name);
    if (currentTab === 'instance') loadInstanceDetail(currentInstanceId);
    else loadScenarios();
  } catch (err) { /* toast already shown */ }
}

async function triggerDirectMigration(targetId) {
  const sc = cachedScenarios.find(s => s.id === targetId);
  const inst = cachedInstances.find(i => i.id === (sc ? sc.targetInstanceId : targetId));
  const src = sc ? sc.sourceRegion : inst ? inst.region : REGION_CODES[0];
  const dst = sc ? sc.destRegion : otherRegion(src);
  const name = inst ? inst.name : (sc ? sc.targetInstanceId : targetId);

  const ok = await confirmDialog({
    title: 'Chuyển vùng ngay?',
    html: `<strong>${esc(name)}</strong> sẽ được chuyển từ ${esc(regionInfo(src).city)} sang ${esc(regionInfo(dst).city)}. Dịch vụ tạm gián đoạn trong lúc dừng máy nguồn và tạo snapshot cuối. Nếu một bước thất bại, hệ thống bật lại máy ở vùng nguồn.`,
    okLabel: 'Bắt đầu chuyển vùng'
  });
  if (!ok) return;

  switchTab('migration');
  renderRunHeader({ instanceName: name, instanceId: inst ? inst.id : targetId, sourceRegion: src, destRegion: dst, progressPercent: 0, status: 'IN_PROGRESS', stepNumber: 0 });

  try {
    const res = await apiRequest('/migrations/trigger', {
      method: 'POST',
      body: JSON.stringify({ id: targetId })
    });
    updatePipelineUI({ sourceRegion: src, destRegion: dst, instanceName: name, ...res });
    startProgressPolling(res.instanceId);
    loadInstances(true);
  } catch (err) {
    renderRunHeader({ instanceName: name, sourceRegion: src, destRegion: dst, progressPercent: 0, status: 'FAILED', stepNumber: 0, currentStep: err.message });
  }
}

function startProgressPolling(instanceId) {
  if (migrationPollInterval) clearInterval(migrationPollInterval);
  appendTerminal(`Bắt đầu theo dõi tiến trình cho ${instanceId}`, true);

  migrationPollInterval = setInterval(async () => {
    try {
      const data = await apiRequest(`/migrations/progress/${encodeURIComponent(instanceId)}`, { silent: true });
      updatePipelineUI(data);
      if (['COMPLETED', 'ROLLED_BACK', 'FAILED'].includes(data.status)) {
        clearInterval(migrationPollInterval);
        migrationPollInterval = null;
        if (data.status === 'COMPLETED') toast('ok', 'Chuyển vùng hoàn tất', `${data.instanceName || instanceId} đang chạy ở ${regionInfo(data.destRegion).city}`);
        else toast('bad', 'Chuyển vùng thất bại', 'Máy ảo đã được bật lại ở vùng nguồn. Xem nhật ký để biết bước lỗi.');
        loadInstances(true);
        loadScenarios();
      }
    } catch (err) {
      clearInterval(migrationPollInterval);
      migrationPollInterval = null;
    }
  }, 1000);
}

function renderRunHeader(data) {
  const src = data.sourceRegion;
  const dst = data.destRegion;
  const pct = Math.max(0, Math.min(100, data.progressPercent || 0));
  const failed = data.status === 'FAILED' || data.status === 'ROLLED_BACK';

  $('runTitle').textContent = data.instanceName || data.instanceId || 'Máy ảo';
  $('runRoute').innerHTML = `${routeTag(src, dst)}${data.currentStep ? `<span class="panel-sub">${esc(data.currentStep)}</span>` : ''}`;
  $('runPercent').innerHTML = `${pct}%<small>${esc((STATUS_VIEW[data.status] || {}).text || 'Đang chờ')}</small>`;

  const progress = $('runProgress');
  progress.classList.toggle('failed', failed);
  progress.style.setProperty('--from-color', `var(--reg-${regionInfo(src).cls || 'a'})`);
  progress.style.setProperty('--to-color', `var(--reg-${regionInfo(dst).cls || 'b'})`);
  $('pipelineBar').style.width = pct + '%';
}

function updatePipelineUI(data) {
  renderRunHeader(data);

  const step = data.stepNumber || 0;
  const failed = data.status === 'FAILED' || data.status === 'ROLLED_BACK';
  const completed = data.status === 'COMPLETED';

  for (let i = 1; i <= 6; i++) {
    const li = $('stepCircle' + i);
    const dot = li.querySelector('.pipe-dot');
    li.className = 'pipe-step';
    if (completed || i < step) {
      li.classList.add('done');
      dot.innerHTML = icon('check');
    } else if (i === step) {
      li.classList.add(failed ? 'failed' : 'active');
      dot.innerHTML = failed ? icon('x') : String(i);
    } else {
      dot.textContent = String(i);
    }
  }

  if (data.logs && data.logs.length) {
    const term = $('terminalLogs');
    term.innerHTML = data.logs.map(l => `<div class="ln">${esc(l)}</div>`).join('');
    term.scrollTop = term.scrollHeight;
  }
}

function appendTerminal(line, dim) {
  const term = $('terminalLogs');
  const time = new Date().toLocaleTimeString('vi-VN');
  term.insertAdjacentHTML('beforeend', `<div class="ln${dim ? ' dim' : ''}">[${time}] ${esc(line)}</div>`);
  term.scrollTop = term.scrollHeight;
}

function clearTerminal() {
  $('terminalLogs').innerHTML = '';
}

// ---------- TAB: MONITORING ----------
async function loadMonitoringOverview() {
  if (!cachedInstances.length) await loadInstances(true);
  loadMetrics();
}

async function loadMetrics() {
  const instanceId = $('metricVmSelect').value;
  if (!instanceId) {
    $('costCards').innerHTML = '<div class="empty"><strong>Chưa có máy ảo để giám sát</strong>Tạo máy ảo trước, số liệu sẽ xuất hiện ở đây.</div>';
    return;
  }
  try {
    const data = await apiRequest(`/metrics/instances/${encodeURIComponent(instanceId)}`);
    renderMetricStats(data);
    renderCostCards(data.costSummary);
    renderPerformanceChart(data.timeSeries);
  } catch (err) { /* toast already shown */ }
}

function renderMetricStats(d) {
  const pct = v => (v === undefined || v === null) ? '–' : `${Number(v).toFixed(1)}<span class="stat-unit">%</span>`;
  const mbps = v => (v === undefined || v === null) ? '–' : `${Math.round(v)}<span class="stat-unit">Mbps</span>`;
  $('mCpu').innerHTML = pct(d.currentCpuUsage);
  $('mRam').innerHTML = pct(d.currentRamUsage);
  $('mNetIn').innerHTML = mbps(d.currentNetworkIn);
  $('mNetOut').innerHTML = mbps(d.currentNetworkOut);
}

function renderCostCards(costs) {
  if (!costs) return;
  const container = $('costCards');
  const aCompute = Number(costs.virginiaComputeMonthly) || 0;
  const aStorage = Number(costs.virginiaStorageMonthly) || 0;
  const bCompute = Number(costs.sydneyComputeMonthly) || 0;
  const bStorage = Number(costs.sydneyStorageMonthly) || 0;
  const xfer = Number(costs.crossRegionDataTransfer) || 0;
  const total = Number(costs.totalMonthlyEstimated) || (aCompute + aStorage + bCompute + bStorage + xfer);
  const max = Math.max(aCompute + aStorage, bCompute + bStorage, xfer, 1);
  const w = v => (v / max) * 100;

  const row = (code, compute, storage) => {
    const r = REGIONS[code];
    return `<div class="cost-row">
      <div class="cost-row-head">${regionTag(code, false)}<strong>${fmtMoney(compute + storage)}</strong></div>
      <div class="cost-bar"><span class="compute ${r.cls}" style="width:${w(compute)}%"></span><span class="storage ${r.cls}" style="width:${w(storage)}%"></span></div>
      <div class="cost-legend"><span>Máy ảo ${fmtMoney(compute)}</span><span>Ổ đĩa ${fmtMoney(storage)}</span></div>
    </div>`;
  };

  container.innerHTML = `
    <div class="cost-total">${fmtMoney(total)} <small>/ tháng</small></div>
    <div class="cost-rows">
      ${row('us-east-1', aCompute, aStorage)}
      ${row('ap-southeast-2', bCompute, bStorage)}
      <div class="cost-row">
        <div class="cost-row-head"><span>Truyền dữ liệu liên vùng</span><strong>${fmtMoney(xfer)}</strong></div>
        <div class="cost-bar"><span class="xfer" style="width:${w(xfer)}%"></span></div>
      </div>
    </div>
    <p class="cost-note">Tính từ đơn giá theo giờ của từng vùng nhân với số giờ máy ảo đã chạy, cộng phí sao chép snapshot giữa hai vùng.</p>`;
}

function renderPerformanceChart(timeSeries) {
  if (!timeSeries || typeof Chart === 'undefined') return;
  cachedSeries = timeSeries;
  const mode = segValue('chartMode') || 'usage';
  const ctx = $('performanceChart').getContext('2d');

  const labels = timeSeries.map(p => new Date(p.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }));
  const ink = cssVar('--ink-2');
  const grid = cssVar('--line');
  const c1 = cssVar(mode === 'usage' ? '--accent' : '--reg-a');
  const c2 = cssVar(mode === 'usage' ? '--ok' : '--reg-b');

  const datasets = mode === 'usage'
    ? [
        { label: 'CPU (%)', data: timeSeries.map(p => p.cpuUsage), borderColor: c1, backgroundColor: c1 + '22' },
        { label: 'RAM (%)', data: timeSeries.map(p => p.ramUsage), borderColor: c2, backgroundColor: c2 + '22' }
      ]
    : [
        { label: 'Mạng vào (Mbps)', data: timeSeries.map(p => p.networkIn), borderColor: c1, backgroundColor: c1 + '22' },
        { label: 'Mạng ra (Mbps)', data: timeSeries.map(p => p.networkOut), borderColor: c2, backgroundColor: c2 + '22' }
      ];

  datasets.forEach(d => Object.assign(d, {
    tension: 0.3,
    fill: true,
    borderWidth: 2,
    pointRadius: (c) => c.dataIndex === timeSeries.length - 1 ? 4 : 0,
    pointBackgroundColor: d.borderColor,
    pointHoverRadius: 4
  }));

  if (performanceChart) performanceChart.destroy();

  performanceChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: {
          beginAtZero: true,
          max: mode === 'usage' ? 100 : undefined,
          grid: { color: grid },
          ticks: { color: ink, callback: v => mode === 'usage' ? v + '%' : v }
        },
        x: { grid: { display: false }, ticks: { color: ink, maxRotation: 0, autoSkipPadding: 12 } }
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: ink, boxWidth: 10, boxHeight: 10, usePointStyle: true } }
      }
    }
  });
}

async function loadAuditLogs() {
  setLoadingRows('auditTableBody', 5);
  try {
    const logs = await apiRequest('/logs?limit=50');
    const tbody = $('auditTableBody');
    if (!logs || !logs.length) {
      tbody.innerHTML = emptyRow(5, 'Chưa có nhật ký', ' Mọi thao tác trên máy ảo, ổ đĩa và kịch bản sẽ được ghi lại ở đây.');
      return;
    }
    tbody.innerHTML = logs.map(log => `
      <tr>
        <td class="panel-sub">${esc(fmtTime(log.timestamp))}</td>
        <td><strong>${esc(log.username || 'system')}</strong></td>
        <td><span class="tag">${esc(log.action)}</span></td>
        <td><div>${esc(log.resourceType)}</div><div class="cell-sub">${esc(log.resourceId)}</div></td>
        <td class="wrap">${esc(log.details)}</td>
      </tr>`).join('');
  } catch (err) {
    $('auditTableBody').innerHTML = emptyRow(5, 'Chưa tải được nhật ký', ' Bấm làm mới để thử lại.');
  }
}

// ---------- Bootstrap ----------
window.addEventListener('DOMContentLoaded', () => {
  const savedTheme = storageGet('xregion_theme');
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);
  applyThemeIcon();

  fillRegionSelect('volRegion', REGION_CODES[0]);
  const regionFilter = $('instanceRegionFilter');
  regionFilter.innerHTML = '<option value="ALL">Mọi vùng</option>' +
    REGION_CODES.map(c => `<option value="${c}">${REGIONS[c].city} (${c})</option>`).join('');

  initSegmented('instanceStatusFilter', () => filterInstancesUI());
  initSegmented('chartMode', () => { if (cachedSeries) renderPerformanceChart(cachedSeries); });
  initSegmented('scTriggerType', (v) => { $('scCronField').hidden = v !== 'SCHEDULED'; });
  initSegmented('flavorSeries', (v) => { selectedFlavor = DEFAULT_FLAVOR[v]; renderFlavorTable(); updateLaunchSummary(); });

  renderRegionClocks();
  setInterval(renderRegionClocks, 30000);

  currentTab = routeFromHash();
  window.addEventListener('hashchange', () => {
    const prevVm = currentInstanceId;
    const tab = routeFromHash();
    if (tab !== currentTab || (tab === 'instance' && currentInstanceId !== prevVm)) switchTab(tab);
  });

  setUser(storageGet('xregion_user'));

  if (!authToken) {
    switchTab(currentTab);
    showAuth('login');
  } else {
    switchTab(currentTab);
    if (currentTab !== 'compute') loadInstances(true);
  }
});
