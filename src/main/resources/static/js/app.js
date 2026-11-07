// XRegion Dashboard Client-side JavaScript

const API_BASE = '/api';
let authToken = localStorage.getItem('xregion_jwt') || '';
let performanceChart = null;
let migrationPollInterval = null;
let serverClockOffsetMs = 0;

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
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {})
  };

  try {
    const res = await fetch(API_BASE + endpoint, { ...options, headers });
    if (res.status === 401) {
      const err = new Error('Phiên đăng nhập hết hạn hoặc chưa xác thực (HTTP 401). Vui lòng đăng nhập lại.');
      showApiError(endpoint, err.message, 401);
      setTimeout(() => {
        window.location.href = '/login.html';
      }, 1500);
      throw err;
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
    showApiError(endpoint, err.message);
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
      localStorage.setItem('xregion_jwt', authToken);
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
  authToken = '';
  showToast('Đã đăng xuất khỏi hệ thống', 'success');
  setTimeout(() => {
    window.location.href = '/login.html';
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
// GLOBAL USER BADGE & AUTH STATUS
// ============================================================
function renderUserBadge() {
  const container = document.getElementById('userBadgeContainer');
  if (!container) return;

  const token = localStorage.getItem('xregion_jwt');
  const user = localStorage.getItem('xregion_user') || 'Admin';

  if (token) {
    container.innerHTML = `
      <span style="font-weight: 600; color: #fff;">👤 ${user}</span>
      <button class="btn btn-secondary btn-sm" onclick="logout()" style="padding: 4px 10px; font-size: 11px;">Đăng xuất</button>
    `;
  } else {
    container.innerHTML = `
      <a href="/login.html" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 12px; text-decoration: none;">Đăng Nhập</a>
      <a href="/register.html" class="btn btn-primary btn-sm" style="padding: 4px 10px; font-size: 12px; text-decoration: none; margin-left: 6px;">Đăng Ký</a>
    `;
  }
}

// ============================================================
// PAGE INITIALIZERS: OVERVIEW, INSTANCES, DETAIL, LAUNCH
// ============================================================

// 1. OVERVIEW PAGE (index.html)
async function initOverviewPage() {
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
    if (elRun) elRun.textContent = `${running} Running`;
    if (elRegA) elRegA.textContent = `${regA} máy ảo`;
    if (elRegB) elRegB.textContent = `${regB} máy ảo`;

    if (tbodyInst) {
      if (list.length === 0) {
        tbodyInst.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--text-muted);">Chưa có máy ảo nào. <a href="/launch.html" style="color: var(--accent-cyan); font-weight: 700;">+ Khởi tạo ngay</a></td></tr>';
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
            <td><code>${inst.publicIp || 'Chưa gán'}</code></td>
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

    // Populate header
    document.getElementById('detInstanceName').textContent = inst.name || inst.id;
    document.getElementById('detInstanceId').textContent = inst.id;
    document.getElementById('detRegionName').textContent = inst.regionName || inst.region;

    const badge = document.getElementById('detStatusBadge');
    const cfg = getStatusBadgeConfig(inst.status);
    badge.className = 'badge ' + cfg.cssClass;
    badge.innerHTML = `<span class="status-dot ${cfg.dotClass}"></span>${cfg.label}`;

    // Populate Cards
    const spec = FLAVOR_SPECS[inst.flavor];
    const specDesc = spec ? ` (${spec.vcpu} vCPU${spec.vcpu > 1 ? 's' : ''} • ${spec.ramDisplay} • ${spec.defaultDisk} GB Root Disk)` : '';
    document.getElementById('detFlavor').textContent = `${inst.flavor}${specDesc}`;
    const detKeyEl = document.getElementById('detKeyName');
    if (detKeyEl) detKeyEl.textContent = inst.keyName || 'xregion-key';
    const detSgEl = document.getElementById('detSecurityGroup');
    if (detSgEl) detSgEl.textContent = inst.securityGroup || 'sg-default';
    document.getElementById('detImageName').textContent = inst.imageName || 'Ubuntu Server 22.04 LTS';
    document.getElementById('detRegionCode').textContent = inst.region;
    document.getElementById('detPrivateIp').textContent = inst.privateIp || '10.0.1.10';
    document.getElementById('detPublicIp').textContent = inst.publicIp || 'Chưa gán';
    document.getElementById('detDnsDomain').textContent = inst.dnsDomain || 'N/A';
    document.getElementById('detUpdatedAt').textContent = inst.updatedAt ? formatSyncedDateTime(inst.updatedAt) : 'Vừa xong';

    const volIdEl = document.getElementById('detEbsVolumeId');
    if (volIdEl) volIdEl.textContent = inst.ebsVolumeId || `vol-${inst.id.replace('i-', '')}`;
    const diskSizeEl = document.getElementById('detRootDiskSize');
    if (diskSizeEl) diskSizeEl.textContent = `${spec ? spec.defaultDisk : 10} GB`;

    const consoleLink = document.getElementById('detConsoleLink');
    if (consoleLink) {
      consoleLink.href = inst.consoleUrl || '#';
      consoleLink.onclick = (e) => {
        if (!inst.consoleUrl || inst.consoleUrl === '#') {
          e.preventDefault();
          showToast(`Đang mở Web Terminal VNC cho ${inst.id}...`, 'success');
        }
      };
    }

    // Render Actions Toolbar (disables buttons if instance is transitioning)
    const actionsContainer = document.getElementById('detailActionButtons');
    const isTrans = cfg.isTransitioning;
    const isRunning = (inst.status || '').toUpperCase() === 'RUNNING' || (inst.status || '').toUpperCase() === 'ACTIVE';
    const isTerminated = (inst.status || '').toUpperCase() === 'TERMINATED';

    if (actionsContainer) {
      actionsContainer.innerHTML = `
        <a href="/instance-edit.html?id=${inst.id}" class="btn btn-secondary ${isTrans || isTerminated ? 'disabled' : ''}" style="text-decoration:none; color:var(--accent-cyan);" ${isTrans || isTerminated ? 'tabindex="-1"' : ''}>✏️ Chỉnh Sửa (Modify)</a>
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
      setTimeout(initInstanceDetailPage, 2500);
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
    closeModal('createKeyModal');
    showToast(`Đã tạo Key Pair [${name}] và tải xuống ${name}.pem!`, 'success');
    if (res && res.privateKey) {
      downloadPemFile(name, res.privateKey);
    }
    await loadKeyPairsDropdown(name);
    if (typeof updateEditInstanceSummary === 'function') {
      updateEditInstanceSummary();
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

function selectOs(imageId, osName) {
  document.getElementById('instImage').value = imageId;
  const osCards = ['optOsUbuntu', 'optOsDebian', 'optOsRocky', 'optOsAlpine'];
  osCards.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('selected');
  });

  const cardMap = {
    'img-u22': 'optOsUbuntu',
    'img-deb12': 'optOsDebian',
    'img-rocky9': 'optOsRocky',
    'img-alp319': 'optOsAlpine'
  };
  const activeCard = document.getElementById(cardMap[imageId]);
  if (activeCard) activeCard.classList.add('selected');

  const radio = document.querySelector(`input[name="osRadio"][value="${imageId}"]`);
  if (radio) radio.checked = true;

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
  const sumSg = document.getElementById('sumSgText');
  const sgEl = document.getElementById('instSecurityGroup');
  if (sumSg && sgEl) {
    sumSg.textContent = sgEl.value;
  }

  // Highlight selected row in specification matrix table
  const allRows = ['row-m1-tiny', 'row-m1-small', 'row-m1-medium', 'row-m1-large', 'row-m1-xlarge', 'row-h1-medium', 'row-h1-large', 'row-h1-xlarge'];
  allRows.forEach(rowId => {
    const rowEl = document.getElementById(rowId);
    if (rowEl) {
      if (rowId === `row-${flavorVal.replace('.', '-')}`) {
        rowEl.style.background = 'rgba(56, 189, 248, 0.15)';
      } else {
        rowEl.style.background = 'transparent';
      }
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

// 5. MODIFY / EDIT INSTANCE PAGE (instance-edit.html)
let currentEditingInstance = null;

async function initEditInstancePage() {
  renderUserBadge();
  clearApiError();

  const urlParams = new URLSearchParams(window.location.search);
  const instanceId = urlParams.get('id');

  if (!instanceId) {
    showApiError('/instances/{id}', 'Không tìm thấy tham số ID máy ảo cần chỉnh sửa trên URL.');
    return;
  }

  const bcLink = document.getElementById('editBreadcrumbDetailLink');
  if (bcLink) {
    bcLink.textContent = instanceId;
    bcLink.href = `/instance-detail.html?id=${instanceId}`;
  }
  const backBtn = document.getElementById('btnBackToDetail');
  if (backBtn) backBtn.href = `/instance-detail.html?id=${instanceId}`;
  const cancelBtn = document.getElementById('btnCancelEditInstance');
  if (cancelBtn) cancelBtn.href = `/instance-detail.html?id=${instanceId}`;

  try {
    const inst = await apiRequest(`/instances/${instanceId}`);
    if (!inst) {
      throw new Error(`Không tìm thấy máy ảo [${instanceId}]`);
    }
    currentEditingInstance = inst;

    document.getElementById('editRoInstanceId').textContent = inst.id;
    document.getElementById('editRoRegion').textContent = `${inst.regionName || inst.region} (${inst.region})`;
    document.getElementById('editRoPrivateIp').textContent = inst.privateIp || '10.0.1.10';
    document.getElementById('editRoPublicIp').textContent = inst.publicIp || 'Chưa gán';

    const badge = document.getElementById('editInstStatusBadge');
    if (badge) {
      badge.textContent = inst.status;
      badge.className = 'badge ' + (inst.status === 'ACTIVE' ? 'badge-active' :
                                    inst.status === 'MIGRATING' ? 'badge-migrating' :
                                    inst.status === 'SHUTOFF' ? 'badge-shutoff' : 'badge-error');
    }

    document.getElementById('editInstName').value = inst.name || inst.id;
    const domainInput = document.getElementById('editInstDomain');
    if (domainInput) {
      domainInput.value = inst.dnsDomain || `${(inst.name || inst.id).toLowerCase()}.xregion.net`;
    }
    const flavorSelect = document.getElementById('editInstFlavor');
    if (flavorSelect && inst.flavor) {
      flavorSelect.value = inst.flavor;
    }
    const cooldownInput = document.getElementById('editInstCooldown');
    if (cooldownInput) {
      cooldownInput.value = inst.cooldownSeconds != null ? inst.cooldownSeconds : 300;
    }

    await loadKeyPairsDropdown(inst.keyName || 'xregion-key');
    const keySelect = document.getElementById('instKeyPair');
    if (keySelect && inst.keyName && !Array.from(keySelect.options).some(o => o.value === inst.keyName)) {
      const opt = document.createElement('option');
      opt.value = inst.keyName;
      opt.textContent = `${inst.keyName} (Đang gán trên máy ảo)`;
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
  const keyEl = document.getElementById('instKeyPair');
  const cooldownEl = document.getElementById('editInstCooldown');
  if (!nameEl || !flavorEl) return;

  const newName = nameEl.value.trim() || (currentEditingInstance ? currentEditingInstance.name : '--');
  const newFlavor = flavorEl.value;
  const newKey = (keyEl && keyEl.value) ? keyEl.value : (currentEditingInstance?.keyName || 'xregion-key');
  const newCooldown = cooldownEl ? (parseInt(cooldownEl.value) || 0) : 300;

  const dnsPreview = document.getElementById('editDnsPreview');
  if (dnsPreview) {
    dnsPreview.textContent = `${newName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.xregion.net`;
  }

  const spec = FLAVOR_SPECS[newFlavor] || FLAVOR_SPECS['m1.medium'];
  const oldName = currentEditingInstance?.name;
  const oldFlavor = currentEditingInstance?.flavor;
  const oldKey = currentEditingInstance?.keyName;

  const sumName = document.getElementById('sumEditName');
  const sumFlavor = document.getElementById('sumEditFlavor');
  const sumKey = document.getElementById('sumEditKey');
  const sumCooldown = document.getElementById('sumEditCooldown');

  if (sumName) {
    sumName.innerHTML = (oldName && oldName !== newName)
      ? `<span style="color:#94a3b8; text-decoration:line-through; font-weight:400;">${oldName}</span> ➔ <span style="color:#fbbf24;">${newName}</span>`
      : newName;
  }
  if (sumFlavor) {
    const desc = `${newFlavor} (${spec.vcpu} vCPU • ${spec.ramDisplay})`;
    sumFlavor.innerHTML = (oldFlavor && oldFlavor !== newFlavor)
      ? `<span style="color:#94a3b8; text-decoration:line-through; font-weight:400;">${oldFlavor}</span> ➔ <span style="color:#fbbf24;">${desc}</span>`
      : desc;
  }
  if (sumKey) {
    sumKey.innerHTML = (oldKey && oldKey !== newKey)
      ? `<span style="color:#94a3b8; text-decoration:line-through; font-weight:400;">${oldKey}</span> ➔ <span style="color:#fbbf24;">${newKey}</span>`
      : newKey;
  }
  if (sumCooldown) {
    sumCooldown.textContent = `${newCooldown} giây`;
  }
}

async function handleEditInstanceSubmit(e) {
  e.preventDefault();
  if (!currentEditingInstance) return;

  const errBox = document.getElementById('editErrorBox');
  if (errBox) errBox.style.display = 'none';

  const btn = document.getElementById('btnSaveEditInstance');
  const origText = btn ? btn.innerHTML : '💾 Lưu Thay Đổi (Save Changes)';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang lưu thay đổi lên AWS DynamoDB...';
  }

  const payload = {
    name: document.getElementById('editInstName').value.trim(),
    flavor: document.getElementById('editInstFlavor').value,
    keyPairName: document.getElementById('instKeyPair')?.value || currentEditingInstance.keyName || 'xregion-key',
    domainName: document.getElementById('editInstDomain')?.value.trim() || '',
    cooldownSeconds: parseInt(document.getElementById('editInstCooldown')?.value) || 300
  };

  try {
    await apiRequest(`/instances/${currentEditingInstance.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    showToast(`Đã cập nhật thông tin máy ảo [${payload.name}] thành công!`, 'success');
    setTimeout(() => {
      window.location.replace(`/instance-detail.html?id=${currentEditingInstance.id}`);
    }, 800);
  } catch (err) {
    if (errBox) {
      errBox.innerHTML = `<strong>❌ Lỗi cập nhật máy ảo:</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi cập nhật: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}


