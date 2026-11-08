// Dùng chung mọi trang: biến toàn cục, chặn trang khi chưa đăng nhập, đồng bộ giờ server, tự đăng xuất khi JWT hết hạn.
// Phải nạp sau core/ui.js và core/api.js. Sửa file này phải báo cả nhóm.

// XRegion Dashboard Client-side JavaScript

const API_BASE = '/api';
let authToken = localStorage.getItem('xregion_jwt') || '';
let performanceChart = null;
let migrationPollInterval = null;
let serverClockOffsetMs = 0;

// Auth Guard: Tự động kiểm tra phiên đăng nhập và chuyển hướng nếu chưa xác thực
function requireAuthGuard() {
  const token = localStorage.getItem('xregion_jwt');
  const path = window.location.pathname;
  const isAuthPage = path.endsWith('/login.html') || path.endsWith('/register.html') || path.endsWith('login') || path.endsWith('register');

  if (!token && !isAuthPage) {
    const currentUrl = window.location.pathname + window.location.search;
    window.location.replace('/login.html?redirect=' + encodeURIComponent(currentUrl));
    return false;
  }
  return true;
}

// Chạy kiểm tra Auth Guard ngay khi nạp file app.js
requireAuthGuard();

// Đồng bộ đồng hồ trình duyệt với Server & AWS DynamoDB
async function syncServerClock() {
  try {
    const clientBefore = Date.now();
    const res = await fetch(API_BASE + '/auth/health');
    if (res.ok) {
      const data = await res.json();
      const clientAfter = Date.now();
      const rttHalf = Math.round((clientAfter - clientBefore) / 2);
      const serverTs = Number(data.timestamp);
      if (!isNaN(serverTs) && serverTs > 0) {
        serverClockOffsetMs = (serverTs + rttHalf) - clientAfter;
      }
    }
  } catch (e) {
    console.warn('Clock sync skipped:', e);
  }
}

function getSyncedNowMs() {
  return Date.now() + serverClockOffsetMs;
}

function getSyncedNowSec() {
  return Math.floor(getSyncedNowMs() / 1000);
}

// Tự động chuẩn hóa cả Epoch Seconds (10 chữ số trên DynamoDB) lẫn Milliseconds (13 chữ số)
function toNormalizedMillis(rawTs) {
  if (!rawTs || isNaN(Number(rawTs))) return getSyncedNowMs();
  const num = Number(rawTs);
  return num < 10000000000 ? num * 1000 : num;
}

function formatSyncedDateTime(rawTs) {
  if (!rawTs) return 'Vừa xong';
  const ms = toNormalizedMillis(rawTs);
  return new Date(ms).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
}

// Khởi chạy đồng bộ thời gian ngay khi tải script
syncServerClock();

// ============================================================
// SESSION GUARD, AUTO-LOGOUT & REQUIRE AUTH ON ALL PAGES (INCLUDING /index.html)
// ============================================================
function isJwtTokenExpired() {
  const token = localStorage.getItem('xregion_jwt');
  if (!token) return true;
  const expiresAt = Number(localStorage.getItem('xregion_jwt_expires_at') || 0);
  if (expiresAt > 0 && getSyncedNowMs() >= expiresAt) {
    return true;
  }
  // Fallback: giải mã payload JWT (`exp` tính bằng giây) nếu chưa có `xregion_jwt_expires_at`
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.exp && getSyncedNowSec() >= payload.exp) {
        return true;
      }
    }
  } catch (e) {
    // ignore decode errors
  }
  return false;
}

function enforceAuthGuard() {
  const path = window.location.pathname;
  const isAuthPage = path.endsWith('/login.html') || path.endsWith('/register.html');
  const token = localStorage.getItem('xregion_jwt');
  const expired = isJwtTokenExpired();

  if (token && expired) {
    localStorage.removeItem('xregion_jwt');
    localStorage.removeItem('xregion_user');
    localStorage.removeItem('xregion_jwt_expires_at');
    authToken = '';
    if (!isAuthPage) {
      alert('Phiên đăng nhập của bạn đã hết hạn. Vui lòng đăng nhập lại!');
      window.location.replace('/login.html');
    }
    return;
  }

  // Nếu chưa đăng nhập thì chặn toàn bộ trang (bao gồm cả / và /index.html) và đẩy về /login.html
  if (!isAuthPage && !token) {
    window.location.replace('/login.html?redirect=' + encodeURIComponent(path + window.location.search));
  }
}

enforceAuthGuard();
setInterval(() => {
  const path = window.location.pathname;
  const isAuthPage = path.endsWith('/login.html') || path.endsWith('/register.html');
  if (!isAuthPage && isJwtTokenExpired()) {
    localStorage.removeItem('xregion_jwt');
    localStorage.removeItem('xregion_user');
    localStorage.removeItem('xregion_jwt_expires_at');
    authToken = '';
    showToast('Phiên đăng nhập đã hết hạn, đang tự động đăng xuất...', 'error');
    setTimeout(() => {
      window.location.replace('/login.html');
    }, 600);
  }
}, 5000);
