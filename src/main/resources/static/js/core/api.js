// Dùng chung mọi trang: hàm gọi REST API (gắn JWT, xử lý lỗi).
// Sửa file này phải báo cả nhóm.

// Authenticated Fetch wrapper
async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('xregion_jwt') || authToken;
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': 'Bearer ' + token } : {})
  };

  try {
    const res = await fetch(API_BASE + endpoint, { ...options, headers });
    if (res.status === 401 || res.status === 403) {
      console.warn(`Auth error (${res.status}) on endpoint: ${endpoint}`);
      localStorage.removeItem('xregion_jwt');
      localStorage.removeItem('xregion_user');
      authToken = '';

      const isAuthPage = window.location.pathname.endsWith('login.html') || window.location.pathname.endsWith('register.html');
      if (!isAuthPage) {
        showToast('Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Đang chuyển về trang đăng nhập...', 'error');
        const currentUrl = window.location.pathname + window.location.search;
        setTimeout(() => {
          window.location.replace('/login.html?redirect=' + encodeURIComponent(currentUrl));
        }, 800);
      }
      throw new Error(`Yêu cầu bị từ chối (${res.status} Forbidden/Unauthorized). Vui lòng đăng nhập lại.`);
    }

    let data;
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = { message: text };
    }

    if (!res.ok) {
      const errMsg = (data && data.message) ? data.message : `Yêu cầu thất bại với mã lỗi HTTP ${res.status}`;
      showApiError(endpoint, errMsg, res.status);
      throw new Error(errMsg);
    }
    return data ? data.data : null;
  } catch (err) {
    console.error('API Error:', endpoint, err);
    if (!endpoint.includes('/auth/login')) {
      showApiError(endpoint, err.message);
    }
    throw err;
  }
}
