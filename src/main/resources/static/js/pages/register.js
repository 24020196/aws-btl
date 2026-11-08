// Chỉ dùng cho register.html

registerI18n({
  brandSubtitle: ['Hệ Thống Quản Trị Máy Ảo Đa Vùng', 'Multi-Region Cloud Console'],
  regHeading: ['Đăng ký người dùng', 'User sign up'],
  regSubheading: ['Tạo tài khoản mới để khởi tạo và quản lý máy ảo của riêng bạn', 'Create a new account to launch and manage your virtual machines'],
  labelFullName: ['Họ và tên', 'Full Name'],
  placeholderFullName: ['VD: Nguyễn Văn A', 'e.g. John Doe'],
  labelUsername: ['Tên đăng nhập *', 'Username *'],
  placeholderUsername: ['VD: alex_dev', 'e.g. alex_dev'],
  labelPassword: ['Mật khẩu *', 'Password *'],
  labelConfirmPassword: ['Nhập lại mật khẩu *', 'Confirm password *'],
  showPassword: ['Hiển thị mật khẩu', 'Show Password'],
  createBtn: ['Đăng ký tài khoản', 'Create account'],
  creatingBtn: ['Đang tạo tài khoản...', 'Creating account...'],
  orDivider: ['Đã có tài khoản?', 'Already have an account?'],
  signInExistingBtn: ['Quay lại đăng nhập', 'Back to sign in'],
  promoHeadline: ['Không gian hạ tầng máy ảo độc lập cho từng tài khoản.', 'Isolated virtual machine workspace for every account.'],
  promoSubtext: ['Sau khi tạo tài khoản, bạn có thể sử dụng đầy đủ các tính năng:', 'Once registered, you have full access to:'],
  feat1: ['Quản lý danh sách máy ảo riêng biệt theo tài khoản', 'Per-user isolated virtual machine instances'],
  feat2: ['Tạo cặp khóa bảo mật SSH (tự động tải file .pem)', 'SSH RSA 2048-bit key pair generation (.pem download)'],
  feat3: ['Di chuyển máy ảo liên vùng không gián đoạn', 'Seamless cross-region live migration'],
  feat4: ['Cấp phát và quản lý mã API Token cá nhân', 'Personal API Token management'],
  footerPrivacy: ['Bảo mật', 'Privacy'],
  footerTerms: ['Điều khoản sử dụng', 'Terms of Use'],
  footerSwitchLang: ['Switch to English', 'Chuyển sang Tiếng Việt'],
  errPassMismatch: ['Mật khẩu xác nhận không trùng khớp!', 'Password confirmation does not match!'],
  regSuccessToast: ['Đăng ký tài khoản thành công! Đang chuyển sang trang Đăng nhập...', 'Account created successfully! Redirecting to Sign in...'],
  regErrorPrefix: ['Lỗi đăng ký:', 'Registration error:']
});

onLangChange(lang => {
  const select = document.getElementById('xrLangSelect');
  if (select) select.value = lang;
});

function toggleShowRegPasswords(show) {
  const p1 = document.getElementById('regPassword');
  const p2 = document.getElementById('regConfirmPassword');
  if (p1) p1.type = show ? 'text' : 'password';
  if (p2) p2.type = show ? 'text' : 'password';
}

async function handleRegisterPageSubmit(e) {
  e.preventDefault();

  const errBox = document.getElementById('registerErrorBox');
  errBox.style.display = 'none';

  const pass = document.getElementById('regPassword').value;
  const confirmPass = document.getElementById('regConfirmPassword').value;
  if (pass !== confirmPass) {
    const iconWarn = typeof ICON === 'function' ? ICON('ui-warning', 'ico-warning') : '';
    errBox.innerHTML = `<strong>${iconWarn} ${tk('regErrorPrefix')}</strong> ${tk('errPassMismatch')}`;
    errBox.style.display = 'block';
    return;
  }

  const btn = document.getElementById('regBtn');
  const origText = tk('createBtn');
  btn.disabled = true;
  btn.textContent = tk('creatingBtn');

  const username = document.getElementById('regUsername').value.trim();
  const payload = {
    fullName: document.getElementById('regFullName').value.trim(),
    username: username,
    password: pass,
    role: 'ROLE_USER'
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
      showToast(tk('regSuccessToast'), 'success');
      setTimeout(() => {
        window.location.replace('/login.html');
      }, 800);
    } else {
      throw new Error(data.message || t('Đăng ký không thành công.', 'Registration failed.'));
    }
  } catch (err) {
    const iconWarn = typeof ICON === 'function' ? ICON('ui-warning', 'ico-warning') : '';
    errBox.innerHTML = `<strong>${iconWarn} ${tk('regErrorPrefix')}</strong> ${err.message}`;
    errBox.style.display = 'block';
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}
