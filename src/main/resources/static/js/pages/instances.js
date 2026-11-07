// Trang danh sách máy ảo (instances.html).

// TAB 1: COMPUTE & EC2 INSTANCES
let cachedInstances = [];
let statePollingInterval = null;

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
          
          <button class="btn btn-primary btn-sm ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="location.href='/instance-detail.html?id=${encodeURIComponent(inst.id)}&action=migrate'" title="Chuyển vùng máy ảo tức thì (Fast Migrate): mở trang chi tiết để theo dõi 6 bước">⚡ Migrate</button>
          
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
