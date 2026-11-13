// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Trạng thái trang, hàm tiện ích, chuyển tab, tải và hiển thị máy ảo, thanh nút thao tác.

registerI18n({
  detSummaryFor: ['Tóm tắt máy ảo', 'Instance summary for'],
  detSumState: ['Trạng thái máy ảo', 'Instance state'],
  detSumType: ['Loại máy ảo', 'Instance type'],
  detSumChecks: ['Kiểm tra trạng thái', 'Status checks'],
  detSumOwner: ['Chủ sở hữu', 'Owner'],
  detHwTitle: ['Phần cứng & Hệ điều hành', 'Hardware & OS'],
  detOs: ['Hệ điều hành', 'Operating system'],
  detVirt: ['Ảo hóa', 'Virtualization'],
  detVirtValue: ['KVM (OpenStack Nova) trên EC2 Bare Metal', 'KVM (OpenStack Nova) on EC2 Bare Metal'],
  detIdTitle: ['Định danh & Truy cập', 'Identity & access'],
  detName: ['Tên máy ảo', 'Instance name'],
  detOwner: ['Chủ sở hữu', 'Owner'],
  detCurrentState: ['Trạng thái hiện tại', 'Current state'],
  detLoginUser: ['User đăng nhập', 'Login user'],
  detConnect: ['Kết nối', 'Connect'],
  detViewSsh: ['Xem lệnh SSH', 'View SSH command'],
  detCancel: ['Hủy', 'Cancel'],
  detClose: ['Đóng', 'Close'],
  detLoading: ['Đang tải...', 'Loading...'],
  detColType: ['Loại', 'Type'],
  detColDesc: ['Mô tả', 'Description'],
  detColState: ['Trạng thái', 'State'],
  detColName: ['Tên', 'Name']
});

const DET_TRANSITIONAL = ['PENDING', 'STOPPING', 'SHUTTING_DOWN', 'TERMINATING', 'REBOOTING'];

// The API may return either the old UI names (ACTIVE/SHUTOFF) or EC2 names (RUNNING/STOPPED)
// depending on the InstanceService version, so the page accepts both.
function isRunningStatus(s) { return ['ACTIVE', 'RUNNING'].includes(String(s || '').toUpperCase()); }
function isTransitional(s) { return DET_TRANSITIONAL.includes(String(s || '').toUpperCase()); }
function isGone(s) { return ['TERMINATED', 'TERMINATING', 'SHUTTING_DOWN'].includes(String(s || '').toUpperCase()); }

// UI status from the API -> EC2 state shown on screen
// Trạng thái máy → [class badge (status-badges.css), key i18n dùng chung st*]; trang chủ và trang danh sách dùng cùng kiểu
const DET_STATES = {
  ACTIVE:        { cls: 'state-running',       key: 'stRunning' },
  RUNNING:       { cls: 'state-running',       key: 'stRunning' },
  SHUTOFF:       { cls: 'state-stopped',       key: 'stStopped' },
  STOPPED:       { cls: 'state-stopped',       key: 'stStopped' },
  PENDING:       { cls: 'state-pending',       key: 'stPending' },
  STOPPING:      { cls: 'state-stopping',      key: 'stStopping' },
  SHUTTING_DOWN: { cls: 'state-shutting-down', key: 'stShuttingDown' },
  TERMINATING:   { cls: 'state-shutting-down', key: 'stShuttingDown' },
  REBOOTING:     { cls: 'state-rebooting',     key: 'stRebooting' },
  MIGRATING:     { cls: 'state-migrating',     key: 'stMigrating' },
  TERMINATED:    { cls: 'state-terminated',    key: 'stTerminated' },
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
  'icmp':       { protocol: 'icmp', from: 0,    to: 0 },
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
  const key = String(status || '').toUpperCase();
  const s = DET_STATES[key] || { cls: 'state-error', label: status || 'Unknown' };
  const spin = isTransitional(key) ? ICON('ui-spinner', 'ico-xs ico-spin') + ' ' : '';
  return `<span class="ec2-state ${s.cls}">${spin}${esc(s.key ? tk(s.key) : s.label)}</span>`;
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
  return m ? t(`${m} phút ${s} giây`, `${m} min ${s} s`) : t(`${s} giây`, `${s} s`);
}

function fmtCountdown(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------- Tabs ----------------
const DET_TABS = ['details', 'monitoring', 'migration'];
const SSH_USERS = {
  cirros: 'cirros',
  alpine: 'alpine',
  debian: 'debian',
  ubuntu: 'ubuntu',
  rocky: 'rocky',
  centos: 'centos',
  fedora: 'fedora',
  amazon: 'ec2-user',
  al2: 'ec2-user'
};

const KNOWN_IMAGE_MAP = {
  '831dc24b-9d29-4cb6-8154-9de2d0fd268f': { name: 'CirrOS-0.6.2', user: 'cirros' },
  'c66c2ab2-68fe-40bb-8f55-d2e5ba1c944d': { name: 'Alpine-Linux-3.20-Cloud', user: 'alpine' },
  'fd249548-1863-4d30-b809-732108cab057': { name: 'Ubuntu Server 24.04 LTS', user: 'ubuntu' },
  'img-u22': { name: 'Ubuntu Server 22.04 LTS', user: 'ubuntu' },
  'img-deb12': { name: 'Debian 12 Bookworm', user: 'debian' },
  'img-rocky9': { name: 'Rocky Linux 9 Enterprise', user: 'rocky' },
  'img-alp319': { name: 'Alpine Linux 3.19 Minimal', user: 'alpine' }
};

function sshUser(inst) {
  if (!inst) return 'ubuntu';
  const rawId = inst.imageId || '';
  if (rawId && KNOWN_IMAGE_MAP[rawId]) return KNOWN_IMAGE_MAP[rawId].user;
  const name = String(inst.imageName || rawId || '').toLowerCase();
  const hit = Object.keys(SSH_USERS).find(k => name.includes(k) || (k === 'debian' && name.includes('deb')));
  return hit ? SSH_USERS[hit] : 'ubuntu';
}

function copyText(id) {
  const el = document.getElementById(id);
  const text = el ? el.textContent.trim() : '';
  if (!text || text === '–' || text === '--') return;
  const done = () => showToast(t('Đã sao chép: ', 'Copied: ') + esc(text), 'success');
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
  try { document.execCommand('copy'); done(); } catch (e) { showToast(t('Trình duyệt chặn sao chép', 'The browser blocked copying'), 'error'); }
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
}

// Đổi ngôn ngữ: i18n.js đã vẽ lại phần đầu trang, tab Security/Networking và lịch sử;
// ở đây vẽ lại phần còn lại đang hiện trên màn hình.
onLangChange(() => {
  if (!det.inst) return;
  const tab = (location.hash || '').replace('#', '');
  if (tab === 'monitoring') loadMetrics();
  renderMonSub();
  if (det.lastProgress) renderPipeline(det.lastProgress);
});

// ---------------- Init ----------------
async function initInstanceDetail() {
  renderUserBadge();
  clearApiError();

  document.querySelectorAll('.det-tab').forEach(b => b.addEventListener('click', () => switchDetailTab(b.dataset.tab)));
  switchDetailTab((location.hash || '').replace('#', ''));

  det.id = new URLSearchParams(window.location.search).get('id');
  if (!det.id) {
    renderLoadFailure(null);
    return;
  }
  setText('breadcrumbInstanceId', det.id);
  setText('detInstanceId', det.id);

  const ok = await loadInstance();
  if (!ok) return;

  await Promise.all([loadSecurityAndNetwork(), loadMigrationHistory()]);
  const tabNow = (location.hash || '').replace('#', '');
  if (tabNow === 'monitoring') loadMetrics();
  await resumeRunningMigration();
  if (new URLSearchParams(window.location.search).get('action') === 'migrate') {
    switchDetailTab('migration');
    if (!det.running) openMigrateModal();
  }
}

async function loadInstance() {
  try {
    const inst = await apiRequest(`/instances/${encodeURIComponent(det.id)}`);
    if (!inst) throw new Error(`Instance not found: ${det.id}`);
    det.inst = inst;
    renderInstance();
    watchTransitionalStatus();
    return true;
  } catch (err) {
    renderLoadFailure(err);
    return false;
  }
}

// Như AWS: không tìm thấy máy thì hiện một khối thông báo + đường quay lại, không hiện khung dữ liệu trống.
function renderLoadFailure(err) {
  clearApiError();
  const msg = String((err && err.message) || '');
  const notFound = !det.id || /not found|không tìm thấy|404/i.test(msg);
  const main = document.querySelector('main.app-main');
  if (!main) return;
  [...main.children].forEach(el => { if (!el.classList.contains('breadcrumb') && el.id !== 'apiErrorBanner') el.hidden = true; });
  setText('breadcrumbInstanceId', det.id || '–');
  document.title = (notFound ? t('Không tìm thấy máy ảo', 'Instance not found') : t('Lỗi tải máy ảo', 'Error loading instance')) + ' | XRegion-EC2';
  const box = document.createElement('section');
  box.className = 'card det-empty';
  box.setAttribute('role', 'alert');
  box.innerHTML = notFound
    ? `<div class="det-empty-icon" aria-hidden="true">${ICON('ui-search', 'ico-xl')}</div>
       <h1 class="det-empty-title">${det.id ? `${t('Không tìm thấy máy ảo', 'Instance not found:')} <code>${esc(det.id)}</code>` : t('Chưa chọn máy ảo', 'No instance selected')}</h1>
       <p class="det-empty-text">${det.id
         ? t('Máy ảo này không tồn tại, đã bị xóa (Terminated) hoặc thuộc tài khoản khác.', 'This instance does not exist, was terminated, or belongs to another account.')
         : t('Địa chỉ trang thiếu ID máy ảo. Hãy chọn một máy trong danh sách.', 'The page address has no instance ID. Pick an instance from the list.')}</p>
       <div class="det-empty-actions">
         <a href="/instances.html" class="btn btn-primary ico-label">${ICON('ui-chevron-left', 'ico-sm')} ${t('Về danh sách máy ảo', 'Back to instances')}</a>
         <a href="/launch.html" class="btn btn-secondary ico-label">${ICON('ui-plus', 'ico-sm')} ${tk('navLaunch')}</a>
       </div>`
    : `<div class="det-empty-icon is-error" aria-hidden="true">${ICON('ui-error', 'ico-xl')}</div>
       <h1 class="det-empty-title">${t('Không tải được thông tin máy ảo', 'Could not load the instance')}</h1>
       <p class="det-empty-text">${t('Máy chủ không phản hồi hoặc đang gặp lỗi. Chi tiết:', 'The server did not respond or returned an error. Details:')} <code>${esc(msg || '–')}</code></p>
       <div class="det-empty-actions">
         <button type="button" class="btn btn-primary ico-label" onclick="location.reload()">${ICON('ui-refresh', 'ico-sm')} ${t('Thử lại', 'Retry')}</button>
         <a href="/instances.html" class="btn btn-secondary ico-label">${ICON('ui-chevron-left', 'ico-sm')} ${t('Về danh sách máy ảo', 'Back to instances')}</a>
       </div>`;
  main.appendChild(box);
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

  setText('detInstanceName', inst.name ? `(${inst.name})` : '');
  setText('detInstanceId', inst.id);
  setText('breadcrumbInstanceId', inst.id);
  setHtml('detRegionName', regionTag(inst.region));
  setText('detUpdated', t('Cập nhật lúc ', 'Updated ') + new Date().toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'vi-VN', { hour12: false }));
  document.title = `${inst.name || inst.id} | Instance summary - XRegion-EC2`;
  document.getElementById('detStatusBadge').outerHTML = stateTag(inst.status).replace('class="ec2-state', 'id="detStatusBadge" class="ec2-state');

  // Summary strip
  setText('sumId', inst.id);
  setHtml('sumState', stateTag(inst.status));
  setText('sumPublicIp', inst.publicIp && inst.publicIp !== 'Chưa gán' ? inst.publicIp : '–');
  setText('sumPrivateIp', inst.privateIp || '–');
  setText('sumFlavor', inst.flavor + (spec ? ` · ${spec.vcpu} vCPU` : ''));
  setHtml('sumRegion', regionTag(inst.region));
  setText('sumDns', inst.dnsDomain || '–');
  setText('sumKey', inst.keyName || '–');
  setHtml('sumChecks', statusChecks(inst.status));
  setText('sumAmi', inst.imageName || inst.imageId || '–');
  setText('sumOwner', inst.username || inst.owner || '–');

  // FLAVOR_SPECS (ui.js) chỉ có nhãn tiếng Việt: đổi sang tiếng Anh tại đây, không sửa file dùng chung
  const series = spec && spec.series ? spec.series : '';
  setText('detSeries', getLang() === 'en'
    ? series.replace('Tiêu chuẩn', 'General purpose').replace('Hiệu năng cao', 'Compute optimized')
    : series);
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
  if (isRunningStatus(s)) return `<span class="check-ok">${ICON('ui-check-circle', 'ico-sm')} 2/2 checks passed</span>`;
  if (s === 'MIGRATING' || isTransitional(s)) return `<span class="check-wait">${ICON('ui-spinner', 'ico-sm ico-spin')} Initializing</span>`;
  if (s === 'ERROR') return `<span class="check-bad">${ICON('ui-error', 'ico-sm')} 1/2 checks failed</span>`;
  return `<span class="muted">${t('Không áp dụng', 'Not applicable')}</span>`;
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
      showToast(t('Đã làm mới thông tin máy ảo', 'Instance refreshed'), 'success');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function migrationBlockReason() {
  const inst = det.inst || {};
  const h = det.history || {};
  const status = String(inst.status || h.currentStatus || '').toUpperCase();
  if (isGone(status)) return t('Máy ảo đang bị xóa hoặc đã xóa.', 'The instance is terminating or terminated.');
  if (det.running || (h.migrationLock && !h.lockStale) || (status === 'MIGRATING' && !h.lockStale)) return t('Đang có một lần chuyển vùng chạy, migration_lock đang khóa.', 'A migration is running, migration_lock is held.');
  if (isTransitional(status)) return t(`Máy đang ở trạng thái ${status}. Đợi máy về Running hoặc Stopped.`, `The instance is ${status}. Wait until it is Running or Stopped.`);
  const left = Math.max(0, Math.ceil((det.cooldownDeadline - Date.now()) / 1000));
  if (left > 0) return t(`Đang trong thời gian cooldown, còn ${fmtCountdown(left)}.`, `In cooldown, ${fmtCountdown(left)} left.`);
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
    setText('migBlockReason', reason || t('Sẵn sàng chuyển vùng.', 'Ready to migrate.'));
    setText('detActionHint', reason ? t('Fast Migrate tạm khóa: ', 'Fast Migrate unavailable: ') + reason : '');
    return;
  }
  det.actionsKey = key;

  // Như AWS: máy đang Migrating vẫn tính là "đang chạy" (sẽ chạy tiếp ở vùng đích), nên hiện Stop chứ không hiện Start.
  const powered = running || String(inst.status).toUpperCase() === 'MIGRATING';
  const item = (action, label, disabled, cls = '', hint = '') =>
    `<button type="button" role="menuitem" class="state-menu-item ${cls}" ${disabled ? `disabled title="${esc(hint)}"` : ''}
       onclick="closeStateMenu(); runDetailAction('${id}', '${action}')">${label}</button>`;
  const busyHint = t('Máy đang chuyển trạng thái hoặc đang chuyển vùng', 'Instance is transitioning or migrating');


  setHtml('detailActionButtons', `
    <button class="btn btn-secondary btn-sm" id="btnRefresh" onclick="refreshAll()">${ICON('ui-refresh', 'ico-sm')} ${tk('actRefresh')}</button>
    <button class="btn btn-secondary btn-sm" onclick="openConnectModal()" ${running ? '' : `disabled title="${t('Máy phải đang chạy mới kết nối được', 'Instance must be running to connect')}"`}>${ICON('ui-terminal', 'ico-sm')} ${tk('actConnect')}</button>
    <div class="state-menu" id="stateMenu">
      <button type="button" class="btn btn-secondary btn-sm" id="stateMenuBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="stateMenuList"
        onclick="toggleStateMenu()" ${isGone(inst.status) ? 'disabled' : ''}>${ICON('ui-power', 'ico-sm')} ${tk('actInstanceState')} ${ICON('ui-chevron-down', 'ico-sm')}</button>
      <div class="state-menu-list" id="stateMenuList" role="menu" aria-labelledby="stateMenuBtn" hidden>
        ${item('START', ICON('ui-play') + ' ' + t('Khởi động máy ảo', 'Start instance'), powered || busy, '', powered ? t('Máy đang chạy', 'Instance is already running') : busyHint)}
        ${item('STOP', ICON('ui-stop') + ' ' + t('Dừng máy ảo', 'Stop instance'), !powered || busy, '', !powered ? t('Máy đã dừng', 'Instance is already stopped') : busyHint)}
        ${item('REBOOT', ICON('ui-reboot') + ' ' + t('Khởi động lại máy ảo', 'Reboot instance'), !running || busy, '', !running ? t('Chỉ reboot được máy đang chạy', 'Instance must be running to reboot') : busyHint)}
        <div class="state-menu-sep" role="separator"></div>
        ${item('TERMINATE', ICON('ui-trash') + ' ' + t('Xóa máy ảo', 'Terminate instance'), busy, 'danger', busyHint)}
      </div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="openMigrateModal()" ${reason ? 'disabled' : ''} title="${esc(reason || t('Chuyển sang ', 'Migrate to ') + regionLabel(otherRegion(inst.region)))}">${ICON('ui-migrate', 'ico-sm')} Fast Migrate X-Region</button>
  `);

  setText('detActionHint', reason ? t('Fast Migrate tạm khóa: ', 'Fast Migrate unavailable: ') + reason : '');

  const tabBtn = document.getElementById('btnMigrateTab');
  if (tabBtn) {
    tabBtn.disabled = !!reason;
    tabBtn.innerHTML = `${ICON('ui-migrate')} Fast Migrate ${t('sang', 'to')} ${esc(regionLabel(otherRegion(inst.region)))}`;
  }
  setText('migBlockReason', reason || t('Sẵn sàng chuyển vùng.', 'Ready to migrate.'));
  document.getElementById('migBlockReason')?.classList.toggle('warn', !!reason);
}

async function runDetailAction(id, action) {
  const name = (det.inst && det.inst.name) || id;
  if (action === 'TERMINATE' && !(await confirmDialog({
    title: t('Xóa (terminate) máy ảo?', 'Terminate instance?'),
    message: t(`Máy ảo <strong>${esc(name)}</strong> (<code>${esc(id)}</code>) sẽ bị xóa vĩnh viễn. Ổ EBS gốc bị xóa, Elastic IP được trả lại và bản ghi Route 53 ngừng trỏ tới máy. Không thể hoàn tác.`,
      `<strong>${esc(name)}</strong> (<code>${esc(id)}</code>) will be permanently deleted. The root EBS volume is deleted, the Elastic IP is released and the Route 53 record stops pointing to it. This cannot be undone.`),
    confirmText: tk('actTerminate'),
    danger: true,
    requireText: name
  }))) return;
  if (action === 'STOP' && !(await confirmDialog({
    title: t('Dừng máy ảo?', 'Stop instance?'),
    message: t(`Dịch vụ trên <strong>${esc(name)}</strong> sẽ gián đoạn tới khi bật lại. Dữ liệu trên ổ EBS được giữ nguyên.`,
      `Services on <strong>${esc(name)}</strong> are unavailable until it is started again. Data on the EBS volume is kept.`),
    confirmText: tk('actStop')
  }))) return;
  try {
    await apiRequest(`/instances/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
    showToast(t(`Đã gửi lệnh ${action} tới ${esc(id)}`, `${action} request sent to ${esc(id)}`), 'success');
    if (action === 'TERMINATE') {
      setTimeout(() => { window.location.href = '/instances.html'; }, 800);
      return;
    }
    await loadInstance();
    loadMigrationHistory();
    if (action === 'REBOOT') setTimeout(loadInstance, 3500);
  } catch (err) {
    showToast(t(`Không thực hiện được ${action}: `, `Could not ${action.toLowerCase()}: `) + esc(err.message), 'error');
  }
}
