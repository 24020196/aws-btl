// Instance detail page (instance-detail.html), EC2-style layout.
// Depends on helpers from app.js: apiRequest, showToast, showApiError, clearApiError,
// renderUserBadge, formatSyncedDateTime, FLAVOR_SPECS, openModal, closeModal.

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

// ---------------- Security groups & network ----------------
async function loadSecurityAndNetwork() {
  // After the security_group column is added to InstanceEntity/InstanceResponse, the instance
  // itself says which group it uses. Until then, ask the network API which groups are attached.
  const fromField = typeof det.inst.securityGroup === 'string' && det.inst.securityGroup.trim() !== '';
  const groupsUrl = fromField ? '/network/security-groups' : `/network/security-groups?instanceId=${encodeURIComponent(det.id)}`;
  const [groups, net] = await Promise.all([
    apiRequest(groupsUrl).catch(() => null),
    apiRequest('/network').catch(() => null)
  ]);
  if (fromField) {
    const ids = det.inst.securityGroup.split(',').map(s => s.trim()).filter(Boolean);
    det.groups = (groups || []).filter(g => ids.includes(g.groupId));
  } else {
    det.groups = groups || [];
  }
  if (net) {
    det.vpc = (net.vpcs || []).find(v => v.region === det.inst.region) || null;
    det.dns = (net.dnsRecords || []).find(d => String(d.domainName).toLowerCase() === String(det.inst.dnsDomain).toLowerCase()) || null;
  }
  renderSecurityGroups();
  renderNetwork();
}

function ruleType(rule) {
  const p = rule.protocol;
  if (p === 'all') return 'All traffic';
  if (p === 'icmp') return 'All ICMP';
  if (p === 'tcp' && rule.fromPort === rule.toPort) {
    const known = { 22: 'SSH', 80: 'HTTP', 443: 'HTTPS', 3306: 'MySQL/Aurora', 5432: 'PostgreSQL', 3389: 'RDP' };
    if (known[rule.fromPort]) return known[rule.fromPort];
  }
  return p === 'udp' ? 'Custom UDP' : 'Custom TCP';
}

function rulePorts(rule) {
  if (rule.protocol === 'all' || rule.protocol === 'icmp') return 'Tất cả';
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort} – ${rule.toPort}`;
}

function ruleRows(direction) {
  const rows = [];
  det.groups.forEach(g => {
    (g[direction === 'inbound' ? 'inboundRules' : 'outboundRules'] || []).forEach(r => rows.push({ g, r }));
  });
  return rows;
}

function renderSecurityGroups() {
  setHtml('sgChips', det.groups.length
    ? det.groups.map(g => `
        <div class="sg-chip">
          <code>${esc(g.groupId)}</code>
          <strong>${esc(g.name)}</strong>
          <span class="muted">${esc(g.description || '')}</span>
          ${g.shared ? '<span class="tag-shared" title="Nhóm dùng chung của hệ thống">dùng chung</span>' : ''}
        </div>`).join('')
    : '<span class="muted">Máy ảo chưa gắn Security Group nào.</span>');

  ['inbound', 'outbound'].forEach(dir => {
    const rows = ruleRows(dir);
    setText(dir + 'Count', `(${rows.length})`);
    setHtml(dir + 'RulesBody', rows.length
      ? rows.map(({ g, r }) => {
          const open = dir === 'inbound' && r.cidr === '0.0.0.0/0' && ![80, 443].includes(r.fromPort);
          return `<tr>
            <td><code>${esc(g.groupId)}</code><div class="muted">${esc(g.name)}</div></td>
            <td class="mono muted">${esc(r.ruleId || '–')}</td>
            <td>${esc(ruleType(r))}</td>
            <td><span class="proto">${esc(String(r.protocol).toUpperCase())}</span></td>
            <td class="mono">${esc(rulePorts(r))}</td>
            <td class="mono">${esc(r.cidr)}${open ? ' <span class="tag-open" title="Mở cho toàn Internet">mở công khai</span>' : ''}</td>
            <td>${esc(r.description || '–')}</td>
            <td class="rule-actions">${r.deletable
              ? `<button class="btn btn-danger btn-sm" onclick="deleteRule('${esc(g.groupId)}', '${esc(r.ruleId)}', '${dir}')" aria-label="Xóa rule ${esc(ruleType(r))} cổng ${esc(rulePorts(r))}">Xóa</button>`
              : `<span class="muted" title="${r.system ? 'Rule mặc định của nhóm dùng chung' : 'Rule do người khác thêm'}">${r.system ? 'Mặc định' : '–'}</span>`}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="8" class="empty-cell">Chưa có ${dir} rule nào. Bấm "Thêm rule" để mở cổng.</td></tr>`);
  });
}

function renderNetwork() {
  const inst = det.inst;
  const vpc = det.vpc;
  setText('netVpcId', vpc ? vpc.id : '–');
  setText('netVpcCidr', vpc ? vpc.cidr : '');
  setText('netSubnetId', vpc ? vpc.primarySubnetId : '–');
  setText('netSubnetCidr', vpc && vpc.primarySubnetCidr ? vpc.primarySubnetCidr : '');
  setText('netPrivateIp', inst.privateIp || '–');
  setText('netPublicIp', inst.publicIp || 'Chưa gán');
  setText('netDomain', inst.dnsDomain || '–');
  setText('netAz', vpc && vpc.availabilityZone ? vpc.availabilityZone : '–');
  setText('sumAz', vpc && vpc.availabilityZone ? vpc.availabilityZone : '–');
  setText('sumVpc', vpc ? vpc.id : '–');
  setHtml('eniBody', vpc && vpc.bareMetalEniId
    ? `<tr>
        <td class="mono">${esc(vpc.bareMetalEniId)}</td>
        <td>EC2 Bare Metal · ${esc(vpc.primarySubnetId || '')}</td>
        <td class="mono">${esc(vpc.bareMetalPrivateIp || '–')}</td>
        <td class="mono">${esc(inst.privateIp || '–')}</td>
        <td class="mono">${esc(inst.publicIp || 'Chưa gán')}</td>
        <td>1:1 NAT (iptables DNAT/SNAT)</td>
        <td><span class="muted">Tắt (để định tuyến IP máy ảo)</span></td>
      </tr>`
    : '<tr><td colspan="7" class="empty-cell">Không đọc được thông tin ENI của vùng này.</td></tr>');

  const target = det.dns ? det.dns.targetIp : null;
  setText('netDnsTarget', target || 'Chưa có bản ghi');
  setText('netDnsTtl', det.dns ? `${det.dns.ttl} giây` : '–');
  if (!target) {
    setHtml('netDnsSync', '<span class="sync-bad">Chưa tạo bản ghi A</span>');
  } else if (target === inst.publicIp) {
    setHtml('netDnsSync', '<span class="sync-ok">Khớp Elastic IP</span>');
  } else {
    setHtml('netDnsSync', `<span class="sync-bad">Lệch: đang trỏ ${esc(target)}</span>`);
  }

  const chip = document.getElementById('vpcCidrChip');
  if (chip) {
    chip.dataset.cidr = vpc ? vpc.cidr : '10.0.0.0/16';
    chip.textContent = `Trong VPC ${chip.dataset.cidr}`;
  }
}

function openAddRuleModal(direction) {
  if (!det.groups.length) {
    showToast('Máy chưa gắn Security Group nào. Tạo một nhóm trước.', 'error');
    return;
  }
  document.getElementById('ruleDirection').value = direction;
  document.getElementById('ruleGroup').innerHTML = det.groups
    .map(g => `<option value="${esc(g.groupId)}">${esc(g.groupId)} (${esc(g.name)})</option>`).join('');
  const preferred = det.groups.find(g => !g.shared) || det.groups.find(g => g.groupId === 'sg-web-public');
  if (preferred) document.getElementById('ruleGroup').value = preferred.groupId;
  document.getElementById('ruleType').value = 'custom-tcp';
  document.getElementById('ruleDesc').value = '';
  setRuleCidr('0.0.0.0/0');
  applyRulePreset();
  openModal('addRuleModal');
}

function applyRulePreset() {
  const p = RULE_PRESETS[document.getElementById('ruleType').value];
  const from = document.getElementById('ruleFromPort');
  const to = document.getElementById('ruleToPort');
  from.value = p.from;
  to.value = p.to === null ? '' : p.to;
  const fixed = !document.getElementById('ruleType').value.startsWith('custom');
  from.readOnly = fixed;
  to.readOnly = fixed;
  const dir = document.getElementById('ruleDirection').value;
  setText('ruleCidrLabel', dir === 'inbound' ? 'Nguồn (CIDR)' : 'Đích (CIDR)');
  checkRuleWarning();
}

function setRuleCidr(cidr) {
  document.getElementById('ruleCidr').value = cidr;
  checkRuleWarning();
}

function checkRuleWarning() {
  const dir = document.getElementById('ruleDirection').value;
  const type = document.getElementById('ruleType').value;
  const cidr = document.getElementById('ruleCidr').value.trim();
  document.getElementById('ruleWarn').hidden = !(dir === 'inbound' && cidr === '0.0.0.0/0' && !['http', 'https'].includes(type));
}

async function submitAddRule(e) {
  e.preventDefault();
  const dir = document.getElementById('ruleDirection').value;
  const preset = RULE_PRESETS[document.getElementById('ruleType').value];
  const from = parseInt(document.getElementById('ruleFromPort').value, 10);
  const toRaw = document.getElementById('ruleToPort').value;
  const to = toRaw === '' ? from : parseInt(toRaw, 10);
  if (to < from) {
    showToast('Cổng kết thúc phải lớn hơn hoặc bằng cổng bắt đầu', 'error');
    return;
  }
  const rule = {
    protocol: preset.protocol,
    fromPort: from,
    toPort: to,
    cidr: document.getElementById('ruleCidr').value.trim(),
    description: document.getElementById('ruleDesc').value.trim()
  };
  const body = { groupId: document.getElementById('ruleGroup').value };
  body[dir === 'inbound' ? 'inboundRules' : 'outboundRules'] = [rule];
  try {
    const res = await apiRequest('/network/security-groups', { method: 'POST', body: JSON.stringify(body) });
    closeModal('addRuleModal');
    showToast(res && res.rulesAdded === 0 ? 'Rule này đã có sẵn, không thêm mới' : `Đã thêm ${dir} rule vào ${esc(body.groupId)}`, 'success');
    loadSecurityAndNetwork();
  } catch (err) {
    showToast(`Không thêm được rule: ${esc(err.message)}`, 'error');
  }
}

async function deleteRule(groupId, ruleId, dir) {
  const g = det.groups.find(x => x.groupId === groupId);
  const r = g && (g[dir === 'inbound' ? 'inboundRules' : 'outboundRules'] || []).find(x => x.ruleId === ruleId);
  const label = r ? `${ruleType(r)}${rulePorts(r) === 'Tất cả' ? '' : ' ' + rulePorts(r)} ${dir === 'inbound' ? 'từ' : 'tới'} ${r.cidr}` : ruleId;
  if (!(await confirmDialog({
    title: `Xóa ${dir} rule?`,
    message: `Rule <code>${esc(label)}</code> sẽ bị xóa khỏi <code>${esc(groupId)}</code>. Lưu lượng khớp rule này bị chặn ngay lập tức.`
      + (dir === 'inbound' && r && r.protocol === 'tcp' && r.fromPort <= 22 && r.toPort >= 22 ? '<br><span class="confirm-warn">Đây là rule mở cổng SSH: xóa đi có thể khiến bạn mất kết nối tới máy.</span>' : ''),
    confirmText: 'Xóa rule',
    danger: true
  }))) return;
  try {
    await apiRequest(`/network/security-groups/${encodeURIComponent(groupId)}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    showToast(`Đã xóa rule ${esc(label)}`, 'success');
    loadSecurityAndNetwork();
  } catch (err) {
    showToast(`Không xóa được rule: ${esc(err.message)}`, 'error');
  }
}

function openCreateSgModal() {
  document.getElementById('sgName').value = '';
  document.getElementById('sgDesc').value = '';
  document.getElementById('sgAttach').checked = true;
  openModal('createSgModal');
  setTimeout(() => document.getElementById('sgName').focus(), 50);
}

async function submitCreateSg(e) {
  e.preventDefault();
  const attach = document.getElementById('sgAttach').checked;
  const fieldSupported = Object.prototype.hasOwnProperty.call(det.inst, 'securityGroup');
  const body = {
    name: document.getElementById('sgName').value.trim(),
    description: document.getElementById('sgDesc').value.trim(),
    region: det.inst.region,
    attachInstanceId: attach && !fieldSupported ? det.id : null
  };
  try {
    const sg = await apiRequest('/network/security-groups', { method: 'POST', body: JSON.stringify(body) });
    if (attach && fieldSupported) {
      // security_group is stored on the instance (InstanceEntity), so attach through the edit API
      await apiRequest(`/instances/${encodeURIComponent(det.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: det.inst.name,
          flavor: det.inst.flavor,
          keyPairName: det.inst.keyName,
          domainName: det.inst.dnsDomain,
          cooldownSeconds: det.inst.cooldownSeconds,
          securityGroup: sg.groupId
        })
      });
      await loadInstance();
    }
    closeModal('createSgModal');
    showToast(`Đã tạo Security Group ${esc(sg.groupId)}`, 'success');
    await loadSecurityAndNetwork();
  } catch (err) {
    showToast(`Không tạo được Security Group: ${esc(err.message)}`, 'error');
  }
}

function openDnsModal() {
  document.getElementById('dnsDomain').value = det.inst.dnsDomain || '';
  document.getElementById('dnsTarget').value = det.inst.publicIp && det.inst.publicIp !== 'Chưa gán' ? det.inst.publicIp : '';
  document.getElementById('dnsTtl').value = det.dns ? det.dns.ttl : 60;
  openModal('dnsModal');
}

async function submitDnsUpdate(e) {
  e.preventDefault();
  const body = {
    domainName: document.getElementById('dnsDomain').value.trim(),
    targetIp: document.getElementById('dnsTarget').value.trim(),
    ttl: parseInt(document.getElementById('dnsTtl').value, 10) || 60
  };
  try {
    await apiRequest('/network/dns', { method: 'POST', body: JSON.stringify(body) });
    closeModal('dnsModal');
    showToast(`Đã cập nhật ${esc(body.domainName)} trỏ tới ${esc(body.targetIp)}`, 'success');
    loadSecurityAndNetwork();
  } catch (err) {
    showToast(`Không cập nhật được DNS: ${esc(err.message)}`, 'error');
  }
}

// ---------------- Migration: lock, cooldown, history ----------------
async function loadMigrationHistory() {
  try {
    const h = await apiRequest(`/migrations/history/${encodeURIComponent(det.id)}`);
    det.history = h;
    det.cooldownTotal = h.cooldownSeconds || 300;
    det.cooldownDeadline = Date.now() + (h.cooldownRemainingSeconds || 0) * 1000;
    renderLockAndCooldown();
    renderHistory();
    startCooldownTimer();
  } catch (err) {
    setHtml('historyBody', '<tr><td colspan="8" class="empty-cell">Không tải được lịch sử chuyển vùng.</td></tr>');
  }
}

function renderLockAndCooldown() {
  const h = det.history || {};
  const locked = !!h.migrationLock || det.running;
  setHtml('migLock', locked
    ? '<span class="lock-badge locked">🔒 LOCKED</span>'
    : '<span class="lock-badge">🔓 Unlocked</span>');
  setText('migLockHint', locked && h.lockStale && !det.running
    ? `Khóa từ ${fmtTime(h.lockAcquiredAt)} nhưng không còn tiến trình nào chạy (khóa treo). Bấm Fast Migrate để tự giải phóng và chuyển lại.`
    : locked
    ? `Khóa từ ${fmtTime(h.lockAcquiredAt)}. Lần chuyển khác sẽ bị từ chối.`
    : 'Ghi có điều kiện trên DynamoDB, chỉ một lần chuyển chạy tại một thời điểm.');
  setHtml('sumLock', locked ? '<span class="lock-badge locked">🔒 LOCKED</span>' : '<span class="lock-badge">🔓 Unlocked</span>');

  const region = (det.inst && det.inst.region) || h.currentRegion;
  setHtml('migRoute', `${regionTag(region)} <span class="muted">→</span> ${regionTag(otherRegion(region))}`);
  setText('migRouteHint', 'Elastic IP mới được cấp ở vùng đích.');
  document.getElementById('migTabDot').hidden = !locked;
  tickCooldown();
}

function startCooldownTimer() {
  if (det.cooldownTimer) clearInterval(det.cooldownTimer);
  det.cooldownTimer = setInterval(tickCooldown, 1000);
}

function tickCooldown() {
  const left = Math.max(0, Math.ceil((det.cooldownDeadline - Date.now()) / 1000));
  const total = det.cooldownTotal || 300;
  const bar = document.getElementById('migCooldownBar');
  if (left > 0) {
    setText('migCooldown', fmtCountdown(left));
    setText('migCooldownHint', `Mỗi máy phải nghỉ ${Math.round(total / 60)} phút giữa hai lần chuyển.`);
    document.getElementById('migCooldown').classList.add('active');
    if (bar) bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
  } else {
    setText('migCooldown', 'Sẵn sàng');
    setText('migCooldownHint', `Cooldown ${Math.round(total / 60)} phút, tính từ lần chuyển hoàn tất gần nhất.`);
    document.getElementById('migCooldown').classList.remove('active');
    if (bar) bar.style.width = '0%';
    if (det.cooldownTimer && !det.running) {
      clearInterval(det.cooldownTimer);
      det.cooldownTimer = null;
    }
  }
  renderActions();
}

const HISTORY_STATUS = {
  COMPLETED: 'state-running',
  IN_PROGRESS: 'state-migrating',
  FAILED: 'state-error',
  ROLLED_BACK: 'state-error'
};

function renderHistory() {
  const rows = (det.history && det.history.history) || [];
  setHtml('historyBody', rows.length
    ? rows.map((r, i) => `<tr class="hist-row" tabindex="0" data-idx="${i}" aria-label="Xem log lần chuyển vùng ${esc(r.migrationId)}">
        <td class="mono">${esc(r.migrationId)}</td>
        <td>${regionTag(r.sourceRegion)} <span class="muted">→</span> ${regionTag(r.destRegion)}</td>
        <td>${esc(fmtTime(r.startedAt))}</td>
        <td>${r.completedAt ? esc(fmtTime(r.completedAt)) : '<span class="muted">Chưa xong</span>'}</td>
        <td>${esc(fmtDuration(r.durationSeconds))}</td>
        <td>${r.downtimeSeconds ? `<strong class="rto">${esc(r.downtimeSeconds)}s</strong>` : '<span class="muted">–</span>'}</td>
        <td><span class="ec2-state ${HISTORY_STATUS[r.status] || 'state-stopped'}">${esc(r.status)}</span>${r.errorMessage ? `<div class="err-text">${esc(r.errorMessage)}</div>` : ''}</td>
        <td class="rule-actions"><span class="link-accent hist-open">Xem log →</span></td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty-cell">Máy ảo này chưa chuyển vùng lần nào.</td></tr>');
}

const MIG_STEP_NAMES = ['Dừng VM nguồn', 'Tạo EBS snapshot', 'Sao chép snapshot sang vùng đích', 'Tạo volume ở vùng đích', 'Khởi động VM ở vùng đích', 'Route 53 DNS cutover'];

function openMigrationLog(idx) {
  const r = ((det.history && det.history.history) || [])[idx];
  if (!r) return;
  const logs = r.logs || [];
  setText('migLogTitle', r.migrationId);
  setHtml('migLogStatus', `<span class="ec2-state ${HISTORY_STATUS[r.status] || 'state-stopped'}">${esc(r.status)}</span>`);
  setHtml('migLogRoute', `${regionTag(r.sourceRegion)} <span class="muted">→</span> ${regionTag(r.destRegion)}`);
  const stat = (label, value, cls = '') => `<div class="mig-log-stat"><div class="mig-sum-label">${label}</div><div class="${cls}">${value}</div></div>`;
  setHtml('migLogStats', [
    stat('Bắt đầu', esc(fmtTime(r.startedAt))),
    stat('Hoàn tất', r.completedAt ? esc(fmtTime(r.completedAt)) : 'Chưa xong'),
    stat('Tổng thời lượng', esc(fmtDuration(r.durationSeconds))),
    stat('Downtime (RTO)', r.downtimeSeconds ? `${esc(r.downtimeSeconds)} giây` : '–', 'rto')
  ].join(''));

  const failed = String(r.status).toUpperCase() === 'FAILED';
  const doneSteps = new Set(logs.map(l => (l.match(/Step (\d)\/6/) || [])[1]).filter(Boolean).map(Number));
  const lastDone = doneSteps.size ? Math.max(...doneSteps) : 0;
  setHtml('migLogSteps', MIG_STEP_NAMES.map((name, i) => {
    const n = i + 1;
    const line = logs.find(l => l.includes(`Step ${n}/6`));
    const time = line ? (line.match(/^\[([^\]]+)\]/) || [])[1] : '';
    const state = doneSteps.has(n) ? 'done' : (failed && n === lastDone + 1 ? 'fail' : 'skip');
    return `<li class="mig-log-step ${state}">
      <span class="mig-log-dot" aria-hidden="true">${state === 'done' ? '✓' : state === 'fail' ? '✕' : n}</span>
      <div><strong>${n}. ${name}</strong>${time ? ` <span class="muted mono">${esc(time)}</span>` : ''}
      <div class="muted">${line ? esc(line.replace(/^\[[^\]]+\]\s*Step \d\/6:\s*/, '')) : state === 'fail' ? esc(r.errorMessage || 'Thất bại ở bước này') : 'Không chạy tới bước này'}</div></div>
    </li>`;
  }).join(''));

  setHtml('migLogTerminal', logs.length
    ? logs.map(l => `<div class="${/ERROR/.test(l) ? 'log-err' : ''}">${esc(l)}</div>`).join('')
    : '<div class="muted">Lần chuyển vùng này chạy trước khi hệ thống bắt đầu lưu log, nên không có log chi tiết.</div>');
  openModal('migLogModal');
}

document.addEventListener('click', e => {
  const row = e.target.closest('#historyBody .hist-row');
  if (row) openMigrationLog(Number(row.dataset.idx));
});
document.addEventListener('keydown', e => {
  const row = e.target.closest && e.target.closest('#historyBody .hist-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMigrationLog(Number(row.dataset.idx)); }
});

// ---------------- Migration: trigger + live pipeline ----------------
function openMigrateModal() {
  const reason = migrationBlockReason();
  if (reason) {
    showToast(esc(reason), 'error');
    return;
  }
  const inst = det.inst;
  setHtml('migrateModalText', `<strong>${esc(inst.name)}</strong> sẽ được chuyển từ ${regionTag(inst.region)} sang ${regionTag(otherRegion(inst.region))}.`);
  openModal('migrateModal');
}

async function confirmMigrate() {
  const btn = document.getElementById('btnConfirmMigrate');
  btn.disabled = true;
  try {
    const res = await apiRequest('/migrations/trigger', { method: 'POST', body: JSON.stringify({ id: det.id }) });
    closeModal('migrateModal');
    switchDetailTab('migration');
    showToast('Đã bắt đầu chuyển vùng, theo dõi tiến trình bên dưới', 'success');
    det.running = true;
    det.inst.status = 'MIGRATING';
    det.history = Object.assign({}, det.history, { migrationLock: true, lockStale: false, lockAcquiredAt: res && res.startedAt ? res.startedAt : Date.now() });
    renderInstance();
    renderLockAndCooldown();
    renderPipeline(res);
    startProgressPollingDetail();
  } catch (err) {
    closeModal('migrateModal');
    showToast(`Không chuyển vùng được: ${esc(err.message)}`, 'error');
    loadMigrationHistory();
  } finally {
    btn.disabled = false;
  }
}

async function resumeRunningMigration() {
  try {
    const p = await apiRequest(`/migrations/progress/${encodeURIComponent(det.id)}`);
    if (p && p.status === 'IN_PROGRESS') {
      det.running = true;
      renderLockAndCooldown();
      renderPipeline(p);
      startProgressPollingDetail();
    } else if (p && (p.status === 'COMPLETED' || p.status === 'ROLLED_BACK')) {
      renderPipeline(p);
    }
  } catch (err) {
    // progress endpoint is optional for this page
  }
}

function startProgressPollingDetail() {
  if (det.pollTimer) clearInterval(det.pollTimer);
  det.pollTimer = setInterval(async () => {
    try {
      const p = await apiRequest(`/migrations/progress/${encodeURIComponent(det.id)}`);
      renderPipeline(p);
      if (p.status === 'COMPLETED' || p.status === 'ROLLED_BACK' || p.status === 'FAILED') {
        clearInterval(det.pollTimer);
        det.pollTimer = null;
        det.running = false;
        if (p.status === 'COMPLETED') {
          showToast(`Chuyển vùng hoàn tất, máy đang chạy ở ${esc(regionLabel(p.destRegion))}`, 'success');
        } else {
          showToast('Chuyển vùng thất bại, máy đã được giữ ở vùng nguồn', 'error');
        }
        await loadInstance();
        await Promise.all([loadMigrationHistory(), loadSecurityAndNetwork()]);
      }
    } catch (err) {
      clearInterval(det.pollTimer);
      det.pollTimer = null;
    }
  }, 1000);
}

function renderPipeline(p) {
  if (!p) return;
  const step = p.stepNumber || 0;
  const done = p.status === 'COMPLETED';
  const failed = p.status === 'ROLLED_BACK' || p.status === 'FAILED';
  const pct = done ? 100 : (p.progressPercent || 0);

  setText('pipePercent', `${pct}%`);
  const bar = document.getElementById('detPipeBar');
  bar.style.width = pct + '%';
  bar.parentElement.classList.toggle('failed', failed);

  document.querySelectorAll('#detPipeline .det-step').forEach(li => {
    const n = Number(li.dataset.step);
    const dot = li.querySelector('.det-step-dot');
    li.className = 'det-step';
    if (done || n < step) {
      li.classList.add('done');
      dot.textContent = '✓';
    } else if (n === step) {
      li.classList.add(failed ? 'failed' : 'active');
      dot.textContent = failed ? '✕' : String(n);
    } else {
      dot.textContent = String(n);
    }
  });

  const label = done ? 'Hoàn tất' : failed ? 'Thất bại, đã khôi phục' : p.status === 'IN_PROGRESS' ? 'Đang chạy' : 'Đang chờ';
  setText('logStatus', label);
  if (p.sourceRegion && p.destRegion) {
    setHtml('pipeSub', `${regionTag(p.sourceRegion)} <span class="muted">→</span> ${regionTag(p.destRegion)} · ${esc(p.currentStep || '')}`);
  }

  const term = document.getElementById('detTerminal');
  if (p.logs && p.logs.length) {
    term.innerHTML = p.logs.map(l => `<div>${esc(l)}</div>`).join('');
    term.scrollTop = term.scrollHeight;
  }
}

// Close modals with Escape
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
});
['ruleDirection', 'ruleCidr'].forEach(id => {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => (id === 'ruleDirection' ? applyRulePreset() : checkRuleWarning()));
  });
});


// ---------------- Connect ----------------
function openConnectModal() {
  const inst = det.inst;
  if (!inst) return;
  const key = (inst.keyName || 'my-key').replace(/\.pem$/i, '') + '.pem';
  const user = sshUser(inst);
  const host = inst.publicIp || inst.privateIp || '<elastic-ip>';
  setText('connKeyFile', key);
  setText('connChmod', `chmod 400 "${key}"`);
  setText('connCmdIp', `ssh -i "${key}" ${user}@${host}`);
  setText('connCmdDns', inst.dnsDomain ? `ssh -i "${key}" ${user}@${inst.dnsDomain}` : 'Máy chưa có tên miền Route 53');
  setText('connNote', `User mặc định của ${inst.imageName || 'image này'} là "${user}". Security Group phải mở inbound TCP 22 cho IP của bạn.`
    + (det.groups.some(g => (g.inboundRules || []).some(r => (r.protocol === 'tcp' && r.fromPort <= 22 && r.toPort >= 22) || r.protocol === 'all'))
      ? '' : ' Hiện chưa có rule nào mở cổng 22.'));
  openModal('connectModal');
}

// ---------------- Change security groups ----------------
async function openChangeSgModal() {
  let all;
  try {
    all = await apiRequest('/network/security-groups');
  } catch (err) {
    showToast('Không tải được danh sách Security Group: ' + esc(err.message), 'error');
    return;
  }
  const single = 'securityGroup' in (det.inst || {});
  const current = det.groups.map(g => g.groupId);
  const type = single ? 'radio' : 'checkbox';
  setHtml('changeSgList', (all || []).map(g => `
    <label class="sg-pick-row">
      <input type="${type}" name="sgPick" value="${esc(g.groupId)}" ${current.includes(g.groupId) ? 'checked' : ''}>
      <span><code>${esc(g.groupId)}</code> <strong>${esc(g.name)}</strong>
      <span class="muted">${esc(g.description || '')} · ${(g.inboundRules || []).length} inbound</span></span>
    </label>`).join('') || '<p class="muted">Chưa có Security Group nào.</p>');
  openModal('changeSgModal');
}

async function submitChangeSg(e) {
  e.preventDefault();
  const ids = [...document.querySelectorAll('#changeSgList input[name="sgPick"]:checked')].map(i => i.value);
  if (!ids.length) {
    showToast('Phải chọn ít nhất một Security Group', 'error');
    return;
  }
  try {
    if ('securityGroup' in det.inst) {
      await apiRequest(`/instances/${encodeURIComponent(det.id)}`, { method: 'PUT', body: JSON.stringify({ securityGroup: ids[0] }) });
      await loadInstance();
    } else {
      await apiRequest(`/network/security-groups/instances/${encodeURIComponent(det.id)}`, { method: 'PUT', body: JSON.stringify({ groupIds: ids }) });
    }
    closeModal('changeSgModal');
    showToast('Đã cập nhật Security Group: ' + esc(ids.join(', ')), 'success');
    await loadSecurityAndNetwork();
  } catch (err) {
    showToast('Không đổi được Security Group: ' + esc(err.message), 'error');
  }
}

// ---------------- Storage ----------------
async function loadVolumes() {
  let list;
  try {
    list = await apiRequest('/volumes');
  } catch (err) {
    setHtml('volumesBody', '<tr><td colspan="7" class="empty-cell">Không tải được danh sách ổ đĩa.</td></tr>');
    return;
  }
  const mine = (list || []).filter(v => v.attachedInstanceId === det.id);
  setText('volCount', `(${mine.length + 1})`);
  const spec = FLAVOR_SPECS[det.inst.flavor];
  const rootId = det.inst.ebsVolumeId || `vol-${String(det.inst.id).replace('i-', '')}`;
  const rootRow = `<tr>
      <td class="mono">${esc(rootId)}</td><td>Root volume</td><td class="mono">/dev/vda</td>
      <td>${spec ? spec.defaultDisk : 10} GiB</td><td>gp3</td><td>3000 / 125 MB/s</td>
      <td><span class="ec2-state state-running">in-use</span></td></tr>`;
  setHtml('volumesBody', rootRow + mine.map(v => `<tr>
      <td class="mono">${esc(v.id)}</td>
      <td>${esc(v.name || '–')}</td>
      <td class="mono">${esc(v.device || '–')}</td>
      <td>${esc(v.sizeGb)} GiB</td>
      <td>${esc(v.volumeType || '–')}</td>
      <td>${esc(v.iops || '–')} / ${esc(v.throughput || '–')} MB/s</td>
      <td><span class="ec2-state ${String(v.status).toUpperCase() === 'IN_USE' || String(v.status).toLowerCase() === 'in-use' ? 'state-running' : 'state-pending'}">${esc(String(v.status || '').toLowerCase().replace('_', '-'))}</span></td>
    </tr>`).join(''));
}

// ---------------- Monitoring (inline SVG) ----------------
function svgChart(series, opts) {
  const W = 480, H = 170, L = 40, R = 10, T = 12, B = 24;
  const pts = series[0].values.length;
  if (!pts) return '<p class="muted">Chưa có dữ liệu.</p>';
  const all = series.flatMap(s => s.values);
  let max = opts.max;
  if (!max) {
    const raw = Math.max(1, ...all) * 1.1 / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(v => v >= raw);
    max = step * 4;
  }
  const x = i => L + (pts === 1 ? 0 : i * (W - L - R) / (pts - 1));
  const y = v => T + (H - T - B) * (1 - v / max);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = max * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="mon-grid-line"/>
      <text x="${L - 6}" y="${y(v) + 3}" class="mon-axis" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');
  const every = Math.max(1, Math.ceil(pts / 5));
  const labels = opts.times.map((t, i) => (i % every === 0 || i === pts - 1)
    ? `<text x="${x(i)}" y="${H - 6}" class="mon-axis" text-anchor="${i === pts - 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${t}</text>` : '').join('');
  const lines = series.map(s => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${d}L${x(pts - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    return `<path d="${area}" fill="${s.color}" opacity="0.10"/><path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`
      + s.values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${opts.threshold && v > opts.threshold ? 3.6 : pts > 24 ? 1.4 : 2.2}" fill="${opts.threshold && v > opts.threshold ? '#f87171' : s.color}"><title>${opts.times[i]} · ${s.name}: ${v}${opts.unit}</title></circle>`).join('');
  }).join('');
  const thr = opts.threshold
    ? `<line x1="${L}" x2="${W - R}" y1="${y(opts.threshold)}" y2="${y(opts.threshold)}" class="mon-threshold"/>
       <text x="${W - R}" y="${y(opts.threshold) - 4}" class="mon-threshold-label" text-anchor="end">Alarm ${opts.threshold}${opts.unit}</text>` : '';
  const legend = series.length > 1
    ? `<div class="mon-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="mon-svg" role="img" aria-label="${esc(opts.label)}">${grid}${labels}${lines}${thr}</svg>${legend}`;
}

async function loadMetrics() {
  let data;
  try {
    data = await apiRequest(`/metrics/instances/${encodeURIComponent(det.id)}?hours=${det.monHours || 1}`);
  } catch (err) {
    ['chartCpu', 'chartRam', 'chartNet', 'chartDisk'].forEach(id => setHtml(id, '<p class="muted">Không tải được chỉ số.</p>'));
    return;
  }
  const ts = (Array.isArray(data) ? data : (data && data.timeSeries) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  const stopped = !isRunningStatus(det.inst.status) && det.inst.status !== 'MIGRATING';
  const val = k => ts.map(p => stopped ? 0 : Number(p[k]) || 0);
  const times = ts.map(p => new Date(p.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }));
  const hours = det.monHours || 1;
  setText('monTitle', `Chỉ số ${hours} giờ qua`);
  setText('monPeriod', hours >= 12 ? '15 phút' : '5 phút');
  const last = arr => arr.length ? arr[arr.length - 1] : 0;
  const cpu = val('cpuUsage'), ram = val('ramUsage'), nin = val('networkIn'), nout = val('networkOut'), disk = val('diskIo');
  setHtml('chartCpu', svgChart([{ name: 'CPU', values: cpu, color: '#22d3ee' }], { max: 100, unit: '%', times, label: 'CPU utilization', threshold: CPU_ALARM }));
  renderCpuAlarm(cpu, ts, stopped);
  setHtml('chartRam', svgChart([{ name: 'RAM', values: ram, color: '#a78bfa' }], { max: 100, unit: '%', times, label: 'Memory utilization' }));
  setHtml('chartNet', svgChart([{ name: 'In', values: nin, color: '#34d399' }, { name: 'Out', values: nout, color: '#fbbf24' }], { unit: ' Mbps', times, label: 'Network' }));
  setHtml('chartDisk', svgChart([{ name: 'Disk', values: disk, color: '#f472b6' }], { unit: ' IOPS', times, label: 'Disk IO' }));
  setText('monCpuNow', last(cpu) + '%');
  setText('monRamNow', last(ram) + '%');
  setText('monNetNow', `${last(nin)} / ${last(nout)} Mbps`);
  setText('monDiskNow', last(disk) + ' IOPS');
  setText('monUpdated', new Date().toLocaleTimeString('vi-VN'));
}


// ---------------- Confirm dialog (thay cho confirm() của trình duyệt) ----------------
function confirmDialog({ title, message, confirmText = 'Xác nhận', cancelText = 'Hủy', danger = false, requireText = '' }) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmModal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmModal';
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'confirmTitle');
      overlay.setAttribute('aria-describedby', 'confirmMsg');
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="modal-card confirm-card ${danger ? 'is-danger' : ''}">
        <div class="confirm-head">
          <span class="confirm-icon" aria-hidden="true">${danger ? '!' : '?'}</span>
          <h2 class="modal-title" id="confirmTitle">${esc(title)}</h2>
        </div>
        <p class="modal-text" id="confirmMsg">${message}</p>
        ${requireText ? `
          <label class="confirm-require" for="confirmInput">Gõ <code>${esc(requireText)}</code> để xác nhận</label>
          <input id="confirmInput" class="form-input" autocomplete="off" spellcheck="false">` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>
        </div>
      </div>`;
    const okBtn = overlay.querySelector('[data-act="ok"]');
    const input = overlay.querySelector('#confirmInput');
    const last = document.activeElement;
    const finish = val => {
      overlay.classList.remove('active');
      document.removeEventListener('keydown', onKey, true);
      overlay.onclick = null;
      if (last && last.focus) last.focus();
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      if (e.key === 'Enter' && !okBtn.disabled && document.activeElement !== overlay.querySelector('[data-act="cancel"]')) { e.preventDefault(); finish(true); }
    };
    overlay.onclick = e => {
      if (e.target === overlay) return finish(false);
      const act = e.target.closest('[data-act]');
      if (act) finish(act.dataset.act === 'ok');
    };
    if (input) input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== requireText; });
    document.addEventListener('keydown', onKey, true);
    overlay.classList.add('active');
    setTimeout(() => (input || overlay.querySelector('[data-act="cancel"]')).focus(), 30);
  });
}


// ---------------- Instance state & Actions dropdowns ----------------
function toggleStateMenu(force) {
  const list = document.getElementById('stateMenuList');
  const btn = document.getElementById('stateMenuBtn');
  if (!list || !btn) return;
  const open = force !== undefined ? force : list.hidden;
  if (open) closeEc2ActionsMenu();
  list.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const first = list.querySelector('.state-menu-item:not([disabled])');
    if (first) first.focus();
  }
}

function closeStateMenu() { toggleStateMenu(false); }

function toggleEc2ActionsMenu(force) {
  const list = document.getElementById('ec2ActionsList');
  const btn = document.getElementById('ec2ActionsBtn');
  if (!list || !btn) return;
  const open = force !== undefined ? force : list.hidden;
  if (open) closeStateMenu();
  list.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeEc2ActionsMenu() { toggleEc2ActionsMenu(false); }

document.addEventListener('click', e => {
  if (!e.target.closest('#stateMenu')) closeStateMenu();
  if (!e.target.closest('#ec2ActionsMenu')) closeEc2ActionsMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeEc2ActionsMenu();
  }
  const list = document.getElementById('stateMenuList');
  if (!list || list.hidden) return;
  if (e.key === 'Escape') { closeStateMenu(); document.getElementById('stateMenuBtn').focus(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...list.querySelectorAll('.state-menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    if (items[next]) items[next].focus();
  }
});


// ---------------- Monitoring: range, auto refresh, CPU alarm ----------------
const CPU_ALARM = 80;

function renderCpuAlarm(cpu, ts, stopped) {
  const el = document.getElementById('cpuAlarmState');
  const bar = document.getElementById('cpuAlarm');
  if (!el || !bar) return;
  setText('cpuAlarmThreshold', CPU_ALARM);
  let state = 'OK';
  if (stopped || !cpu.length) state = 'INSUFFICIENT_DATA';
  else if (cpu[cpu.length - 1] > CPU_ALARM) state = 'ALARM';
  el.textContent = state === 'INSUFFICIENT_DATA' ? 'Insufficient data' : state === 'ALARM' ? 'In alarm' : 'OK';
  bar.dataset.state = state;
  const breaches = cpu.map((v, i) => ({ v, t: ts[i] && ts[i].timestamp })).filter(p => p.v > CPU_ALARM);
  setText('cpuAlarmNote', stopped
    ? 'Máy không chạy nên không có dữ liệu.'
    : breaches.length
      ? `${breaches.length} lần vượt ngưỡng, gần nhất lúc ${new Date(breaches[breaches.length - 1].t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}.`
      : 'Không lần nào vượt ngưỡng trong khoảng này.');
}

function scheduleMetricsRefresh(tab) {
  clearInterval(det.monTimer);
  det.monTimer = null;
  const auto = document.getElementById('monAuto');
  if (tab === 'monitoring' && auto && auto.checked) {
    det.monTimer = setInterval(() => { if (!document.hidden) loadMetrics(); }, 60000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.seg-btn[data-hours]').forEach(b => b.addEventListener('click', () => {
    det.monHours = Number(b.dataset.hours);
    document.querySelectorAll('.seg-btn[data-hours]').forEach(x => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    loadMetrics();
  }));
  const auto = document.getElementById('monAuto');
  if (auto) auto.addEventListener('change', () => scheduleMetricsRefresh((location.hash || '').replace('#', '')));
});
