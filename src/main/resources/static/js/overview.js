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
  const isEn = typeof getLang === 'function' && getLang() === 'en';
  if (s < 60) return isEn ? `${s}s ago` : `${s} giây trước`;
  if (s < 3600) return isEn ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return isEn ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 3600)} giờ trước`;
  return isEn ? `${Math.floor(s / 86400)}d ago` : `${Math.floor(s / 86400)} ngày trước`;
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
  const tr = (vi, en) => (typeof t === 'function' ? t(vi, en) : vi);
  let s;
  try {
    s = await apiRequest('/migrations/summary');
  } catch (err) {
    document.getElementById('migSumLatest').textContent = tr('Không tải được dữ liệu chuyển vùng.', 'Failed to load migration summary.');
    document.getElementById('migSumLocked').textContent = '–';
    return;
  }
  const now = s.serverTime || Date.now();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('migSumCompleted', s.completed);
  set('migSumFailed', s.failed);
  set('migSumRunning', s.inProgress);
  set('migSumRate', s.successRate == null ? tr('Chưa có lần nào kết thúc', 'No completed migrations yet') : tr(`Tỉ lệ thành công ${s.successRate}%`, `Success rate ${s.successRate}%`));
  set('migSumRto', s.avgDowntimeSeconds == null ? '–' : `${s.avgDowntimeSeconds}s`);
  set('migSumLockedCount', tr(`${s.locked.length} máy đang khóa`, `${s.locked.length} locked instance(s)`));
  set('migSumUpdated', tr(`Cập nhật ${new Date(now).toLocaleTimeString('vi-VN')}.`, `Updated ${new Date(now).toLocaleTimeString('en-US', { hour12: false })}.`));

  const latest = document.getElementById('migSumLatest');
  if (!s.latest) {
    latest.innerHTML = tr(
      'Chưa có lần chuyển vùng nào. Mở một máy ảo và bấm <strong>⚡ Fast Migrate X-Region</strong>.',
      'No cross-region migrations yet. Open an instance and click <strong>⚡ Fast Migrate X-Region</strong>.'
    );
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
      <div class="muted">${tr('Bắt đầu', 'Started')} ${ovEsc(ovTime(l.startedAt))} (${ovAgo(l.startedAt, now)})${l.downtimeSeconds ? ` · downtime ${l.downtimeSeconds}s` : ''}</div>`;
  }

  const locked = document.getElementById('migSumLocked');
  if (!s.locked.length) {
    locked.className = 'muted';
    locked.innerHTML = `<span class="lock-free">🔓 ${tr('Không có máy nào đang khóa.', 'No instances currently locked.')}</span>`;
  } else {
    locked.className = '';
    locked.innerHTML = `<ul class="mig-sum-locks">${s.locked.map(i => `
      <li>
        <a class="link-accent" href="/instance-detail.html?id=${encodeURIComponent(i.instanceId)}#migration">🔒 ${ovEsc(i.instanceName || i.instanceId)}</a>
        <span class="muted">${ovEsc(i.instanceId)} · ${ovRegionTag(i.currentRegion)}</span>
        <span class="${i.stale ? 'sync-bad' : 'muted'}">${i.stale ? tr('khóa treo, sẽ tự nhả ở lần chuyển tiếp theo', 'stale lock, will auto-release on next migration') : (i.lockAcquiredAt ? tr('khóa ', 'locked ') + ovAgo(i.lockAcquiredAt, now) : '')}</span>
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
