// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Trạng thái trang, hàm tiện ích, chuyển tab, tải và hiển thị máy ảo, thanh nút thao tác.

const DET_TRANSITIONAL = ['PENDING', 'STOPPING', 'SHUTTING_DOWN', 'TERMINATING', 'REBOOTING'];

// The API may return either the old UI names (ACTIVE/SHUTOFF) or EC2 names (RUNNING/STOPPED)
// depending on the InstanceService version, so the page accepts both.
function isRunningStatus(s) { return ['ACTIVE', 'RUNNING'].includes(String(s || '').toUpperCase()); }
function isTransitional(s) { return DET_TRANSITIONAL.includes(String(s || '').toUpperCase()); }
function isGone(s) { return ['TERMINATED', 'TERMINATING', 'SHUTTING_DOWN'].includes(String(s || '').toUpperCase()); }

// UI status from the API -> EC2 state shown on screen
const DET_STATES = {
  ACTIVE:        { cls: 'state-running',       label: 'Running' },
  RUNNING:       { cls: 'state-running',       label: 'Running' },
  SHUTOFF:       { cls: 'state-stopped',       label: 'Stopped' },
  STOPPED:       { cls: 'state-stopped',       label: 'Stopped' },
  PENDING:       { cls: 'state-pending',       label: 'Pending' },
  STOPPING:      { cls: 'state-stopping',      label: 'Stopping' },
  SHUTTING_DOWN: { cls: 'state-shutting-down', label: 'Shutting-down' },
  TERMINATING:   { cls: 'state-shutting-down', label: 'Terminating' },
  REBOOTING:     { cls: 'state-rebooting',     label: 'Rebooting' },
  MIGRATING:     { cls: 'state-migrating',     label: 'Migrating' },
  TERMINATED:    { cls: 'state-terminated',    label: 'Terminated' },
  ERROR:         { cls: 'state-error',         label: 'Error' }
};

const REGION_LABELS = {
  'ap-southeast-2': 'Sydney',
  'us-east-1': 'N. Virginia'
};

const RULE_PRESETS = {
  'ssh':        { protocol: 'tcp',  from: 22,   to: 22 },
  'http':       { protocol: 'tcp',  from: 80,   to: 80 },
  'https':      { protocol: 'tcp',  from: 443,  to: 443 },
  'mysql':      { protocol: 'tcp',  from: 3306, to: 3306 },
  'postgres':   { protocol: 'tcp',  from: 5432, to: 5432 },
  'custom-tcp': { protocol: 'tcp',  from: 8080, to: null },
  'custom-udp': { protocol: 'udp',  from: 53,   to: null },
  'icmp':       { protocol: 'icmp', from: 0,    to: 65535 },
  'all':        { protocol: 'all',  from: 0,    to: 65535 }
};

const det = {
  id: null,
  inst: null,
  groups: [],
  vpc: null,
  dns: null,
  history: null,
  cooldownDeadline: 0,
  cooldownTotal: 300,
  cooldownTimer: null,
  pollTimer: null,
  running: false,
  statusTimer: null,
  actionsKey: ''
};

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function regionLabel(code) {
  return REGION_LABELS[code] || code || '–';
}

function otherRegion(code) {
  return code === 'us-east-1' ? 'ap-southeast-2' : 'us-east-1';
}

function regionTag(code) {
  const cls = code === 'us-east-1' ? 'reg-use1' : 'reg-apse2';
  return `<span class="region-tag ${cls}"><i></i>${esc(regionLabel(code))} <code>${esc(code)}</code></span>`;
}

function stateTag(status) {
  const s = DET_STATES[String(status || '').toUpperCase()] || { cls: 'state-error', label: status || 'Unknown' };
  return `<span class="ec2-state ${s.cls}">${esc(s.label)}</span>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function fmtTime(ms) {
  return ms ? formatSyncedDateTime(ms) : '–';
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '–';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} phút ${s} giây` : `${s} giây`;
}

function fmtCountdown(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------- Tabs ----------------
const DET_TABS = ['details', 'security', 'storage', 'monitoring', 'migration'];
const SSH_USERS = { ubuntu: 'ubuntu', debian: 'admin', rocky: 'rocky', alpine: 'alpine', centos: 'centos', amazon: 'ec2-user' };

function sshUser(inst) {
  const name = String((inst && (inst.imageName || inst.imageId)) || '').toLowerCase();
  const hit = Object.keys(SSH_USERS).find(k => name.includes(k) || (k === 'debian' && name.includes('deb')));
  return hit ? SSH_USERS[hit] : 'ubuntu';
}

function copyText(id) {
  const el = document.getElementById(id);
  const text = el ? el.textContent.trim() : '';
  if (!text || text === '–' || text === '--') return;
  const done = () => showToast('Đã sao chép: ' + esc(text), 'success');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { showToast('Trình duyệt chặn sao chép', 'error'); }
  ta.remove();
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-btn[data-copy]');
  if (btn) copyText(btn.dataset.copy);
});
function switchDetailTab(tab) {
  if (!DET_TABS.includes(tab)) tab = 'details';
  document.querySelectorAll('.det-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.det-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (location.hash !== '#' + tab) history.replaceState(null, '', location.pathname + location.search + '#' + tab);
  if (tab === 'monitoring' && det.inst) loadMetrics();
  scheduleMetricsRefresh(tab);
  if (tab === 'storage' && det.inst) loadVolumes();
}

// ---------------- Init ----------------
async function initInstanceDetail() {
  renderUserBadge();
  clearApiError();

  document.querySelectorAll('.det-tab').forEach(b => b.addEventListener('click', () => switchDetailTab(b.dataset.tab)));
  switchDetailTab((location.hash || '').replace('#', ''));

  det.id = new URLSearchParams(window.location.search).get('id');
  if (!det.id) {
    showApiError('/instances/{id}', 'Không có ID máy ảo trên địa chỉ trang. Quay lại danh sách máy ảo và chọn một máy.');
    return;
  }
  setText('breadcrumbInstanceId', det.id);

  const ok = await loadInstance();
  if (!ok) return;

  await Promise.all([loadSecurityAndNetwork(), loadMigrationHistory()]);
  const tabNow = (location.hash || '').replace('#', '');
  if (tabNow === 'monitoring') loadMetrics();
  if (tabNow === 'storage') loadVolumes();
  await resumeRunningMigration();
  if (new URLSearchParams(window.location.search).get('action') === 'migrate') {
    switchDetailTab('migration');
    if (!det.running) openMigrateModal();
  }
}

async function loadInstance() {
  try {
    const inst = await apiRequest(`/instances/${encodeURIComponent(det.id)}`);
    if (!inst) throw new Error(`Không tìm thấy máy ảo ${det.id}`);
    det.inst = inst;
    renderInstance();
    watchTransitionalStatus();
    return true;
  } catch (err) {
    setText('detInstanceName', 'Không tải được máy ảo');
    return false;
  }
}

// While the VM is PENDING / STOPPING / REBOOTING..., re-read it every 2.5 s until it settles.
function watchTransitionalStatus() {
  if (isTransitional(det.inst.status)) {
    if (!det.statusTimer) {
      det.statusTimer = setInterval(async () => {
        const wasTransitional = isTransitional(det.inst.status);
        await loadInstance();
        if (wasTransitional && !isTransitional(det.inst.status)) loadMigrationHistory();
      }, 2500);
    }
  } else if (det.statusTimer) {
    clearInterval(det.statusTimer);
    det.statusTimer = null;
  }
}

function renderInstance() {
  const inst = det.inst;
  const spec = FLAVOR_SPECS[inst.flavor];

  setText('detInstanceName', inst.name || inst.id);
  setText('detInstanceId', inst.id);
  setText('detRegionName', `${regionLabel(inst.region)} (${inst.region})`);
  document.getElementById('detStatusBadge').outerHTML = stateTag(inst.status).replace('class="ec2-state', 'id="detStatusBadge" class="ec2-state');

  // Summary strip
  setText('sumId', inst.id);
  setHtml('sumState', stateTag(inst.status));
  setText('sumPublicIp', inst.publicIp || 'Chưa gán');
  setText('sumPrivateIp', inst.privateIp || '–');
  setText('sumFlavor', inst.flavor + (spec ? ` · ${spec.vcpu} vCPU` : ''));
  setHtml('sumRegion', regionTag(inst.region));
  setText('sumDns', inst.dnsDomain || '–');
  setText('sumKey', inst.keyName || '–');
  setHtml('sumChecks', statusChecks(inst.status));

  setText('detSeries', spec && spec.series ? spec.series : '');
  setText('detName', inst.name || '–');
  setText('detId', inst.id);
  setText('detOwner', inst.username || inst.owner || '–');
  setText('detSshUser', sshUser(inst));

  // Tab 1
  setText('detFlavor', inst.flavor);
  setText('detSpecs', spec ? `${spec.vcpu} vCPU · ${spec.ramDisplay}` : '–');
  setText('detImageName', inst.imageName || '–');
  setText('detImageId', inst.imageId || '–');
  setText('detKeyName', inst.keyName || '–');
  setHtml('detState', stateTag(inst.status));
  setText('detEbsVolumeId', inst.volumeId || inst.ebsVolumeId || `vol-${String(inst.id).replace('i-', '')}`);
  setText('detRootDiskSize', `${inst.ebsSizeGb || (spec ? spec.defaultDisk : 10)} GB`);
  const consoleLink = document.getElementById('detConsoleLink');
  if (consoleLink) consoleLink.href = inst.consoleUrl || '#';

  renderActions();
}

function statusChecks(status) {
  const s = String(status || '').toUpperCase();
  if (isRunningStatus(s)) return '<span class="check-ok">✓ 2/2 checks passed</span>';
  if (s === 'MIGRATING' || isTransitional(s)) return '<span class="check-wait">⟳ Initializing</span>';
  if (s === 'ERROR') return '<span class="check-bad">✕ 1/2 checks failed</span>';
  return '<span class="muted">Không áp dụng</span>';
}

async function refreshAll() {
  const btn = document.getElementById('btnRefresh');
  if (btn) btn.disabled = true;
  try {
    const ok = await loadInstance();
    if (ok) {
      await Promise.all([loadSecurityAndNetwork(), loadMigrationHistory()]);
      const tab = (location.hash || '').replace('#', '');
      if (tab === 'monitoring') loadMetrics();
      if (tab === 'storage') loadVolumes();
      showToast('Đã làm mới thông tin máy ảo', 'success');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function migrationBlockReason() {
  const inst = det.inst || {};
  const h = det.history || {};
  const status = String(inst.status || h.currentStatus || '').toUpperCase();
  if (isGone(status)) return 'Máy ảo đang bị xóa hoặc đã xóa.';
  if (det.running || (h.migrationLock && !h.lockStale) || (status === 'MIGRATING' && !h.lockStale)) return 'Đang có một lần chuyển vùng chạy, migration_lock đang khóa.';
  if (isTransitional(status)) return `Máy đang ở trạng thái ${status}. Đợi máy về Running hoặc Stopped.`;
  const left = Math.max(0, Math.ceil((det.cooldownDeadline - Date.now()) / 1000));
  if (left > 0) return `Đang trong thời gian cooldown, còn ${fmtCountdown(left)}.`;
  return '';
}

function renderActions() {
  const inst = det.inst;
  if (!inst) return;
  const busy = inst.status === 'MIGRATING' || det.running || isTransitional(inst.status) || isGone(inst.status);
  const running = isRunningStatus(inst.status);
  const reason = migrationBlockReason();
  const id = esc(inst.id);
  // tickCooldown() calls this every second: only rebuild buttons when something changed
  const key = [inst.status, busy, reason.replace(/\d{2}:\d{2}/, '')].join('|');
  if (key === det.actionsKey) {
    setText('migBlockReason', reason || 'Sẵn sàng chuyển vùng.');
    setText('detActionHint', reason ? 'Fast Migrate tạm khóa: ' + reason : '');
    return;
  }
  det.actionsKey = key;

  // Như AWS: máy đang Migrating vẫn tính là "đang chạy" (sẽ chạy tiếp ở vùng đích), nên hiện Stop chứ không hiện Start.
  const powered = running || String(inst.status).toUpperCase() === 'MIGRATING';
  const item = (action, label, disabled, cls = '', hint = '') =>
    `<button type="button" role="menuitem" class="state-menu-item ${cls}" ${disabled ? `disabled title="${esc(hint)}"` : ''}
       onclick="closeStateMenu(); runDetailAction('${id}', '${action}')">${label}</button>`;
  const busyHint = t('Máy đang chuyển trạng thái hoặc đang chuyển vùng', 'Instance is transitioning or migrating');

  const editLink = (section, labelVi, labelEn, requiresStop = false, immutableVi = '', immutableEn = '') => {
    const label = t(labelVi, labelEn);
    const url = `/instance-edit.html?id=${encodeURIComponent(inst.id)}&section=${section}`;
    if (immutableVi) {
      const msg = t(immutableVi, immutableEn || immutableVi);
      return `<span role="menuitem" aria-disabled="true" class="ec2-actions-item is-disabled" data-tooltip="${esc(msg)}" title="${esc(msg)}">${label}</span>`;
    }
    if (requiresStop && (powered || busy)) {
      const stopMsg = t('Cần dừng máy ảo (Stop instance) trước khi ' + labelVi, `Stop the instance before using "${labelEn}"`);
      return `<span role="menuitem" aria-disabled="true" class="ec2-actions-item is-disabled" data-tooltip="${esc(stopMsg)}" title="${esc(stopMsg)}">${label}</span>`;
    }
    return `<a role="menuitem" href="${url}" class="ec2-actions-item">${label}</a>`;
  };

  setHtml('detailActionButtons', `
    <button class="btn btn-secondary" id="btnRefresh" onclick="refreshAll()" title="${t('Làm mới', 'Refresh')}" aria-label="${t('Làm mới', 'Refresh')}">⟳</button>
    <button class="btn btn-secondary" onclick="openConnectModal()" ${running ? '' : `disabled title="${t('Máy phải đang chạy mới kết nối được', 'Instance must be running to connect')}"`}>${t('Kết nối (Connect)', 'Connect')}</button>
    <div class="state-menu" id="stateMenu">
      <button type="button" class="btn btn-secondary" id="stateMenuBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="stateMenuList"
        onclick="toggleStateMenu()" ${isGone(inst.status) ? 'disabled' : ''}>${t('Trạng thái máy ảo ▾', 'Instance state ▾')}</button>
      <div class="state-menu-list" id="stateMenuList" role="menu" aria-labelledby="stateMenuBtn" hidden>
        ${item('START', t('▶ Khởi động máy ảo (Start)', '▶ Start instance'), powered || busy, '', powered ? t('Máy đang chạy', 'Instance is already running') : busyHint)}
        ${item('STOP', t('⏸ Dừng máy ảo (Stop)', '⏸ Stop instance'), !powered || busy, '', !powered ? t('Máy đã dừng', 'Instance is already stopped') : busyHint)}
        ${item('REBOOT', t('🔄 Khởi động lại (Reboot)', '🔄 Reboot instance'), !running || busy, '', !running ? t('Chỉ reboot được máy đang chạy', 'Instance must be running to reboot') : busyHint)}
        <div class="state-menu-sep" role="separator"></div>
        ${item('TERMINATE', t('🗑 Xóa vĩnh viễn (Terminate)', '🗑 Terminate (delete) instance'), busy, 'danger', busyHint)}
      </div>
    </div>
    <div class="ec2-actions-menu" id="ec2ActionsMenu">
      <button type="button" class="btn btn-secondary" id="ec2ActionsBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="ec2ActionsList"
        onclick="toggleEc2ActionsMenu()" ${isGone(inst.status) ? 'disabled' : ''}>${t('Hành động ▾', 'Actions ▾')}</button>
      <div class="ec2-actions-list" id="ec2ActionsList" role="menu" aria-labelledby="ec2ActionsBtn" hidden>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Cài đặt máy ảo', 'Instance settings')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Quản lý vòng đời & Nhãn', 'Protection and lifecycle management')}</div>
            ${editLink('tags', 'Đổi tên máy ảo & nhãn (Tags)', 'Change instance name & tags', false)}
            ${editLink('cooldown', 'Đổi thời gian chờ Cooldown', 'Change migration cooldown', false)}
            <div class="ec2-actions-sep"></div>
            <div class="ec2-actions-subhead">${t('Cấu hình phần cứng', 'Instance configuration')}</div>
            ${editLink('instance-type', 'Đổi loại máy ảo (Instance type)', 'Change instance type', true)}
            ${editLink('cpu-options', 'Tùy chọn vi xử lý (CPU options)', 'Change CPU options', true, 'Cần dừng máy ảo (Stop instance) để cấu hình CPU options', 'Instance must be stopped to modify CPU options')}
          </div>
        </div>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Mạng (Networking)', 'Networking')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Địa chỉ IP & Tên miền', 'IP & DNS configuration')}</div>
            ${editLink('elastic-ip', 'Quản lý địa chỉ Elastic IP', 'Manage Elastic IP address', false)}
            ${editLink('dns', 'Cập nhật tên miền Route 53 DNS', 'Change Route 53 DNS record', false)}
            ${editLink('vpc', 'Đổi mạng VPC / Subnet', 'Change VPC / Subnet', false, 'Không thể đổi trực tiếp VPC/Subnet. Vui lòng dùng Fast Migrate X-Region để chuyển vùng', 'VPC/Subnet cannot be changed directly. Use Fast Migrate X-Region instead')}
          </div>
        </div>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Bảo mật (Security)', 'Security')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Tường lửa & Khóa truy cập', 'Access & Firewall')}</div>
            ${editLink('security-groups', 'Đổi nhóm bảo mật (Security groups)', 'Change security groups', false)}
            ${editLink('key-pair', 'Đổi khóa truy cập SSH Key Pair', 'Change SSH key pair', false)}
          </div>
        </div>
        <div class="ec2-actions-group">
          <button type="button" class="ec2-actions-trigger"><span>${t('Lưu trữ (Storage)', 'Storage')}</span><span>▸</span></button>
          <div class="ec2-actions-submenu">
            <div class="ec2-actions-subhead">${t('Ổ đĩa EBS Elastic Volumes', 'EBS Elastic Volumes')}</div>
            ${editLink('storage', 'Mở rộng ổ cứng gốc EBS (gp3)', 'Modify EBS root volume (gp3)', false)}
          </div>
        </div>
      </div>
    </div>
    <button class="btn btn-primary" onclick="openMigrateModal()" ${reason ? 'disabled' : ''} title="${esc(reason || t('Chuyển sang ', 'Migrate to ') + regionLabel(otherRegion(inst.region)))}">⚡ Fast Migrate X-Region</button>
  `);

  setText('detActionHint', reason ? 'Fast Migrate tạm khóa: ' + reason : '');

  const tabBtn = document.getElementById('btnMigrateTab');
  if (tabBtn) {
    tabBtn.disabled = !!reason;
    tabBtn.textContent = `⚡ Fast Migrate sang ${regionLabel(otherRegion(inst.region))}`;
  }
  setText('migBlockReason', reason || 'Sẵn sàng chuyển vùng.');
  document.getElementById('migBlockReason').classList.toggle('warn', !!reason);
}

async function runDetailAction(id, action) {
  const name = (det.inst && det.inst.name) || id;
  if (action === 'TERMINATE' && !(await confirmDialog({
    title: 'Terminate máy ảo?',
    message: `Máy ảo <strong>${esc(name)}</strong> (<code>${esc(id)}</code>) sẽ bị xóa vĩnh viễn. Ổ EBS gốc bị xóa, Elastic IP được trả lại và bản ghi Route 53 ngừng trỏ tới máy. Không thể hoàn tác.`,
    confirmText: 'Terminate',
    danger: true,
    requireText: name
  }))) return;
  if (action === 'STOP' && !(await confirmDialog({
    title: 'Dừng máy ảo?',
    message: `Dịch vụ trên <strong>${esc(name)}</strong> sẽ gián đoạn tới khi bật lại. Dữ liệu trên ổ EBS được giữ nguyên.`,
    confirmText: 'Stop'
  }))) return;
  try {
    await apiRequest(`/instances/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
    showToast(`Đã gửi lệnh ${action} tới ${esc(id)}`, 'success');
    if (action === 'TERMINATE') {
      setTimeout(() => { window.location.href = '/instances.html'; }, 800);
      return;
    }
    await loadInstance();
    loadMigrationHistory();
    if (action === 'REBOOT') setTimeout(loadInstance, 3500);
  } catch (err) {
    showToast(`Không thực hiện được ${action}: ${esc(err.message)}`, 'error');
  }
}
