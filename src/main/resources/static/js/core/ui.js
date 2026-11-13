// Dùng chung mọi trang: cấu hình flavor, modal, thanh báo lỗi API, toast, badge trạng thái.
// Sửa file này phải báo cả nhóm.

// OpenStack & AWS Flavor Specifications (Dòng Tiêu Chuẩn m1 & Dòng Hiệu Năng Cao h1)
const FLAVOR_SPECS = {
  'm1.tiny':   { vcpu: 1,  ramMb: 1024,  ramDisplay: '1024 MB (1 GB)',  defaultDisk: 1, series: 'Tiêu chuẩn (m1)' },
  'm1.small':  { vcpu: 1,  ramMb: 2048,  ramDisplay: '2048 MB (2 GB)',  defaultDisk: 1, series: 'Tiêu chuẩn (m1)' },
  'm1.medium': { vcpu: 2,  ramMb: 4096,  ramDisplay: '4096 MB (4 GB)',  defaultDisk: 1, series: 'Tiêu chuẩn (m1)' },
  'm1.large':  { vcpu: 4,  ramMb: 8192,  ramDisplay: '8192 MB (8 GB)',  defaultDisk: 1, series: 'Tiêu chuẩn (m1)' },
  'm1.xlarge': { vcpu: 8,  ramMb: 16384, ramDisplay: '16384 MB (16 GB)',defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'h1.medium': { vcpu: 8,  ramMb: 16384, ramDisplay: '16384 MB (16 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' },
  'h1.large':  { vcpu: 16, ramMb: 32768, ramDisplay: '32768 MB (32 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' },
  'h1.xlarge': { vcpu: 32, ramMb: 65536, ramDisplay: '65536 MB (64 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' }
};

// Tab Routing

// Helper render icon dùng chung từ SVG sprite (/img/icons/sprite.svg)
function ICON(id, cls = '') {
  return `<svg class="ico ${cls}" aria-hidden="true"><use href="/img/icons/sprite.svg#${id}"></use></svg>`;
}

function uiEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Hộp xác nhận kiểu AWS, thay cho confirm() của trình duyệt (dùng chung mọi trang).
// await confirmDialog({ title, message (HTML, tự escape dữ liệu), confirmText, danger, requireText }) -> true/false
function confirmDialog({ title, message, confirmText = t('Xác nhận', 'Confirm'), cancelText = t('Hủy', 'Cancel'), danger = false, requireText = '' }) {
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
          <span class="confirm-icon" aria-hidden="true">${ICON(danger ? 'ui-warning' : 'ui-info', 'ico-lg')}</span>
          <h2 class="modal-title" id="confirmTitle">${uiEsc(title)}</h2>
        </div>
        <p class="modal-text" id="confirmMsg">${message}</p>
        ${requireText ? `
          <label class="confirm-require" for="confirmInput">${t('Gõ', 'Type')} <code>${uiEsc(requireText)}</code> ${t('để xác nhận', 'to confirm')}</label>
          <input id="confirmInput" class="form-input" autocomplete="off" spellcheck="false">` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">${uiEsc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok" ${requireText ? 'disabled' : ''}>${uiEsc(confirmText)}</button>
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

// Modal Helpers
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
}

async function showScenarioFreezePopup(instanceId, onDetailPage = false) {
  const safeId = String(instanceId || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = await confirmDialog({
    title: t('Kịch bản chuyển vùng đang kích hoạt (ACTIVE)', 'Migration scenario is ACTIVE'),
    message: t(
      `Máy ảo <code>${safeId}</code> đang bật Kịch bản chuyển vùng tự động, nên mọi thao tác sửa/xóa (Start, Stop, Reboot, Terminate, Security Group, chỉnh sửa kịch bản và chuyển vùng tay) đều bị khóa.<br><br>Vui lòng mở mục <strong>Kịch bản chuyển vùng</strong> tại <code>instance-detail.html?id=${safeId}#migration</code> và bấm <strong>Tạm dừng kịch bản</strong> (PAUSED) trước khi thực hiện.`,
      `Instance <code>${safeId}</code> has an ACTIVE alternating migration scenario, so lifecycle actions, Terminate, Security Group edits, scenario edits, and manual migration are locked.<br><br>Open <strong>Migration scenario</strong> at <code>instance-detail.html?id=${safeId}#migration</code> and choose <strong>Pause scenario</strong> (PAUSED) first.`
    ),
    confirmText: onDetailPage ? t('Tới nút Tạm dừng', 'Go to Pause button') : t('Mở Kịch bản chuyển vùng', 'Open Migration scenario'),
    cancelText: t('Đóng', 'Close')
  });
  if (!ok) return;
  if (onDetailPage) {
    const card = document.getElementById('scenarioCard');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const btn = document.getElementById('btnToggleScenario');
      if (btn) btn.focus();
    }
  } else if (instanceId) {
    window.location.href = `/instance-detail.html?id=${encodeURIComponent(instanceId)}#migration`;
  }
}

async function showDynamoLoadingPopup() {
  await confirmDialog({
    title: t('Đang tải dữ liệu từ DynamoDB', 'Loading data from DynamoDB'),
    message: t(
      'Dữ liệu trạng thái máy ảo, lịch sử chuyển vùng và kịch bản đang được tải từ AWS DynamoDB. Vui lòng đợi hoàn tất rồi thử lại.',
      'Instance state, migration history, and scenario data are still loading from AWS DynamoDB. Please wait until loading finishes and try again.'
    ),
    confirmText: t('Đã hiểu', 'OK'),
    cancelText: ''
  });
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
        <span>${ICON('ui-warning', 'ico-warning')} LỖI GỌI API: <code>${endpoint}</code> ${statusText}</span>
        <span style="font-size: 11px; font-weight: 400; color: #94a3b8; margin-left: 8px;">[${now}]</span>
      </div>
      <div class="api-error-message">${errorMsg || 'Không thể kết nối đến máy chủ Backend.'}</div>
      <div class="api-error-hint">
        ${ICON('ui-info', 'ico-accent')} <strong>Gợi ý:</strong> Kiểm tra file <code>.env</code> xem đã điền AWS Credentials (<code>AWS_ACCESS_KEY_ID</code>, <code>AWS_SECRET_ACCESS_KEY</code>) chưa hoặc kiểm tra kết nối mạng DynamoDB.
      </div>
    </div>
    <button class="api-error-close" onclick="clearApiError()" title="Đóng thông báo">${ICON('ui-close')}</button>
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
  const icon = type === 'success' ? ICON('ui-check-circle', 'ico-success') : ICON('ui-error', 'ico-danger');
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

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
