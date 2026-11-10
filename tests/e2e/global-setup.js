// Chuẩn bị trước khi chạy test Playwright trên môi trường AWS thật.
//
// Yêu cầu bắt buộc:
//   1. E2E_ALLOW_REAL_AWS=1 để xác nhận người dùng cho phép tạo tài nguyên thật.
//   2. BASE_URL trỏ tới app backend đã deploy (ví dụ: http://localhost:8081).
//
// Quy trình:
//   - Đăng ký user e2e riêng biệt.
//   - Lấy danh mục Images & Flavors từ API (đảm bảo Image UUID và Flavor hợp lệ theo SPEC-05).
//   - Lưu thông tin phiên làm việc vào %TEMP%/xregion-e2e/state.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

function stop(msg) {
  throw new Error(`\n\n[e2e] DỪNG, chưa chạy bài test nào: ${msg}\n`);
}

const STATE_DIR = path.join(os.tmpdir(), 'xregion-e2e');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

module.exports = async () => {
  // 1. Kiểm tra cờ cho phép chạy trên AWS thật
  if (process.env.E2E_ALLOW_REAL_AWS !== '1' && process.env.E2E_ALLOW_REAL_AWS !== 'true') {
    stop('Thiếu biến môi trường E2E_ALLOW_REAL_AWS=1. ' +
      'Mỗi lần chạy sẽ tạo máy ảo thật trên OpenStack/AWS. ' +
      'Hãy thiết lập E2E_ALLOW_REAL_AWS=1 và BASE_URL=<url> để tiếp tục.');
  }

  // 2. Kiểm tra BASE_URL
  const BASE_URL = (process.env.BASE_URL || '').trim();
  if (!BASE_URL) {
    stop('Thiếu biến môi trường BASE_URL trỏ tới ứng dụng đã deploy (ví dụ: http://localhost:8081).');
  }

  // 3. Kiểm tra kết nối app
  try {
    const health = await fetch(`${BASE_URL}/login.html`);
    if (!health.ok && health.status >= 500) {
      stop(`Không thể truy cập ${BASE_URL}/login.html (status: ${health.status}).`);
    }
  } catch (err) {
    stop(`Không kết nối được tới ${BASE_URL}: ${err.message}`);
  }

  // 4. Tạo tài khoản user e2e ngẫu nhiên
  const username = `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const password = 'Passw0rd!e2e';
  console.log(`[e2e] Đăng ký user test: ${username}`);

  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      email: `${username}@test.local`,
      fullName: 'E2E Test User'
    })
  });

  const regData = await regRes.json().catch(() => ({}));
  if (!regRes.ok || !regData.data?.token) {
    stop(`Đăng ký user thất bại: ${JSON.stringify(regData)}`);
  }
  const token = regData.data.token;
  const user = { username, password, token };

  // 5. Kiểm tra danh mục Images và Flavors từ API
  const imgRes = await fetch(`${BASE_URL}/api/images`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const imgData = await imgRes.json().catch(() => ({}));
  const images = (imgData.data || []).filter(img => img && img.id);
  if (!images.length) {
    stop('Danh mục Images từ /api/images trống. Không có Image UUID hợp lệ để khởi tạo máy.');
  }
  const selectedImage = images[0];

  const flvRes = await fetch(`${BASE_URL}/api/flavors`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const flvData = await flvRes.json().catch(() => ({}));
  const flavors = (flvData.data || []).filter(f => f && (f.name || f.flavorName || f.id || f.flavorId));
  if (!flavors.length) {
    stop('Danh mục Flavors từ /api/flavors trống. Không có Flavor hợp lệ để khởi tạo máy.');
  }
  const preferredFlavor = flavors.find(f => (f.name || f.flavorName) === 'm1.small') || flavors[0];
  const selectedFlavor = preferredFlavor.name || preferredFlavor.flavorName || preferredFlavor.id || preferredFlavor.flavorId;

  // 6. Lưu state khởi đầu phiên làm việc ra thư mục TEMP
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const state = {
    baseUrl: BASE_URL,
    user,
    keyPairName: null,
    imageId: selectedImage.id,
    imageName: selectedImage.name,
    flavor: selectedFlavor,
    vm: null,
    createdAt: Date.now()
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log(`[e2e] Preflight thành công: User [${username}], Image [${selectedImage.id}], Flavor [${selectedFlavor}].`);
};
