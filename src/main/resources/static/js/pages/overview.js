// Trang chủ (index.html) — Lực. Bố cục "EC2 Dashboard": Resources, tình trạng 2 vùng, máy ảo, nhật ký.
// Khung chuyển vùng nằm ở overview-migration.js.

registerI18n({
  dashCrumb: ['Bảng điều khiển', 'Dashboard'],
  dashSubtitle: ['Máy ảo NovaVM trên EC2 Bare Metal ở 2 vùng, chuyển vùng bằng EBS snapshot và Route 53.', 'NovaVM instances on EC2 Bare Metal in 2 regions, migrated with EBS snapshots and Route 53.'],
  dashResources: ['Tài nguyên', 'Resources'],
  dashResourcesSub: ['Bạn đang dùng các tài nguyên sau ở Sydney (ap-southeast-2) và N. Virginia (us-east-1).', 'You are using the following resources in Sydney (ap-southeast-2) and N. Virginia (us-east-1).'],
  dashResRunning: ['Máy ảo (đang chạy)', 'Instances (running)'],
  dashResInstances: ['Máy ảo (tất cả)', 'Instances (all)'],
  dashResSnapshotsFoot: ['tạo khi chuyển vùng', 'created by migrations'],
  dashRegionPrimary: ['Vùng chính', 'Primary'],
  dashRegionStandby: ['Vùng dự phòng', 'Standby'],
  dashRegionRole: ['Vai trò', 'Role'],
  dashRegionRoleA: ['Chạy production', 'Production'],
  dashRegionRoleB: ['Dự phòng, khôi phục sau sự cố', 'Standby, disaster recovery'],
  dashRegionInstances: ['Máy ảo tại vùng', 'Instances in region'],
  dashRegionOk: ['Dịch vụ hoạt động bình thường', 'This service is operating normally'],
  dashViewAll: ['Xem tất cả', 'View all'],
  dashColName: ['Tên', 'Name'],
  dashColType: ['Loại máy', 'Instance type'],
  dashColState: ['Trạng thái', 'Instance state'],
  dashLogs: ['Nhật ký thao tác gần đây', 'Recent activity'],
  dashColTime: ['Thời gian', 'Time'],
  dashColUser: ['Người thực hiện', 'User'],
  dashColAction: ['Hành động', 'Action'],
  dashColResource: ['Đối tượng', 'Resource'],
  dashColDetail: ['Chi tiết', 'Details']
});

// Trạng thái máy → [class badge trong status-badges.css, key i18n dùng chung st*]
const DASH_STATE = {
  ACTIVE: ['state-running', 'stRunning'], RUNNING: ['state-running', 'stRunning'],
  SHUTOFF: ['state-stopped', 'stStopped'], STOPPED: ['state-stopped', 'stStopped'],
  PENDING: ['state-pending', 'stPending'], BUILDING: ['state-pending', 'stPending'],
  STOPPING: ['state-stopping', 'stStopping'], REBOOTING: ['state-rebooting', 'stRebooting'],
  SHUTTING_DOWN: ['state-shutting-down', 'stShuttingDown'], TERMINATING: ['state-shutting-down', 'stShuttingDown'],
  TERMINATED: ['state-terminated', 'stTerminated'], MIGRATING: ['state-migrating', 'stMigrating']
};
const DASH_TRANSITIONAL = ['PENDING', 'BUILDING', 'STOPPING', 'REBOOTING', 'SHUTTING_DOWN', 'TERMINATING', 'MIGRATING'];

function dashEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dashStateBadge(status) {
  const key = String(status || '').toUpperCase();
  const [cls, label] = DASH_STATE[key] || ['state-error', ''];
  const spin = DASH_TRANSITIONAL.includes(key) ? ICON('ui-spinner', 'ico-xs ico-spin') + ' ' : '';
  return `<span class="ec2-state ${cls}">${spin}${dashEsc(label ? tk(label) : key || '–')}</span>`;
}

function dashSet(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function dashIsGone(i) {
  return ['TERMINATED', 'TERMINATING', 'SHUTTING_DOWN'].includes(String(i.status || '').toUpperCase());
}

async function initOverviewPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();
  await Promise.all([loadDashInstances(), loadDashResources(), loadDashLogs()]);
}

function refreshDashboard() {
  initOverviewPage();
  if (typeof loadMigrationSummary === 'function') loadMigrationSummary();
}

async function loadDashInstances() {
  const tbody = document.getElementById('overviewInstanceTableBody');
  try {
    const list = (await apiRequest('/instances')) || [];
    const live = list.filter(i => !dashIsGone(i));
    const running = live.filter(i => ['RUNNING', 'ACTIVE'].includes(String(i.status || '').toUpperCase())).length;
    dashSet('resRunning', running);
    dashSet('resInstances', live.length);
    dashSet('resEips', live.filter(i => i.publicIp).length);
    dashSet('regionAInstanceCount', live.filter(i => (i.region || '').includes('southeast')).length);
    dashSet('regionBInstanceCount', live.filter(i => (i.region || '').includes('us-east')).length);

    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">${t('Chưa có máy ảo nào.', 'No instances yet.')}
        <a class="link-accent" href="/launch.html">${dashEsc(tk('navLaunch'))}</a></td></tr>`;
      return;
    }
    tbody.innerHTML = list.slice(0, 5).map(inst => `
      <tr>
        <td><a class="link-accent mono" href="/instance-detail.html?id=${encodeURIComponent(inst.id)}">${dashEsc(inst.id)}</a></td>
        <td><strong>${dashEsc(inst.name)}</strong></td>
        <td class="mono">${dashEsc(inst.region || '–')}</td>
        <td class="mono">${dashEsc(inst.flavor || '–')}</td>
        <td class="mono">${dashEsc(inst.publicIp || '–')}</td>
        <td>${dashEsc(inst.dnsDomain || '–')}</td>
        <td>${dashStateBadge(inst.status)}</td>
      </tr>`).join('');
  } catch (err) {
    ['resRunning', 'resInstances', 'resEips', 'regionAInstanceCount', 'regionBInstanceCount'].forEach(id => dashSet(id, '–'));
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-cell dash-err">${ICON('ui-error', 'ico-sm')}
        ${t('Không tải được danh sách máy ảo', 'Could not load instances')}: ${dashEsc(err.message)}</td></tr>`;
    }
  }
}

// Các ô Resources còn lại: API nào lỗi thì chỉ ô đó hiện "–".
async function loadDashResources() {
  const safe = p => apiRequest(p).catch(() => null);
  const [volumes, keys, groups, mig] = await Promise.all([
    safe('/volumes'), safe('/keys'), safe('/network/security-groups'), safe('/migrations/summary')
  ]);
  dashSet('resVolumes', volumes ? volumes.length : '–');
  dashSet('resVolumesGb', volumes ? `${volumes.reduce((s, v) => s + (v.sizeGb || 0), 0)} GiB` : '');
  dashSet('resKeys', keys ? keys.length : '–');
  dashSet('resSgs', groups ? groups.length : '–');
  dashSet('resSnapshots', mig && mig.snapshotCount != null ? mig.snapshotCount : '–');
}

async function loadDashLogs() {
  const tbody = document.getElementById('overviewAuditLogsBody');
  if (!tbody) return;
  try {
    const logs = (await apiRequest('/logs?limit=5')) || [];
    tbody.innerHTML = logs.length
      ? logs.slice(0, 5).map(l => `
        <tr>
          <td class="muted nowrap">${l.timestamp ? dashEsc(formatSyncedDateTime(l.timestamp)) : '–'}</td>
          <td><strong>${dashEsc(l.username || '–')}</strong></td>
          <td><span class="proto">${dashEsc(l.action)}</span></td>
          <td><code>${dashEsc(l.resourceType)}</code></td>
          <td>${dashEsc(l.details)}</td>
        </tr>`).join('')
      : `<tr><td colspan="5" class="empty-cell">${t('Chưa có nhật ký thao tác.', 'No activity yet.')}</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">${t('Không tải được nhật ký.', 'Could not load activity.')}</td></tr>`;
  }
}
