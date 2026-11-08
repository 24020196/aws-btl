// Trang Máy ảo (instances.html) — Lực. Nút "Security group" cạnh Làm mới: xem và sửa inbound/outbound rule
// của Security Group riêng của máy đang chọn, giống bước Firewall lúc tạo máy (dùng lại launch-firewall.js).
// Lưu bằng PUT /api/network/security-groups/instances/{id} (thay toàn bộ rule của nhóm).
// Nạp sau instances.js và launch-firewall.js. Mọi hàm/biến có tiền tố sge.

registerI18n({
  sgeBtn: ['Security group', 'Security group'],
  sgeBtnTitle: ['Xem và sửa rule Security Group của máy đang chọn', 'View and edit the security group rules of the selected instance'],
  sgeTitle: ['Sửa Security Group', 'Edit security group'],
  sgeSub: ['Rule áp dụng cho Security Group riêng của máy này. Bấm "Lưu thay đổi" để ghi; lưu lượng không khớp rule nào bị chặn.', 'Rules apply to this instance\'s own security group. Choose "Save changes" to apply; traffic that matches no rule is blocked.'],
  sgeSave: ['Lưu thay đổi', 'Save changes'],
  sgeCancel: ['Hủy', 'Cancel'],
  sgeLoading: ['Đang tải rule…', 'Loading rules…'],
  sgeDetail: ['Mở tab Security', 'Open Security tab']
});

const sge = { instance: null, group: null, original: '' };

// Rule từ API -> dòng của bảng lfw (type theo LFW_TYPES)
function sgeToRow(r) {
  const protocol = String(r.protocol || '').toLowerCase();
  let type = protocol === 'all' ? 'all' : protocol === 'icmp' ? 'icmp' : protocol === 'udp' ? 'custom-udp' : 'custom-tcp';
  if (protocol === 'tcp' && r.fromPort === r.toPort) {
    const known = Object.entries(LFW_TYPES).find(([, v]) => !v.custom && v.protocol === 'tcp' && v.from === r.fromPort);
    if (known) type = known[0];
  }
  const p = LFW_TYPES[type];
  return {
    type,
    from: p.custom ? r.fromPort : p.from,
    to: p.custom ? r.toPort : p.to,
    cidr: String(r.cidr || ''),
    description: r.description || ''
  };
}

function sgeSnapshot() {
  return JSON.stringify(lfwPayload());
}

function sgeEnsureModal() {
  if (document.getElementById('sgEditModal')) return;
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'sgEditModal';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'sgeTitle');
  el.innerHTML = `
    <div class="modal-card sge-modal">
      <div class="sge-head">
        <div>
          <h2 class="modal-title" id="sgeTitle"></h2>
          <div class="sge-target" id="sgeTarget"></div>
        </div>
        <a class="link-accent sge-detail" id="sgeDetailLink" href="#"></a>
      </div>
      <p class="lfw-sub" id="sgeSub"></p>
      <div class="sge-body" id="sgeBody">
        <div class="lfw-head">
          <h3><span data-i18n="lfwInbound">${tk('lfwInbound')}</span> <span class="muted" id="lfwInboundCount"></span></h3>
          <button type="button" class="btn btn-secondary btn-sm" id="sgeAddIn" onclick="lfwAdd('inbound')"></button>
        </div>
        <div class="table-wrap"><table class="data-table lfw-table">
          <thead><tr>
            <th data-i18n="lfwColType">${tk('lfwColType')}</th><th data-i18n="lfwColPort">${tk('lfwColPort')}</th><th data-i18n="lfwColSource">${tk('lfwColSource')}</th>
            <th data-i18n="lfwColDesc">${tk('lfwColDesc')}</th><th><span class="sr-only" data-i18n="lfwColDel">${tk('lfwColDel')}</span></th>
          </tr></thead>
          <tbody id="lfwInboundBody"></tbody>
        </table></div>
        <div class="form-warn lfw-warn" id="lfwWarn" hidden></div>
        <div class="lfw-head" style="margin-top: 18px;">
          <h3><span data-i18n="lfwOutbound">${tk('lfwOutbound')}</span> <span class="muted" id="lfwOutboundCount"></span></h3>
          <button type="button" class="btn btn-secondary btn-sm" id="sgeAddOut" onclick="lfwAdd('outbound')"></button>
        </div>
        <div class="table-wrap"><table class="data-table lfw-table">
          <thead><tr>
            <th data-i18n="lfwColType">${tk('lfwColType')}</th><th data-i18n="lfwColPort">${tk('lfwColPort')}</th><th data-i18n="lfwColDest">${tk('lfwColDest')}</th>
            <th data-i18n="lfwColDesc">${tk('lfwColDesc')}</th><th><span class="sr-only" data-i18n="lfwColDel">${tk('lfwColDel')}</span></th>
          </tr></thead>
          <tbody id="lfwOutboundBody"></tbody>
        </table></div>
        <datalist id="lfwCidrList"><option value="0.0.0.0/0"><option value="10.0.0.0/16"><option value="10.1.0.0/16"></datalist>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="sgeCancelBtn" onclick="sgeClose()"></button>
        <button type="button" class="btn btn-primary" id="sgeSaveBtn" onclick="sgeSave()"></button>
      </div>
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) sgeClose(); });
  document.addEventListener('keydown', e => {
    const rule = document.getElementById('lfwRuleModal');
    if (e.key === 'Escape' && el.classList.contains('active') && !(rule && rule.classList.contains('active'))) sgeClose();
  });
  document.body.appendChild(el);
}

// Chữ trên hộp thoại (gọi lại khi đổi ngôn ngữ)
function sgeLabels() {
  const set = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };
  set('sgeTitle', tk('sgeTitle'));
  set('sgeSub', tk('sgeSub'));
  set('sgeAddIn', tk('lfwAddIn'));
  set('sgeAddOut', tk('lfwAddOut'));
  set('sgeCancelBtn', tk('sgeCancel'));
  set('sgeSaveBtn', tk('sgeSave'));
  set('sgeDetailLink', tk('sgeDetail'));
  set('lfwWarn', tk('lfwWarn'));
}

function sgeRenderTarget() {
  const inst = sge.instance;
  const g = sge.group;
  const target = document.getElementById('sgeTarget');
  if (!target || !inst) return;
  target.innerHTML = `${ICON('svc-security-group', 'ico-sm')}
    ${g ? `<code>${lfwEsc(g.groupId)}</code> (${lfwEsc(g.name)})` : `<span class="muted">${lfwEsc(tk('sgeLoading'))}</span>`}
    <span class="muted">· ${lfwEsc(inst.name || inst.id)} · <span class="mono">${lfwEsc(inst.id)}</span></span>`;
}

async function openSgEditor() {
  if (selectedInstanceIds.size !== 1) return;
  const id = [...selectedInstanceIds][0];
  const inst = cachedInstances.find(i => i.id === id);
  if (!inst) return;
  sgeEnsureModal();
  sgeLabels();
  sge.instance = inst;
  sge.group = null;
  lfw.region = inst.region;
  lfw.inbound = [];
  lfw.outbound = [];
  document.getElementById('sgeDetailLink').href = `/instance-detail.html?id=${encodeURIComponent(id)}#security`;
  const saveBtn = document.getElementById('sgeSaveBtn');
  saveBtn.disabled = true;
  sgeRenderTarget();
  lfwRender();
  openModal('sgEditModal');

  try {
    const groups = await apiRequest(`/network/security-groups?instanceId=${encodeURIComponent(id)}`);
    if (sge.instance !== inst) return; // người dùng đã đóng / mở máy khác
    const g = (groups || [])[0];
    if (!g) throw new Error(t('Máy chưa có Security Group', 'The instance has no security group'));
    sge.group = g;
    // Rule tham chiếu nhóm khác (nguồn "sg-...") không dùng trong nhóm riêng của máy nên không hiện
    lfw.inbound = (g.inboundRules || []).filter(r => !String(r.cidr).startsWith('sg-')).map(sgeToRow);
    lfw.outbound = (g.outboundRules || []).filter(r => !String(r.cidr).startsWith('sg-')).map(sgeToRow);
    sge.original = sgeSnapshot();
    sgeRenderTarget();
    lfwRender();
    saveBtn.disabled = false;
  } catch (err) {
    closeModal('sgEditModal');
    showToast(t('Không tải được Security Group: ', 'Could not load the security group: ') + lfwEsc(err.message), 'error');
  }
}

async function sgeClose() {
  const modal = document.getElementById('sgEditModal');
  if (!modal || !modal.classList.contains('active')) return;
  if (sge.group && sgeSnapshot() !== sge.original) {
    const ok = await confirmDialog({
      title: t('Bỏ các thay đổi?', 'Discard changes?'),
      message: t('Các rule bạn vừa sửa chưa được lưu.', 'Your rule changes have not been saved.'),
      confirmText: t('Bỏ thay đổi', 'Discard'),
      danger: true
    });
    if (!ok) return;
  }
  closeModal('sgEditModal');
  sge.instance = null;
}

async function sgeSave() {
  if (!sge.instance || !sge.group) return;
  const err = lfwValidate();
  if (err) {
    showToast(err, 'error');
    return;
  }
  if (sgeSnapshot() === sge.original) {
    closeModal('sgEditModal');
    showToast(t('Không có thay đổi nào', 'No changes to save'), 'success');
    return;
  }
  const btn = document.getElementById('sgeSaveBtn');
  btn.disabled = true;
  try {
    const g = await apiRequest(`/network/security-groups/instances/${encodeURIComponent(sge.instance.id)}`, {
      method: 'PUT',
      body: JSON.stringify(lfwPayload())
    });
    const name = (g && g.name) || sge.group.name;
    sge.original = sgeSnapshot();
    closeModal('sgEditModal');
    showToast(t(`Đã lưu rule của ${lfwEsc(name)}: ${lfw.inbound.length} inbound / ${lfw.outbound.length || 1} outbound`,
      `Saved ${lfwEsc(name)}: ${lfw.inbound.length} inbound / ${lfw.outbound.length || 1} outbound`), 'success');
    // Khung tóm tắt bên dưới đang mở tab Security thì vẽ lại cho khớp
    if (typeof loadInstances === 'function') loadInstances();
  } catch (e) {
    showToast(t('Không lưu được rule: ', 'Could not save the rules: ') + lfwEsc(e.message), 'error');
  } finally {
    btn.disabled = false;
  }
}

// Nút chỉ sáng khi chọn đúng 1 máy (giống nút Kết nối)
function sgeSyncButton() {
  const btn = document.getElementById('btnEditSecurityGroup');
  if (!btn) return;
  const one = selectedInstanceIds.size === 1;
  const inst = one ? cachedInstances.find(i => i.id === [...selectedInstanceIds][0]) : null;
  const gone = inst && ['TERMINATED', 'SHUTTING_DOWN', 'TERMINATING'].includes(String(inst.status || '').toUpperCase());
  btn.disabled = !one || !!gone;
}

if (typeof updateSelectionToolbar === 'function') {
  const sgeOrigToolbar = updateSelectionToolbar;
  // eslint-disable-next-line no-global-assign
  updateSelectionToolbar = function () {
    sgeOrigToolbar.apply(this, arguments);
    sgeSyncButton();
  };
}

if (typeof onLangChange === 'function') {
  onLangChange(() => {
    if (!document.getElementById('sgEditModal')) return;
    sgeLabels();
    sgeRenderTarget();
  });
}
