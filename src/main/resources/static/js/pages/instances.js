// Trang danh sách máy ảo (instances.html) - Tạ Duy Anh
// Chuẩn hóa giao diện AWS EC2 Console, hỗ trợ Multi-instance selection & Bottom Split-Pane Drawer.

// 1. Đăng ký từ điển song ngữ trang Instances
registerI18n({
  instBreadcrumb: ['Máy ảo', 'Instances'],
  instKpiTotal: ['Tổng số máy ảo', 'Total Instances'],
  instKpiRunning: ['Đang chạy', 'Running Instances'],
  instKpiStopped: ['Đã dừng', 'Stopped Instances'],
  instKpiPending: ['Đang chuyển tiếp', 'Pending / Transitioning'],
  instSearchPlaceholder: ['Tìm kiếm theo ID, Name, IP...', 'Search by ID, Name, IP...'],
  instFilterAll: ['Tất cả trạng thái', 'All instance states'],
  instColName: ['Tên máy ảo', 'Name'],
  instColId: ['Mã máy ảo (ID)', 'Instance ID'],
  instColState: ['Trạng thái', 'Instance state'],
  instColType: ['Loại máy ảo', 'Instance type'],
  instColRegion: ['Vùng', 'Region'],
  instColPublicIp: ['Public IPv4', 'Public IPv4'],
  instColPrivateIp: ['Private IP', 'Private IP'],
  instColSecurityGroup: ['Nhóm bảo mật', 'Security group'],
  instColKeyName: ['Cặp khóa', 'Key pair'],
  instColDetail: ['Chi tiết', 'Details'],
  instViewDetail: ['Xem chi tiết', 'View details'],
  instMigrateBtn: ['Chuyển vùng', 'Migrate'],
  instMigrateTitle: ['Fast Migrate X-Region: chuyển máy đang chọn sang vùng còn lại', 'Fast Migrate X-Region: move the selected instance to the other region'],
  instLoading: ['Đang tải danh sách máy ảo...', 'Loading instances...'],
  instEmpty: ['Không tìm thấy máy ảo nào phù hợp bộ lọc.', 'No instances matching filter.'],
  instSelectedCount: ['máy ảo đã chọn', 'instances selected'],
  instConnectTitle: ['Kết nối tới máy ảo qua SSH', 'Connect to instance via SSH'],
  instConnectHelp: ['Sử dụng SSH client từ máy tính cá nhân để kết nối tới máy ảo:', 'Use SSH client from your terminal to connect to this instance:'],
  instConnectCommand: ['Lệnh SSH:', 'SSH Command:'],
  instActionEdit: ['Chỉnh sửa cấu hình máy ảo', 'Edit instance settings'],
  instActionMigrate: ['Chuyển vùng tức thì (Fast Migrate)', 'Fast Migrate X-Region'],
  actClose: ['Đóng', 'Close'],
  actViewDetails: ['Xem chi tiết', 'View full details'],
  // Cùng tên với menu "Trạng thái máy ảo" ở trang chi tiết
  instMenuStart: ['Khởi động máy ảo', 'Start instance'],
  instMenuStop: ['Dừng máy ảo', 'Stop instance'],
  instMenuReboot: ['Khởi động lại máy ảo', 'Reboot instance'],
  instMenuTerminate: ['Xóa máy ảo', 'Terminate instance']
});

let cachedInstances = [];
let cachedGroups = new Map(); // groupId -> nhóm (để hiện tên Security Group)
let cachedImages = new Map(); // imageId -> thông tin image từ /api/images
let selectedInstanceIds = new Set();
let statePollingInterval = null;
let currentSplitTab = 'tabDetails';

function notifyLaunchStatus(instances) {
  const id = sessionStorage.getItem('xregion_pending_launch');
  const instance = id && instances.find(i => i.id === id);
  if (!instance) return;
  if (instance.status === 'RUNNING' && instance.activeNovaId) {
    showToast(t(`Máy ảo [${instance.name}] đã sẵn sàng.`, `Instance [${instance.name}] is ready.`), 'success');
    sessionStorage.removeItem('xregion_pending_launch');
  } else if (instance.status === 'FAILED') {
    showToast(t('Tạo máy ảo thất bại: ', 'Launch failed: ') +
      (instance.errorMessage || instance.errorCode || instance.id), 'error');
    sessionStorage.removeItem('xregion_pending_launch');
  }
}

// 2. Cập nhật các thẻ KPI trên đầu trang
function updateInstancesKPIs() {
  const elTotal = document.getElementById('statTotalInstances');
  const elRegA = document.getElementById('statRegionACount');
  const elRun = document.getElementById('statRunningInstances');
  const elStop = document.getElementById('statStoppedInstances');
  const elPending = document.getElementById('statPendingInstances');
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

  if (elTotal) elTotal.textContent = total;
  if (elRegA) elRegA.textContent = `${total} ` + t('máy ảo trên mọi vùng', 'across regions');
  if (elRun) elRun.textContent = running;
  if (elStop) elStop.textContent = stopped;
  if (elPending) elPending.textContent = pendingOrTransition;
  if (elBadge) elBadge.textContent = `(${total})`;
}

// 3. Polling tự động khi có máy ảo đang trong trạng thái chuyển tiếp
function checkAndTriggerStatePolling() {
  const hasTransitioningInstance = cachedInstances.some(inst => {
    const config = getStatusBadgeConfig(inst.status);
    return config.isTransitioning;
  });

  if (hasTransitioningInstance) {
    if (!statePollingInterval) {
      statePollingInterval = setInterval(async () => {
        try {
          const instances = await apiRequest('/instances');
          cachedInstances = instances || [];
          notifyLaunchStatus(cachedInstances);
          updateInstancesKPIs();
          filterInstancesUI();

          const stillTransitioning = cachedInstances.some(i => getStatusBadgeConfig(i.status).isTransitioning);
          if (!stillTransitioning) {
            clearInterval(statePollingInterval);
            statePollingInterval = null;
          }
        } catch (e) {
          console.error('State polling error:', e);
        }
      }, 2500);
    }
  } else {
    if (statePollingInterval) {
      clearInterval(statePollingInterval);
      statePollingInterval = null;
    }
  }
}

// 4. Tải danh sách máy ảo từ API
async function loadInstances() {
  const tbody = document.getElementById('instanceTableBody');
  const btnRefresh = document.getElementById('btnRefreshInstances');

  if (btnRefresh) {
    const icon = btnRefresh.querySelector('svg');
    if (icon) icon.classList.add('ico-spin');
  }

  try {
    // Lấy nhóm trước: server tạo nhóm riêng <tên-máy>-sg cho máy nào chưa có, rồi danh sách máy mới trả đúng mã nhóm
    const groups = await apiRequest('/network/security-groups').catch(() => null);
    if (groups) {
      cachedGroups = new Map(groups.map(g => [g.groupId, g]));
      // Nhóm riêng của từng máy (server trả instanceId), vì bảng Instances không còn lưu mã nhóm
      groups.filter(g => g.instanceId).forEach(g => cachedGroups.set(`inst:${g.instanceId}`, g));
    }
    const images = await apiRequest('/images').catch(() => null);
    if (images && images.length) {
      cachedImages = new Map(images.map(img => [img.id, img]));
      images.filter(img => img.glanceId).forEach(img => cachedImages.set(img.glanceId, img));
    }
    const instances = await apiRequest('/instances');
    cachedInstances = instances || [];
    notifyLaunchStatus(cachedInstances);
    // Loại bỏ các ID không còn tồn tại khỏi selectedInstanceIds
    const currentIds = new Set(cachedInstances.map(i => i.id));
    selectedInstanceIds.forEach(id => {
      if (!currentIds.has(id)) selectedInstanceIds.delete(id);
    });

    updateInstancesKPIs();
    filterInstancesUI();
    updateSelectionToolbar();
    checkAndTriggerStatePolling();
  } catch (err) {
    console.error('Failed to load instances from API:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align:center; padding: 36px 20px; background: rgba(239, 68, 68, 0.05); border-radius: 8px;">
            <div style="margin-bottom: 8px;">${ICON('ui-error', 'ico-xl ico-danger')}</div>
            <div style="font-size: 15px; font-weight: 700; color: #f87171; margin-bottom: 6px;">
              ${t('Không thể tải danh sách máy ảo từ API (GET /api/instances)', 'Failed to load instances from API (GET /api/instances)')}
            </div>
            <div style="font-size: 13px; color: #cbd5e1; max-width: 680px; margin: 0 auto; line-height: 1.5; font-family: monospace; word-break: break-all;">
              ${err.message || 'Lỗi kết nối máy chủ hoặc DynamoDB'}
            </div>
            <div style="margin-top: 14px;">
              <button class="btn btn-secondary btn-sm" onclick="loadInstances()">${t('Thử lại (Retry)', 'Retry')}</button>
            </div>
          </td>
        </tr>
      `;
    }
  } finally {
    if (btnRefresh) {
      const icon = btnRefresh.querySelector('svg');
      if (icon) icon.classList.remove('ico-spin');
    }
  }
}

// 5. Lọc và render bảng dữ liệu máy ảo
function filterInstancesUI() {
  const tbody = document.getElementById('instanceTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = (document.getElementById('instanceSearchInput')?.value || '').trim().toLowerCase();
  const filtered = cachedInstances.filter(inst => {
    const matchText = !q || (inst.name || '').toLowerCase().includes(q) || (inst.id || '').toLowerCase().includes(q) || (inst.publicIp || '').includes(q) || (inst.privateIp || '').includes(q);
    return matchText;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center; padding: 36px; color: var(--text-muted);">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
            ${ICON('ui-search', 'ico-lg ico-muted')}
            <span>${tk('instEmpty', 'Không tìm thấy máy ảo nào phù hợp bộ lọc.')}</span>
          </div>
        </td>
      </tr>
    `;
    updateMasterCheckbox(0, 0);
    return;
  }

  filtered.forEach(inst => {
    const cfg = getStatusBadgeConfig(inst.status);
    const isSelected = selectedInstanceIds.has(inst.id);
    const isTrans = cfg.isTransitioning;

    const tr = document.createElement('tr');
    tr.id = `row-${inst.id}`;
    if (isSelected) tr.classList.add('row-selected');


    tr.innerHTML = `
      <td style="text-align: center;" onclick="event.stopPropagation()">
        <input type="checkbox" class="row-checkbox" value="${inst.id}" ${isSelected ? 'checked' : ''} onchange="toggleRowSelect('${inst.id}', this.checked)">
      </td>
      <td>
        <strong style="color: #fff; cursor: pointer;" onclick="quickSelectOne('${inst.id}')">${inst.name}</strong>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 6px;">
          <a href="/instance-detail.html?id=${encodeURIComponent(inst.id)}" style="font-family: monospace; color: var(--accent-cyan); font-weight: 700; text-decoration: none; white-space: nowrap;" title="${t('Xem chi tiết', 'View details')}">
            ${inst.id}
          </a>
          <button class="btn btn-secondary btn-sm" style="padding: 2px 6px; font-size: 11px;" onclick="copyToClipboard('${inst.id}', 'Instance ID')" title="Copy ID">
            ${ICON('ui-copy', 'ico-xs')}
          </button>
        </div>
      </td>
      <td>
        ${instanceStateBadge(inst.status)}
      </td>
      <td><span class="badge" style="background:#1e293b; color:#94a3b8; font-family:monospace; text-transform: none; letter-spacing: 0;">${inst.flavor}</span></td>
      <td><span style="font-size:12px; color:#cbd5e1;">${inst.regionName || inst.region}</span></td>
      <td><code style="color: var(--accent-cyan);">${inst.publicIp || '--'}</code></td>
      <td><code>${inst.privateIp || '--'}</code></td>
      <td>
        <span class="badge" style="background:rgba(16, 185, 129, 0.15); color:#34d399; font-family:monospace; display: inline-flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; white-space: nowrap;">
          ${ICON('svc-key-pair', 'ico-xs')}
          <span>${inst.keyName || 'xregion-key'}</span>
        </span>
      </td>
      <td class="inst-detail-cell">
        <a class="btn btn-secondary btn-sm inst-detail-btn" href="/instance-detail.html?id=${encodeURIComponent(inst.id)}"
          onclick="event.stopPropagation()" title="${tk('instViewDetail')}">
          <span>${tk('instViewDetail')}</span>${ICON('ui-chevron-right', 'ico-xs')}
        </a>
      </td>
    `;

    // Click vào cả dòng sẽ kích hoạt chọn
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input')) return;
      quickSelectOne(inst.id);
    });

    tbody.appendChild(tr);
  });

  const selectedInFiltered = filtered.filter(i => selectedInstanceIds.has(i.id)).length;
  updateMasterCheckbox(selectedInFiltered, filtered.length);
}

// Badge trạng thái giống trang chi tiết và trang chủ: class ec2-state (status-badges.css) + nhãn i18n dùng chung st*
const INSTANCE_STATE_UI = {
  RUNNING: ['state-running', 'stRunning'], ACTIVE: ['state-running', 'stRunning'],
  STOPPED: ['state-stopped', 'stStopped'], SHUTOFF: ['state-stopped', 'stStopped'],
  PENDING: ['state-pending', 'stPending'], STOPPING: ['state-stopping', 'stStopping'],
  REBOOTING: ['state-rebooting', 'stRebooting'], SHUTTING_DOWN: ['state-shutting-down', 'stShuttingDown'],
  TERMINATING: ['state-shutting-down', 'stShuttingDown'], TERMINATED: ['state-terminated', 'stTerminated'],
  MIGRATING: ['state-migrating', 'stMigrating']
};

function instanceStateBadge(status) {
  const key = String(status || '').toUpperCase();
  const [cls, label] = INSTANCE_STATE_UI[key] || ['state-error', ''];
  const spin = getStatusBadgeConfig(status).isTransitioning ? ICON('ui-spinner', 'ico-xs ico-spin') + ' ' : '';
  return `<span class="ec2-state ${cls}" style="white-space: nowrap;">${spin}${label ? tk(label) : (status || 'unknown')}</span>`;
}

function renderSecurityGroupBadge(sgString, instanceId) {
  const own = instanceId ? cachedGroups.get(`inst:${instanceId}`) : null;
  const sgs = own ? [own.groupId] : String(sgString || 'sg-default').split(',').map(x => x.trim()).filter(Boolean);
  const first = sgs[0] || 'sg-default';
  const extra = sgs.length > 1 ? ` +${sgs.length - 1}` : '';
  // Hiện tên nhóm (vd. web-sg) như cột "Security group name" của EC2, mã nhóm để ở tooltip
  const g = cachedGroups.get(first);
  const label = g ? g.name : first;
  const title = sgs.map(id => (cachedGroups.get(id) ? `${id} (${cachedGroups.get(id).name})` : id)).join(', ');
  return `<span class="badge" style="background:#1e293b; color:#38bdf8; font-family:monospace; display: inline-flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; white-space: nowrap;" title="${splitEsc(title)}">
    ${ICON('svc-security-group', 'ico-xs')}
    <span>${splitEsc(label)}${extra}</span>
  </span>`;
}

// 6. Xử lý Multi-instance Selection
function toggleSelectAll(checked) {
  const checkboxes = document.querySelectorAll('#instanceTableBody .row-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = checked;
    if (checked) {
      selectedInstanceIds.add(cb.value);
    } else {
      selectedInstanceIds.delete(cb.value);
    }
    const row = document.getElementById(`row-${cb.value}`);
    if (row) row.classList.toggle('row-selected', checked);
  });

  updateSelectionToolbar();
  updateSplitPane();
}

function toggleRowSelect(id, checked) {
  if (checked) {
    selectedInstanceIds.add(id);
  } else {
    selectedInstanceIds.delete(id);
  }

  const row = document.getElementById(`row-${id}`);
  if (row) row.classList.toggle('row-selected', checked);

  const checkboxes = document.querySelectorAll('#instanceTableBody .row-checkbox');
  const checkedBoxes = document.querySelectorAll('#instanceTableBody .row-checkbox:checked');
  updateMasterCheckbox(checkedBoxes.length, checkboxes.length);

  updateSelectionToolbar();
  updateSplitPane();
}

function quickSelectOne(id) {
  // Khi người dùng click vào dòng, toggle chọn riêng máy đó để xem split-pane
  if (selectedInstanceIds.has(id) && selectedInstanceIds.size === 1) {
    selectedInstanceIds.clear();
  } else {
    selectedInstanceIds.clear();
    selectedInstanceIds.add(id);
  }

  document.querySelectorAll('#instanceTableBody .row-checkbox').forEach(cb => {
    cb.checked = selectedInstanceIds.has(cb.value);
    const row = document.getElementById(`row-${cb.value}`);
    if (row) row.classList.toggle('row-selected', cb.checked);
  });

  const checkboxes = document.querySelectorAll('#instanceTableBody .row-checkbox');
  const checkedBoxes = document.querySelectorAll('#instanceTableBody .row-checkbox:checked');
  updateMasterCheckbox(checkedBoxes.length, checkboxes.length);

  updateSelectionToolbar();
  updateSplitPane();
}

function updateMasterCheckbox(selectedCount, totalCount) {
  const master = document.getElementById('masterCheckbox');
  if (!master) return;
  if (totalCount === 0) {
    master.checked = false;
    master.indeterminate = false;
  } else if (selectedCount === totalCount) {
    master.checked = true;
    master.indeterminate = false;
  } else if (selectedCount > 0) {
    master.checked = false;
    master.indeterminate = true;
  } else {
    master.checked = false;
    master.indeterminate = false;
  }
}

function updateSelectionToolbar() {
  const count = selectedInstanceIds.size;
  const banner = document.getElementById('selectionBanner');
  const text = document.getElementById('selectionText');
  const btnConnect = document.getElementById('btnConnectInstance');
  const btnState = document.getElementById('btnInstanceStateMenu');
  const btnActions = document.getElementById('btnActionsMenu');

  if (count > 0) {
    if (banner) banner.classList.add('active');
    if (text) text.textContent = `${count} ` + t(tk('instSelectedCount'), 'selected');
  } else {
    if (banner) banner.classList.remove('active');
  }

  // Nút Connect & Actions sáng khi chọn đúng 1 máy ảo
  if (btnConnect) btnConnect.disabled = (count !== 1);
  if (btnActions) btnActions.disabled = (count !== 1);

  // Nút Chuyển vùng: đúng 1 máy, đang Running/Stopped và không bị migration_lock (giống điều kiện ở trang chi tiết)
  const btnMigrate = document.getElementById('btnMigrateInstance');
  if (btnMigrate) {
    const one = count === 1 ? cachedInstances.find(i => i.id === Array.from(selectedInstanceIds)[0]) : null;
    const st = one ? String(one.status || '').toUpperCase() : '';
    let why = '';
    if (count !== 1) why = t('Chọn đúng 1 máy ảo để chuyển vùng', 'Select exactly one instance to migrate');
    else if (one && one.migrationLock) why = t('Máy đang có một lần chuyển vùng chạy', 'A migration is already running for this instance');
    else if (!['RUNNING', 'ACTIVE', 'STOPPED', 'SHUTOFF'].includes(st)) why = t('Chỉ chuyển vùng được khi máy đang chạy hoặc đã dừng', 'Only running or stopped instances can be migrated');
    btnMigrate.disabled = !!why;
    btnMigrate.title = why || tk('instMigrateTitle');
  }

  // Nút Instance State chỉ sáng khi chọn đúng 1 máy ảo; vô hiệu hóa khi chọn 0 hoặc >= 2 máy ảo
  if (btnState) {
    btnState.disabled = (count !== 1);
    if (count >= 2) {
      btnState.title = t('Chỉ có thể thay đổi trạng thái khi chọn đúng 1 máy ảo', 'State changes are only supported for a single selected instance');
      closeAllDropdowns();
    } else {
      btnState.title = count === 0 ? t('Chọn một máy ảo', 'Select an instance') : '';
    }
  }
  updateStateMenuItems();
}

// Máy nào được Start / Stop / Reboot / Terminate (giống trang chi tiết: máy đang chạy thì khóa Start...)
const ACTION_ALLOWED_FROM = {
  START: ['STOPPED', 'SHUTOFF'],
  STOP: ['RUNNING', 'ACTIVE'],
  REBOOT: ['RUNNING', 'ACTIVE'],
  TERMINATE: ['RUNNING', 'ACTIVE', 'STOPPED', 'SHUTOFF', 'ERROR']
};

function selectedInstancesFor(action) {
  const allowed = ACTION_ALLOWED_FROM[action] || [];
  return Array.from(selectedInstanceIds)
    .map(id => cachedInstances.find(i => i.id === id))
    .filter(i => i && allowed.includes(String(i.status || '').toUpperCase()));
}

function actionDisabledReason(action) {
  if (selectedInstanceIds.size === 0) return t('Chọn ít nhất một máy ảo', 'Select at least one instance');
  if (selectedInstancesFor(action).length > 0) return '';
  return {
    START: t('Các máy đã chọn đang chạy hoặc đang chuyển trạng thái', 'The selected instances are already running or changing state'),
    STOP: t('Các máy đã chọn đã dừng hoặc đang chuyển trạng thái', 'The selected instances are already stopped or changing state'),
    REBOOT: t('Chỉ reboot được máy đang chạy', 'Only running instances can be rebooted'),
    TERMINATE: t('Các máy đã chọn đang chuyển trạng thái hoặc đã xóa', 'The selected instances are changing state or terminated')
  }[action];
}

// Khóa / mở từng mục trong menu "Trạng thái máy ảo" và các nút trong khung chọn nhiều máy
function updateStateMenuItems() {
  document.querySelectorAll('#instanceStateDropdown [onclick^="handleBulkAction"], #splitBulkSummary [onclick^="handleBulkAction"]').forEach(btn => {
    const action = (btn.getAttribute('onclick').match(/'([A-Z]+)'/) || [])[1];
    const reason = actionDisabledReason(action);
    btn.disabled = !!reason;
    btn.title = reason || '';
  });
}

// 7. Thao tác hàng loạt (Bulk Actions)
async function handleBulkAction(action) {
  closeAllDropdowns();
  // Chỉ gửi lệnh cho máy đang ở trạng thái hợp lệ; máy khác bỏ qua và báo lại
  const eligible = selectedInstancesFor(action);
  const skipped = selectedInstanceIds.size - eligible.length;
  if (eligible.length === 0) {
    showToast(actionDisabledReason(action), 'error');
    return;
  }
  if (skipped > 0) {
    showToast(t(`Bỏ qua ${skipped} máy không ở trạng thái phù hợp`, `Skipping ${skipped} instance(s) in an incompatible state`), 'info');
  }
  const ids = eligible.map(i => i.id);

  const actionNameMap = {
    'START': t('Khởi động', 'Start'),
    'STOP': t('Dừng', 'Stop'),
    'REBOOT': t('Khởi động lại', 'Reboot'),
    'TERMINATE': t('Xóa', 'Terminate')
  };
  const actionLabel = actionNameMap[action] || action;

  // Xác nhận bằng hộp thoại chung confirmDialog() (js/core/ui.js), giống trang chi tiết máy ảo
  if (action === 'TERMINATE' || action === 'STOP') {
    const picked = ids.map(id => (typeof cachedInstances !== 'undefined' && cachedInstances.find(i => i.id === id)) || { id, name: id });
    const list = picked.map(i => `<strong>${uiEsc(i.name)}</strong> (<code>${uiEsc(i.id)}</code>)`).join(', ');
    const single = picked.length === 1;
    const ok = action === 'TERMINATE'
      ? await confirmDialog({
          title: single ? t('Xóa (terminate) máy ảo?', 'Terminate instance?') : t(`Xóa (terminate) ${picked.length} máy ảo?`, `Terminate ${picked.length} instances?`),
          message: t(`${list} sẽ bị xóa vĩnh viễn. Ổ EBS gốc bị xóa, Elastic IP được trả lại và bản ghi Route 53 ngừng trỏ tới máy. Không thể hoàn tác.`,
                     `${list} will be permanently deleted. The root EBS volume is deleted, the Elastic IP is released and the Route 53 record stops pointing to it. This cannot be undone.`),
          confirmText: tk('actTerminate'),
          danger: true,
          requireText: single ? picked[0].name : 'terminate'
        })
      : await confirmDialog({
          title: single ? t('Dừng máy ảo?', 'Stop instance?') : t(`Dừng ${picked.length} máy ảo?`, `Stop ${picked.length} instances?`),
          message: t(`Dịch vụ trên ${list} sẽ gián đoạn tới khi bật lại. Dữ liệu trên ổ EBS được giữ nguyên.`,
                     `Services on ${list} are unavailable until started again. Data on the EBS volume is kept.`),
          confirmText: tk('actStop'),
          danger: true
        });
    if (!ok) return;
  }

  showToast(t(`Đang gửi yêu cầu ${actionLabel} cho ${ids.length} máy ảo...`, `Submitting ${actionLabel} for ${ids.length} instance(s)...`), 'info');

  const promises = ids.map(id => apiRequest(`/instances/${id}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action })
  }).then(() => ({ id, ok: true })).catch(err => ({ id, ok: false, error: err.message })));

  const results = await Promise.allSettled(promises);
  let successCount = 0;
  let failCount = 0;

  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.ok) successCount++;
    else failCount++;
  });

  if (failCount === 0) {
    showToast(t(`Đã thực hiện ${actionLabel} thành công cho tất cả ${successCount} máy ảo!`, `Successfully performed ${actionLabel} for all ${successCount} instance(s)!`), 'success');
  } else {
    showToast(t(`Thực hiện ${actionLabel}: ${successCount} thành công, ${failCount} thất bại.`, `${actionLabel} completed: ${successCount} succeeded, ${failCount} failed.`), 'warning');
  }

  // Tải lại danh sách sau khi thao tác
  loadInstances();
}

// 8. Bottom Split-Pane Drawer
function updateSplitPane() {
  const drawer = document.getElementById('instanceSplitPane');
  if (!drawer) return;

  const count = selectedInstanceIds.size;
  // Chỉ hiển thị panel Split Pane khi chọn đúng 1 máy; đóng khi chọn 0 hoặc từ 2 máy trở lên
  if (count !== 1) {
    drawer.classList.remove('active');
    return;
  }

  drawer.classList.add('active');

  const tabsBar = document.getElementById('splitTabsBar');
  const bulkPane = document.getElementById('paneTabBulk');
  const normalPanes = ['paneTabDetails', 'paneTabSecurity', 'paneTabNetworking', 'paneTabStorage'];

  if (count === 1) {
    // 1 máy ảo -> Hiển thị các tab chi tiết chuẩn
    const id = Array.from(selectedInstanceIds)[0];
    const inst = cachedInstances.find(i => i.id === id);
    if (!inst) return;

    if (tabsBar) tabsBar.style.display = 'flex';
    if (bulkPane) bulkPane.classList.remove('active');

    const titleEl = document.getElementById('splitPaneTitle');
    if (titleEl) titleEl.innerHTML = `${t('Tóm tắt máy ảo', 'Instance summary')} <code style="color: var(--accent-cyan); margin-left: 6px;">${inst.id}</code> (${inst.name})`;

    const linkEl = document.getElementById('splitPaneViewDetailLink');
    if (linkEl) {
      linkEl.href = `/instance-detail.html?id=${encodeURIComponent(inst.id)}`;
      linkEl.style.display = 'inline-flex';
    }

    renderSplitDetailsTab(inst);
    renderSplitSecurityTab(inst);
    renderSplitNetworkingTab(inst);
    renderSplitStorageTab(inst);

    // Kích hoạt tab hiện tại
    switchSplitTab(currentSplitTab);
  } else {
    // Nhiều máy ảo -> Hiển thị panel tóm tắt thao tác hàng loạt
    if (tabsBar) tabsBar.style.display = 'none';
    normalPanes.forEach(p => {
      const el = document.getElementById(p);
      if (el) el.classList.remove('active');
    });
    if (bulkPane) bulkPane.classList.add('active');

    const titleEl = document.getElementById('splitPaneTitle');
    if (titleEl) titleEl.innerHTML = `${t('Thao tác hàng loạt', 'Bulk selection summary')} (${count} ` + t('máy ảo', 'instances') + ')';

    const linkEl = document.getElementById('splitPaneViewDetailLink');
    if (linkEl) linkEl.style.display = 'none';

    renderSplitBulkSummary(count);
  }
}

// Khung tóm tắt dưới bảng: cùng nhãn và cùng nguồn dữ liệu với trang chi tiết (instance-detail.html)
function splitEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function splitKv(label, valueHtml) {
  return `<div class="split-kv-item"><div class="split-kv-label">${label}</div><div class="split-kv-value">${valueHtml}</div></div>`;
}

function splitRegion(inst) {
  const name = String(inst.regionName || '').replace(/\s*\(Region [AB]\)\s*/, '') || inst.region || '–';
  return `${splitEsc(name)} <code style="color: var(--text-muted);">${splitEsc(inst.region || '')}</code>`;
}

function renderSplitDetailsTab(inst) {
  const grid = document.getElementById('splitDetailsGrid');
  if (!grid) return;
  const spec = (typeof FLAVOR_SPECS !== 'undefined' && FLAVOR_SPECS[inst.flavor]) || null;
  const imgInfo = resolveInstanceImageInfo(inst);
  grid.innerHTML = [
    splitKv('Instance ID', `<code style="color: var(--accent-cyan); font-weight: 700;">${splitEsc(inst.id)}</code>`),
    splitKv(t('Tên máy ảo', 'Instance name'), `<strong>${splitEsc(inst.name)}</strong>`),
    splitKv(t('Trạng thái máy ảo', 'Instance state'), instanceStateBadge(inst.status)),
    splitKv(t('Loại máy ảo', 'Instance type'), `<code>${splitEsc(inst.flavor || '–')}</code>${spec ? ` · ${spec.vcpu} vCPU` : ''}`),
    splitKv('Region', splitRegion(inst)),
    splitKv('AMI', splitEsc(imgInfo.imageName || inst.imageName || inst.image || '–'))
  ].join('');
}

function renderSplitSecurityTab(inst) {
  const grid = document.getElementById('splitSecurityGrid');
  if (!grid) return;
  grid.innerHTML = [
    splitKv('Security group', `<span id="splitSgName">${renderSecurityGroupBadge(inst.securityGroup, inst.id)}</span>`),
    splitKv('Key pair', `<code>${splitEsc(inst.keyName || '–')}</code>`),
    splitKv('Inbound rules', `<span id="splitInboundRules" class="muted">${t('Đang tải…', 'Loading…')}</span>`)
  ].join('');
  // Rule thật của Security Group riêng của máy (giống tab Security ở trang chi tiết)
  apiRequest(`/network/security-groups?instanceId=${encodeURIComponent(inst.id)}`).then(groups => {
    const el = document.getElementById('splitInboundRules');
    if (!el) return;
    const rules = (groups || []).flatMap(g => g.inboundRules || []);
    const sgEl = document.getElementById('splitSgName');
    if (sgEl && groups && groups.length) {
      sgEl.innerHTML = groups.map(g => `<code>${splitEsc(g.groupId)}</code> (${splitEsc(g.name)})`).join('<br>');
    }
    const port = r => (r.protocol === 'all' || r.protocol === 'icmp') ? 'All' : (r.fromPort === r.toPort ? r.fromPort : `${r.fromPort}-${r.toPort}`);
    el.className = '';
    el.innerHTML = rules.length
      ? rules.map(r => `<code>${splitEsc(String(r.protocol).toUpperCase())} ${splitEsc(port(r))}</code> ${t('từ', 'from')} <code>${splitEsc(r.cidr)}</code>`).join('<br>')
      : `<span class="muted">${t('Chưa có inbound rule nào', 'No inbound rules')}</span>`;
  }).catch(() => {
    const el = document.getElementById('splitInboundRules');
    if (el) el.textContent = t('Không tải được rule', 'Could not load rules');
  });
}

function renderSplitNetworkingTab(inst) {
  const grid = document.getElementById('splitNetworkingGrid');
  if (!grid) return;
  grid.innerHTML = [
    splitKv('Public IPv4 (Elastic IP)', `<code style="color: var(--accent-cyan);">${splitEsc(inst.publicIp || '–')}</code>`),
    splitKv('Private IPv4', `<code>${splitEsc(inst.privateIp || '–')}</code>`),
    splitKv('Public DNS (Route 53)', `<code>${splitEsc(inst.dnsDomain || '–')}</code>`),
    splitKv('Region', splitRegion(inst))
  ].join('');
}

function renderSplitStorageTab(inst) {
  const grid = document.getElementById('splitStorageGrid');
  if (!grid) return;
  const spec = (typeof FLAVOR_SPECS !== 'undefined' && FLAVOR_SPECS[inst.flavor]) || null;
  grid.innerHTML = [
    splitKv(t('Tên thiết bị gốc', 'Root device name'), '<code>/dev/vda</code>'),
    splitKv('Root EBS Volume', `<code>${splitEsc(inst.volumeId || inst.ebsVolumeId || `vol-${String(inst.id).replace('i-', '')}`)}</code>`),
    splitKv(t('Loại ổ đĩa', 'Volume type'), 'gp3 SSD'),
    splitKv(t('Dung lượng', 'Size'), `${splitEsc(inst.ebsSizeGb || (spec ? spec.defaultDisk : 10))} GB`)
  ].join('');
}

function renderSplitBulkSummary(count) {
  const pane = document.getElementById('splitBulkSummary');
  if (!pane) return;

  const ids = Array.from(selectedInstanceIds);
  const selectedInstances = cachedInstances.filter(i => selectedInstanceIds.has(i.id));
  const runningCount = selectedInstances.filter(i => (i.status || '').toUpperCase() === 'RUNNING').length;
  const stoppedCount = selectedInstances.filter(i => (i.status || '').toUpperCase() === 'STOPPED').length;

  pane.innerHTML = `
    <div>
      <div style="font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 4px;">
        ${t(`Đã chọn ${count} máy ảo:`, `${count} instances selected:`)}
      </div>
      <div style="font-size: 12.5px; color: var(--text-muted); line-height: 1.5;">
        ${t('Bao gồm:', 'Includes:')} <span style="color:#34d399; font-weight:600;">${runningCount} ${t('đang chạy', 'running')}</span>,
        <span style="color:#94a3b8; font-weight:600;">${stoppedCount} ${t('đã dừng', 'stopped')}</span>.<br>
        <code style="color: var(--accent-cyan); font-size: 12px;">${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ` (+${ids.length - 6} khác)` : ''}</code>
      </div>
    </div>
    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
      <button class="btn btn-secondary btn-sm" onclick="handleBulkAction('START')">
        ${ICON('ui-play', 'ico-xs')}
        <span>${t('Khởi động tất cả', 'Start all')}</span>
      </button>
      <button class="btn btn-secondary btn-sm" onclick="handleBulkAction('STOP')">
        ${ICON('ui-stop', 'ico-xs')}
        <span>${t('Dừng tất cả', 'Stop all')}</span>
      </button>
      <button class="btn btn-secondary btn-sm" onclick="handleBulkAction('REBOOT')">
        ${ICON('ui-reboot', 'ico-xs')}
        <span>${t('Reboot tất cả', 'Reboot all')}</span>
      </button>
    </div>
  `;
  updateStateMenuItems();
}

function closeSplitPane() {
  selectedInstanceIds.clear();
  document.querySelectorAll('#instanceTableBody .row-checkbox').forEach(cb => {
    cb.checked = false;
    const row = document.getElementById(`row-${cb.value}`);
    if (row) row.classList.remove('row-selected');
  });
  updateMasterCheckbox(0, 0);
  updateSelectionToolbar();
  const drawer = document.getElementById('instanceSplitPane');
  if (drawer) drawer.classList.remove('active');
}

function switchSplitTab(tabKey, ev) {
  currentSplitTab = tabKey;
  if (ev) ev.preventDefault();

  document.querySelectorAll('#splitTabsBar .split-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.split-tab-pane').forEach(pane => pane.classList.remove('active'));

  const activePane = document.getElementById('pane' + tabKey.charAt(0).toUpperCase() + tabKey.slice(1));
  if (activePane) activePane.classList.add('active');

  if (ev && ev.currentTarget) {
    ev.currentTarget.classList.add('active');
  } else {
    const btn = Array.from(document.querySelectorAll('#splitTabsBar .split-tab-btn')).find(b => b.getAttribute('onclick')?.includes(tabKey));
    if (btn) btn.classList.add('active');
  }
}

// 9. Dropdowns Menu trên Toolbar
function toggleStateDropdown(ev) {
  if (ev) ev.stopPropagation();
  const drop = document.getElementById('instanceStateDropdown');
  const actDrop = document.getElementById('actionsDropdown');
  if (actDrop) actDrop.classList.remove('show');
  updateStateMenuItems();
  if (drop) drop.classList.toggle('show');
}

function toggleActionsDropdown(ev) {
  if (ev) ev.stopPropagation();
  const drop = document.getElementById('actionsDropdown');
  const stateDrop = document.getElementById('instanceStateDropdown');
  if (stateDrop) stateDrop.classList.remove('show');
  if (!drop) return;
  // Cùng menu nhiều cấp với trang chi tiết (instance-actions-menu.js), thêm mục Fast Migrate vì trang này không có nút riêng
  const inst = cachedInstances.find(i => i.id === Array.from(selectedInstanceIds)[0]);
  if (inst && !drop.classList.contains('show')) {
    drop.innerHTML = ec2ActionsGroupsHtml(inst) + `
      <div class="ec2-actions-sep"></div>
      <a role="menuitem" class="ec2-actions-item" href="/instance-detail.html?id=${encodeURIComponent(inst.id)}#migration">
        ${ICON('ui-migrate', 'ico-sm')} Fast Migrate X-Region
      </a>`;
  }
  drop.classList.toggle('show');
}

function closeAllDropdowns() {
  const stateDrop = document.getElementById('instanceStateDropdown');
  const actDrop = document.getElementById('actionsDropdown');
  if (stateDrop) stateDrop.classList.remove('show');
  if (actDrop) actDrop.classList.remove('show');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.toolbar-dropdown')) {
    closeAllDropdowns();
  }
});

// 10. Actions Dropdown Callbacks
function viewSelectedInstanceDetail() {
  closeAllDropdowns();
  if (selectedInstanceIds.size !== 1) return;
  const id = Array.from(selectedInstanceIds)[0];
  window.location.href = `/instance-detail.html?id=${encodeURIComponent(id)}`;
}

function editSelectedInstance() {
  closeAllDropdowns();
  if (selectedInstanceIds.size !== 1) return;
  const id = Array.from(selectedInstanceIds)[0];
  window.location.href = `/instance-edit.html?id=${encodeURIComponent(id)}`;
}

function migrateSelectedInstance() {
  closeAllDropdowns();
  if (selectedInstanceIds.size !== 1) return;
  const id = Array.from(selectedInstanceIds)[0];
  window.location.href = `/instance-detail.html?id=${encodeURIComponent(id)}&action=migrate`;
}

// 11. Connect SSH Modal
// Hộp Kết nối: tự động nhận diện username chuẩn theo image OpenStack Glance / Cloud
const KNOWN_IMAGE_MAP = {
  // OpenStack Glance images
  '831dc24b-9d29-4cb6-8154-9de2d0fd268f': { name: 'CirrOS-0.6.2', user: 'cirros' },
  'c66c2ab2-68fe-40bb-8f55-d2e5ba1c944d': { name: 'Alpine-Linux-3.20-Cloud', user: 'alpine' },
  'fd249548-1863-4d30-b809-732108cab057': { name: 'Ubuntu Server 24.04 LTS', user: 'ubuntu' },
  // Legacy / Test IDs
  'img-u22': { name: 'Ubuntu Server 22.04 LTS', user: 'ubuntu' },
  'img-deb12': { name: 'Debian 12 Bookworm', user: 'debian' },
  'img-rocky9': { name: 'Rocky Linux 9 Enterprise', user: 'rocky' },
  'img-alp319': { name: 'Alpine Linux 3.19 Minimal', user: 'alpine' }
};

// SSH User mapping theo chuẩn OpenStack Glance distro
const CONNECT_SSH_USERS = {
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

function resolveInstanceImageInfo(inst) {
  if (!inst) return { imageName: 'Linux Image', sshUser: 'ubuntu' };
  const rawId = inst.imageId || '';
  const rawName = inst.imageName || '';

  // 1. Kiểm tra bảng KNOWN_IMAGE_MAP theo UUID hoặc legacy ID
  if (rawId && KNOWN_IMAGE_MAP[rawId]) {
    return {
      imageName: rawName || KNOWN_IMAGE_MAP[rawId].name,
      sshUser: KNOWN_IMAGE_MAP[rawId].user
    };
  }

  // 2. Kiểm tra cachedImages từ API GET /api/images
  if (rawId && cachedImages && cachedImages.has(rawId)) {
    const imgObj = cachedImages.get(rawId);
    const resolvedName = imgObj.name || rawName || rawId;
    const lowerName = resolvedName.toLowerCase();
    const hit = Object.keys(CONNECT_SSH_USERS).find(k => lowerName.includes(k));
    return {
      imageName: resolvedName,
      sshUser: hit ? CONNECT_SSH_USERS[hit] : 'ubuntu'
    };
  }

  // 3. Phân giải theo từ khóa tên image hoặc ID
  const candidate = (rawName || rawId).toLowerCase();
  const hit = Object.keys(CONNECT_SSH_USERS).find(k => candidate.includes(k));
  return {
    imageName: rawName || rawId || 'Linux Image',
    sshUser: hit ? CONNECT_SSH_USERS[hit] : 'ubuntu'
  };
}

function openConnectModal() {
  if (selectedInstanceIds.size !== 1) return;
  const id = Array.from(selectedInstanceIds)[0];
  const inst = cachedInstances.find(i => i.id === id);
  if (!inst) return;

  const imgInfo = resolveInstanceImageInfo(inst);
  const user = imgInfo.sshUser;
  const imageName = imgInfo.imageName;
  const key = (inst.keyName || 'my-key').replace(/\.pem$/i, '') + '.pem';
  const host = inst.publicIp || inst.privateIp || '<elastic-ip>';
  const set = (elId, text) => { const el = document.getElementById(elId); if (el) el.textContent = text; };

  set('connectTitle', t('Kết nối tới máy ảo', 'Connect to instance'));
  set('connStep1a', t('Mở terminal ở thư mục chứa file khóa', 'Open a terminal in the folder with the key file'));
  set('connStep1b', t('đã tải lúc tạo Key Pair.', 'downloaded when the key pair was created.'));
  set('connStep2', t('Trên Linux/macOS, giới hạn quyền đọc file khóa:', 'On Linux/macOS, restrict the key file permissions:'));
  set('connStep3', t('Kết nối bằng Elastic IP:', 'Connect with the Elastic IP:'));
  set('connDnsText', t('Hoặc dùng tên miền Route 53, vẫn đúng sau khi chuyển vùng:', 'Or use the Route 53 domain, which keeps working after a migration:'));
  set('connCloseBtn', t('Đóng', 'Close'));
  set('connKeyFile', key);
  set('connChmod', `chmod 400 "${key}"`);
  set('connCmdIp', `ssh -i "${key}" ${user}@${host}`);
  set('connCmdDns', inst.dnsDomain ? `ssh -i "${key}" ${user}@${inst.dnsDomain}` : t('Máy chưa có tên miền Route 53', 'No Route 53 domain yet'));
  set('connNote', t(`User mặc định của ${imageName || 'image này'} là "${user}". Security Group phải mở inbound TCP 22 cho IP của bạn.`,
    `The default user of ${imageName || 'this image'} is "${user}". A security group must allow inbound TCP 22 from your IP.`));
  openModal('connectModal');
}

// Sao chép (nút cạnh Instance ID, lệnh SSH). Trước đây hàm này chưa có nên bấm nút copy bị lỗi JS.
function copyToClipboard(text, label) {
  const done = () => showToast(t(`Đã sao chép ${label || ''}: `, `Copied ${label || ''}: `) + splitEsc(text), 'success');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => showToast(t('Trình duyệt chặn sao chép', 'The browser blocked copying'), 'error'));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { showToast(t('Trình duyệt chặn sao chép', 'The browser blocked copying'), 'error'); }
  ta.remove();
}

function copyConnectCmd(elId) {
  const el = document.getElementById(elId);
  if (el && el.textContent.startsWith('ssh')) copyToClipboard(el.textContent, 'SSH');
}

// 12. Khởi tạo trang Instances
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
