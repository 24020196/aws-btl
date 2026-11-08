// Chỉ dùng cho login.html

(function () {
  const existingToken = localStorage.getItem('xregion_jwt');
  const expAt = Number(localStorage.getItem('xregion_jwt_expires_at') || 0);
  if (existingToken && (!expAt || Date.now() < expAt)) {
    window.location.replace('/instances.html');
  }

  const savedUser = localStorage.getItem('xregion_last_username');
  if (savedUser) {
    const userInput = document.getElementById('authUsername');
    if (userInput) userInput.value = savedUser;
  }
})();

// Đăng ký từ điển i18n cho trang đăng nhập
registerI18n({
  loginTitle: ['Đăng nhập — XRegion Cloud Console', 'Sign in — XRegion Cloud Console'],
  brandSubtitle: ['Hệ Thống Quản Trị Máy Ảo Đa Vùng', 'Multi-Region Cloud Console'],
  signInHeading: ['Đăng nhập người dùng', 'User sign in'],
  signInDesc: ['Đăng nhập để quản lý máy ảo và hạ tầng đám mây của bạn', 'Sign in to manage your virtual machines and cloud infrastructure'],
  troubleTitle: ['Tài khoản mặc định để thử nghiệm:', 'Default demo credentials:'],
  troubleAutoFill: ['Bấm vào đây để tự động điền admin / admin123', 'Click here to auto-fill admin / admin123'],
  labelUsername: ['Tên đăng nhập', 'Username'],
  placeholderUsername: ['Nhập tên đăng nhập', 'Enter username'],
  rememberAccount: ['Ghi nhớ tài khoản này', 'Remember this account'],
  labelPassword: ['Mật khẩu', 'Password'],
  showPassword: ['Hiển thị mật khẩu', 'Show Password'],
  havingTrouble: ['Tài khoản mẫu?', 'Demo account?'],
  signInBtn: ['Đăng nhập', 'Sign in'],
  signingInBtn: ['Đang đăng nhập...', 'Signing in...'],
  orDivider: ['Chưa có tài khoản?', 'New to XRegion?'],
  createAccountLink: ['Tạo tài khoản mới', 'Create a new account'],
  promoHeadline: ['Triển khai & chuyển vùng máy ảo chỉ trong vài phút.', 'Deploy & migrate virtual machines in minutes.'],
  promoSubtext: [
    'Quản lý vòng đời máy ảo trực quan, tự động sao lưu ổ đĩa và chuyển đổi vùng dự phòng tức thì khi có sự cố hạ tầng.',
    'Manage VM lifecycles intuitively with automated disk replication and instant cross-region failover.'
  ],
  promoCta: ['Bắt đầu trải nghiệm ngay', 'Get started now'],
  footerPrivacy: ['Bảo mật', 'Privacy'],
  footerTerms: ['Điều khoản sử dụng', 'Terms of Use'],
  footerSwitchLang: ['Switch to English', 'Chuyển sang Tiếng Việt'],
  loginSuccessToast: ['Đăng nhập thành công! Đang chuyển hướng...', 'Signed in successfully! Redirecting...'],
  loginErrorPrefix: ['Lỗi đăng nhập:', 'Sign-in error:']
});

function syncLoginPageLang(lang) {
  const currentLang = lang || getLang();
  const select = document.getElementById('xrLangSelect');
  if (select && select.value !== currentLang) select.value = currentLang;
  document.title = tk('loginTitle');
}

onLangChange(lang => {
  syncLoginPageLang(lang);
});

// Đồng bộ trạng thái ngôn ngữ ngay khi trang đăng nhập được nạp
syncLoginPageLang();


function toggleShowLoginPassword(show) {
  const passInput = document.getElementById('authPassword');
  if (passInput) {
    passInput.type = show ? 'text' : 'password';
  }
}

function toggleTroubleBox() {
  const box = document.getElementById('troubleHintBox');
  if (box) {
    box.style.display = box.style.display === 'block' ? 'none' : 'block';
  }
}

function fillDefaultAdminCredentials() {
  document.getElementById('authUsername').value = 'admin';
  document.getElementById('authPassword').value = 'admin123';
  showToast(t('Đã điền tài khoản mặc định: admin / admin123', 'Filled demo account: admin / admin123'), 'success');
}

async function handleLoginPageSubmit(e) {
  e.preventDefault();

  const errBox = document.getElementById('loginErrorBox');
  errBox.style.display = 'none';

  const btn = document.getElementById('loginBtn');
  const origText = tk('signInBtn');
  btn.disabled = true;
  btn.textContent = tk('signingInBtn');

  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const remember = document.getElementById('rememberAccountBox').checked;

  if (remember) {
    localStorage.setItem('xregion_last_username', username);
  } else {
    localStorage.removeItem('xregion_last_username');
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (res.ok && data.data && data.data.token) {
      const expiresAt = data.data.expiresAt || (Date.now() + (data.data.expiresIn || 86400) * 1000);
      localStorage.setItem('xregion_jwt', data.data.token);
      localStorage.setItem('xregion_user', data.data.fullName || username);
      localStorage.setItem('xregion_jwt_expires_at', String(expiresAt));
      showToast(tk('loginSuccessToast'), 'success');
      setTimeout(() => {
        window.location.replace('/instances.html');
      }, 500);
    } else {
      throw new Error(data.message || t('Sai tên đăng nhập hoặc mật khẩu.', 'Invalid username or password.'));
    }
  } catch (err) {
    const iconWarn = typeof ICON === 'function' ? ICON('ui-warning', 'ico-warning') : '';
    errBox.innerHTML = `<strong>${iconWarn} ${tk('loginErrorPrefix')}</strong> ${err.message}`;
    errBox.style.display = 'block';
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}
