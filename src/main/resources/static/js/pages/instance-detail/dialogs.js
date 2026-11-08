// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Hộp thoại dùng trên trang: đóng modal bằng Esc, lệnh SSH (Kết nối), hộp xác nhận, menu Trạng thái máy ảo và Hành động.

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
});

// ---------------- Connect ----------------
function openConnectModal() {
  const inst = det.inst;
  if (!inst) return;
  const key = (inst.keyName || 'my-key').replace(/\.pem$/i, '') + '.pem';
  const user = sshUser(inst);
  const host = inst.publicIp || inst.privateIp || '<elastic-ip>';
  setText('connKeyFile', key);
  setText('connChmod', `chmod 400 "${key}"`);
  setText('connCmdIp', `ssh -i "${key}" ${user}@${host}`);
  setText('connCmdDns', inst.dnsDomain ? `ssh -i "${key}" ${user}@${inst.dnsDomain}` : 'Máy chưa có tên miền Route 53');
  setText('connNote', `User mặc định của ${inst.imageName || 'image này'} là "${user}". Security Group phải mở inbound TCP 22 cho IP của bạn.`
    + (det.groups.some(g => (g.inboundRules || []).some(r => (r.protocol === 'tcp' && r.fromPort <= 22 && r.toPort >= 22) || r.protocol === 'all'))
      ? '' : ' Hiện chưa có rule nào mở cổng 22.'));
  openModal('connectModal');
}

// ---------------- Confirm dialog (thay cho confirm() của trình duyệt) ----------------
function confirmDialog({ title, message, confirmText = 'Xác nhận', cancelText = 'Hủy', danger = false, requireText = '' }) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmModal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmModal';
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'confirmTitle');
      overlay.setAttribute('aria-describedby', 'confirmMsg');
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="modal-card confirm-card ${danger ? 'is-danger' : ''}">
        <div class="confirm-head">
          <span class="confirm-icon" aria-hidden="true">${ICON(danger ? 'ui-warning' : 'ui-info', 'ico-lg')}</span>
          <h2 class="modal-title" id="confirmTitle">${esc(title)}</h2>
        </div>
        <p class="modal-text" id="confirmMsg">${message}</p>
        ${requireText ? `
          <label class="confirm-require" for="confirmInput">Gõ <code>${esc(requireText)}</code> để xác nhận</label>
          <input id="confirmInput" class="form-input" autocomplete="off" spellcheck="false">` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>
        </div>
      </div>`;
    const okBtn = overlay.querySelector('[data-act="ok"]');
    const input = overlay.querySelector('#confirmInput');
    const last = document.activeElement;
    const finish = val => {
      overlay.classList.remove('active');
      document.removeEventListener('keydown', onKey, true);
      overlay.onclick = null;
      if (last && last.focus) last.focus();
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      if (e.key === 'Enter' && !okBtn.disabled && document.activeElement !== overlay.querySelector('[data-act="cancel"]')) { e.preventDefault(); finish(true); }
    };
    overlay.onclick = e => {
      if (e.target === overlay) return finish(false);
      const act = e.target.closest('[data-act]');
      if (act) finish(act.dataset.act === 'ok');
    };
    if (input) input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== requireText; });
    document.addEventListener('keydown', onKey, true);
    overlay.classList.add('active');
    setTimeout(() => (input || overlay.querySelector('[data-act="cancel"]')).focus(), 30);
  });
}


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
