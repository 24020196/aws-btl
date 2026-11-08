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
  instLoading: ['Đang tải danh sách máy ảo...', 'Loading instances...'],
  instEmpty: ['Không tìm thấy máy ảo nào phù hợp bộ lọc.', 'No instances matching filter.'],
  instSelectedCount: ['máy ảo đã chọn', 'instances selected'],
  instConnectTitle: ['Kết nối tới máy ảo qua SSH', 'Connect to instance via SSH'],
  instConnectHelp: ['Sử dụng SSH client từ máy tính cá nhân để kết nối tới máy ảo:', 'Use SSH client from your terminal to connect to this instance:'],
  instConnectCommand: ['Lệnh SSH:', 'SSH Command:'],
  instActionEdit: ['Chỉnh sửa cấu hình máy ảo', 'Edit instance settings'],
  instActionMigrate: ['Chuyển vùng tức thì (Fast Migrate)', 'Fast Migrate X-Region'],
  actClose: ['Đóng', 'Close'],
  actViewDetails: ['Xem chi tiết', 'View full details']
});

let cachedInstances = [];
let selectedInstanceIds = new Set();
let statePollingInterval = null;
let currentSplitTab = 'tabDetails';

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

  const pag = document.getElementById('paginationInfo');
  if (pag) pag.textContent = total > 0 ? `1-${total} of ${total}` : '0 of 0';
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
    const instances = await apiRequest('/instances');
    cachedInstances = instances || [];
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
  const statusFilter = document.getElementById('instanceStatusFilter')?.value || 'ALL';

  const filtered = cachedInstances.filter(inst => {
    const rawStatus = (inst.status || '').toUpperCase();
    const matchText = !q || (inst.name || '').toLowerCase().includes(q) || (inst.id || '').toLowerCase().includes(q) || (inst.publicIp || '').includes(q) || (inst.privateIp || '').includes(q);
    const matchStatus = statusFilter === 'ALL' || rawStatus === statusFilter.toUpperCase();
    return matchText && matchStatus;
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
      <td>${renderSecurityGroupBadge(inst.securityGroup)}</td>
      <td>
        <span class="badge" style="background:rgba(16, 185, 129, 0.15); color:#34d399; font-family:monospace; display: inline-flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; white-space: nowrap;">
          ${ICON('svc-key-pair', 'ico-xs')}
          <span>${inst.keyName || 'xregion-key'}</span>
        </span>
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

function renderSecurityGroupBadge(sgString) {
  const sgs = String(sgString || 'sg-default').split(',').map(x => x.trim()).filter(Boolean);
  const first = sgs[0] || 'sg-default';
  const extra = sgs.length > 1 ? ` +${sgs.length - 1}` : '';
  return `<span class="badge" style="background:#1e293b; color:#38bdf8; font-family:monospace; display: inline-flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; white-space: nowrap;" title="${sgs.join(', ')}">
    ${ICON('svc-security-group', 'ico-xs')}
    <span>${first}${extra}</span>
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

  // Nút Instance State sáng khi chọn >= 1 máy ảo
  if (btnState) btnState.disabled = (count === 0);
}

// 7. Thao tác hàng loạt (Bulk Actions)
async function handleBulkAction(action) {
  closeAllDropdowns();
  const ids = Array.from(selectedInstanceIds);
  if (ids.length === 0) return;

  const actionNameMap = {
    'START': t('Khởi động', 'Start'),
    'STOP': t('Dừng', 'Stop'),
    'REBOOT': t('Khởi động lại', 'Reboot'),
    'TERMINATE': t('Xóa', 'Terminate')
  };
  const actionLabel = actionNameMap[action] || action;

  if (action === 'TERMINATE') {
    const msg = t(`Bạn có chắc chắn muốn XÓA vĩnh viễn ${ids.length} máy ảo đã chọn? Hành động này không thể hoàn tác!`,
                  `Are you sure you want to TERMINATE ${ids.length} selected instance(s)? This action cannot be undone!`);
    if (!confirm(msg)) return;
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
  if (count === 0) {
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

function renderSplitDetailsTab(inst) {
  const grid = document.getElementById('splitDetailsGrid');
  if (!grid) return;
  const cfg = getStatusBadgeConfig(inst.status);

  grid.innerHTML = `
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Mã máy ảo (ID)', 'Instance ID')}</div>
      <div class="split-kv-value"><code style="color: var(--accent-cyan); font-weight: 700;">${inst.id}</code></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Tên máy ảo', 'Instance name')}</div>
      <div class="split-kv-value"><strong>${inst.name}</strong></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Trạng thái', 'Instance state')}</div>
      <div class="split-kv-value">${instanceStateBadge(inst.status)}</div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Loại cấu hình', 'Instance type')}</div>
      <div class="split-kv-value"><span class="badge" style="background:#1e293b; color:#94a3b8; font-family:monospace; text-transform: none; letter-spacing: 0;">${inst.flavor}</span></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Vùng đám mây', 'Region')}</div>
      <div class="split-kv-value">${inst.regionName || inst.region}</div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Hệ điều hành / AMI', 'AMI / OS')}</div>
      <div class="split-kv-value">${inst.image || 'Ubuntu 22.04 LTS'}</div>
    </div>
  `;
}

function renderSplitSecurityTab(inst) {
  const grid = document.getElementById('splitSecurityGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Nhóm bảo mật (Security Group)', 'Security groups')}</div>
      <div class="split-kv-value">${renderSecurityGroupBadge(inst.securityGroup)}</div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Cặp khóa SSH (Key pair)', 'Key pair name')}</div>
      <div class="split-kv-value">
        <span class="badge" style="background:rgba(16, 185, 129, 0.15); color:#34d399; font-family:monospace; display: inline-flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; white-space: nowrap;">
          ${ICON('svc-key-pair', 'ico-xs')}
          <span>${inst.keyName || 'xregion-key'}</span>
        </span>
      </div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">${t('Tường lửa Inbound Rules', 'Firewall rules')}</div>
      <div class="split-kv-value">${t('Cổng mở: SSH (22), HTTP (80), ICMP', 'Ports open: SSH (22), HTTP (80), ICMP')}</div>
    </div>
  `;
}

function renderSplitNetworkingTab(inst) {
  const grid = document.getElementById('splitNetworkingGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="split-kv-item">
      <div class="split-kv-label">Public IPv4 address</div>
      <div class="split-kv-value"><code style="color: var(--accent-cyan);">${inst.publicIp || '--'}</code></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">Private IPv4 address</div>
      <div class="split-kv-value"><code>${inst.privateIp || '--'}</code></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">Route 53 DNS Name</div>
      <div class="split-kv-value"><code>${inst.dnsDomain || (inst.name.toLowerCase() + '.xregion.net')}</code></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">Elastic IP Status</div>
      <div class="split-kv-value"><span class="badge" style="background: #1e293b; color: #38bdf8;">${inst.publicIp ? 'Associated' : 'None'}</span></div>
    </div>
  `;
}

function renderSplitStorageTab(inst) {
  const grid = document.getElementById('splitStorageGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="split-kv-item">
      <div class="split-kv-label">Root Volume ID</div>
      <div class="split-kv-value"><code>vol-${(inst.id || '').substring(0, 8)}</code></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">Volume Type</div>
      <div class="split-kv-value"><span class="badge" style="background: #1e293b; color: #34d399;">gp3 SSD</span></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">Volume Size</div>
      <div class="split-kv-value"><strong>${inst.ebsSizeGb || 10} GiB</strong></div>
    </div>
    <div class="split-kv-item">
      <div class="split-kv-label">Delete on Termination</div>
      <div class="split-kv-value">Yes</div>
    </div>
  `;
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
  if (drop) drop.classList.toggle('show');
}

function toggleActionsDropdown(ev) {
  if (ev) ev.stopPropagation();
  const drop = document.getElementById('actionsDropdown');
  const stateDrop = document.getElementById('instanceStateDropdown');
  if (stateDrop) stateDrop.classList.remove('show');
  if (drop) drop.classList.toggle('show');
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
function openConnectModal() {
  if (selectedInstanceIds.size !== 1) return;
  const id = Array.from(selectedInstanceIds)[0];
  const inst = cachedInstances.find(i => i.id === id);
  if (!inst) return;

  const keyFile = `${inst.keyName || 'xregion-key'}.pem`;
  const host = inst.publicIp || inst.privateIp || '10.0.1.10';
  const cmd = `ssh -i "${keyFile}" ubuntu@${host}`;

  const input = document.getElementById('connectSshCmd');
  if (input) input.value = cmd;

  const webBtn = document.getElementById('connectWebTerminalBtn');
  if (webBtn) {
    webBtn.href = `/instance-detail.html?id=${encodeURIComponent(inst.id)}#details`;
  }

  openModal('connectModal');
}

function copySshCommand() {
  const input = document.getElementById('connectSshCmd');
  if (input) {
    copyToClipboard(input.value, 'Lệnh SSH');
  }
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
