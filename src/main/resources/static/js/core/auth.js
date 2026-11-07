// Đăng nhập, đăng ký, đăng xuất.

// Authentication
async function submitLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;

  try {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok && data.data && data.data.token) {
      authToken = data.data.token;
      const expiresAt = data.data.expiresAt || (getSyncedNowMs() + (data.data.expiresIn || 86400) * 1000);
      localStorage.setItem('xregion_jwt', authToken);
      localStorage.setItem('xregion_user', data.data.fullName || username);
      localStorage.setItem('xregion_jwt_expires_at', String(expiresAt));
      document.getElementById('userNameDisplay').textContent = data.data.fullName || username;
      closeModal('loginModal');
      clearApiError();
      showToast('Đăng nhập thành công với vai trò Administrator!', 'success');
      loadInstances();
    } else {
      const msg = data.message || 'Sai thông tin đăng nhập';
      showApiError('/auth/login', msg, res.status);
      alert('Đăng nhập thất bại: ' + msg);
    }
  } catch (err) {
    showApiError('/auth/login', err.message);
    alert('Lỗi đăng nhập: ' + err.message);
  }
}

function logout() {
  localStorage.removeItem('xregion_jwt');
  localStorage.removeItem('xregion_user');
  localStorage.removeItem('xregion_jwt_expires_at');
  authToken = '';
  showToast('Đã đăng xuất khỏi hệ thống', 'success');
  setTimeout(() => {
    window.location.replace('/login.html');
  }, 400);
}

function switchToRegister() {
  closeModal('loginModal');
  openModal('registerModal');
}

function switchToLogin() {
  closeModal('registerModal');
  openModal('loginModal');
}

async function submitRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUser').value.trim();
  const fullName = document.getElementById('regFullName').value.trim();
  const password = document.getElementById('regPass').value;
  const confirmPass = document.getElementById('regPassConfirm').value;

  if (password !== confirmPass) {
    alert('Mật khẩu xác nhận không khớp!');
    return;
  }

  try {
    const res = await fetch(API_BASE + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, fullName })
    });
    const data = await res.json();
    if (res.ok && data.data && data.data.token) {
      authToken = data.data.token;
      localStorage.setItem('xregion_jwt', authToken);
      document.getElementById('userNameDisplay').textContent = data.data.fullName || username;
      document.getElementById('registerForm').reset();
      closeModal('registerModal');
      alert('Đăng ký tài khoản thành công!');
      loadInstances();
    } else {
      alert('Đăng ký thất bại: ' + (data.message || 'Tài khoản đã tồn tại hoặc dữ liệu không hợp lệ'));
    }
  } catch (err) {
    alert('Lỗi đăng ký: ' + err.message);
  }
}
