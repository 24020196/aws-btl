// Dùng chung mọi trang: cấu hình flavor, modal, thanh báo lỗi API, toast, badge trạng thái.
// Sửa file này phải báo cả nhóm.

// OpenStack & AWS Flavor Specifications (Dòng Tiêu Chuẩn m1 & Dòng Hiệu Năng Cao h1)
const FLAVOR_SPECS = {
  'm1.tiny':   { vcpu: 1,  ramMb: 512,   ramDisplay: '512 MB',          defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.small':  { vcpu: 1,  ramMb: 2048,  ramDisplay: '2048 MB (2 GB)',  defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.medium': { vcpu: 2,  ramMb: 4096,  ramDisplay: '4096 MB (4 GB)',  defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.large':  { vcpu: 4,  ramMb: 8192,  ramDisplay: '8192 MB (8 GB)',  defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'm1.xlarge': { vcpu: 8,  ramMb: 16384, ramDisplay: '16384 MB (16 GB)',defaultDisk: 10, series: 'Tiêu chuẩn (m1)' },
  'h1.medium': { vcpu: 8,  ramMb: 16384, ramDisplay: '16384 MB (16 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' },
  'h1.large':  { vcpu: 16, ramMb: 32768, ramDisplay: '32768 MB (32 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' },
  'h1.xlarge': { vcpu: 32, ramMb: 65536, ramDisplay: '65536 MB (64 GB)',defaultDisk: 10, series: 'Hiệu năng cao (h1)' }
};

// Tab Routing

// Modal Helpers
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
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
        <span>⚠️ LỖI GỌI API: <code>${endpoint}</code> ${statusText}</span>
        <span style="font-size: 11px; font-weight: 400; color: #94a3b8; margin-left: 8px;">[${now}]</span>
      </div>
      <div class="api-error-message">${errorMsg || 'Không thể kết nối đến máy chủ Backend.'}</div>
      <div class="api-error-hint">
        💡 <strong>Gợi ý:</strong> Kiểm tra file <code>.env</code> xem đã điền AWS Credentials (<code>AWS_ACCESS_KEY_ID</code>, <code>AWS_SECRET_ACCESS_KEY</code>) chưa hoặc kiểm tra kết nối mạng DynamoDB.
      </div>
    </div>
    <button class="api-error-close" onclick="clearApiError()" title="Đóng thông báo">✕</button>
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
  const icon = type === 'success' ? '✅' : '❌';
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
