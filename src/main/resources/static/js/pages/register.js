// Chỉ dùng cho register.html (trước đây viết thẳng trong thẻ <script> cuối trang).

const REG_I18N = {
  vi: {
    brandSubtitle: 'Hệ Thống Quản Trị Máy Ảo Đa Vùng',
    regHeading: 'Đăng ký người dùng',
    regSubheading: 'Tạo tài khoản mới để khởi tạo và quản lý máy ảo của riêng bạn',
    labelFullName: 'Họ và tên',
    labelUsername: 'Tên đăng nhập *',
    labelPassword: 'Mật khẩu *',
    labelConfirmPassword: 'Nhập lại mật khẩu *',
    showPassword: 'Hiển thị mật khẩu',
    labelRole: 'Vai trò người dùng',
    createBtn: 'Đăng ký tài khoản',
    creatingBtn: 'Đang tạo tài khoản...',
    orDivider: 'Đã có tài khoản?',
    signInExistingBtn: 'Quay lại đăng nhập',
    promoHeadline: 'Không gian hạ tầng máy ảo độc lập cho từng tài khoản.',
    promoSubtext: 'Sau khi tạo tài khoản, bạn có thể sử dụng đầy đủ các tính năng:',
    feat1: '✓ Quản lý danh sách máy ảo riêng biệt theo tài khoản',
    feat2: '✓ Tạo cặp khóa bảo mật SSH (tự động tải file .pem)',
    feat3: '✓ Di chuyển máy ảo liên vùng không gián đoạn',
    feat4: '✓ Cấp phát và quản lý mã API Token cá nhân',
    footerPrivacy: 'Bảo mật',
    footerTerms: 'Điều khoản sử dụng',
    footerSwitchLang: '🌐 Switch to English',
    errPassMismatch: 'Mật khẩu xác nhận không trùng khớp!',
    regSuccessToast: 'Đăng ký tài khoản thành công! Đang chuyển sang trang Đăng nhập...',
    regErrorPrefix: 'Lỗi đăng ký:'
  },
  en: {
    brandSubtitle: 'Multi-Region Cloud Console',
    regHeading: 'User sign up',
    regSubheading: 'Create a new account to launch and manage your virtual machines',
    labelFullName: 'Full Name',
    labelUsername: 'Username *',
    labelPassword: 'Password *',
    labelConfirmPassword: 'Confirm password *',
    showPassword: 'Show Password',
    labelRole: 'User Role',
    createBtn: 'Create account',
    creatingBtn: 'Creating account...',
    orDivider: 'Already have an account?',
    signInExistingBtn: 'Back to sign in',
    promoHeadline: 'Isolated virtual machine workspace for every account.',
    promoSubtext: 'Once registered, you have full access to:',
    feat1: '✓ Per-user isolated virtual machine instances',
    feat2: '✓ SSH RSA 2048-bit key pair generation (.pem download)',
    feat3: '✓ Seamless cross-region live migration',
    feat4: '✓ Personal API Token management',
    footerPrivacy: 'Privacy',
    footerTerms: 'Terms of Use',
    footerSwitchLang: '🌐 Chuyển sang Tiếng Việt',
    errPassMismatch: 'Password confirmation does not match!',
    regSuccessToast: 'Account created successfully! Redirecting to Sign in...',
    regErrorPrefix: 'Registration error:'
  }
};

function changeXrRegisterLanguage(lang) {
  const targetLang = REG_I18N[lang] ? lang : 'vi';
  localStorage.setItem('xregion_lang', targetLang);
  const select = document.getElementById('xrLangSelect');
  if (select) select.value = targetLang;

  const dict = REG_I18N[targetLang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.innerHTML = dict[key];
    }
  });
}

function toggleShowRegPasswords(show) {
  const p1 = document.getElementById('regPassword');
  const p2 = document.getElementById('regConfirmPassword');
  if (p1) p1.type = show ? 'text' : 'password';
  if (p2) p2.type = show ? 'text' : 'password';
}

changeXrRegisterLanguage(localStorage.getItem('xregion_lang') || 'vi');

async function handleRegisterPageSubmit(e) {
  e.preventDefault();
  const lang = localStorage.getItem('xregion_lang') || 'vi';
  const dict = REG_I18N[lang] || REG_I18N.vi;

  const errBox = document.getElementById('registerErrorBox');
  errBox.style.display = 'none';

  const pass = document.getElementById('regPassword').value;
  const confirmPass = document.getElementById('regConfirmPassword').value;
  if (pass !== confirmPass) {
    errBox.innerHTML = `<strong>⚠️ ${dict.regErrorPrefix}</strong> ${dict.errPassMismatch}`;
    errBox.style.display = 'block';
    return;
  }

  const btn = document.getElementById('regBtn');
  const origText = dict.createBtn;
  btn.disabled = true;
  btn.textContent = dict.creatingBtn;

  const username = document.getElementById('regUsername').value.trim();
  const payload = {
    fullName: document.getElementById('regFullName').value.trim(),
    username: username,
    password: pass,
    role: document.getElementById('regRole').value
  };

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (res.ok) {
      localStorage.setItem('xregion_last_username', username);
      showToast(dict.regSuccessToast, 'success');
      setTimeout(() => {
        window.location.replace('/login.html');
      }, 800);
    } else {
      throw new Error(data.message || 'Đăng ký không thành công.');
    }
  } catch (err) {
    errBox.innerHTML = `<strong>⚠️ ${dict.regErrorPrefix}</strong> ${err.message}`;
    errBox.style.display = 'block';
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}
