// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Hộp thoại dùng trên trang: đóng modal bằng Esc, lệnh SSH (Kết nối), hộp xác nhận, menu Trạng thái máy ảo và Hành động.

registerI18n({
  detConnTitle: ['Kết nối tới máy ảo', 'Connect to instance'],
  detConnStep1a: ['Mở terminal ở thư mục chứa file khóa', 'Open a terminal in the folder with the key file'],
  detConnStep1b: ['đã tải lúc tạo Key Pair.', 'downloaded when the key pair was created.'],
  detConnStep2: ['Trên Linux/macOS, giới hạn quyền đọc file khóa (tránh lỗi WARNING: UNPROTECTED PRIVATE KEY FILE!):', 'On Linux/macOS, restrict key file permissions (avoids WARNING: UNPROTECTED PRIVATE KEY FILE!):'],
  detConnStep2Win: ['Trên Windows (PowerShell), chạy lệnh sau để tránh lỗi WARNING: UNPROTECTED PRIVATE KEY FILE!:', 'On Windows (PowerShell), run this command to avoid WARNING: UNPROTECTED PRIVATE KEY FILE!:'],
  detConnCopyPermAria: ['Sao chép lệnh phân quyền', 'Copy permission command'],
  detConnStep3: ['Kết nối bằng Elastic IP:', 'Connect with the Elastic IP:'],
  detConnCopyAria: ['Sao chép lệnh SSH', 'Copy SSH command'],
  detConnDns: ['Hoặc dùng tên miền Route 53, vẫn đúng sau khi chuyển vùng:', 'Or use the Route 53 domain, which keeps working after a migration:'],
  detConnCopyDnsAria: ['Sao chép lệnh SSH theo tên miền', 'Copy SSH command (domain)']
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
});

// ---------------- Connect ----------------
function openConnectModal() {
  if (typeof ensureDynamoDataReady === 'function' && !ensureDynamoDataReady()) return;
  const inst = det.inst;
  if (!inst) return;
  const key = (inst.keyName || 'my-key').replace(/\.pem$/i, '') + '.pem';
  const user = sshUser(inst);
  const host = inst.publicIp || inst.privateIp || '<elastic-ip>';
  setText('connKeyFile', key);
  setText('connChmod', `chmod 400 "${key}"`);
  setText('connIcacls', `icacls "${key}" /inheritance:r /grant:r "$($env:USERNAME):R"`);
  setText('connCmdIp', `ssh -i "${key}" ${user}@${host}`);
  setText('connCmdDns', inst.dnsDomain ? `ssh -i "${key}" ${user}@${inst.dnsDomain}` : t('Máy chưa có tên miền Route 53', 'No Route 53 domain yet'));
  const imgName = (inst.imageId && typeof KNOWN_IMAGE_MAP !== 'undefined' && KNOWN_IMAGE_MAP[inst.imageId] && KNOWN_IMAGE_MAP[inst.imageId].name) || inst.imageName || 'image này';
  setText('connNote', t(`User mặc định của ${imgName} là "${user}". Security Group phải mở inbound TCP 22 cho IP của bạn.`,
    `The default user of ${imgName} is "${user}". A security group must allow inbound TCP 22 from your IP.`)
    + (det.groups.some(g => (g.inboundRules || []).some(r => (r.protocol === 'tcp' && r.fromPort <= 22 && r.toPort >= 22) || r.protocol === 'all'))
      ? '' : t(' Hiện chưa có rule nào mở cổng 22.', ' No rule opens port 22 yet.')));
  openModal('connectModal');
}

// confirmDialog() nằm trong js/core/ui.js (dùng chung mọi trang).

// ---------------- Instance state & Actions dropdowns ----------------
function toggleStateMenu(force) {
  const list = document.getElementById('stateMenuList');
  const btn = document.getElementById('stateMenuBtn');
  if (!list || !btn) return;
  const open = force !== undefined ? force : list.hidden;
  if (open) closeEc2ActionsMenu();
  list.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const first = list.querySelector('.state-menu-item:not([disabled])');
    if (first) first.focus();
  }
}

function closeStateMenu() { toggleStateMenu(false); }

function toggleEc2ActionsMenu(force) {
  const list = document.getElementById('ec2ActionsList');
  const btn = document.getElementById('ec2ActionsBtn');
  if (!list || !btn) return;
  const open = force !== undefined ? force : list.hidden;
  if (open) closeStateMenu();
  list.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeEc2ActionsMenu() { toggleEc2ActionsMenu(false); }

document.addEventListener('click', e => {
  if (!e.target.closest('#stateMenu')) closeStateMenu();
  if (!e.target.closest('#ec2ActionsMenu')) closeEc2ActionsMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeEc2ActionsMenu();
  }
  const list = document.getElementById('stateMenuList');
  if (!list || list.hidden) return;
  if (e.key === 'Escape') { closeStateMenu(); document.getElementById('stateMenuBtn').focus(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...list.querySelectorAll('.state-menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    if (items[next]) items[next].focus();
  }
});
