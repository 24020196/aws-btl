// Chỉ dùng cho account-tokens.html

let currentNewToken = '';

// Đăng ký từ điển i18n riêng cho trang Account & Tokens
registerI18n({
  tokensBreadcrumb: ['Tài Khoản & API Token', 'Account & API Tokens'],
  tokensPageTitle: ['Quản Lý Tài Khoản & API Token Xác Thực', 'Account & Personal Access Tokens'],
  tokensPageSubtitle: [
    'Quản lý tài khoản quản trị và cấp phát API Token độc lập để xác thực an toàn qua AWS API Gateway (Edge-Optimized).',
    'Manage administrative account credentials and provision personal access tokens for secure AWS API Gateway requests.'
  ],
  tokensProfileHeading: ['Thông Tin Tài Khoản', 'Account Profile'],
  tokensLabelUsername: ['Tên đăng nhập:', 'Username:'],
  tokensLabelFullName: ['Họ và tên:', 'Full name:'],
  tokensLabelRole: ['Vai trò (Role):', 'Role:'],
  tokensLabelCreatedAt: ['Ngày khởi tạo:', 'Created at:'],
  tokensChangePassHeading: ['Đổi Mật Khẩu', 'Change Password'],
  tokensOldPassLabel: ['Mật khẩu hiện tại', 'Current password'],
  tokensOldPassPlaceholder: ['Nhập mật khẩu hiện tại', 'Enter current password'],
  tokensNewPassLabel: ['Mật khẩu mới', 'New password'],
  tokensNewPassPlaceholder: ['Nhập mật khẩu mới', 'Enter new password'],
  tokensUpdatePassBtn: ['Cập Nhật Mật Khẩu', 'Update Password'],
  tokensCreateHeading: ['Tạo API Token Xác Thực Mới', 'Generate New Personal Access Token'],
  tokensCreateDesc: [
    'API Token được tạo riêng biệt với phiên đăng nhập Web Dashboard, lưu trữ vào DynamoDB và dùng để gọi trực tiếp các dịch vụ qua AWS API Gateway (Edge-Optimized).',
    'Personal API tokens are stored in DynamoDB and used to authenticate direct API requests via AWS API Gateway (Edge-Optimized).'
  ],
  tokensNameLabel: ['Tên gợi nhớ của Token', 'Token Name / Description'],
  tokensNamePlaceholder: ['Ví dụ: CI/CD Deployment, CLI Tool, Monitoring System', 'e.g. CI/CD Deployment, CLI Tool, Monitoring System'],
  tokensDurationLabel: ['Thời hạn hiệu lực', 'Expiration'],
  tokensOpt1Month: ['1 Tháng (30 ngày)', '1 Month (30 days)'],
  tokensOpt3Months: ['3 Tháng (90 ngày)', '3 Months (90 days)'],
  tokensOpt6Months: ['6 Tháng (180 ngày)', '6 Months (180 days)'],
  tokensOptForever: ['Không thời hạn (No Date / Vĩnh viễn)', 'No Expiration (Never expires)'],
  tokensSubmitBtn: ['+ Sinh API Token Mới', '+ Generate New Token'],
  tokensCreatedSuccess: ['API Token của bạn đã được khởi tạo thành công!', 'Your API token has been generated successfully!'],
  tokensCopyBtn: ['Sao Chép Token', 'Copy Token'],
  tokensCopyWarning: [
    'Vui lòng sao chép token ngay bây giờ. Token này sẽ được sử dụng trong header Authorization: Bearer <TOKEN>.',
    'Please copy the token now. It will be used in the header Authorization: Bearer <TOKEN>.'
  ],
  tokensTableHeading: ['Danh Sách API Token Đã Cấp Phát', 'Issued API Access Tokens'],
  tokensColName: ['TÊN TOKEN', 'TOKEN NAME'],
  tokensColId: ['TOKEN ID', 'TOKEN ID'],
  tokensColPrefix: ['MÃ TOKEN (TRÍCH XUẤT)', 'TOKEN PREFIX'],
  tokensColCreated: ['NGÀY TẠO', 'CREATED AT'],
  tokensColExpiry: ['HẠN DÙNG', 'EXPIRES AT'],
  tokensColStatus: ['TRẠNG THÁI', 'STATUS'],
  tokensColActions: ['THAO TÁC', 'ACTIONS'],
  tokensLoading: ['Đang tải danh sách token...', 'Loading tokens list...'],
  tokensEmpty: ['Chưa có API Token nào. Hãy tạo token mới ở trên!', 'No API tokens found. Generate a new token above!'],
  tokensStatusActive: ['Hoạt động', 'Active'],
  tokensStatusRevoked: ['Đã thu hồi', 'Revoked'],
  tokensStatusExpired: ['Đã hết hạn', 'Expired'],
  tokensNeverExpires: ['Không thời hạn (Vĩnh viễn)', 'Never expires'],
  tokensRevokeBtn: ['Thu hồi', 'Revoke']
});

document.addEventListener('DOMContentLoaded', () => {
  renderUserBadge();
  loadUserProfile();
  loadUserTokens();
});

async function loadUserProfile() {
  try {
    const token = localStorage.getItem('xregion_jwt');
    if (!token) {
      window.location.href = '/login.html';
      return;
    }

    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (res.ok && data.data) {
      const u = data.data;
      document.getElementById('profUsername').textContent = u.username || 'admin';
      document.getElementById('profFullName').textContent = u.fullName || u.username || 'Administrator';
      document.getElementById('profRole').textContent = u.role || 'ROLE_ADMIN';
      document.getElementById('profCreatedAt').textContent = u.createdAt ? new Date(u.createdAt).toLocaleString('vi-VN') : tk('tokensStatusActive', 'Mặc định');
    }
  } catch (e) {
    console.error('Lỗi tải thông tin user:', e);
  }
}

async function loadUserTokens() {
  const tbody = document.getElementById('apiTokensTableBody');
  try {
    const token = localStorage.getItem('xregion_jwt');
    const res = await fetch('/api/auth/tokens', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (res.ok && data.data) {
      const list = data.data;
      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">${tk('tokensEmpty', 'Chưa có API Token nào. Hãy tạo token mới ở trên!')}</td></tr>`;
        return;
      }

      const now = Date.now();
      tbody.innerHTML = list.map(raw => {
        // API trả tên trường dạng camelCase (tokenId, createdAt, expiresAt); vẫn đọc được dạng cũ snake_case
        const t = {
          ...raw,
          token_id: raw.tokenId ?? raw.token_id,
          created_at: raw.createdAt ?? raw.created_at,
          expires_at: raw.expiresAt ?? raw.expires_at
        };
        const isExpired = t.expires_at > 0 && now > t.expires_at;
        let statusBadge = `<span class="badge-status-active">${tk('tokensStatusActive', 'Hoạt động')}</span>`;
        if (!t.active) {
          statusBadge = `<span class="badge-status-revoked">${tk('tokensStatusRevoked', 'Đã thu hồi')}</span>`;
        } else if (isExpired) {
          statusBadge = `<span class="badge-status-expired">${tk('tokensStatusExpired', 'Đã hết hạn')}</span>`;
        }

        const expiryText = (t.expires_at === 0 || !t.expires_at)
          ? tk('tokensNeverExpires', 'Không thời hạn (Vĩnh viễn)')
          : new Date(t.expires_at).toLocaleDateString('vi-VN');

        const tokenMasked = t.token ? (t.token.substring(0, 15) + '...' + t.token.substring(t.token.length - 8)) : '***';

        return `
          <tr>
            <td><strong>${t.name || 'API Token'}</strong></td>
            <td><code>${t.token_id || '-'}</code></td>
            <td><code style="color: #38bdf8;">${tokenMasked}</code></td>
            <td>${t.created_at ? new Date(t.created_at).toLocaleDateString('vi-VN') : '-'}</td>
            <td>${expiryText}</td>
            <td>${statusBadge}</td>
            <td style="text-align: right;">
              ${t.token ? `<button class="btn btn-secondary btn-sm" onclick="copyTokenText('${t.token}')" style="margin-right: 4px;">${ICON('ui-copy', 'ico-xs')} ${tk('commonCopy', 'Copy')}</button>` : ''}
              ${t.active ? `<button class="btn btn-secondary btn-sm" onclick="revokeToken('${t.token_id}')" style="color: #ef4444;">${ICON('ui-trash', 'ico-xs')} ${tk('tokensRevokeBtn', 'Thu hồi')}</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #ef4444; padding: 20px;">Lỗi tải API Tokens: ${e.message}</td></tr>`;
  }
}

async function submitCreateToken(e) {
  e.preventDefault();
  const name = document.getElementById('tokenName').value.trim();
  const durationMonths = parseInt(document.getElementById('tokenDuration').value, 10);

  try {
    const token = localStorage.getItem('xregion_jwt');
    const res = await fetch('/api/auth/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ name, durationMonths })
    });

    const data = await res.json();
    if (res.ok && data.data) {
      currentNewToken = data.data.token;
      document.getElementById('newGeneratedTokenCode').textContent = currentNewToken;
      document.getElementById('tokenDisplayBox').style.display = 'block';
      document.getElementById('tokenName').value = '';
      showToast(tk('tokensCreatedSuccess', 'Đã tạo API Token mới thành công!'), 'success');
      loadUserTokens();
    } else {
      alert('Lỗi tạo token: ' + (data.message || 'Không xác định'));
    }
  } catch (err) {
    alert('Lỗi kết nối tạo token: ' + err.message);
  }
}

function copyNewToken() {
  if (currentNewToken) {
    navigator.clipboard.writeText(currentNewToken);
    showToast(tk('commonCopied', 'Đã sao chép API Token vào Clipboard!'), 'success');
  }
}

function copyTokenText(tokenVal) {
  navigator.clipboard.writeText(tokenVal);
  showToast(tk('commonCopied', 'Đã sao chép token vào Clipboard!'), 'success');
}

async function revokeToken(tokenId) {
  const ok = await confirmDialog({
    title: t('Thu hồi API token?', 'Revoke API token?'),
    message: t(`Token <code>${uiEsc(tokenId)}</code> sẽ bị thu hồi. Các ứng dụng đang dùng token này bị từ chối truy cập ngay lập tức.`,
               `Token <code>${uiEsc(tokenId)}</code> will be revoked. Apps using it are denied access immediately.`),
    confirmText: t('Thu hồi', 'Revoke'),
    danger: true
  });
  if (!ok) return;

  try {
    const token = localStorage.getItem('xregion_jwt');
    const res = await fetch('/api/auth/tokens/' + tokenId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Đã thu hồi token thành công', 'success');
      loadUserTokens();
    } else {
      alert('Lỗi thu hồi token: ' + data.message);
    }
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}

async function submitChangePassword(e) {
  e.preventDefault();
  const oldPassword = document.getElementById('oldPassword').value;
  const newPassword = document.getElementById('newPassword').value;

  try {
    const token = localStorage.getItem('xregion_jwt');
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ oldPassword, newPassword })
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Đã đổi mật khẩu thành công!', 'success');
      document.getElementById('oldPassword').value = '';
      document.getElementById('newPassword').value = '';
    } else {
      alert('Đổi mật khẩu thất bại: ' + data.message);
    }
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}
