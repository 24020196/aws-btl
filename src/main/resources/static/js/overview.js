// Phần mở rộng cho trang Tổng quan (index.html): badge trạng thái kiểu EC2 và tóm tắt chuyển vùng.
// Không sửa initOverviewPage() trong app.js: chỉ đọc API riêng và trang trí lại bảng sau khi app.js vẽ xong.

const OV_STATE = {
  ACTIVE: ['state-running', 'Running'], RUNNING: ['state-running', 'Running'],
  SHUTOFF: ['state-stopped', 'Stopped'], STOPPED: ['state-stopped', 'Stopped'],
  PENDING: ['state-pending', 'Pending'], BUILDING: ['state-pending', 'Pending'],
  STOPPING: ['state-stopping', 'Stopping'], SHUTTING_DOWN: ['state-shutting-down', 'Shutting-down'],
  REBOOTING: ['state-rebooting', 'Rebooting'], MIGRATING: ['state-migrating', 'Migrating'],
  TERMINATED: ['state-terminated', 'Terminated'], ERROR: ['state-error', 'Error']
};
const OV_REGION = { 'ap-southeast-2': ['reg-apse2', 'Sydney'], 'us-east-1': ['reg-use1', 'N. Virginia'] };
let ovSummaryTimer = null;

function ovEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ovStateTag(status) {
  const key = String(status || '').toUpperCase();
  const [cls, label] = OV_STATE[key] || ['state-stopped', key || '–'];
  return `<span class="ec2-state ${cls}">${ovEsc(label)}</span>`;
}

function ovRegionTag(region) {
  const r = OV_REGION[region];
  return r ? `<span class="region-tag ${r[0]}">${r[1]}</span>` : ovEsc(region || '–');
}

function ovAgo(ms, now) {
  const s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

function ovTime(ms) {
  if (!ms) return '–';
  return typeof formatSyncedDateTime === 'function' ? formatSyncedDateTime(ms) : new Date(ms).toLocaleString('vi-VN');
}

// Bảng "Máy ảo đang hoạt động": đổi cột trạng thái (cột 7) sang badge EC2, mỗi lần app.js vẽ lại bảng.
function restyleOverviewTable() {
  const body = document.getElementById('overviewInstanceTableBody');
  if (!body) return;
  body.querySelectorAll('tr').forEach(tr => {
    const cell = tr.children[6];
    if (!cell || cell.dataset.ec2) return;
    const raw = cell.textContent.trim();
    if (!raw) return;
    cell.innerHTML = ovStateTag(raw);
    cell.dataset.ec2 = '1';
  });
}

async function loadMigrationSummary() {
  let s;
  try {
    s = await apiRequest('/migrations/summary');
  } catch (err) {
    document.getElementById('migSumLatest').textContent = 'Không tải được dữ liệu chuyển vùng.';
    document.getElementById('migSumLocked').textContent = '–';
    return;
  }
  const now = s.serverTime || Date.now();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('migSumCompleted', s.completed);
  set('migSumFailed', s.failed);
  set('migSumRunning', s.inProgress);
  set('migSumRate', s.successRate == null ? 'Chưa có lần nào kết thúc' : `Tỉ lệ thành công ${s.successRate}%`);
  set('migSumRto', s.avgDowntimeSeconds == null ? '–' : `${s.avgDowntimeSeconds}s`);
  set('migSumLockedCount', `${s.locked.length} máy đang khóa`);
  set('migSumUpdated', `Cập nhật ${new Date(now).toLocaleTimeString('vi-VN')}.`);

  const latest = document.getElementById('migSumLatest');
  if (!s.latest) {
    latest.innerHTML = 'Chưa có lần chuyển vùng nào. Mở một máy ảo và bấm <strong>⚡ Fast Migrate X-Region</strong>.';
  } else {
    const l = s.latest;
    const st = String(l.status || '').toUpperCase();
    const cls = st === 'COMPLETED' ? 'state-running' : st === 'FAILED' ? 'state-error' : 'state-migrating';
    latest.classList.remove('muted');
    latest.innerHTML = `
      <div class="mig-sum-latest">
        <a class="link-accent" href="/instance-detail.html?id=${encodeURIComponent(l.instanceId)}#migration"><strong>${ovEsc(l.instanceName)}</strong></a>
        <code class="muted">${ovEsc(l.migrationId)}</code>
        <span class="ec2-state ${cls}">${ovEsc(st)}</span>
      </div>
      <div class="mig-sum-route">${ovRegionTag(l.sourceRegion)} <span class="muted">→</span> ${ovRegionTag(l.destRegion)}</div>
      <div class="muted">Bắt đầu ${ovEsc(ovTime(l.startedAt))} (${ovAgo(l.startedAt, now)})${l.downtimeSeconds ? ` · downtime ${l.downtimeSeconds}s` : ''}</div>`;
  }

  const locked = document.getElementById('migSumLocked');
  if (!s.locked.length) {
    locked.className = 'muted';
    locked.innerHTML = '<span class="lock-free">🔓 Không có máy nào đang khóa.</span>';
  } else {
    locked.className = '';
    locked.innerHTML = `<ul class="mig-sum-locks">${s.locked.map(i => `
      <li>
        <a class="link-accent" href="/instance-detail.html?id=${encodeURIComponent(i.instanceId)}#migration">🔒 ${ovEsc(i.instanceName || i.instanceId)}</a>
        <span class="muted">${ovEsc(i.instanceId)} · ${ovRegionTag(i.currentRegion)}</span>
        <span class="${i.stale ? 'sync-bad' : 'muted'}">${i.stale ? 'khóa treo, sẽ tự nhả ở lần chuyển tiếp theo' : (i.lockAcquiredAt ? 'khóa ' + ovAgo(i.lockAcquiredAt, now) : '')}</span>
      </li>`).join('')}</ul>`;
  }

  // Có lần chuyển vùng đang chạy thì cập nhật nhanh hơn để thấy nó kết thúc
  clearTimeout(ovSummaryTimer);
  ovSummaryTimer = setTimeout(loadMigrationSummary, s.inProgress > 0 ? 3000 : 30000);
}

function initOverviewExtras() {
  const body = document.getElementById('overviewInstanceTableBody');
  if (body) new MutationObserver(restyleOverviewTable).observe(body, { childList: true });
  restyleOverviewTable();
  loadMigrationSummary();
}
