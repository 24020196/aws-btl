// Chỉ dùng cho login.html (trước đây viết thẳng trong thẻ <script> cuối trang).

(function () {
  const existingToken = localStorage.getItem('xregion_jwt');
  const expAt = Number(localStorage.getItem('xregion_jwt_expires_at') || 0);
  if (existingToken && (!expAt || Date.now() < expAt)) {
    window.location.replace('/index.html');
  }

  const savedUser = localStorage.getItem('xregion_last_username');
  if (savedUser) {
    document.getElementById('authUsername').value = savedUser;
  }
})();

const LOGIN_I18N = {
  vi: {
    brandSubtitle: 'Hệ Thống Quản Trị Máy Ảo Đa Vùng',
    signInHeading: 'Đăng nhập người dùng',
    signInDesc: 'Đăng nhập để quản lý máy ảo và hạ tầng đám mây của bạn',
    troubleTitle: 'Tài khoản mặc định để thử nghiệm:',
    troubleAutoFill: 'Bấm vào đây để tự động điền admin / admin123',
    labelUsername: 'Tên đăng nhập',
    rememberAccount: 'Ghi nhớ tài khoản này',
    labelPassword: 'Mật khẩu',
    showPassword: 'Hiển thị mật khẩu',
    havingTrouble: 'Tài khoản mẫu?',
    signInBtn: 'Đăng nhập',
    signingInBtn: 'Đang đăng nhập...',
    orDivider: 'Chưa có tài khoản?',
    createAccountLink: 'Tạo tài khoản mới',
    promoHeadline: 'Triển khai & chuyển vùng máy ảo chỉ trong vài phút.',
    promoSubtext: 'Quản lý vòng đời máy ảo trực quan, tự động sao lưu ổ đĩa và chuyển đổi vùng dự phòng tức thì khi có sự cố hạ tầng.',
    promoCta: 'Bắt đầu trải nghiệm ngay',
    footerPrivacy: 'Bảo mật',
    footerTerms: 'Điều khoản sử dụng',
    footerSwitchLang: '🌐 Switch to English',
    loginSuccessToast: 'Đăng nhập thành công! Đang chuyển hướng...',
    loginErrorPrefix: 'Lỗi đăng nhập:'
  },
  en: {
    brandSubtitle: 'Multi-Region Cloud Console',
    signInHeading: 'User sign in',
    signInDesc: 'Sign in to manage your virtual machines and cloud infrastructure',
    troubleTitle: 'Default demo credentials:',
    troubleAutoFill: 'Click here to auto-fill admin / admin123',
    labelUsername: 'Username',
    rememberAccount: 'Remember this account',
    labelPassword: 'Password',
    showPassword: 'Show Password',
    havingTrouble: 'Demo account?',
    signInBtn: 'Sign in',
    signingInBtn: 'Signing in...',
    orDivider: 'New to XRegion?',
    createAccountLink: 'Create a new account',
    promoHeadline: 'Deploy & migrate virtual machines in minutes.',
    promoSubtext: 'Manage VM lifecycles intuitively with automated disk replication and instant cross-region failover.',
    promoCta: 'Get started now',
    footerPrivacy: 'Privacy',
    footerTerms: 'Terms of Use',
    footerSwitchLang: '🌐 Chuyển sang Tiếng Việt',
    loginSuccessToast: 'Signed in successfully! Redirecting...',
    loginErrorPrefix: 'Sign-in error:'
  }
};

function changeXrLanguage(lang) {
  const targetLang = LOGIN_I18N[lang] ? lang : 'vi';
  localStorage.setItem('xregion_lang', targetLang);
  const select = document.getElementById('xrLangSelect');
  if (select) select.value = targetLang;

  const dict = LOGIN_I18N[targetLang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.innerHTML = dict[key];
    }
  });
}

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
  showToast('Đã điền tài khoản mặc định: admin / admin123', 'success');
}

changeXrLanguage(localStorage.getItem('xregion_lang') || 'vi');

async function handleLoginPageSubmit(e) {
  e.preventDefault();
  const lang = localStorage.getItem('xregion_lang') || 'vi';
  const dict = LOGIN_I18N[lang] || LOGIN_I18N.vi;

  const errBox = document.getElementById('loginErrorBox');
  errBox.style.display = 'none';

  const btn = document.getElementById('loginBtn');
  const origText = dict.signInBtn;
  btn.disabled = true;
  btn.textContent = dict.signingInBtn;

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
      showToast(dict.loginSuccessToast, 'success');
      setTimeout(() => {
        window.location.replace('/index.html');
      }, 500);
    } else {
      throw new Error(data.message || 'Sai tên đăng nhập hoặc mật khẩu.');
    }
  } catch (err) {
    errBox.innerHTML = `<strong>⚠️ ${dict.loginErrorPrefix}</strong> ${err.message}`;
    errBox.style.display = 'block';
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}
