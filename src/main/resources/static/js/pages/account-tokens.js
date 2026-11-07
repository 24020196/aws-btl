// Chỉ dùng cho account-tokens.html (trước đây viết thẳng trong thẻ <script> cuối trang).

let currentNewToken = '';

document.addEventListener('DOMContentLoaded', () => {
  initUserBadge();
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
      document.getElementById('profCreatedAt').textContent = u.createdAt ? new Date(u.createdAt).toLocaleString('vi-VN') : 'Mặc định';
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
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Chưa có API Token nào. Hãy tạo token mới ở trên!</td></tr>';
        return;
      }

      const now = Date.now();
      tbody.innerHTML = list.map(t => {
        const isExpired = t.expires_at > 0 && now > t.expires_at;
        let statusBadge = '<span class="badge-status-active">Hoạt động</span>';
        if (!t.active) {
          statusBadge = '<span class="badge-status-revoked">Đã thu hồi</span>';
        } else if (isExpired) {
          statusBadge = '<span class="badge-status-expired">Đã hết hạn</span>';
        }

        const expiryText = (t.expires_at === 0 || !t.expires_at)
          ? 'Không thời hạn (Vĩnh viễn)'
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
              ${t.token ? `<button class="btn btn-secondary" onclick="copyTokenText('${t.token}')" style="padding: 3px 8px; font-size: 11px; margin-right: 4px;">Copy</button>` : ''}
              ${t.active ? `<button class="btn btn-secondary" onclick="revokeToken('${t.token_id}')" style="padding: 3px 8px; font-size: 11px; color: #ef4444;">Thu hồi</button>` : ''}
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
      showToast('Đã tạo API Token mới thành công!', 'success');
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
    showToast('Đã sao chép API Token vào Clipboard!', 'success');
  }
}

function copyTokenText(tokenVal) {
  navigator.clipboard.writeText(tokenVal);
  showToast('Đã sao chép token vào Clipboard!', 'success');
}

async function revokeToken(tokenId) {
  if (!confirm(`Bạn có chắc chắn muốn thu hồi Token [${tokenId}]? Các ứng dụng sử dụng token này sẽ bị từ chối truy cập ngay lập tức.`)) {
    return;
  }

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

function initUserBadge() {
  const container = document.getElementById('userBadgeContainer');
  const token = localStorage.getItem('xregion_jwt');
  if (container) {
    if (token) {
      container.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 13px; color: var(--text-main); font-weight: 500;">admin</span>
          <button onclick="logout()" class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px;">Đăng xuất</button>
        </div>
      `;
    } else {
      container.innerHTML = `<a href="/login.html" class="btn btn-primary" style="padding: 4px 12px; font-size: 12px; text-decoration: none;">Đăng nhập</a>`;
    }
  }
}
