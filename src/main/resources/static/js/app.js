// XRegion Dashboard Client-side JavaScript

const API_BASE = '/api';
let authToken = localStorage.getItem('xregion_jwt') || '';
let performanceChart = null;
let migrationPollInterval = null;
let serverClockOffsetMs = 0;

// Auth Guard: Tự động kiểm tra phiên đăng nhập và chuyển hướng nếu chưa xác thực
function requireAuthGuard() {
  const token = localStorage.getItem('xregion_jwt');
  const path = window.location.pathname;
  const isAuthPage = path.endsWith('/login.html') || path.endsWith('/register.html') || path.endsWith('login') || path.endsWith('register');

  if (!token && !isAuthPage) {
    const currentUrl = window.location.pathname + window.location.search;
    window.location.replace('/login.html?redirect=' + encodeURIComponent(currentUrl));
    return false;
  }
  return true;
}

// Chạy kiểm tra Auth Guard ngay khi nạp file app.js
requireAuthGuard();

// Đồng bộ đồng hồ trình duyệt với Server & AWS DynamoDB
async function syncServerClock() {
  try {
    const clientBefore = Date.now();
    const res = await fetch(API_BASE + '/auth/health');
    if (res.ok) {
      const data = await res.json();
      const clientAfter = Date.now();
      const rttHalf = Math.round((clientAfter - clientBefore) / 2);
      const serverTs = Number(data.timestamp);
      if (!isNaN(serverTs) && serverTs > 0) {
        serverClockOffsetMs = (serverTs + rttHalf) - clientAfter;
      }
    }
  } catch (e) {
    console.warn('Clock sync skipped:', e);
  }
}

function getSyncedNowMs() {
  return Date.now() + serverClockOffsetMs;
}

function getSyncedNowSec() {
  return Math.floor(getSyncedNowMs() / 1000);
}

// Tự động chuẩn hóa cả Epoch Seconds (10 chữ số trên DynamoDB) lẫn Milliseconds (13 chữ số)
function toNormalizedMillis(rawTs) {
  if (!rawTs || isNaN(Number(rawTs))) return getSyncedNowMs();
  const num = Number(rawTs);
  return num < 10000000000 ? num * 1000 : num;
}

function formatSyncedDateTime(rawTs) {
  if (!rawTs) return 'Vừa xong';
  const ms = toNormalizedMillis(rawTs);
  return new Date(ms).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
}

// Khởi chạy đồng bộ thời gian ngay khi tải script
syncServerClock();

// ============================================================
// SESSION GUARD, AUTO-LOGOUT & REQUIRE AUTH ON ALL PAGES (INCLUDING /index.html)
// ============================================================
function isJwtTokenExpired() {
  const token = localStorage.getItem('xregion_jwt');
  if (!token) return true;
  const expiresAt = Number(localStorage.getItem('xregion_jwt_expires_at') || 0);
  if (expiresAt > 0 && getSyncedNowMs() >= expiresAt) {
    return true;
  }
  // Fallback: giải mã payload JWT (`exp` tính bằng giây) nếu chưa có `xregion_jwt_expires_at`
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.exp && getSyncedNowSec() >= payload.exp) {
        return true;
      }
    }
  } catch (e) {
    // ignore decode errors
  }
  return false;
}

function enforceAuthGuard() {
  const path = window.location.pathname;
  const isAuthPage = path.endsWith('/login.html') || path.endsWith('/register.html');
  const token = localStorage.getItem('xregion_jwt');
  const expired = isJwtTokenExpired();

  if (token && expired) {
    localStorage.removeItem('xregion_jwt');
    localStorage.removeItem('xregion_user');
    localStorage.removeItem('xregion_jwt_expires_at');
    authToken = '';
    if (!isAuthPage) {
      alert('Phiên đăng nhập của bạn đã hết hạn. Vui lòng đăng nhập lại!');
      window.location.replace('/login.html');
    }
    return;
  }

  // Nếu chưa đăng nhập thì chặn toàn bộ trang (bao gồm cả / và /index.html) và đẩy về /login.html
  if (!isAuthPage && !token) {
    window.location.replace('/login.html');
  }
}

enforceAuthGuard();
setInterval(() => {
  const path = window.location.pathname;
  const isAuthPage = path.endsWith('/login.html') || path.endsWith('/register.html');
  if (!isAuthPage && isJwtTokenExpired()) {
    localStorage.removeItem('xregion_jwt');
    localStorage.removeItem('xregion_user');
    localStorage.removeItem('xregion_jwt_expires_at');
    authToken = '';
    showToast('Phiên đăng nhập đã hết hạn, đang tự động đăng xuất...', 'error');
    setTimeout(() => {
      window.location.replace('/login.html');
    }, 600);
  }
}, 5000);

// OpenStack & AWS Flavor Specifications (Dòng Tiêu Chuẩn m1 & Dòng Hiệu Năng Cao h1)
const FLAVOR_SPECS = {
  'm1.tiny':   { vcpu: 1,  ramMb: 512,   ramDisplay: '512 MB',          defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.small':  { vcpu: 1,  ramMb: 2048,  ramDisplay: '2048 MB (2 GB)',  defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.medium': { vcpu: 2,  ramMb: 4096,  ramDisplay: '4096 MB (4 GB)',  defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.large':  { vcpu: 4,  ramMb: 8192,  ramDisplay: '8192 MB (8 GB)',  defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.xlarge': { vcpu: 8,  ramMb: 16384, ramDisplay: '16384 MB (16 GB)',defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'h1.medium': { vcpu: 8,  ramMb: 16384, ramDisplay: '16384 MB (16 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' },
  'h1.large':  { vcpu: 16, ramMb: 32768, ramDisplay: '32768 MB (32 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' },
  'h1.xlarge': { vcpu: 32, ramMb: 65536, ramDisplay: '65536 MB (64 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' }
};

// Tab Routing
function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-card').forEach(el => el.classList.remove('active'));

  const activePane = document.getElementById('tab-' + tabId);
  if (activePane) activePane.classList.add('active');

  const navCards = document.querySelectorAll('.nav-card');
  const tabs = ['compute', 'storage', 'images', 'network', 'migration', 'monitoring'];
  const idx = tabs.indexOf(tabId);
  if (idx !== -1 && navCards[idx]) {
    navCards[idx].classList.add('active');
  }

  // Refresh tab data
  if (tabId === 'compute') loadInstances();
  if (tabId === 'storage') loadVolumes();
  if (tabId === 'images') loadImages();
  if (tabId === 'network') loadNetwork();
  if (tabId === 'migration') loadScenarios();
  if (tabId === 'monitoring') {
    loadMonitoringOverview();
    loadAuditLogs();
  }
}

// Modal Helpers
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
}

// On-Screen API Error Banner
function showApiError(endpoint, errorMsg, httpStatus = null) {
  const banner = document.getElementById('apiErrorBanner');
  if (!banner) return;

  const statusText = httpStatus ? `(HTTP ${httpStatus})` : '';
  const now = new Date().toLocaleTimeString();

  banner.innerHTML = `
    <div class="api-error-content">
      <div class="api-error-title">
        <span>⚠️ LỖI GỌI API: <code>${endpoint}</code> ${statusText}</span>
        <span style="font-size: 11px; font-weight: 400; color: #94a3b8; margin-left: 8px;">[${now}]</span>
      </div>
      <div class="api-error-message">${errorMsg || 'Không thể kết nối đến máy chủ Backend.'}</div>
      <div class="api-error-hint">
        💡 <strong>Gợi ý:</strong> Kiểm tra file <code>.env</code> xem đã điền AWS Credentials (<code>AWS_ACCESS_KEY_ID</code>, <code>AWS_SECRET_ACCESS_KEY</code>) chưa hoặc kiểm tra kết nối mạng DynamoDB.
      </div>
    </div>
    <button class="api-error-close" onclick="clearApiError()" title="Đóng thông báo">✕</button>
  `;
  banner.style.display = 'flex';
}

function clearApiError() {
  const banner = document.getElementById('apiErrorBanner');
  if (banner) banner.style.display = 'none';
}

// Toast Notifications
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✅' : '❌';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Authenticated Fetch wrapper
async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('xregion_jwt') || authToken;
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': 'Bearer ' + token } : {})
  };

  try {
    const res = await fetch(API_BASE + endpoint, { ...options, headers });
    if (res.status === 401 || res.status === 403) {
      console.warn(`Auth error (${res.status}) on endpoint: ${endpoint}`);
      localStorage.removeItem('xregion_jwt');
      localStorage.removeItem('xregion_user');
      authToken = '';

      const isAuthPage = window.location.pathname.endsWith('login.html') || window.location.pathname.endsWith('register.html');
      if (!isAuthPage) {
        showToast('Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Đang chuyển về trang đăng nhập...', 'error');
        const currentUrl = window.location.pathname + window.location.search;
        setTimeout(() => {
          window.location.replace('/login.html?redirect=' + encodeURIComponent(currentUrl));
        }, 800);
      }
      throw new Error(`Yêu cầu bị từ chối (${res.status} Forbidden/Unauthorized). Vui lòng đăng nhập lại.`);
    }

    let data;
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = { message: text };
    }

    if (!res.ok) {
      const errMsg = (data && data.message) ? data.message : `Yêu cầu thất bại với mã lỗi HTTP ${res.status}`;
      showApiError(endpoint, errMsg, res.status);
      throw new Error(errMsg);
    }
    return data ? data.data : null;
  } catch (err) {
    console.error('API Error:', endpoint, err);
    if (!endpoint.includes('/auth/login')) {
      showApiError(endpoint, err.message);
    }
    throw err;
  }
}

// Authentication
async function submitLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;

  try {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok && data.data && data.data.token) {
      authToken = data.data.token;
      const expiresAt = data.data.expiresAt || (getSyncedNowMs() + (data.data.expiresIn || 86400) * 1000);
      localStorage.setItem('xregion_jwt', authToken);
      localStorage.setItem('xregion_user', data.data.fullName || username);
      localStorage.setItem('xregion_jwt_expires_at', String(expiresAt));
      document.getElementById('userNameDisplay').textContent = data.data.fullName || username;
      closeModal('loginModal');
      clearApiError();
      showToast('Đăng nhập thành công với vai trò Administrator!', 'success');
      loadInstances();
    } else {
      const msg = data.message || 'Sai thông tin đăng nhập';
      showApiError('/auth/login', msg, res.status);
      alert('Đăng nhập thất bại: ' + msg);
    }
  } catch (err) {
    showApiError('/auth/login', err.message);
    alert('Lỗi đăng nhập: ' + err.message);
  }
}

function logout() {
  localStorage.removeItem('xregion_jwt');
  localStorage.removeItem('xregion_user');
  localStorage.removeItem('xregion_jwt_expires_at');
  authToken = '';
  showToast('Đã đăng xuất khỏi hệ thống', 'success');
  setTimeout(() => {
    window.location.replace('/login.html');
  }, 400);
}

function switchToRegister() {
  closeModal('loginModal');
  openModal('registerModal');
}

function switchToLogin() {
  closeModal('registerModal');
  openModal('loginModal');
}

async function submitRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUser').value.trim();
  const fullName = document.getElementById('regFullName').value.trim();
  const password = document.getElementById('regPass').value;
  const confirmPass = document.getElementById('regPassConfirm').value;

  if (password !== confirmPass) {
    alert('Mật khẩu xác nhận không khớp!');
    return;
  }

  try {
    const res = await fetch(API_BASE + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, fullName })
    });
    const data = await res.json();
    if (res.ok && data.data && data.data.token) {
      authToken = data.data.token;
      localStorage.setItem('xregion_jwt', authToken);
      document.getElementById('userNameDisplay').textContent = data.data.fullName || username;
      document.getElementById('registerForm').reset();
      closeModal('registerModal');
      alert('Đăng ký tài khoản thành công!');
      loadInstances();
    } else {
      alert('Đăng ký thất bại: ' + (data.message || 'Tài khoản đã tồn tại hoặc dữ liệu không hợp lệ'));
    }
  } catch (err) {
    alert('Lỗi đăng ký: ' + err.message);
  }
}

// TAB 1: COMPUTE & EC2 INSTANCES
let cachedInstances = [];
let statePollingInterval = null;

function getStatusBadgeConfig(status) {
  const s = (status || '').toUpperCase().trim();
  switch (s) {
    case 'RUNNING':
    case 'ACTIVE':
      return { cssClass: 'badge-running', dotClass: 'dot-running', label: 'running', isTransitioning: false };
    case 'PENDING':
      return { cssClass: 'badge-pending', dotClass: 'dot-pending', label: 'pending', isTransitioning: true };
    case 'STOPPING':
      return { cssClass: 'badge-stopping', dotClass: 'dot-stopping', label: 'stopping', isTransitioning: true };
    case 'STOPPED':
    case 'SHUTOFF':
      return { cssClass: 'badge-stopped', dotClass: 'dot-stopped', label: 'stopped', isTransitioning: false };
    case 'REBOOTING':
      return { cssClass: 'badge-rebooting', dotClass: 'dot-rebooting', label: 'rebooting', isTransitioning: true };
    case 'SHUTTING_DOWN':
      return { cssClass: 'badge-shutting-down', dotClass: 'dot-shutting-down', label: 'shutting-down', isTransitioning: true };
    case 'TERMINATED':
      return { cssClass: 'badge-terminated', dotClass: 'dot-terminated', label: 'terminated', isTransitioning: false };
    case 'MIGRATING':
      return { cssClass: 'badge-migrating', dotClass: 'dot-migrating', label: 'migrating', isTransitioning: true };
    default:
      return { cssClass: 'badge-error', dotClass: 'dot-stopped', label: status || 'unknown', isTransitioning: false };
  }
}

function updateInstancesKPIs() {
  const elTotal = document.getElementById('statTotalInstances');
  const elRegA = document.getElementById('statRegionACount');
  const elRun = document.getElementById('statRunningInstances');
  const elStop = document.getElementById('statStoppedInstances');
  const elPending = document.getElementById('statPendingInstances');
  const elMig = document.getElementById('statMigratingInstances');
  const elBadge = document.getElementById('instanceCountBadge');

  const total = cachedInstances.length;
  const running = cachedInstances.filter(i => {
    const s = (i.status || '').toUpperCase();
    return s === 'RUNNING' || s === 'ACTIVE';
  }).length;
  const stopped = cachedInstances.filter(i => {
    const s = (i.status || '').toUpperCase();
    return s === 'STOPPED' || s === 'SHUTOFF';
  }).length;
  const pendingOrTransition = cachedInstances.filter(i => {
    const s = (i.status || '').toUpperCase();
    return s === 'PENDING' || s === 'STOPPING' || s === 'REBOOTING' || s === 'SHUTTING_DOWN';
  }).length;
  const migrating = cachedInstances.filter(i => (i.status || '').toUpperCase() === 'MIGRATING').length;

  if (elTotal) elTotal.textContent = total;
  if (elRegA) elRegA.textContent = `${total} across regions`;
  if (elRun) elRun.textContent = running;
  if (elStop) elStop.textContent = stopped;
  if (elPending) elPending.textContent = pendingOrTransition;
  if (elMig) elMig.textContent = migrating;
  if (elBadge) elBadge.textContent = `(${total})`;
}

function checkAndTriggerStatePolling() {
  const hasTransitioningInstance = cachedInstances.some(inst => {
    const config = getStatusBadgeConfig(inst.status);
    return config.isTransitioning;
  });

  if (hasTransitioningInstance) {
    if (!statePollingInterval) {
      console.log('Transitioning instance detected, starting polling every 2000ms...');
      statePollingInterval = setInterval(async () => {
        try {
          const instances = await apiRequest('/instances');
          cachedInstances = instances || [];
          updateInstancesKPIs();
          filterInstancesUI();

          const stillTransitioning = cachedInstances.some(i => getStatusBadgeConfig(i.status).isTransitioning);
          if (!stillTransitioning) {
            console.log('All instances in steady state, clearing polling interval.');
            clearInterval(statePollingInterval);
            statePollingInterval = null;
          }
        } catch (e) {
          console.error('State polling error:', e);
        }
      }, 2000);
    }
  } else {
    if (statePollingInterval) {
      clearInterval(statePollingInterval);
      statePollingInterval = null;
    }
  }
}

async function loadInstances() {
  const tbody = document.getElementById('instanceTableBody');
  const elTotal = document.getElementById('statTotalInstances');
  const elRegA = document.getElementById('statRegionACount');
  const elRun = document.getElementById('statRunningInstances');
  const elStop = document.getElementById('statStoppedInstances');
  const elPending = document.getElementById('statPendingInstances');
  const elMig = document.getElementById('statMigratingInstances');
  const elBadge = document.getElementById('instanceCountBadge');

  try {
    const instances = await apiRequest('/instances');
    cachedInstances = instances || [];
    const select = document.getElementById('scInstanceSelect');
    const metricSelect = document.getElementById('metricVmSelect');

    if (select) select.innerHTML = '';
    if (metricSelect) metricSelect.innerHTML = '';

    updateInstancesKPIs();

    cachedInstances.forEach(inst => {
      if (select) {
        select.innerHTML += `<option value="${inst.id}">${inst.name} (${inst.id}) - ${inst.region}</option>`;
      }
      if (metricSelect) {
        metricSelect.innerHTML += `<option value="${inst.id}">${inst.name} (${inst.id})</option>`;
      }
    });

    filterInstancesUI();
    checkAndTriggerStatePolling();
  } catch (err) {
    console.error('Failed to load instances from API:', err);
    if (elTotal) elTotal.textContent = 'ERR';
    if (elRegA) elRegA.textContent = 'Lỗi kết nối API';
    if (elRun) elRun.textContent = 'ERR';
    if (elStop) elStop.textContent = 'ERR';
    if (elPending) elPending.textContent = 'ERR';
    if (elMig) elMig.textContent = 'ERR';
    if (elBadge) elBadge.textContent = '(Lỗi)';

    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align:center; padding: 36px 20px; background: rgba(239, 68, 68, 0.05); border-radius: 8px;">
            <div style="font-size: 26px; margin-bottom: 8px;">❌</div>
            <div style="font-size: 15px; font-weight: 700; color: #f87171; margin-bottom: 6px;">Không thể tải danh sách máy ảo từ API (GET /api/instances)</div>
            <div style="font-size: 13px; color: #cbd5e1; max-width: 680px; margin: 0 auto; line-height: 1.5; font-family: monospace; word-break: break-all;">${err.message || 'Lỗi kết nối máy chủ hoặc chưa cấu hình AWS Credentials'}</div>
            <div style="margin-top: 14px; font-size: 12px; color: #94a3b8;">
              Nguyên nhân: Chưa cấu hình AWS Credentials trong file <code>.env</code> hoặc bảng DynamoDB không phản hồi.<br>
              <button class="btn btn-secondary btn-sm" onclick="loadInstances()" style="margin-top: 10px;">Thử lại (Retry)</button>
            </div>
          </td>
        </tr>
      `;
    }
  }
}

function filterInstancesUI() {
  const tbody = document.getElementById('instanceTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = (document.getElementById('instanceSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('instanceStatusFilter')?.value || 'ALL';

  const filtered = cachedInstances.filter(inst => {
    const rawStatus = (inst.status || '').toUpperCase();
    const matchText = !q || (inst.name || '').toLowerCase().includes(q) || (inst.id || '').toLowerCase().includes(q) || (inst.publicIp || '').includes(q) || (inst.privateIp || '').includes(q);
    const matchStatus = statusFilter === 'ALL' || rawStatus === statusFilter.toUpperCase();
    return matchText && matchStatus;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding: 24px; color: var(--text-muted);">Không có máy ảo nào phù hợp bộ lọc. Bấm "+ Launch Instance" để khởi tạo máy ảo mới.</td></tr>';
    return;
  }

  filtered.forEach(inst => {
    const cfg = getStatusBadgeConfig(inst.status);
    const rawStatus = (inst.status || '').toUpperCase();
    const isTrans = cfg.isTransitioning;
    const isRunning = rawStatus === 'RUNNING' || rawStatus === 'ACTIVE';
    const isStopped = rawStatus === 'STOPPED' || rawStatus === 'SHUTOFF';
    const isTerminated = rawStatus === 'TERMINATED';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="/instance-detail.html?id=${inst.id}" style="font-family:monospace; color:var(--accent-cyan); font-weight:700; text-decoration:none;" title="Xem chi tiết máy ảo">${inst.id}</a></td>
      <td><strong>${inst.name}</strong></td>
      <td><span class="badge ${cfg.cssClass}"><span class="status-dot ${cfg.dotClass}"></span>${cfg.label}</span></td>
      <td><span style="font-size:12px; color:#cbd5e1;">${inst.regionName || inst.region}</span></td>
      <td><span class="badge" style="background:#1e293b; color:#94a3b8; font-family:monospace;">${inst.flavor}</span></td>
      <td><span class="badge" style="background:#1e293b; color:#38bdf8; font-family:monospace;">${inst.securityGroup || 'sg-default'}</span></td>
      <td><code>${inst.publicIp || 'Chưa gán'}</code></td>
      <td><code>${inst.privateIp}</code></td>
      <td><span class="badge" style="background:rgba(16, 185, 129, 0.15); color:#34d399; font-family:monospace;">🔑 ${inst.keyName || 'xregion-key'}</span></td>
      <td>
        <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
          <a href="/instance-detail.html?id=${inst.id}" class="btn btn-secondary btn-sm" style="text-decoration:none; padding:4px 8px;" title="Chi tiết máy ảo">Chi tiết</a>
          <a href="/instance-edit.html?id=${inst.id}" class="btn btn-secondary btn-sm ${isTrans || isTerminated ? 'disabled' : ''}" style="text-decoration:none; padding:4px 8px; color:var(--accent-cyan);" ${isTrans || isTerminated ? 'tabindex="-1"' : ''} title="Chỉnh sửa">✏️</a>
          
          ${isRunning
            ? `<button class="btn btn-secondary btn-sm ${isTrans ? 'disabled' : ''}" ${isTrans ? 'disabled' : ''} onclick="instanceAction('${inst.id}', 'STOP')" title="Dừng máy ảo (Stop)">Dừng</button>`
            : `<button class="btn btn-success btn-sm ${isTrans || isTerminated ? 'disabled' : ''}" ${isTrans || isTerminated ? 'disabled' : ''} onclick="instanceAction('${inst.id}', 'START')" title="Khởi động máy ảo (Start)">Bật</button>`
          }
          
          <button class="btn btn-secondary btn-sm ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="instanceAction('${inst.id}', 'REBOOT')" title="Khởi động lại (Reboot)">Reboot</button>
          
          <button class="btn btn-primary btn-sm ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="triggerDirectMigration('${inst.id}')" title="Chuyển vùng máy ảo tức thì (Fast Migrate)">⚡ Migrate</button>
          
          <button class="btn btn-danger btn-sm ${isTrans || isTerminated ? 'disabled' : ''}" ${isTrans || isTerminated ? 'disabled' : ''} onclick="instanceAction('${inst.id}', 'TERMINATE')" title="Xóa máy ảo vĩnh viễn (Terminate)">Xóa</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderRowEc2ActionsDropdown(inst) {
  const isStopped = (inst.status === 'SHUTOFF' || inst.status === 'STOPPED');
  const menuId = `rowActionsList-${inst.id}`;
  const itemLink = (sec, labelVi, labelEn, needStop = false, immutableMsgVi = '', immutableMsgEn = '') => {
    const label = t(labelVi, labelEn);
    if (immutableMsgVi) {
      const msg = t(immutableMsgVi, immutableMsgEn || immutableMsgVi);
      return `<span class="ec2-actions-item is-disabled" data-tooltip="${msg}" title="${msg}">${label}</span>`;
    }
    if (needStop && !isStopped) {
      const msg = t(`Cần dừng máy ảo (Stop instance) trước khi ${labelVi}`, `Stop the instance before using "${labelEn}"`);
      return `<span class="ec2-actions-item is-disabled" data-tooltip="${msg}" title="${msg}">${label}</span>`;
    }
    return `<a href="/instance-edit.html?id=${encodeURIComponent(inst.id)}&section=${sec}" class="ec2-actions-item">${label}</a>`;
  };
  return `
    <div class="ec2-actions-menu">
      <button type="button" class="btn btn-secondary btn-sm" style="padding:4px 8px; color:var(--accent-cyan);" onclick="toggleRowActionsMenu('${menuId}', event)">${t('Hành động ▾', 'Actions ▾')}</button>
      <div class="ec2-actions-list" id="${menuId}" hidden>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Cài đặt máy ảo', 'Instance settings')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Quản lý vòng đời & Nhãn', 'Protection and lifecycle management')}</div>
            ${itemLink('tags', 'Đổi tên máy ảo & nhãn (Tags)', 'Change instance name & tags', false)}
            ${itemLink('cooldown', 'Đổi thời gian chờ Cooldown', 'Change migration cooldown', false)}
            <div class="ec2-actions-sep"></div>
            <div class="ec2-actions-subhead">${t('Cấu hình phần cứng', 'Instance configuration')}</div>
            ${itemLink('instance-type', 'Đổi loại máy ảo (Instance type)', 'Change instance type', true)}
            ${itemLink('cpu-options', 'Tùy chọn vi xử lý (CPU options)', 'Change CPU options', true, 'Cần dừng máy ảo (Stop instance) để cấu hình CPU options', 'Instance must be stopped to modify CPU options')}
          </div>
        </div>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Mạng (Networking)', 'Networking')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Địa chỉ IP & Tên miền', 'IP & DNS configuration')}</div>
            ${itemLink('elastic-ip', 'Quản lý địa chỉ Elastic IP', 'Manage Elastic IP address', false)}
            ${itemLink('dns', 'Cập nhật tên miền Route 53 DNS', 'Change Route 53 DNS record', false)}
            ${itemLink('vpc', 'Đổi mạng VPC / Subnet', 'Change VPC / Subnet', false, 'Không thể đổi trực tiếp VPC/Subnet. Vui lòng dùng Fast Migrate X-Region để chuyển vùng', 'VPC/Subnet cannot be changed directly. Use Fast Migrate X-Region instead')}
          </div>
        </div>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Bảo mật (Security)', 'Security')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Tường lửa & Khóa truy cập', 'Access & Firewall')}</div>
            ${itemLink('security-groups', 'Đổi nhóm bảo mật (Security groups)', 'Change security groups', false)}
            ${itemLink('key-pair', 'Đổi khóa truy cập SSH Key Pair', 'Change SSH key pair', false)}
          </div>
        </div>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Lưu trữ (Storage)', 'Storage')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Ổ đĩa EBS Elastic Volumes', 'EBS Elastic Volumes')}</div>
            ${itemLink('storage', 'Mở rộng ổ cứng gốc EBS (gp3)', 'Modify EBS root volume (gp3)', false)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function toggleRowActionsMenu(menuId, ev) {
  if (ev) ev.stopPropagation();
  const target = document.getElementById(menuId);
  document.querySelectorAll('.ec2-actions-list').forEach(el => {
    if (el.id !== menuId) el.hidden = true;
  });
  if (target) target.hidden = !target.hidden;
}

document.addEventListener('click', e => {
  if (!e.target.closest('.ec2-actions-menu')) {
    document.querySelectorAll('.ec2-actions-list').forEach(el => { el.hidden = true; });
  }
});

function openLaunchModal() {
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';
  openModal('launchModal');
  updateLaunchSummary();
}

function updateLaunchSummary() {
  const regionEl = document.getElementById('instRegion');
  const imageEl = document.getElementById('instImage');
  const flavorEl = document.getElementById('instFlavor');
  const ebsEl = document.getElementById('instEbsSize');

  if (!regionEl || !imageEl || !flavorEl || !ebsEl) return;

  const region = regionEl.value;
  const isRegionA = region.includes('southeast');
  const regionLabel = isRegionA ? 'Region A (Singapore / Sydney)' : 'Region B (N. Virginia)';

  const osMap = {
    'img-u22': 'Ubuntu Server 22.04 LTS',
    'img-deb12': 'Debian 12 Bookworm',
    'img-rocky9': 'Rocky Linux 9 Enterprise',
    'img-alp319': 'Alpine Linux 3.19 Minimal'
  };
  const osLabel = osMap[imageEl.value] || 'Ubuntu Server 22.04 LTS';

  const flavorVal = flavorEl.value;
  const spec = FLAVOR_SPECS[flavorVal] || FLAVOR_SPECS['m1.medium'];
  const ebsSize = parseInt(ebsEl.value) || spec.defaultDisk || 10;

  const specsText = `${spec.vcpu} vCPU${spec.vcpu > 1 ? 's' : ''} • ${spec.ramDisplay} • ${ebsSize} GB Root Disk`;

  const sumReg = document.getElementById('sumRegionText');
  const sumOs = document.getElementById('sumOsText');
  const sumSpecs = document.getElementById('sumSpecsText');
  const sumKey = document.getElementById('sumKeyText');

  if (sumReg) sumReg.textContent = regionLabel;
  if (sumOs) sumOs.textContent = osLabel;
  if (sumSpecs) sumSpecs.textContent = specsText;
  if (sumKey) {
    const kpEl = document.getElementById('instKeyPair');
    const val = kpEl ? kpEl.value.trim() : '';
    sumKey.textContent = val ? val : 'Mặc định (xregion-key)';
  }
}

async function instanceAction(id, action) {
  if (action === 'TERMINATE' && !confirm('Bạn có chắc chắn muốn xóa máy ảo ' + id + '?')) {
    return;
  }
  try {
    await apiRequest(`/instances/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    showToast(`Thao tác ${action} trên máy ảo ${id} đã được gửi thành công!`, 'success');
    loadInstances();
  } catch (err) {
    console.error('instanceAction error:', err);
    showToast(`Lỗi thao tác ${action} trên ${id}: ${err.message}`, 'error');
  }
}

async function submitLaunch(e) {
  e.preventDefault();
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.innerHTML : '🚀 Launch Compute Instance';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '⏳ Đang khởi tạo máy ảo...';
  }

  const body = {
    name: document.getElementById('instName').value.trim(),
    region: document.getElementById('instRegion').value,
    flavor: document.getElementById('instFlavor').value,
    imageId: document.getElementById('instImage').value,
    keyPairName: document.getElementById('instKeyPair')?.value || 'xregion-key',
    securityGroup: document.getElementById('instSecurityGroup')?.value || 'sg-default',
    ebsSizeGb: parseInt(document.getElementById('instEbsSize').value) || 10,
    domainName: document.getElementById('instDomain').value.trim()
  };

  try {
    const res = await apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('launchModal');
    showToast(`Đã khởi tạo máy ảo ${body.name} (${res ? res.id : ''}) thành công!`, 'success');
    loadInstances();
  } catch (err) {
    console.error('Launch instance failed:', err);
    if (errBox) {
      errBox.innerHTML = `<strong>❌ Lỗi khởi tạo máy ảo (POST /api/instances):</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi khởi tạo máy ảo: ${err.message}`, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
  }
}

// TAB 2: STORAGE
async function loadVolumes() {
  const tbody = document.getElementById('volumeTableBody');
  try {
    const volumes = await apiRequest('/volumes');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!volumes || volumes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 20px; color: var(--text-muted);">Chưa có ổ đĩa nào trong kho lưu trữ.</td></tr>';
      return;
    }

    volumes.forEach(vol => {
      const isAttached = vol.status === 'IN_USE';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace; color:var(--accent-green); font-weight:700;">${vol.id}</td>
        <td><strong>${vol.name}</strong></td>
        <td>${vol.sizeGb} GB</td>
        <td><span class="badge" style="background:#1e293b; color:#38bdf8;">${vol.volumeType}</span></td>
        <td>${vol.iops} IOPS / ${vol.throughput} MB/s</td>
        <td>${vol.region}</td>
        <td>${vol.attachedInstanceName} ${vol.device ? `(${vol.device})` : ''}</td>
        <td><span class="badge ${isAttached ? 'badge-active' : 'badge-shutoff'}">${vol.status}</span></td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            ${isAttached 
              ? `<button class="btn btn-secondary btn-sm" onclick="detachVolume('${vol.id}')">Tháo</button>` 
              : `<button class="btn btn-success btn-sm" onclick="promptAttachVolume('${vol.id}')">Gắn</button>`}
            <button class="btn btn-primary btn-sm" onclick="openCopySnapshotModal('${vol.id}', '${vol.name}', '${vol.region}')">Snapshot Xuyên Vùng</button>
            <button class="btn btn-danger btn-sm" onclick="deleteVolume('${vol.id}')">Xóa</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load volumes:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 24px; color: #f87171; background: rgba(239, 68, 68, 0.05); border-radius: 8px;">❌ Không thể tải danh sách ổ đĩa từ API (GET /api/volumes): ${err.message}</td></tr>`;
    }
  }
}

async function submitCreateVolume(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('volName').value.trim(),
    sizeGb: parseInt(document.getElementById('volSize').value) || 20,
    region: document.getElementById('volRegion').value,
    volumeType: 'gp3'
  };

  try {
    const res = await apiRequest('/volumes', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('createVolumeModal');
    showToast(`Đã cấp phát ổ đĩa ${body.name} (${res ? res.id : ''}) thành công!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to create volume:', err);
    showToast(`Lỗi cấp phát ổ đĩa: ${err.message}`, 'error');
  }
}

async function detachVolume(id) {
  try {
    await apiRequest(`/volumes/${id}/detach`, { method: 'POST' });
    showToast(`Đã tháo ổ đĩa ${id} thành công!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to detach volume:', err);
    showToast(`Lỗi tháo ổ đĩa: ${err.message}`, 'error');
  }
}

async function promptAttachVolume(volId) {
  const instanceId = prompt('Nhập ID máy ảo cần gắn ổ đĩa (VD: i-0a3f9c21e7b4d5810):');
  if (!instanceId) return;
  try {
    await apiRequest(`/volumes/${volId}/attach`, {
      method: 'POST',
      body: JSON.stringify({ instanceId: instanceId.trim(), device: '/dev/vdb' })
    });
    showToast(`Đã gắn ổ đĩa ${volId} vào máy ảo ${instanceId}!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to attach volume:', err);
    showToast(`Lỗi gắn ổ đĩa: ${err.message}`, 'error');
  }
}

function openCopySnapshotModal(volId, name, region) {
  document.getElementById('copyVolId').value = volId;
  document.getElementById('copySrcRegion').value = region;
  document.getElementById('copyVolNameDisplay').value = `${name} (${volId}) [${region}]`;
  document.getElementById('copyDestRegion').value = region.includes('southeast') ? 'us-east-1' : 'ap-southeast-2';
  openModal('copySnapshotModal');
}

async function submitCopySnapshot(e) {
  e.preventDefault();
  const body = {
    volumeId: document.getElementById('copyVolId').value,
    sourceRegion: document.getElementById('copySrcRegion').value,
    destinationRegion: document.getElementById('copyDestRegion').value,
    description: 'Cross-region copy triggered from UI'
  };

  try {
    await apiRequest('/volumes/cross-region-copy', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('copySnapshotModal');
    showToast('Đã kích hoạt sao chép snapshot xuyên vùng sang ' + body.destinationRegion, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to copy snapshot cross region:', err);
    showToast(`Lỗi sao chép snapshot: ${err.message}`, 'error');
  }
}

async function deleteVolume(id) {
  if (!confirm('Bạn có chắc chắn muốn xóa ổ đĩa ' + id + '?')) return;
  try {
    await apiRequest(`/volumes/${id}`, { method: 'DELETE' });
    showToast(`Đã xóa ổ đĩa ${id} thành công!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to delete volume:', err);
    showToast(`Lỗi xóa ổ đĩa: ${err.message}`, 'error');
  }
}

// TAB 3: IMAGES
async function loadImages() {
  const grid = document.getElementById('imageGrid');
  try {
    const images = await apiRequest('/images');
    if (!grid) return;
    grid.innerHTML = '';

    if (!images || images.length === 0) {
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding: 24px; color: var(--text-muted);">Không có OS Image nào.</div>';
      return;
    }

    images.forEach(img => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.marginBottom = '0';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <span class="badge badge-active">${img.osType}</span>
          <span style="font-size:11px; color:var(--text-muted);">${img.visibility}</span>
        </div>
        <h3 style="font-size:15px; margin-bottom:8px;">${img.name}</h3>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Glance ID: <code>${img.glanceId}</code></p>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted);">
          <span>Dung lượng: ${img.sizeGb} GB</span>
          <span>Trạng thái: <strong>${img.status}</strong></span>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load images:', err);
    if (grid) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 30px; background: rgba(239, 68, 68, 0.05); border-radius: 8px; color: #f87171;">❌ Không thể tải kho ảnh hệ điều hành từ API (GET /api/images):<br><span style="font-family: monospace; font-size: 12px; color: #cbd5e1;">${err.message}</span></div>`;
    }
  }
}

// TAB 4: NETWORK
async function loadNetwork() {
  try {
    const net = await apiRequest('/network');
    const vpcContainer = document.getElementById('vpcContainer');
    const dnsBody = document.getElementById('dnsTableBody');

    vpcContainer.innerHTML = '';
    dnsBody.innerHTML = '';

    // Render VPCs
    if (net.vpcs) {
      net.vpcs.forEach(vpc => {
        const box = document.createElement('div');
        box.className = 'card';
        box.style.flex = '1';
        box.style.marginBottom = '0';
        box.innerHTML = `
          <div style="font-weight:700; font-size:15px; color:var(--accent-purple); margin-bottom:8px;">
            ${vpc.name} (${vpc.region})
          </div>
          <div style="font-size:13px; color:var(--text-muted); line-height:1.6;">
            <div>CIDR Block: <code>${vpc.cidr}</code></div>
            <div>Subnet ID: <code>${vpc.primarySubnetId || 'N/A'}</code></div>
            <div>Gateway: Internet Gateway & NAT Active</div>
          </div>
        `;
        vpcContainer.appendChild(box);
      });
    }

    // Render DNS Records
    if (net.dnsRecords) {
      net.dnsRecords.forEach(dns => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${dns.domainName}</strong></td>
          <td><span class="badge" style="background:#3b82f6; color:white;">A</span></td>
          <td><code>${dns.targetIp}</code></td>
          <td>${dns.ttl}s</td>
          <td><span class="badge badge-active">${dns.status || 'SYNCED'}</span></td>
        `;
        dnsBody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error(err);
  }
}

async function submitUpdateDns(e) {
  e.preventDefault();
  const body = {
    domainName: document.getElementById('dnsDomainInput').value,
    targetIp: document.getElementById('dnsTargetIpInput').value,
    ttl: parseInt(document.getElementById('dnsTtlInput').value) || 60
  };

  try {
    await apiRequest('/network/dns', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('dnsModal');
    alert('Đã cập nhật bản ghi Route 53 DNS thành công!');
    loadNetwork();
  } catch (err) {
    console.error(err);
  }
}

// TAB 5: MIGRATION (6-Step Pipeline Coordinator)
async function loadScenarios() {
  try {
    const scenarios = await apiRequest('/migrations/scenarios');
    const tbody = document.getElementById('scenarioTableBody');
    tbody.innerHTML = '';

    if (!scenarios || scenarios.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">Chưa có kịch bản di trú nào. Bấm "+ Tạo Kịch Bản" để cấu hình.</td></tr>';
      return;
    }

    scenarios.forEach(sc => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace; color:var(--accent-pink); font-weight:700;">${sc.id}</td>
        <td><strong>${sc.name}</strong></td>
        <td><code>${sc.targetInstanceId}</code></td>
        <td>${sc.sourceRegion} ➔ ${sc.destRegion}</td>
        <td><span class="badge badge-active">${sc.triggerType}</span></td>
        <td><code>${sc.cronExpression || 'Manual'}</code></td>
        <td>${sc.cooldownMinutes} phút</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="triggerDirectMigration('${sc.id}')">Chạy Kịch Bản Ngay</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

async function submitCreateScenario(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('scName').value,
    targetInstanceId: document.getElementById('scInstanceSelect').value,
    sourceRegion: document.getElementById('scSrcRegion').value,
    destRegion: document.getElementById('scDstRegion').value,
    triggerType: document.getElementById('scTriggerType').value,
    cooldownMinutes: parseInt(document.getElementById('scCooldown').value) || 60
  };

  try {
    await apiRequest('/migrations/scenarios', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('scenarioModal');
    loadScenarios();
  } catch (err) {
    console.error(err);
  }
}

async function triggerDirectMigration(targetId) {
  if (!confirm('Bạn có chắc chắn muốn kích hoạt chuyển vùng ngay lập tức cho ' + targetId + '?')) {
    return;
  }

  // Switch to migration tab to show live progress
  switchTab('migration');

  try {
    const res = await apiRequest('/migrations/trigger', {
      method: 'POST',
      body: JSON.stringify({ id: targetId })
    });

    const instanceId = res.instanceId;
    startProgressPolling(instanceId);
  } catch (err) {
    console.error(err);
  }
}

function startProgressPolling(instanceId) {
  if (migrationPollInterval) clearInterval(migrationPollInterval);

  const term = document.getElementById('terminalLogs');
  term.innerHTML = `[${new Date().toLocaleTimeString()}] Bắt đầu theo dõi tiến trình di trú cho máy ảo ${instanceId}...<br>`;

  migrationPollInterval = setInterval(async () => {
    try {
      const data = await apiRequest(`/migrations/progress/${instanceId}`);
      updatePipelineUI(data);

      if (data.status === 'COMPLETED' || data.status === 'ROLLED_BACK') {
        clearInterval(migrationPollInterval);
        loadInstances();
      }
    } catch (err) {
      clearInterval(migrationPollInterval);
    }
  }, 1000);
}

function updatePipelineUI(data) {
  const bar = document.getElementById('pipelineBar');
  const term = document.getElementById('terminalLogs');
  const percent = data.progressPercent || 0;
  bar.style.width = percent + '%';

  const step = data.stepNumber || 0;
  for (let i = 1; i <= 6; i++) {
    const circle = document.getElementById('stepCircle' + i);
    circle.className = 'step-circle';
    if (i < step) {
      circle.classList.add('completed');
    } else if (i === step) {
      circle.classList.add('active');
    }
  }

  if (data.logs && data.logs.length > 0) {
    term.innerHTML = data.logs.join('<br>');
    term.scrollTop = term.scrollHeight;
  }
}

// TAB 6: MONITORING & LOGS
async function loadMonitoringOverview() {
  loadMetrics();
}

async function loadMetrics() {
  const select = document.getElementById('metricVmSelect');
  const instanceId = select.value || 'vm-syd-01';

  try {
    const data = await apiRequest(`/metrics/instances/${instanceId}`);
    renderCostCards(data.costSummary);
    renderPerformanceChart(data.timeSeries);
  } catch (err) {
    console.error(err);
  }
}

function renderCostCards(costs) {
  if (!costs) return;
  const container = document.getElementById('costCards');
  container.innerHTML = `
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-cyan);">
      <div style="font-size:12px; color:var(--text-muted);">Sydney Compute (ap-southeast-2)</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.sydneyComputeMonthly}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-green);">
      <div style="font-size:12px; color:var(--text-muted);">EBS gp3 Storage Sydney</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.sydneyStorageMonthly}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-purple);">
      <div style="font-size:12px; color:var(--text-muted);">N. Virginia Standby (us-east-1)</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.virginiaComputeMonthly}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-pink);">
      <div style="font-size:12px; color:var(--text-muted);">Truyền Dữ Liệu X-Region</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.crossRegionDataTransfer}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-amber);">
      <div style="font-size:12px; color:var(--text-muted);">Tổng Chi Phí Ước Tính</div>
      <div style="font-size:22px; font-weight:800; color:#38bdf8; margin-top:4px;">$${costs.totalMonthlyEstimated}/tháng</div>
    </div>
  `;
}

function renderPerformanceChart(timeSeries) {
  if (!timeSeries) return;
  const ctx = document.getElementById('performanceChart').getContext('2d');

  const labels = timeSeries.map(p => new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const cpuData = timeSeries.map(p => p.cpuUsage);
  const ramData = timeSeries.map(p => p.ramUsage);

  if (performanceChart) {
    performanceChart.destroy();
  }

  performanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'CPU Usage (%)',
          data: cpuData,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.1)',
          tension: 0.3,
          fill: true
        },
        {
          label: 'RAM Usage (%)',
          data: ramData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.3,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' }
        },
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#f8fafc' }
        }
      }
    }
  });
}

async function loadAuditLogs() {
  try {
    const logs = await apiRequest('/logs?limit=50');
    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Chưa có nhật ký nào.</td></tr>';
      return;
    }

    logs.forEach(log => {
      const tr = document.createElement('tr');
      const timeStr = log.timestamp ? formatSyncedDateTime(log.timestamp) : 'N/A';
      tr.innerHTML = `
        <td style="color:var(--text-muted); font-size:12px;">${timeStr}</td>
        <td><strong>${log.username || 'system'}</strong></td>
        <td><span class="badge" style="background:#1e293b; color:var(--accent-cyan);">${log.action}</span></td>
        <td>${log.resourceType}</td>
        <td><code>${log.resourceId}</code></td>
        <td style="color:#cbd5e1;">${log.details}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

// ============================================================
// GLOBAL LANGUAGE (i18n: Tiếng Việt & English) & USER BADGE
// ============================================================
function getLang() {
  return localStorage.getItem('xregion_lang') === 'en' ? 'en' : 'vi';
}

function t(viText, enText) {
  return getLang() === 'en' ? enText : viText;
}

// Comprehensive Bidirectional Phrase Dictionary for DOM Text Nodes & Placeholders across all pages
const I18N_PAIRS = [
  // --- index.html (Overview) ---
  ['Tổng Quan Hạ Tầng Điện Toán Đa Vùng', 'Multi-Region Cloud Compute Infrastructure Overview'],
  ['Quản lý vòng đời máy ảo NovaVM trên máy chủ Bare Metal, tự động sao chép ổ đĩa EBS gp3 và cắt chuyển định tuyến Route 53 DNS xuyên vùng không gián đoạn.', 'Manage NovaVM instances on Bare Metal hosts with automated EBS gp3 snapshot replication and seamless cross-region Route 53 DNS cutover.'],
  ['+ Khởi Tạo Máy Ảo', '+ Launch Instance'],
  ['Quản Lý Máy Ảo →', 'Manage Instances →'],
  ['Tổng số máy ảo', 'Total Compute Instances'],
  ['Vùng AWS đã kết nối', 'Connected AWS Regions'],
  ['Tổng dung lượng EBS', 'Total EBS Storage'],
  ['Sức khỏe hệ thống', 'Fleet Health Rate'],
  ['Hoạt động tốt', 'Operational'],
  ['• Mã vùng:', '• Region code:'],
  ['• Vai trò: Active Primary Production', '• Role: Active Primary Production'],
  ['• Định tuyến mạng: VPC Subnet', '• Network routing: VPC Subnet'],
  ['• Vai trò: Standby Secondary & Disaster Recovery', '• Role: Standby Secondary & Disaster Recovery'],
  ['Máy ảo tại vùng:', 'Instances in region:'],
  ['Chuyển vùng xuyên vùng (Cross-Region Migration)', 'Cross-Region Migration'],
  ['Tổng hợp từ bảng XRegion-Migrations cho các máy ảo của bạn.', 'Aggregated from XRegion-Migrations table for your instances.'],
  ['Chọn máy để chuyển vùng →', 'Select instance to migrate →'],
  ['Thành công', 'Completed'],
  ['Thất bại / rollback', 'Failed / Rollback'],
  ['Khóa được nhả tự động', 'Lock auto-released'],
  ['Đang chạy', 'Running'],
  ['Downtime TB (RTO)', 'Avg Downtime (RTO)'],
  ['Từ lúc dừng VM nguồn tới khi DNS đổi IP', 'From source VM stop to Route 53 DNS cutover'],
  ['Lần chuyển vùng gần nhất', 'Latest Cross-Region Migration'],
  ['Máy đang giữ migration_lock', 'Instances Holding migration_lock'],
  ['Đang tải…', 'Loading…'],
  ['Máy Ảo Đang Hoạt Động (Active Instances)', 'Active Compute Instances'],
  ['Xem Toàn Bộ Máy Ảo →', 'View All Instances →'],
  ['TÊN MÁY ẢO', 'INSTANCE NAME'],
  ['VÙNG HIỆN TẠI', 'CURRENT REGION'],
  ['DNS TÊN MIỀN', 'ROUTE 53 DNS'],
  ['TRẠNG THÁI', 'STATE'],
  ['CHI TIẾT', 'DETAILS'],
  ['THAO TÁC', 'ACTIONS'],
  ['IP NỘI BỘ', 'PRIVATE IP'],
  ['Đang tải dữ liệu máy ảo...', 'Loading compute instances...'],
  ['Nhật Ký Thao Tác Hệ Thống (Recent Audit Logs)', 'Recent System Audit Logs'],
  ['THỜI GIAN', 'TIMESTAMP'],
  ['NGƯỜI THỰC HIỆN', 'ACTOR'],
  ['HÀNH ĐỘNG', 'ACTION'],
  ['ĐỐI TƯỢNG', 'RESOURCE'],
  ['CHI TIẾT NHẬT KÝ', 'AUDIT DETAILS'],
  ['Đang tải nhật ký...', 'Loading audit logs...'],

  // --- instances.html ---
  ['Tổng số máy ảo', 'Total Instances'],
  ['Đang dừng', 'Stopped'],
  ['Đang chuyển vùng', 'Migrating'],
  ['Tất cả trạng thái', 'All statuses'],
  ['Đang chạy (ACTIVE)', 'Running (ACTIVE)'],
  ['Đã dừng (SHUTOFF)', 'Stopped (SHUTOFF)'],
  ['Đang chuyển vùng (MIGRATING)', 'Migrating'],
  ['Làm mới', 'Refresh'],
  ['Đang tải danh sách máy ảo...', 'Loading instances...'],
  ['Tìm theo tên hoặc ID...', 'Search by instance name or ID...'],

  // --- instance-detail.html ---
  ['Vùng:', 'Region:'],
  ['Trạng thái', 'Instance state'],
  ['Vùng hiện tại', 'Current region'],
  ['Khóa chuyển vùng', 'Migration lock'],
  ['Chi tiết', 'Details'],
  ['Bảo mật & Mạng', 'Security & Networking'],
  ['Lưu trữ', 'Storage'],
  ['Giám sát', 'Monitoring'],
  ['Chuyển vùng', 'Cross-Region Migration'],
  ['Phần cứng & Hệ điều hành', 'Hardware & OS Configuration'],
  ['Hệ điều hành', 'Operating System'],
  ['Nền tảng', 'Platform'],
  ['Ảo hóa', 'Virtualization'],
  ['KVM (OpenStack Nova) trên EC2 Bare Metal', 'KVM (OpenStack Nova) on EC2 Bare Metal'],
  ['Định danh & Truy cập', 'Identity & Access'],
  ['Tên máy ảo', 'Instance name'],
  ['Chủ sở hữu', 'Owner'],
  ['Trạng thái hiện tại', 'Current state'],
  ['User đăng nhập', 'SSH login user'],
  ['Kết nối', 'Connection'],
  ['Xem lệnh SSH', 'View SSH command'],
  ['Tường lửa ảo gắn vào card mạng của máy. Lưu lượng chỉ đi qua khi khớp ít nhất một rule.', 'Virtual firewall attached to the instance ENI. Traffic is permitted only when matching at least one rule.'],
  ['Đổi Security Group', 'Change Security Group'],
  ['+ Tạo Security Group', '+ Create Security Group'],
  ['+ Thêm rule', '+ Add rule'],
  ['+ Thêm outbound rule', '+ Add outbound rule'],
  ['Loại', 'Type'],
  ['Giao thức', 'Protocol'],
  ['Cổng', 'Port range'],
  ['Nguồn', 'Source'],
  ['Đích', 'Destination'],
  ['Mô tả', 'Description'],
  ['Máy ảo không có ENI riêng: nó dùng một secondary IP trên ENI của máy chủ EC2 Bare Metal, Elastic IP được NAT 1:1 vào IP đó.', 'The VM uses a secondary private IP on the EC2 Bare Metal host ENI with 1:1 Elastic IP NAT mapping.'],
  ['Gắn vào', 'Attached to'],
  ['Secondary IP (máy ảo)', 'Secondary IP (VM)'],
  ['Mạng & Route 53', 'VPC Network & Route 53'],
  ['Cập nhật Route 53 DNS', 'Update Route 53 DNS'],
  ['Tên miền', 'Domain name'],
  ['Bản ghi A đang trỏ tới', 'A-Record target IP'],
  ['Đồng bộ với Elastic IP', 'Synced with Elastic IP'],
  ['Thiết bị gốc (Root device)', 'Root Device Configuration'],
  ['Tên thiết bị gốc', 'Root device name'],
  ['Loại thiết bị', 'Device type'],
  ['Loại ổ đĩa', 'Volume type'],
  ['Dung lượng', 'Size'],
  ['Hiệu năng', 'Performance'],
  ['Block devices đang gắn', 'Attached Block Devices'],
  ['Khi chuyển vùng, ổ gốc được chụp snapshot và sao chép sang vùng đích. Ổ dữ liệu gắn thêm cần sao chép riêng bằng Cross-region copy.', 'During cross-region migration, the root volume is snapshotted and replicated to the destination region.'],
  ['Tên', 'Name'],
  ['Thiết bị', 'Device'],
  ['Tự làm mới mỗi phút', 'Auto-refresh every minute'],
  ['Hướng chuyển tiếp theo', 'Next migration route'],
  ['Tiến trình chuyển vùng (6 bước)', 'Cross-Region Migration Pipeline (6 Steps)'],
  ['Chưa có lần chuyển vùng nào đang chạy.', 'No active migration in progress.'],
  ['Dừng máy nguồn', 'Stop source VM'],
  ['Sao chép liên vùng', 'Cross-region copy'],
  ['Tạo volume đích', 'Create target volume'],
  ['Khởi động NovaVM', 'Boot target NovaVM'],
  ['Chuyển DNS', 'Cutover Route 53 DNS'],
  ['Log thời gian thực', 'Real-time migration log'],
  ['Đang chờ', 'Idle'],
  ['Log của từng bước sẽ hiện ở đây khi bạn bấm Fast Migrate.', 'Step-by-step execution logs will appear here when you trigger Fast Migrate.'],
  ['Lịch sử chuyển vùng', 'Migration History'],
  ['Bấm vào một dòng để xem lại log 6 bước của lần đó.', 'Click any row to inspect the detailed 6-step execution log.'],
  ['Vùng nguồn → Vùng đích', 'Source → Destination'],
  ['Bắt đầu', 'Started at'],
  ['Hoàn tất', 'Completed at'],
  ['Thời lượng', 'Duration'],

  // --- launch.html ---
  ['Khởi Tạo Máy Ảo Mới', 'Launch New Instance'],
  ['Cấu hình máy chủ ảo hóa liên vùng. Sau khi khởi tạo, dữ liệu có thể tự động sao chép và di chuyển giữa các vùng hạ tầng theo kịch bản.', 'Configure a cross-region compute instance with automated EBS gp3 replication and Route 53 DNS failover.'],
  ['Tên Máy Ảo (Instance Name)', 'Instance Name & Tags'],
  ['Tên Máy Ảo *', 'Instance Name *'],
  ['vd: my-web-server', 'e.g. my-web-server'],
  ['Vùng Cấp Phát (Target Region)', 'Target AWS Region'],
  ['Mã vùng:', 'Region code:'],
  ['Ảnh Hệ Điều Hành (Application and OS Images)', 'Application and OS Images (AMI / Glance)'],
  ['Chọn ảnh máy ảo hệ điều hành (Glance OS Image) lưu trữ trên cụm Bare Metal:', 'Select a base operating system image (Glance OS Image) for your instance:'],
  ['Gói Cấu Hình Máy Ảo (Flavor)', 'Instance Type (Flavor)'],
  ['Chọn Flavor:', 'Select Instance Type:'],
  ['📋 Danh Sách Flavor Cho Phép', '📋 Available Instance Types'],
  ['Dòng', 'Series'],
  ['Tên Flavor', 'Instance Type'],
  ['Tiêu chuẩn (m1)', 'General Purpose (m1)'],
  ['Hiệu năng cao (h1)', 'High Performance (h1)'],
  ['Khóa Xác Thực SSH (Key Pair - Login)', 'Key Pair (SSH Login)'],
  ['Chọn khóa SSH đã tạo trước đó hoặc khởi tạo Key Pair mới để tải file', 'Select an existing SSH key pair or create a new key pair to download the'],
  ['Tên Key Pair *', 'Key Pair Name *'],
  ['🔑 + Tạo Key Pair Mới (.pem)', '🔑 + Create New Key Pair (.pem)'],
  ['Ổ Đĩa Root EBS & Tên Miền DNS', 'Root EBS Volume & Route 53 DNS'],
  ['Loại Ổ Đĩa', 'Volume Type'],
  ['Dung Lượng Root Disk (GB) *', 'Root Volume Size (GiB) *'],
  ['Tên Miền Route 53 DNS', 'Route 53 DNS Domain'],
  ['vd: my-app.xregion.net', 'e.g. my-app.xregion.net'],
  ['Tóm Tắt Cấu Hình', 'Summary'],
  ['VÙNG ĐÃ CHỌN', 'TARGET REGION'],
  ['HỆ ĐIỀU HÀNH (OS)', 'OPERATING SYSTEM (AMI)'],
  ['KHÓA XÁC THỰC (KEY PAIR)', 'SSH KEY PAIR'],
  ['THÔNG SỐ PHẦN CỨNG', 'INSTANCE SPECIFICATIONS'],
  ['🚀 Khởi Tạo Máy Ảo', '🚀 Launch Instance'],
  ['Hủy bỏ (Cancel)', 'Cancel'],

  // --- account-tokens.html ---
  ['Quản Lý Tài Khoản & API Token Xác Thực', 'Account Profile & API Access Tokens'],
  ['Thông Tin Tài Khoản', 'Account Information'],
  ['Tên đăng nhập:', 'Username:'],
  ['Họ và tên:', 'Full name:'],
  ['Vai trò (Role):', 'Role:'],
  ['Ngày khởi tạo:', 'Created at:'],
  ['Đổi Mật Khẩu', 'Change Password'],
  ['Mật khẩu hiện tại', 'Current password'],
  ['Nhập mật khẩu hiện tại', 'Enter current password'],
  ['Mật khẩu mới', 'New password'],
  ['Nhập mật khẩu mới', 'Enter new password'],
  ['Cập Nhật Mật Khẩu', 'Update Password'],
  ['Tạo API Token Xác Thực Mới', 'Generate New Personal Access Token'],
  ['API Token được tạo riêng biệt với phiên đăng nhập Web Dashboard, lưu trữ vào DynamoDB và dùng để gọi trực tiếp các dịch vụ qua AWS API Gateway (Edge-Optimized).', 'Personal API tokens are stored in DynamoDB and used to authenticate direct API requests via AWS API Gateway (Edge-Optimized).'],
  ['Tên gợi nhớ của Token', 'Token description / name'],
  ['Ví dụ: CI/CD Deployment, CLI Tool, Monitoring System', 'e.g. CI/CD Deployment, CLI Tool, Monitoring System'],
  ['Thời hạn hiệu lực', 'Expiration'],
  ['1 Tháng (30 ngày)', '1 Month (30 days)'],
  ['3 Tháng (90 ngày)', '3 Months (90 days)'],
  ['6 Tháng (180 ngày)', '6 Months (180 days)'],
  ['Không thời hạn (No Date / Vĩnh viễn)', 'No Expiration (Never expires)'],
  ['+ Sinh API Token Mới', '+ Generate New Token'],
  ['API Token của bạn đã được khởi tạo thành công!', 'Your new API token has been generated!'],
  ['Sao Chép Token', 'Copy Token'],
  ['Danh Sách API Token Đã Cấp Phát', 'Issued API Access Tokens'],
  ['Làm Mới', 'Refresh'],
  ['TÊN TOKEN', 'TOKEN NAME'],
  ['MÃ TOKEN (TRÍCH XUẤT)', 'TOKEN PREFIX'],
  ['NGÀY TẠO', 'CREATED AT'],
  ['HẠN DÙNG', 'EXPIRES AT'],
  ['Hướng Dẫn Gọi AWS API Gateway (Edge-Optimized)', 'AWS API Gateway (Edge-Optimized) cURL Guide'],
  ['Endpoint đã được tối ưu hóa toàn cầu qua mạng CloudFront Edge. Sử dụng lệnh cURL sau để gửi sự kiện vào Amazon EventBridge:', 'Global edge-optimized endpoint via CloudFront. Use the following cURL command to publish lifecycle events to Amazon EventBridge:']
];

const VI_TO_EN_DICT = new Map();
const EN_TO_VI_DICT = new Map();
I18N_PAIRS.forEach(([vi, en]) => {
  VI_TO_EN_DICT.set(vi.trim(), en);
  EN_TO_VI_DICT.set(en.trim(), vi);
});

function setGlobalLang(lang) {
  const normalized = lang === 'en' ? 'en' : 'vi';
  localStorage.setItem('xregion_lang', normalized);
  renderUserBadge();
  applyPageTranslations();

  // Refresh dynamic views on whichever page is currently open
  if (typeof refreshEditSectionLabels === 'function' && document.getElementById('editInstanceForm')) {
    refreshEditSectionLabels();
    if (typeof updateEditInstanceSummary === 'function') updateEditInstanceSummary();
  }
  if (document.getElementById('overviewTotalInstances') && typeof initOverviewPage === 'function') {
    initOverviewPage();
    if (typeof loadMigrationSummary === 'function') loadMigrationSummary();
  }
  if (typeof filterInstancesUI === 'function' && document.getElementById('instanceTableBody')) {
    loadInstances();
  }
  if (typeof det !== 'undefined' && det && det.inst && typeof renderInstance === 'function') {
    det.actionsKey = '';
    renderInstance();
    if (typeof renderSecurityGroups === 'function') renderSecurityGroups();
    if (typeof renderNetwork === 'function') renderNetwork();
    if (typeof loadMigrationHistory === 'function') loadMigrationHistory();
  }
  if (typeof updatePageLaunchSummary === 'function' && document.getElementById('launchInstancePageForm')) {
    updatePageLaunchSummary();
  }
}

function applyPageTranslations() {
  const isEn = getLang() === 'en';
  document.documentElement.lang = isEn ? 'en' : 'vi';

  // 1. Translate all elements with explicit data-i18n-vi / data-i18n-en
  document.querySelectorAll('[data-i18n-vi]').forEach(el => {
    const txt = isEn ? el.getAttribute('data-i18n-en') : el.getAttribute('data-i18n-vi');
    if (txt !== null) el.textContent = txt;
  });

  // 2. Translate top sub-navigation links across all pages
  const navMap = [
    { href: '/index.html', vi: 'Trang Chủ Tổng Quan', en: 'Overview Dashboard' },
    { href: '/instances.html', vi: 'Danh Sách Máy Ảo', en: 'Instances' },
    { href: '/launch.html', vi: 'Khởi Tạo Máy Ảo (+ Launch VM)', en: 'Launch Instance (+ Launch VM)' },
    { href: '/account-tokens.html', vi: 'Tài Khoản & API Token', en: 'Account & API Tokens' }
  ];
  navMap.forEach(item => {
    document.querySelectorAll(`.sub-nav a[href="${item.href}"]`).forEach(a => {
      const svg = a.querySelector('svg');
      const label = isEn ? item.en : item.vi;
      if (svg) {
        a.innerHTML = '';
        a.appendChild(svg);
        a.appendChild(document.createTextNode(' ' + label));
      } else {
        a.textContent = label;
      }
    });
  });

  // 3. Walk DOM text nodes and translate matching phrases losslessly
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const parentTag = node.parentElement ? node.parentElement.tagName : '';
      if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'CODE') continue;
      const raw = node.nodeValue;
      const trimmed = raw.trim().replace(/\s+/g, ' ');
      if (!trimmed) continue;
      if (isEn && VI_TO_EN_DICT.has(trimmed)) {
        node.nodeValue = VI_TO_EN_DICT.get(trimmed);
      } else if (!isEn && EN_TO_VI_DICT.has(trimmed)) {
        node.nodeValue = EN_TO_VI_DICT.get(trimmed);
      }
    }

    // 4. Translate input placeholders
    document.querySelectorAll('input[placeholder]').forEach(inp => {
      const p = inp.getAttribute('placeholder').trim();
      if (isEn && VI_TO_EN_DICT.has(p)) {
        inp.setAttribute('placeholder', VI_TO_EN_DICT.get(p));
      } else if (!isEn && EN_TO_VI_DICT.has(p)) {
        inp.setAttribute('placeholder', EN_TO_VI_DICT.get(p));
      }
    });
  }
}

function renderUserBadge() {
  const container = document.getElementById('userBadgeContainer');
  if (!container) return;

  const token = localStorage.getItem('xregion_jwt');
  const user = localStorage.getItem('xregion_user') || 'Admin';
  const lang = getLang();

  const langSelectorHtml = `
    <select class="header-lang-select" onchange="setGlobalLang(this.value)" aria-label="Language">
      <option value="vi" ${lang === 'vi' ? 'selected' : ''}>🌐 Tiếng Việt (VN)</option>
      <option value="en" ${lang === 'en' ? 'selected' : ''}>🌐 English (US)</option>
    </select>
  `;

  if (token) {
    container.innerHTML = `
      ${langSelectorHtml}
      <span style="font-weight: 600; color: #fff;">👤 ${user}</span>
      <button class="btn btn-secondary btn-sm" onclick="logout()" style="padding: 4px 10px; font-size: 11px;">${t('Đăng xuất', 'Sign out')}</button>
    `;
  } else {
    container.innerHTML = `
      ${langSelectorHtml}
      <a href="/login.html" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 12px; text-decoration: none;">${t('Đăng Nhập', 'Sign in')}</a>
      <a href="/register.html" class="btn btn-primary btn-sm" style="padding: 4px 10px; font-size: 12px; text-decoration: none; margin-left: 6px;">${t('Đăng Ký', 'Sign up')}</a>
    `;
  }
  applyPageTranslations();
}

// ============================================================
// PAGE INITIALIZERS: OVERVIEW, INSTANCES, DETAIL, LAUNCH
// ============================================================

// 1. OVERVIEW PAGE (index.html)
async function initOverviewPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  const elTotal = document.getElementById('overviewTotalInstances');
  const elRun = document.getElementById('overviewRunningCount');
  const elStorage = document.getElementById('overviewStorageGb');
  const elRegA = document.getElementById('regionAInstanceCount');
  const elRegB = document.getElementById('regionBInstanceCount');
  const tbodyInst = document.getElementById('overviewInstanceTableBody');
  const tbodyLogs = document.getElementById('overviewAuditLogsBody');

  // Load Instances
  try {
    const instances = await apiRequest('/instances');
    const list = instances || [];
    const total = list.length;
    const running = list.filter(i => {
      const s = (i.status || '').toUpperCase();
      return s === 'RUNNING' || s === 'ACTIVE';
    }).length;
    const regA = list.filter(i => (i.region || '').includes('southeast')).length;
    const regB = list.filter(i => (i.region || '').includes('us-east')).length;

    if (elTotal) elTotal.textContent = total;
    if (elRun) elRun.textContent = t(`${running} Đang chạy`, `${running} Running`);
    if (elRegA) elRegA.textContent = t(`${regA} máy ảo`, `${regA} instance${regA === 1 ? '' : 's'}`);
    if (elRegB) elRegB.textContent = t(`${regB} máy ảo`, `${regB} instance${regB === 1 ? '' : 's'}`);

    if (tbodyInst) {
      if (list.length === 0) {
        tbodyInst.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--text-muted);">${t('Chưa có máy ảo nào.', 'No instances found.')} <a href="/launch.html" style="color: var(--accent-cyan); font-weight: 700;">${t('+ Khởi tạo ngay', '+ Launch now')}</a></td></tr>`;
      } else {
        tbodyInst.innerHTML = '';
        list.slice(0, 5).forEach(inst => {
          const cfg = getStatusBadgeConfig(inst.status);
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><a href="/instance-detail.html?id=${inst.id}" style="color:var(--accent-cyan); font-weight:700; text-decoration:none; font-family:monospace;">${inst.id}</a></td>
            <td><strong>${inst.name}</strong></td>
            <td>${inst.regionName || inst.region}</td>
            <td><span class="badge" style="background:#1e293b; color:#94a3b8;">${inst.flavor}</span></td>
            <td><code>${inst.publicIp || t('Chưa gán', 'None')}</code></td>
            <td><span style="color:var(--accent-cyan);">${inst.dnsDomain || 'N/A'}</span></td>
            <td><span class="badge ${cfg.cssClass}"><span class="status-dot ${cfg.dotClass}"></span>${cfg.label}</span></td>
            <td><a href="/instance-detail.html?id=${inst.id}" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 11px; text-decoration:none;">Xem Chi Tiết →</a></td>
          `;
          tbodyInst.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error('Failed to load overview instances:', err);
    if (elTotal) elTotal.textContent = 'ERR';
    if (elRun) elRun.textContent = 'Lỗi API';
    if (tbodyInst) {
      tbodyInst.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 24px; color: #f87171; background: rgba(239, 68, 68, 0.05); border-radius: 8px;">❌ Không thể tải danh sách máy ảo từ API (GET /api/instances): ${err.message}</td></tr>`;
    }
  }

  // Load Volumes to calculate storage
  try {
    const volumes = await apiRequest('/volumes');
    if (volumes && elStorage) {
      const totalGb = volumes.reduce((sum, v) => sum + (v.sizeGb || 0), 0);
      elStorage.textContent = totalGb;
    }
  } catch (err) {
    if (elStorage) elStorage.textContent = '50';
  }

  // Load Audit Logs
  try {
    const logs = await apiRequest('/logs?limit=5');
    if (tbodyLogs) {
      if (!logs || logs.length === 0) {
        tbodyLogs.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">Chưa có nhật ký vận hành.</td></tr>';
      } else {
        tbodyLogs.innerHTML = '';
        logs.slice(0, 5).forEach(l => {
          const tr = document.createElement('tr');
          const time = l.timestamp ? formatSyncedDateTime(l.timestamp) : 'N/A';
          tr.innerHTML = `
            <td style="color:var(--text-muted); font-size:12px;">${time}</td>
            <td><strong>${l.username || 'admin'}</strong></td>
            <td><span class="badge" style="background:#1e293b; color:var(--accent-cyan);">${l.action}</span></td>
            <td><code>${l.resourceType}</code></td>
            <td style="color:#cbd5e1;">${l.details}</td>
          `;
          tbodyLogs.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error('Failed to load logs for overview:', err);
  }
}

// 2. INSTANCES LIST PAGE (instances.html)
function initInstancesPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  if (sessionStorage.getItem('xregion_launch_completed') === 'true') {
    sessionStorage.removeItem('xregion_launch_completed');
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', () => {
      window.history.pushState(null, '', window.location.href);
    });
  }
  loadInstances();
}

// 3. INSTANCE DETAIL PAGE (instance-detail.html)
async function initDetailPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  const urlParams = new URLSearchParams(window.location.search);
  const instanceId = urlParams.get('id');

  if (!instanceId) {
    showApiError('/instances/{id}', 'Không tìm thấy tham số ID máy ảo trong URL. Vui lòng quay lại danh sách máy ảo.');
    return;
  }

  const bcId = document.getElementById('breadcrumbInstanceId');
  if (bcId) bcId.textContent = instanceId;

  try {
    const inst = await apiRequest(`/instances/${instanceId}`);
    if (!inst) {
      throw new Error(`Không tìm thấy thông tin máy ảo với ID [${instanceId}]`);
    }

    // Populate header & summary card
    const nameEl = document.getElementById('detInstanceName');
    if (nameEl) nameEl.textContent = inst.name || inst.id;
    const idEl = document.getElementById('detInstanceId');
    if (idEl) idEl.textContent = inst.id;
    const sumIdEl = document.getElementById('summaryCardId');
    if (sumIdEl) sumIdEl.textContent = inst.id;
    const regNameEl = document.getElementById('detRegionName');
    if (regNameEl) regNameEl.textContent = inst.regionName || inst.region;
    const regCodeEl = document.getElementById('detRegionCode');
    if (regCodeEl) regCodeEl.textContent = `(${inst.region})`;

    const badge = document.getElementById('detStatusBadge');
    const cfg = getStatusBadgeConfig(inst.status);
    if (badge) {
      badge.className = 'badge ' + cfg.cssClass;
      badge.innerHTML = `<span class="status-dot ${cfg.dotClass}"></span>${cfg.label}`;
    }

    const sumStat = document.getElementById('detSummaryStatus');
    if (sumStat) {
      sumStat.innerHTML = `<span class="badge ${cfg.cssClass}"><span class="status-dot ${cfg.dotClass}"></span>${cfg.label}</span>`;
    }

    // Populate Summary & Tabs
    const spec = FLAVOR_SPECS[inst.flavor] || FLAVOR_SPECS['m1.medium'];
    const specDesc = spec ? ` (${spec.vcpu} vCPU • ${spec.ramDisplay})` : '';
    const flavEl = document.getElementById('detFlavor');
    if (flavEl) flavEl.textContent = `${inst.flavor}${specDesc}`;

    const detKeyEl = document.getElementById('detKeyName');
    if (detKeyEl) detKeyEl.textContent = inst.keyName || 'xregion-key';
    const detSgEl = document.getElementById('detSecurityGroup');
    if (detSgEl) detSgEl.textContent = inst.securityGroup || 'sg-default';
    const detPrivEl = document.getElementById('detPrivateIp');
    if (detPrivEl) detPrivEl.textContent = inst.privateIp || '10.0.1.10';
    const detPubEl = document.getElementById('detPublicIp');
    if (detPubEl) detPubEl.textContent = inst.publicIp || 'Chưa gán';
    const detDnsEl = document.getElementById('detDnsDomain');
    if (detDnsEl) detDnsEl.textContent = inst.dnsDomain || 'N/A';
    const detUpEl = document.getElementById('detUpdatedAt');
    if (detUpEl) detUpEl.textContent = inst.updatedAt ? formatSyncedDateTime(inst.updatedAt) : 'Vừa xong';

    const cdEl = document.getElementById('detCooldownDisplay');
    if (cdEl) {
      cdEl.textContent = inst.cooldownSeconds && inst.cooldownSeconds > 0 ? `${inst.cooldownSeconds}s (Đang cooldown)` : '0 giây (Sẵn sàng)';
    }

    // Tab 1: Details
    const tfName = document.getElementById('tabFlavorName');
    if (tfName) tfName.textContent = inst.flavor;
    const tfVcpu = document.getElementById('tabFlavorVcpu');
    if (tfVcpu) tfVcpu.textContent = spec ? spec.vcpu : 2;
    const tfRam = document.getElementById('tabFlavorRam');
    if (tfRam) tfRam.textContent = spec ? spec.ramDisplay : '4 GB';
    const tfDisk = document.getElementById('tabFlavorDisk');
    if (tfDisk) tfDisk.textContent = spec ? spec.defaultDisk : 10;
    const tInstName = document.getElementById('tabInstanceName');
    if (tInstName) tInstName.textContent = inst.name || inst.id;
    const tInstId = document.getElementById('tabInstanceId');
    if (tInstId) tInstId.textContent = inst.id;
    const tRegName = document.getElementById('tabRegionName');
    if (tRegName) tRegName.textContent = `${inst.regionName || inst.region} [${inst.region}]`;
    const tUser = document.getElementById('tabUsername');
    if (tUser) tUser.textContent = inst.username || 'admin';

    // Tab 2: Networking & Security
    const tNetDns = document.getElementById('tabNetDns');
    if (tNetDns) tNetDns.textContent = inst.dnsDomain || 'N/A';
    const tNetPub = document.getElementById('tabNetPublicIp');
    if (tNetPub) tNetPub.textContent = inst.publicIp || 'Chưa gán';
    const tNetPriv = document.getElementById('tabNetPrivateIp');
    if (tNetPriv) tNetPriv.textContent = inst.privateIp || '10.0.1.10';
    const tNetSg = document.getElementById('tabNetSecurityGroup');
    if (tNetSg) tNetSg.textContent = inst.securityGroup || 'sg-default';
    const tNetKey = document.getElementById('tabNetKeyName');
    if (tNetKey) tNetKey.textContent = inst.keyName || 'xregion-key';

    // Tab 3: Migration
    const tMigCur = document.getElementById('tabMigCurrentRegion');
    if (tMigCur) tMigCur.textContent = `${inst.regionName || inst.region} (${inst.region})`;
    const isSydney = (inst.region || '').includes('Sydney') || (inst.region || '').includes('Region A');
    const tMigTar = document.getElementById('tabMigTargetRegion');
    if (tMigTar) tMigTar.textContent = isSydney ? 'Melbourne (Region B - ap-southeast-4)' : 'Sydney (Region A - ap-southeast-2)';
    const tMigUp = document.getElementById('tabMigUpdatedAt');
    if (tMigUp) tMigUp.textContent = inst.updatedAt ? formatSyncedDateTime(inst.updatedAt) : 'Vừa xong';

    const isRunning = (inst.status || '').toUpperCase() === 'RUNNING' || (inst.status || '').toUpperCase() === 'ACTIVE';
    const isTrans = cfg.isTransitioning;
    const isTerminated = (inst.status || '').toUpperCase() === 'TERMINATED';

    const tabMigBtn = document.getElementById('tabMigrateActionBtn');
    if (tabMigBtn) {
      tabMigBtn.disabled = !isRunning || isTrans || isTerminated;
      tabMigBtn.onclick = () => triggerDirectMigration(inst.id);
    }

    // Render Actions Toolbar (disables buttons if instance is transitioning)
    const actionsContainer = document.getElementById('detailActionButtons');
    if (actionsContainer) {
      actionsContainer.innerHTML = `
        <button class="btn btn-secondary" onclick="initDetailPage()" title="Làm mới trạng thái">⟳ Làm Mới</button>
        <a href="/instance-edit.html?id=${inst.id}" class="btn btn-secondary ${isTrans || isTerminated ? 'disabled' : ''}" style="text-decoration:none; color:var(--accent-cyan);" ${isTrans || isTerminated ? 'tabindex="-1"' : ''}>✏️ Chỉnh Sửa</a>
        ${isRunning
          ? `<button class="btn btn-secondary ${isTrans ? 'disabled' : ''}" ${isTrans ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'STOP')">⏸ Dừng Máy (Stop)</button>`
          : `<button class="btn btn-success ${isTrans || isTerminated ? 'disabled' : ''}" ${isTrans || isTerminated ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'START')">▶ Bật Máy (Start)</button>`}
        <button class="btn btn-secondary ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'REBOOT')">🔄 Reboot</button>
        <button class="btn btn-primary ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="triggerDirectMigration('${inst.id}')">⚡ Fast Migrate X-Region</button>
        <button class="btn btn-danger ${isTrans || isTerminated ? 'disabled' : ''}" ${isTrans || isTerminated ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'TERMINATE')">🗑 Xóa Máy Ảo</button>
      `;
    }

    // Auto-refresh if currently transitioning
    if (isTrans) {
      setTimeout(initDetailPage, 2500);
    }
  } catch (err) {
    console.error('Failed to load instance detail:', err);
    showApiError(`/instances/${instanceId}`, err.message);
    document.getElementById('detInstanceName').textContent = 'Lỗi Tải Dữ Liệu';
  }
}

async function executeDetailAction(id, action) {
  if (action === 'TERMINATE' && !confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn máy ảo [${id}]?`)) {
    return;
  }

  try {
    await apiRequest(`/instances/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    showToast(`Đã gửi lệnh [${action}] đến máy ảo ${id}!`, 'success');

    if (action === 'TERMINATE') {
      setTimeout(() => {
        window.location.href = '/instances.html';
      }, 1000);
    } else {
      initDetailPage();
    }
  } catch (err) {
    showToast(`Lỗi thao tác ${action}: ${err.message}`, 'error');
  }
}

// 4. LAUNCH INSTANCE PAGE (launch.html)
function initLaunchPage() {
  if (!requireAuthGuard()) return;
  if (sessionStorage.getItem('xregion_launch_completed') === 'true') {
    sessionStorage.removeItem('xregion_launch_completed');
    window.location.replace('/instances.html');
    return;
  }

  window.addEventListener('pageshow', (event) => {
    const form = document.getElementById('launchInstancePageForm');
    if (event.persisted || sessionStorage.getItem('xregion_launch_completed') === 'true') {
      if (form) form.reset();
      sessionStorage.removeItem('xregion_launch_completed');
      window.location.replace('/instances.html');
    }
  });

  const form = document.getElementById('launchInstancePageForm');
  if (form) form.reset();

  renderUserBadge();
  clearApiError();
  loadKeyPairsDropdown();
  loadLaunchImagesAndFlavors();
  updatePageLaunchSummary();
}

async function loadKeyPairsDropdown(selectedName = null) {
  const select = document.getElementById('instKeyPair');
  if (!select) return;
  try {
    const keys = await apiRequest('/keys');
    const currentVal = selectedName || select.value;
    if (keys && keys.length > 0) {
      select.innerHTML = keys.map(k => `<option value="${k.keyName}">${k.keyName} (${k.keyType || 'RSA 2048'} • ${k.keyFingerprint ? k.keyFingerprint.substring(0, 22) + '...' : ''})</option>`).join('');
      if (currentVal && keys.some(k => k.keyName === currentVal)) {
        select.value = currentVal;
      } else {
        select.value = keys[0].keyName;
      }
    } else {
      select.innerHTML = `<option value="">-- Chưa có Key Pair nào (Bấm "+ Tạo Key Pair Mới" bên cạnh) --</option>`;
    }
    updatePageLaunchSummary();
  } catch (e) {
    console.warn('Could not load keypairs from API:', e);
  }
}

function openCreateKeyModal() {
  const input = document.getElementById('newKeyPairName');
  if (input) input.value = '';
  openModal('createKeyModal');
  setTimeout(() => {
    if (input) input.focus();
  }, 100);
}

function downloadPemFile(filename, pemContent) {
  const cleanName = filename.endsWith('.pem') ? filename : `${filename}.pem`;
  const blob = new Blob([pemContent], { type: 'application/x-pem-file;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = cleanName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function submitCreateKeyModal(e) {
  e.preventDefault();
  const input = document.getElementById('newKeyPairName');
  const name = input ? input.value.trim() : '';
  if (!name) return;

  const btn = document.getElementById('btnSubmitCreateKey');
  const origText = btn ? btn.innerHTML : '⬇ Tạo Key Pair & Tải .pem';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang sinh khóa RSA 2048...';
  }

  try {
    const res = await apiRequest('/keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    if (res && res.privateKey) {
      downloadPemFile(name, res.privateKey);
      closeModal('createKeyModal');
      showToast(`Đã tạo Key Pair [${name}] và tải xuống ${name}.pem thành công!`, 'success');
      await loadKeyPairsDropdown(name);
      if (typeof updateEditInstanceSummary === 'function') {
        updateEditInstanceSummary();
      }
    } else {
      showToast(`Tạo khóa thất bại: Không nhận được Private Key từ máy chủ. Vui lòng thử lại.`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi tạo Key Pair: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function promptCreateKey() {
  openCreateKeyModal();
}

function selectRegion(regionCode) {
  document.getElementById('instRegion').value = regionCode;
  document.getElementById('optRegionA').classList.toggle('selected', regionCode === 'ap-southeast-2');
  document.getElementById('optRegionB').classList.toggle('selected', regionCode === 'us-east-1');
  
  const radioA = document.querySelector('input[name="regionRadio"][value="ap-southeast-2"]');
  const radioB = document.querySelector('input[name="regionRadio"][value="us-east-1"]');
  if (radioA) radioA.checked = (regionCode === 'ap-southeast-2');
  if (radioB) radioB.checked = (regionCode === 'us-east-1');

  updatePageLaunchSummary();
}

let dynamicOsMap = {};

function selectOs(imageId, osName) {
  selectDynamicOs(imageId, osName);
}

function selectDynamicOs(imageId, osName) {
  const hiddenInput = document.getElementById('instImage');
  if (hiddenInput) hiddenInput.value = imageId;

  const cards = document.querySelectorAll('#osOptionsGrid .option-card');
  cards.forEach(c => c.classList.remove('selected'));

  const target = document.getElementById(`optOs_${String(imageId).replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  if (target) target.classList.add('selected');

  const radio = document.querySelector(`input[name="osRadio"][value="${imageId}"]`);
  if (radio) radio.checked = true;

  updatePageLaunchSummary();
}

async function loadLaunchImagesAndFlavors() {
  // 1. Tải danh sách Glance Image từ DynamoDB qua API /api/images
  const osGrid = document.getElementById('osOptionsGrid');
  if (osGrid) {
    try {
      const images = await apiRequest('/images');
      if (images && images.length > 0) {
        osGrid.innerHTML = '';
        dynamicOsMap = {};
        images.forEach((img, index) => {
          dynamicOsMap[img.id] = img.name;
          const isSelected = index === 0;
          if (isSelected) {
            document.getElementById('instImage').value = img.id;
          }
          const lower = (img.name || '').toLowerCase();
          let iconClass = 'icon-ubuntu';
          let iconLetter = 'U';
          if (lower.includes('alpine')) {
            iconClass = 'icon-alpine';
            iconLetter = 'A';
          } else if (lower.includes('debian')) {
            iconClass = 'icon-debian';
            iconLetter = 'D';
          } else if (lower.includes('rocky')) {
            iconClass = 'icon-rocky';
            iconLetter = 'R';
          } else if (lower.includes('windows')) {
            iconClass = 'icon-windows';
            iconLetter = 'W';
          }

          const card = document.createElement('div');
          card.className = `option-card ${isSelected ? 'selected' : ''}`;
          card.id = `optOs_${String(img.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          card.onclick = () => selectDynamicOs(img.id, img.name);
          card.innerHTML = `
            <input type="radio" name="osRadio" value="${img.id}" ${isSelected ? 'checked' : ''}>
            <div class="option-icon ${iconClass}">${iconLetter}</div>
            <strong style="font-size: 13px; display: block; margin-bottom: 4px;">${img.name}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${img.osType || 'Linux'} • ${img.sizeGb || 10} GB Image</div>
          `;
          osGrid.appendChild(card);
        });
      }
    } catch (e) {
      console.warn('Không thể tải Glance Images từ DynamoDB:', e);
    }
  }

  // 2. Tải danh sách Nova Flavor từ DynamoDB qua API /api/flavors
  const flavorSelect = document.getElementById('instFlavor');
  const flavorMatrixBody = document.getElementById('flavorMatrixBody');
  if (flavorSelect) {
    try {
      const flavors = await apiRequest('/flavors');
      if (flavors && flavors.length > 0) {
        // Cập nhật cấu hình FLAVOR_SPECS toàn cục
        flavors.forEach(f => {
          FLAVOR_SPECS[f.name] = {
            vcpu: f.vcpus,
            ramMb: f.ramMb,
            ramDisplay: f.ramDisplay,
            defaultDisk: f.diskGb
          };
        });

        const m1Flavors = flavors.filter(f => f.name.startsWith('m1'));
        const h1Flavors = flavors.filter(f => f.name.startsWith('h1'));
        const otherFlavors = flavors.filter(f => !f.name.startsWith('m1') && !f.name.startsWith('h1'));

        let selectHtml = '';
        if (m1Flavors.length > 0) {
          selectHtml += `<optgroup label="── Dòng Tiêu Chuẩn (m1) ──">`;
          m1Flavors.forEach(f => {
            const isDef = f.name === 'm1.medium';
            selectHtml += `<option value="${f.name}" ${isDef ? 'selected' : ''}>${f.name} — ${f.vcpus} vCPU${f.vcpus > 1 ? 's' : ''} • ${f.ramDisplay} • ${f.diskGb} GB Root Disk ${isDef ? '[Mặc định]' : ''}</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        if (h1Flavors.length > 0) {
          selectHtml += `<optgroup label="── Dòng Hiệu Năng Cao (h1) ──">`;
          h1Flavors.forEach(f => {
            selectHtml += `<option value="${f.name}">${f.name} — ${f.vcpus} vCPUs • ${f.ramDisplay} • ${f.diskGb} GB Root Disk</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        if (otherFlavors.length > 0) {
          selectHtml += `<optgroup label="── Dòng Khác ──">`;
          otherFlavors.forEach(f => {
            selectHtml += `<option value="${f.name}">${f.name} — ${f.vcpus} vCPU • ${f.ramDisplay} • ${f.diskGb} GB Root Disk</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        flavorSelect.innerHTML = selectHtml;

        // Render bảng ma trận Flavor
        if (flavorMatrixBody) {
          flavorMatrixBody.innerHTML = flavors.map(f => {
            const rowId = `row-${f.name.replace('.', '-')}`;
            const isMedium = f.name === 'm1.medium';
            const seriesColor = f.name.startsWith('h1') ? '#a855f7' : '#38bdf8';
            return `
              <tr id="${rowId}" style="border-top: 1px solid rgba(255,255,255,0.05); ${isMedium ? 'background: rgba(56, 189, 248, 0.12);' : ''}">
                <td style="padding: 8px 12px; color: ${seriesColor}; font-weight: 600;">${f.series || 'Tiêu chuẩn'}</td>
                <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; color: ${isMedium ? '#38bdf8' : '#fff'};">${f.name} ${isMedium ? '★' : ''}</td>
                <td style="padding: 8px 12px; font-weight: ${isMedium ? '700' : '400'}; color: #fff;">${f.vcpus}</td>
                <td style="padding: 8px 12px; font-weight: ${isMedium ? '700' : '400'}; color: #fff;">${f.ramMb}</td>
                <td style="padding: 8px 12px; color: #34d399; font-weight: 600;">${f.diskGb}</td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (e) {
      console.warn('Không thể tải Nova Flavors từ DynamoDB:', e);
    }
  }

  updatePageLaunchSummary();
}

function updatePageLaunchSummary() {
  const regionEl = document.getElementById('instRegion');
  const imageEl = document.getElementById('instImage');
  const flavorEl = document.getElementById('instFlavor');
  const ebsEl = document.getElementById('instEbsSize');

  if (!regionEl || !imageEl || !flavorEl || !ebsEl) return;

  const region = regionEl.value;
  const isRegionA = region.includes('southeast');
  const regionLabel = isRegionA ? 'Region A (Singapore / Sydney)' : 'Region B (N. Virginia)';

  const osMap = {
    'img-u22': 'Ubuntu Server 22.04 LTS',
    'img-deb12': 'Debian 12 Bookworm',
    'img-rocky9': 'Rocky Linux 9 Enterprise',
    'img-alp319': 'Alpine Linux 3.19 Minimal'
  };
  const osLabel = dynamicOsMap[imageEl.value] || osMap[imageEl.value] || imageEl.value;

  const flavorVal = flavorEl.value;
  const spec = FLAVOR_SPECS[flavorVal] || FLAVOR_SPECS['m1.medium'] || { vcpu: 2, ramDisplay: '4 GB', defaultDisk: 10 };
  const ebsSize = parseInt(ebsEl.value) || spec.defaultDisk || 10;

  const specsText = `${spec.vcpu} vCPU${spec.vcpu > 1 ? 's' : ''} • ${spec.ramDisplay} • ${ebsSize} GB Root Disk`;

  const sumReg = document.getElementById('sumRegionText');
  const sumOs = document.getElementById('sumOsText');
  const sumSpecs = document.getElementById('sumSpecsText');
  const sumKey = document.getElementById('sumKeyText');

  if (sumReg) sumReg.textContent = regionLabel;
  if (sumOs) sumOs.textContent = osLabel;
  if (sumSpecs) sumSpecs.textContent = specsText;
  if (sumKey) {
    const kpEl = document.getElementById('instKeyPair');
    const val = kpEl ? kpEl.value.trim() : '';
    sumKey.textContent = val ? val : 'Mặc định (xregion-key)';
  }
  const sumSg = document.getElementById('sumSgText');
  const sgEl = document.getElementById('instSecurityGroup');
  if (sumSg && sgEl) {
    sumSg.textContent = sgEl.value;
  }

  // Highlight selected row in specification matrix table
  const tableRows = document.querySelectorAll('#flavorMatrixBody tr');
  const targetRowId = `row-${flavorVal.replace('.', '-')}`;
  tableRows.forEach(row => {
    if (row.id === targetRowId) {
      row.style.background = 'rgba(56, 189, 248, 0.15)';
    } else {
      row.style.background = 'transparent';
    }
  });
}

async function handleLaunchPageSubmit(e) {
  e.preventDefault();
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';

  const btn = document.getElementById('btnLaunchInstance');
  const origText = btn ? btn.innerHTML : '🚀 Launch Instance';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang cấp phát máy ảo EC2 & ổ đĩa EBS...';
  }

  const payload = {
    name: document.getElementById('instName').value.trim(),
    region: document.getElementById('instRegion').value,
    flavor: document.getElementById('instFlavor').value,
    imageId: document.getElementById('instImage').value,
    keyPairName: document.getElementById('instKeyPair')?.value || 'xregion-key',
    securityGroup: document.getElementById('instSecurityGroup')?.value || 'sg-default',
    ebsSizeGb: parseInt(document.getElementById('instEbsSize').value) || 10,
    domainName: document.getElementById('instDomain').value.trim()
  };

  try {
    const res = await apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const form = document.getElementById('launchInstancePageForm');
    if (form) form.reset();
    sessionStorage.setItem('xregion_launch_completed', 'true');

    showToast(`Khởi tạo máy ảo [${payload.name}] (${res ? res.id : ''}) thành công!`, 'success');
    setTimeout(() => {
      window.location.replace('/instances.html');
    }, 800);
  } catch (err) {
    console.error('Launch failed:', err);
    if (errBox) {
      errBox.innerHTML = `<strong>❌ Lỗi khởi tạo máy ảo (POST /api/instances):</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi khởi tạo: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

// 5. MODIFY / EDIT INSTANCE PAGE (instance-edit.html?id=...&section=...) - AWS EC2 Dedicated Setting Pages
let currentEditingInstance = null;
let currentEditSection = 'instance-type';

const EC2_EDIT_SECTIONS = {
  'instance-type': {
    titleVi: 'Đổi loại máy ảo (Change instance type)',
    titleEn: 'Change instance type',
    subtitleVi: 'Bạn chỉ có thể đổi sang loại máy ảo tương thích với kiến trúc hiện tại và khi máy ảo đã dừng (Stopped).',
    subtitleEn: 'You can change the instance type only if the current instance type and the instance type that you want are compatible.',
    btnVi: 'Thay đổi (Change)',
    btnEn: 'Change',
    requiresStop: true
  },
  'security-groups': {
    titleVi: 'Đổi nhóm bảo mật (Change security groups)',
    titleEn: 'Change security groups',
    subtitleVi: 'Security Group đóng vai trò tường lửa ảo kiểm soát lưu lượng mạng ra vào card mạng (ENI) của máy ảo.',
    subtitleEn: 'Security groups act as a virtual firewall for your instance to control inbound and outbound traffic.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'elastic-ip': {
    titleVi: 'Quản lý địa chỉ Elastic IP',
    titleEn: 'Manage Elastic IP address',
    subtitleVi: 'Cấp phát địa chỉ IPv4 công khai tĩnh mới từ vùng hiện tại hoặc gỡ bỏ địa chỉ IP hiện tại khỏi máy ảo.',
    subtitleEn: 'Associate a static Public IPv4 address from the regional pool or disassociate the current address.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'dns': {
    titleVi: 'Cập nhật tên miền Route 53 DNS',
    titleEn: 'Change Route 53 DNS record',
    subtitleVi: 'Cập nhật bản ghi tên miền định tuyến đa vùng Route 53 Hosted Zone gắn với máy ảo.',
    subtitleEn: 'Update the Route 53 Hosted Zone A-Record associated with this compute instance.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'storage': {
    titleVi: 'Mở rộng ổ cứng gốc EBS (Modify EBS volume)',
    titleEn: 'Modify EBS root volume',
    subtitleVi: 'Tăng dung lượng ổ đĩa gốc EBS (gp3) trực tiếp khi máy đang hoạt động mà không cần dừng máy.',
    subtitleEn: 'Expand the root EBS Elastic Volume (gp3) capacity online without stopping the instance.',
    btnVi: 'Mở rộng ổ đĩa',
    btnEn: 'Modify',
    requiresStop: false
  },
  'key-pair': {
    titleVi: 'Đổi khóa truy cập SSH Key Pair',
    titleEn: 'Change SSH key pair',
    subtitleVi: 'Chọn một khóa RSA hiện có hoặc tạo khóa .pem mới để đăng nhập SSH vào máy ảo.',
    subtitleEn: 'Select an existing RSA key pair or create a new .pem key pair for SSH access.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'tags': {
    titleVi: 'Đổi tên máy ảo & nhãn (Change instance name & tags)',
    titleEn: 'Change instance name & tags',
    subtitleVi: 'Nhãn (Tag) giúp định danh và quản lý tài nguyên máy ảo xuyên vùng trên bảng điều khiển.',
    subtitleEn: 'A tag is a label that you assign to an AWS resource. Each tag consists of a key and an optional value.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'cooldown': {
    titleVi: 'Đổi thời gian chờ Cooldown chuyển vùng',
    titleEn: 'Change migration cooldown',
    subtitleVi: 'Cấu hình thời gian nghỉ tối thiểu giữa hai lần di trú máy ảo liên vùng liên tiếp.',
    subtitleEn: 'Configure the minimum cooldown duration between consecutive cross-region migrations.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  }
};

function getFlavorSeriesLabel(flavor) {
  if (!flavor) return t('Tiêu chuẩn đa dụng (M1 Series)', 'General Purpose (M1 Series)');
  if (flavor.startsWith('h1.')) return t('Bộ nhớ & Hiệu năng cao (H1 Series)', 'High Memory / Compute (H1 Series)');
  return t('Tiêu chuẩn đa dụng (M1 Series)', 'General Purpose (M1 Series)');
}

function toggleFlavorComparison() {
  const box = document.getElementById('flavorComparisonBox');
  const icon = document.getElementById('cmpToggleIcon');
  if (!box) return;
  const hidden = box.style.display === 'none';
  box.style.display = hidden ? 'block' : 'none';
  if (icon) icon.textContent = hidden ? '▼' : '▶';
}

function refreshEditSectionLabels() {
  const secMeta = EC2_EDIT_SECTIONS[currentEditSection] || EC2_EDIT_SECTIONS['instance-type'];
  const title = t(secMeta.titleVi, secMeta.titleEn);
  const subtitle = t(secMeta.subtitleVi, secMeta.subtitleEn);
  const btnText = t(secMeta.btnVi, secMeta.btnEn);

  const titleEl = document.getElementById('editPageTitle');
  if (titleEl) titleEl.textContent = title;
  const subEl = document.getElementById('editPageSubtitle');
  if (subEl) subEl.textContent = subtitle;
  const bcActionEl = document.getElementById('editBreadcrumbActionName');
  if (bcActionEl) bcActionEl.textContent = title;
  const saveBtn = document.getElementById('btnSaveEditInstance');
  if (saveBtn) saveBtn.textContent = btnText;
  document.title = `${title} - XRegion-EC2`;

  if (currentEditingInstance) {
    applyEditInstanceStateLock(currentEditingInstance.status);
  }
}

function applyEditInstanceStateLock(status) {
  const isStopped = (status === 'SHUTOFF' || status === 'STOPPED');
  const badge = document.getElementById('editInstStatusBadge');
  if (badge) {
    badge.textContent = isStopped ? t('Đã dừng (Stopped)', 'Stopped') : (status === 'ACTIVE' ? t('Đang chạy (Running)', 'Running') : status);
    badge.className = 'badge ' + (status === 'ACTIVE' ? 'badge-active' :
                                   status === 'MIGRATING' ? 'badge-migrating' :
                                   isStopped ? 'badge-shutoff' : 'badge-error');
  }

  const secMeta = EC2_EDIT_SECTIONS[currentEditSection] || EC2_EDIT_SECTIONS['instance-type'];
  const flavorSelect = document.getElementById('editInstFlavor');
  const flavorWrap = document.getElementById('flavorSelectWrap');
  const saveBtn = document.getElementById('btnSaveEditInstance');
  const saveWrap = document.getElementById('saveBtnWrap');
  const stopTooltip = t(
    'Cần dừng máy ảo (Stop instance) trước khi thay đổi Instance type',
    'The instance must be stopped before changing its instance type'
  );

  if (flavorSelect) {
    flavorSelect.disabled = !isStopped;
    flavorSelect.style.opacity = isStopped ? '1' : '0.55';
    flavorSelect.style.cursor = isStopped ? 'pointer' : 'not-allowed';
    flavorSelect.title = isStopped ? '' : stopTooltip;
  }
  if (flavorWrap) {
    flavorWrap.classList.toggle('is-stop-locked', !isStopped);
    if (!isStopped) {
      flavorWrap.setAttribute('data-tooltip', stopTooltip);
    } else {
      flavorWrap.removeAttribute('data-tooltip');
    }
  }

  if (secMeta.requiresStop) {
    if (saveBtn) {
      saveBtn.disabled = !isStopped;
      saveBtn.title = isStopped ? '' : stopTooltip;
    }
    if (saveWrap) {
      saveWrap.classList.toggle('is-stop-locked', !isStopped);
      if (!isStopped) {
        saveWrap.setAttribute('data-tooltip', stopTooltip);
      } else {
        saveWrap.removeAttribute('data-tooltip');
      }
    }
  }
}

async function initEditInstancePage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  const urlParams = new URLSearchParams(window.location.search);
  const instanceId = urlParams.get('id');
  const rawSec = urlParams.get('section') || 'instance-type';
  currentEditSection = EC2_EDIT_SECTIONS[rawSec] ? rawSec : 'instance-type';

  // Activate only the requested section panel
  document.querySelectorAll('.ec2-sec-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${currentEditSection}`);
  });

  refreshEditSectionLabels();

  if (!instanceId) {
    showApiError('/instances/{id}', 'Không tìm thấy tham số ID máy ảo cần chỉnh sửa trên URL.');
    return;
  }

  const detailUrl = `/instance-detail.html?id=${encodeURIComponent(instanceId)}`;
  const bcLink = document.getElementById('editBreadcrumbDetailLink');
  if (bcLink) {
    bcLink.textContent = instanceId;
    bcLink.href = detailUrl;
  }
  const cardIdLink = document.getElementById('editCardInstanceLink');
  if (cardIdLink) cardIdLink.href = detailUrl;
  const cancelBtn = document.getElementById('btnCancelEditInstance');
  if (cancelBtn) cancelBtn.href = detailUrl;

  try {
    const inst = await apiRequest(`/instances/${instanceId}`);
    if (!inst) {
      throw new Error(`Không tìm thấy máy ảo [${instanceId}]`);
    }
    currentEditingInstance = inst;

    document.getElementById('editRoInstanceId').textContent = inst.id;
    const nameParen = document.getElementById('editRoInstanceNameParen');
    if (nameParen) nameParen.textContent = `(${inst.name || inst.id})`;
    const roReg = document.getElementById('editRoRegion');
    if (roReg) roReg.textContent = `${inst.regionName || inst.region} (${inst.region})`;
    const roPriv = document.getElementById('editRoPrivateIp');
    if (roPriv) roPriv.textContent = inst.privateIp || '10.0.1.10';
    const roVol = document.getElementById('editRoVolumeId');
    if (roVol) roVol.textContent = inst.volumeId || 'vol-default';
    const roPubIp = document.getElementById('editRoPublicIp');
    if (roPubIp) roPubIp.textContent = inst.publicIp || '–';

    // Populate Instance Type fields
    const curFlavorSpec = FLAVOR_SPECS[inst.flavor] || FLAVOR_SPECS['m1.medium'];
    const curFlavorDisp = document.getElementById('editCurrentFlavorDisplay');
    if (curFlavorDisp) {
      curFlavorDisp.textContent = inst.flavor || 'm1.medium';
    }
    const flavorSelect = document.getElementById('editInstFlavor');
    if (flavorSelect && inst.flavor) {
      flavorSelect.value = inst.flavor;
    }
    applyEditInstanceStateLock(inst.status);

    // Populate Name, DNS, Security Group, Elastic IP, EBS, Key Pair, Cooldown
    const nameInput = document.getElementById('editInstName');
    if (nameInput) nameInput.value = inst.name || inst.id;

    const curDnsDisp = document.getElementById('editCurrentDnsDisplay');
    if (curDnsDisp) curDnsDisp.textContent = inst.dnsDomain || `${(inst.name || inst.id).toLowerCase()}.xregion.net`;
    const domainInput = document.getElementById('editInstDomain');
    if (domainInput) {
      domainInput.value = inst.dnsDomain || `${(inst.name || inst.id).toLowerCase()}.xregion.net`;
    }

    const curSgDisp = document.getElementById('editCurrentSgDisplay');
    if (curSgDisp) curSgDisp.textContent = inst.securityGroupId || 'sg-default';
    const sgSelect = document.getElementById('editInstSecurityGroup');
    if (sgSelect && inst.securityGroupId) {
      if (!Array.from(sgSelect.options).some(o => o.value === inst.securityGroupId)) {
        const opt = document.createElement('option');
        opt.value = inst.securityGroupId;
        opt.textContent = `${inst.securityGroupId} (Attached to ENI)`;
        sgSelect.prepend(opt);
      }
      sgSelect.value = inst.securityGroupId;
    }

    const eipSelect = document.getElementById('editInstElasticIpAction');
    if (eipSelect) {
      eipSelect.value = 'KEEP';
    }

    const currentEbsGb = inst.ebsSizeGb || curFlavorSpec.defaultDisk || 20;
    currentEditingInstance.ebsSizeGb = currentEbsGb;
    const curEbsDisp = document.getElementById('editCurrentEbsDisplay');
    if (curEbsDisp) {
      curEbsDisp.textContent = `${currentEbsGb} GiB`;
    }
    const ebsInput = document.getElementById('editInstEbsSize');
    if (ebsInput) {
      ebsInput.value = currentEbsGb;
      ebsInput.min = currentEbsGb;
    }

    const cooldownInput = document.getElementById('editInstCooldown');
    if (cooldownInput) {
      cooldownInput.value = inst.cooldownSeconds != null ? inst.cooldownSeconds : 300;
    }

    const curKeyDisp = document.getElementById('editCurrentKeyDisplay');
    if (curKeyDisp) curKeyDisp.textContent = inst.keyName || 'xregion-key';
    await loadKeyPairsDropdown(inst.keyName || 'xregion-key');
    const keySelect = document.getElementById('instKeyPair');
    if (keySelect && inst.keyName && !Array.from(keySelect.options).some(o => o.value === inst.keyName)) {
      const opt = document.createElement('option');
      opt.value = inst.keyName;
      opt.textContent = `${inst.keyName} (Current instance key)`;
      keySelect.prepend(opt);
      keySelect.value = inst.keyName;
    }

    updateEditInstanceSummary();
  } catch (err) {
    console.error('Failed to load instance for editing:', err);
    showApiError(`/instances/${instanceId}`, err.message);
  }
}

function updateEditInstanceSummary() {
  const nameEl = document.getElementById('editInstName');
  const flavorEl = document.getElementById('editInstFlavor');
  const ebsEl = document.getElementById('editInstEbsSize');
  if (!nameEl || !flavorEl) return;

  const newName = nameEl.value.trim() || (currentEditingInstance ? currentEditingInstance.name : '--');
  const newFlavor = flavorEl.value;
  const oldEbs = currentEditingInstance?.ebsSizeGb || 20;
  const newEbs = ebsEl ? (parseInt(ebsEl.value) || oldEbs) : oldEbs;

  const dnsPreview = document.getElementById('editDnsPreview');
  if (dnsPreview) {
    dnsPreview.textContent = `${newName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.xregion.net`;
  }

  // Validate EBS Elastic Volume No-Downsize rule when on storage section
  if (currentEditSection === 'storage') {
    const downsizeWarn = document.getElementById('ebsDownsizeWarning');
    const minEbsSpan = document.getElementById('minAllowedEbsGb');
    const saveBtn = document.getElementById('btnSaveEditInstance');
    if (minEbsSpan) minEbsSpan.textContent = oldEbs;
    if (newEbs < oldEbs) {
      if (downsizeWarn) downsizeWarn.style.display = 'block';
      if (saveBtn) saveBtn.disabled = true;
    } else {
      if (downsizeWarn) downsizeWarn.style.display = 'none';
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // Update Instance Type Comparison Table (AWS EC2 style)
  const oldFlavor = currentEditingInstance?.flavor || 'm1.medium';
  const oldSpec = FLAVOR_SPECS[oldFlavor] || FLAVOR_SPECS['m1.medium'];
  const newSpec = FLAVOR_SPECS[newFlavor] || FLAVOR_SPECS['m1.medium'];

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setText('cmpHeaderCurrent', oldFlavor);
  setText('cmpHeaderNew', newFlavor);
  setText('cmpSeriesCurrent', getFlavorSeriesLabel(oldFlavor));
  setText('cmpSeriesNew', getFlavorSeriesLabel(newFlavor));
  setText('cmpVcpuCurrent', `${oldSpec.vcpu} (${oldSpec.vcpu} core${oldSpec.vcpu > 1 ? 's' : ''})`);
  setText('cmpVcpuNew', `${newSpec.vcpu} (${newSpec.vcpu} core${newSpec.vcpu > 1 ? 's' : ''})`);
  setText('cmpRamCurrent', oldSpec.ramDisplay.replace('GB', 'GiB'));
  setText('cmpRamNew', newSpec.ramDisplay.replace('GB', 'GiB'));
}

async function handleEditInstanceSubmit(e) {
  e.preventDefault();
  if (!currentEditingInstance) return;

  const errBox = document.getElementById('editErrorBox');
  if (errBox) errBox.style.display = 'none';

  const isStopped = (currentEditingInstance.status === 'SHUTOFF' || currentEditingInstance.status === 'STOPPED');
  if (currentEditSection === 'instance-type' && !isStopped) {
    showToast('Cần dừng máy ảo (Stop instance) trước khi thay đổi Instance type!', 'error');
    return;
  }

  const oldEbs = currentEditingInstance.ebsSizeGb || 20;
  const newEbs = parseInt(document.getElementById('editInstEbsSize')?.value) || oldEbs;
  if (currentEditSection === 'storage' && newEbs < oldEbs) {
    showToast(`AWS EBS không cho phép giảm dung lượng ổ đĩa xuống dưới ${oldEbs} GiB!`, 'error');
    return;
  }

  const secMeta = EC2_EDIT_SECTIONS[currentEditSection] || EC2_EDIT_SECTIONS['instance-type'];
  const secTitle = t(secMeta.titleVi, secMeta.titleEn);
  const btn = document.getElementById('btnSaveEditInstance');
  const origText = btn ? btn.innerHTML : t(secMeta.btnVi, secMeta.btnEn);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = t('Đang lưu...', 'Saving...');
  }

  const payload = {
    name: document.getElementById('editInstName').value.trim(),
    flavor: document.getElementById('editInstFlavor').value,
    keyPairName: document.getElementById('instKeyPair')?.value || currentEditingInstance.keyName || 'xregion-key',
    domainName: document.getElementById('editInstDomain')?.value.trim() || '',
    cooldownSeconds: parseInt(document.getElementById('editInstCooldown')?.value) || 300,
    securityGroupId: document.getElementById('editInstSecurityGroup')?.value || currentEditingInstance.securityGroupId || 'sg-default',
    elasticIpAction: document.getElementById('editInstElasticIpAction')?.value || 'KEEP',
    ebsSizeGb: newEbs
  };

  try {
    await apiRequest(`/instances/${currentEditingInstance.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    showToast(t(`Đã cập nhật [${secTitle}] cho máy ảo ${currentEditingInstance.id} thành công!`, `Successfully updated [${secTitle}] for instance ${currentEditingInstance.id}!`), 'success');
    setTimeout(() => {
      window.location.replace(`/instance-detail.html?id=${currentEditingInstance.id}`);
    }, 600);
  } catch (err) {
    if (errBox) {
      errBox.innerHTML = `<strong>❌ Lỗi cập nhật:</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi cập nhật: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

// ============================================================
// 8. SECURITY GROUPS PAGE (security-groups.html)
// ============================================================
let currentSecurityGroups = [];

async function initSecurityGroupsPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  // Load instances for attach dropdown
  populateAttachInstanceSelect();

  // Load security groups list
  await loadSecurityGroups();

  // Add a default SSH rule
  const rulesBody = document.getElementById('inboundRulesBody');
  if (rulesBody && rulesBody.children.length === 0) {
    addPresetRule('SSH');
  }
}

async function loadSecurityGroups() {
  const tbody = document.getElementById('securityGroupsTableBody');
  const countBadge = document.getElementById('sgCountBadge');
  if (!tbody) return;

  try {
    const list = await apiRequest('/network/security-groups');
    currentSecurityGroups = Array.isArray(list) ? list : [];

    if (countBadge) {
      countBadge.textContent = `${currentSecurityGroups.length} nhóm bảo mật`;
    }

    if (currentSecurityGroups.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
            Chưa có Security Group nào. Hãy tạo Security Group mới ở biểu mẫu phía trên.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = currentSecurityGroups.map(sg => {
      const gid = sg.groupId || 'sg-unknown';
      const name = sg.name || gid;
      const desc = sg.description || '--';
      const region = sg.region || 'all';
      const owner = sg.owner || 'system';

      const inRules = Array.isArray(sg.inboundRules) ? sg.inboundRules : [];
      let inRulesHtml = inRules.map(r => {
        const proto = (r.protocol || 'tcp').toUpperCase();
        const portStr = (proto === 'ALL' || proto === 'ICMP') ? proto : (r.fromPort === r.toPort ? `${r.fromPort}` : `${r.fromPort}-${r.toPort}`);
        const cidr = r.cidr || '0.0.0.0/0';
        return `<span class="rule-pill" title="${r.description || ''}">${proto}:${portStr} (${cidr})</span>`;
      }).join(' ');

      if (!inRulesHtml) {
        inRulesHtml = '<span style="color: var(--text-muted); font-size: 12px;">Không có quy tắc</span>';
      }

      return `
        <tr>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <code style="color: var(--accent-cyan); font-weight: 700;">${gid}</code>
              <button class="aws-copy-btn" onclick="copyToClipboard('${gid}', 'Group ID')" title="Sao chép ID">📋</button>
            </div>
          </td>
          <td><strong style="color: #fff;">${name}</strong></td>
          <td style="color: var(--text-muted); font-size: 12.5px;">${desc}</td>
          <td><span class="badge" style="background: #1e293b; color: #38bdf8;">${region}</span></td>
          <td><div style="max-width: 320px; display: flex; flex-wrap: wrap;">${inRulesHtml}</div></td>
          <td><span class="badge" style="background: rgba(255,255,255,0.06); color: #cbd5e1;">${owner}</span></td>
          <td style="text-align: center;">
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11.5px;" onclick="promptAttachGroupToVm('${gid}', '${name}')" title="Gán vào máy ảo">
              🔗 Gán VM
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load security groups:', err);
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: #f87171; padding: 25px;">
          Lỗi tải danh sách Security Groups: ${err.message}
        </td>
      </tr>
    `;
    showApiError('/network/security-groups', err.message);
  }
}

async function populateAttachInstanceSelect() {
  const sel = document.getElementById('sgAttachInstance');
  if (!sel) return;

  try {
    const list = await apiRequest('/instances');
    const instances = Array.isArray(list) ? list : [];
    sel.innerHTML = '<option value="">-- Không gán ngay (Tạo độc lập) --</option>' +
      instances.map(i => `<option value="${i.id}">${i.name || i.id} (${i.id} • ${i.region})</option>`).join('');
  } catch (err) {
    console.debug('Could not load instances for SG attach select:', err.message);
  }
}

const SG_RULE_PRESETS = {
  'SSH':    { proto: 'tcp', fromPort: 22,   toPort: 22,   cidr: '0.0.0.0/0', desc: 'SSH remote management' },
  'HTTP':   { proto: 'tcp', fromPort: 80,   toPort: 80,   cidr: '0.0.0.0/0', desc: 'Web traffic HTTP' },
  'HTTPS':  { proto: 'tcp', fromPort: 443,  toPort: 443,  cidr: '0.0.0.0/0', desc: 'Secure web traffic HTTPS' },
  'MYSQL':  { proto: 'tcp', fromPort: 3306, toPort: 3306, cidr: '0.0.0.0/0', desc: 'MySQL / Aurora database' },
  'ICMP':   { proto: 'icmp',fromPort: 0,    toPort: 0,    cidr: '0.0.0.0/0', desc: 'Echo Request (Ping)' },
  'ALL':    { proto: 'all', fromPort: 0,    toPort: 65535,cidr: '0.0.0.0/0', desc: 'All traffic - Warning: open all ports' }
};

function addPresetRule(type) {
  const preset = SG_RULE_PRESETS[type] || SG_RULE_PRESETS['SSH'];
  addInboundRuleRow({
    type: type,
    protocol: preset.proto,
    fromPort: preset.fromPort,
    toPort: preset.toPort,
    cidr: preset.cidr,
    description: preset.desc
  });
}

function addInboundRuleRow(initial) {
  const tbody = document.getElementById('inboundRulesBody');
  if (!tbody) return;

  const data = initial || {
    type: 'CUSTOM',
    protocol: 'tcp',
    fromPort: 8080,
    toPort: 8080,
    cidr: '0.0.0.0/0',
    description: 'Custom TCP Rule'
  };

  const tr = document.createElement('tr');
  tr.className = 'sg-rule-row';
  tr.innerHTML = `
    <td>
      <select class="rule-select rule-type-select" onchange="onRuleTypeSelectChange(this)">
        <option value="SSH" ${data.type === 'SSH' ? 'selected' : ''}>SSH (22)</option>
        <option value="HTTP" ${data.type === 'HTTP' ? 'selected' : ''}>HTTP (80)</option>
        <option value="HTTPS" ${data.type === 'HTTPS' ? 'selected' : ''}>HTTPS (443)</option>
        <option value="MYSQL" ${data.type === 'MYSQL' ? 'selected' : ''}>MySQL (3306)</option>
        <option value="ICMP" ${data.type === 'ICMP' ? 'selected' : ''}>All ICMP (Ping)</option>
        <option value="ALL" ${data.type === 'ALL' ? 'selected' : ''}>All Traffic</option>
        <option value="CUSTOM" ${data.type === 'CUSTOM' ? 'selected' : ''}>Custom TCP</option>
      </select>
    </td>
    <td>
      <select class="rule-select rule-proto">
        <option value="tcp" ${data.protocol === 'tcp' ? 'selected' : ''}>TCP</option>
        <option value="udp" ${data.protocol === 'udp' ? 'selected' : ''}>UDP</option>
        <option value="icmp" ${data.protocol === 'icmp' ? 'selected' : ''}>ICMP</option>
        <option value="all" ${data.protocol === 'all' ? 'selected' : ''}>ALL</option>
      </select>
    </td>
    <td>
      <div style="display: flex; gap: 4px; align-items: center;">
        <input type="number" class="rule-input rule-from-port" min="0" max="65535" value="${data.fromPort}" placeholder="From" style="width: 70px;">
        <span style="color: var(--text-muted);">-</span>
        <input type="number" class="rule-input rule-to-port" min="0" max="65535" value="${data.toPort}" placeholder="To" style="width: 70px;">
      </div>
    </td>
    <td>
      <input type="text" class="rule-input rule-cidr" value="${data.cidr || '0.0.0.0/0'}" placeholder="0.0.0.0/0" pattern="^(\\d{1,3}\\.){3}\\d{1,3}/\\d{1,2}$|^sg-[a-zA-Z0-9-]+$" required>
    </td>
    <td>
      <input type="text" class="rule-input rule-desc" value="${data.description || ''}" placeholder="Mô tả mục đích rule">
    </td>
    <td style="text-align: center;">
      <button type="button" class="btn btn-danger" onclick="removeRuleRow(this)" style="padding: 4px 8px; font-size: 11px;" title="Xóa quy tắc này">
        🗑
      </button>
    </td>
  `;
  tbody.appendChild(tr);
}

function onRuleTypeSelectChange(sel) {
  const tr = sel.closest('tr');
  const type = sel.value;
  const preset = SG_RULE_PRESETS[type];
  if (!preset) return;

  const protoEl = tr.querySelector('.rule-proto');
  const fromEl = tr.querySelector('.rule-from-port');
  const toEl = tr.querySelector('.rule-to-port');
  const descEl = tr.querySelector('.rule-desc');

  if (protoEl) protoEl.value = preset.proto;
  if (fromEl) fromEl.value = preset.fromPort;
  if (toEl) toEl.value = preset.toPort;
  if (descEl && !descEl.value) descEl.value = preset.desc;
}

function removeRuleRow(btn) {
  const tr = btn.closest('tr');
  if (tr) tr.remove();
}

function resetCreateForm() {
  const form = document.getElementById('createSgForm');
  if (form) form.reset();
  const tbody = document.getElementById('inboundRulesBody');
  if (tbody) {
    tbody.innerHTML = '';
    addPresetRule('SSH');
  }
}

function scrollToCreateForm() {
  const card = document.getElementById('createSecurityGroupCard');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth' });
    const nameInput = document.getElementById('sgName');
    if (nameInput) setTimeout(() => nameInput.focus(), 300);
  }
}

async function handleCreateSecurityGroup(event) {
  event.preventDefault();
  clearApiError();

  const nameInput = document.getElementById('sgName');
  const descInput = document.getElementById('sgDescription');
  const regionInput = document.getElementById('sgRegion');
  const attachInput = document.getElementById('sgAttachInstance');
  const btn = document.getElementById('createSgSubmitBtn');

  const name = nameInput.value.trim();
  const description = descInput.value.trim();
  const region = regionInput.value;
  const attachInstanceId = attachInput.value ? attachInput.value.trim() : null;

  // Collect Inbound Rules
  const rows = document.querySelectorAll('#inboundRulesBody tr.sg-rule-row');
  const inboundRules = [];

  rows.forEach(tr => {
    const proto = tr.querySelector('.rule-proto')?.value || 'tcp';
    const fromPort = parseInt(tr.querySelector('.rule-from-port')?.value) || 0;
    const toPort = parseInt(tr.querySelector('.rule-to-port')?.value) || fromPort;
    const cidr = tr.querySelector('.rule-cidr')?.value?.trim() || '0.0.0.0/0';
    const desc = tr.querySelector('.rule-desc')?.value?.trim() || '';

    inboundRules.push({
      protocol: proto,
      fromPort: Math.min(fromPort, toPort),
      toPort: Math.max(fromPort, toPort),
      cidr: cidr,
      description: desc
    });
  });

  const payload = {
    name: name,
    description: description,
    region: region,
    attachInstanceId: attachInstanceId,
    inboundRules: inboundRules
  };

  const origText = btn ? btn.innerHTML : 'Tạo Security Group';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang tạo...';
  }

  try {
    const res = await apiRequest('/network/security-groups', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const newGid = res ? res.groupId : name;
    showToast(`Đã tạo thành công Security Group [${name}] (${newGid})!`, 'success');
    resetCreateForm();
    await loadSecurityGroups();
  } catch (err) {
    console.error('Failed to create security group:', err);
    showToast(`Lỗi tạo Security Group: ${err.message}`, 'error');
    showApiError('/network/security-groups', err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function promptAttachGroupToVm(groupId, groupName) {
  try {
    const list = await apiRequest('/instances');
    const instances = Array.isArray(list) ? list : [];
    if (instances.length === 0) {
      showToast('Không có máy ảo nào đang chạy để gán nhóm bảo mật!', 'info');
      return;
    }

    const options = instances.map((inst, idx) => `${idx + 1}. ${inst.name || inst.id} (${inst.id})`).join('\n');
    const input = prompt(`Chọn số thứ tự máy ảo muốn gán nhóm [${groupName}] (${groupId}):\n\n${options}\n\nNhập số:`);
    if (!input) return;

    const selectedIdx = parseInt(input.trim()) - 1;
    if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= instances.length) {
      showToast('Lựa chọn máy ảo không hợp lệ!', 'error');
      return;
    }

    const targetVm = instances[selectedIdx];
    await apiRequest(`/network/security-groups/instances/${targetVm.id}`, {
      method: 'PUT',
      body: JSON.stringify({ groupIds: [groupId, 'sg-default'] })
    });

    showToast(`Đã gán thành công Security Group [${groupName}] vào máy ảo ${targetVm.name || targetVm.id}!`, 'success');
  } catch (err) {
    showToast(`Lỗi gán nhóm bảo mật: ${err.message}`, 'error');
  }
}


