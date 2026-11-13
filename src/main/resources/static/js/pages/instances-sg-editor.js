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
  sgeDetail: ['Mở tab Security', 'Open Security tab'],
  sgeWaitLaunch: ['Máy chưa sẵn sàng (đang tạo hoặc tạo thất bại) nên chưa sửa được Security Group. Bật lại nút khi máy có IP.',
    'The instance is not ready yet (launching or failed), so its security group cannot be edited yet.'],
  sgeStatusSynced: ['Hạ tầng đã xác nhận rule này.', 'The infrastructure confirmed these rules.'],
  sgeStatusPending: ['Đã lưu rule trên hệ thống; đang chờ áp dụng xuống tường lửa của máy.',
    'Rules saved; waiting to be applied to the instance firewall.'],
  sgeStatusFailed: ['Lần đồng bộ gần nhất thất bại; tường lửa có thể chưa khớp với rule đã lưu.',
    'The last sync failed; the firewall may not match the saved rules.'],
  sgeStatusNotApplicable: ['Máy chưa có tài nguyên mạng nên rule chưa được áp dụng.',
    'The instance has no network resources yet, so the rules were not applied.'],
  sgeSavedNoSync: ['Đã lưu rule của {name} ({in} inbound / {out} outbound). Chưa xác nhận tường lửa đã mở cổng.',
    'Saved {name} ({in} inbound / {out} outbound). The firewall is not confirmed to have opened the ports.']
});

const sge = { instance: null, group: null, original: '' };

// Trạng thái máy còn tài nguyên mạng để sửa rule: đang tạo, đang chạy, đã dừng, đang dừng, shelved, đang di trú.
const SGE_APPLICABLE_STATES = ['PENDING', 'RUNNING', 'STOPPED', 'STOPPING', 'SHELVED', 'SHELVED_OFFLOADED', 'MIGRATING'];

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

// Máy còn tài nguyên mạng để áp dụng rule? PENDING (đang tạo) và RUNNING/STOPPED vẫn sửa được;
// FAILED / TERMINATED / đang chuyển trạng thái xóa thì không.
function sgeCanEdit(inst) {
  if (!inst) return false;
  const status = String(inst.status || '').toUpperCase();
  if (!SGE_APPLICABLE_STATES.includes(status)) return false;
  return !!(inst.activeNovaId || inst.privateIp);
}

// Câu mô tả trạng thái đồng bộ: cấu hình đã lưu không đồng nghĩa firewall đã mở cổng.
function sgeStatusText(group) {
  if (!group) return '';
  const status = String(group.syncStatus || '').toUpperCase();
  const base = status === 'SYNCED' ? tk('sgeStatusSynced')
    : status === 'SYNC_FAILED' ? tk('sgeStatusFailed')
        : status === 'SYNC_NOT_APPLICABLE' ? tk('sgeStatusNotApplicable')
          : status === 'SYNC_BLOCKED' ? t('Chưa thể nhận quản lý tường lửa của máy này', 'Cannot manage this firewall yet')
            : status === 'SYNCING' ? t('Đang áp dụng xuống hạ tầng', 'Applying to the infrastructure')
              : tk('sgeStatusPending');
  // Hiện cả revision đã lưu và revision đã xác nhận để người dùng thấy rõ cấu hình nào đang chạy.
  const rev = Number(group.revision || 0);
  const applied = group.appliedRevision == null ? null : Number(group.appliedRevision);
  if (!rev) return base;
  return base + (applied == null
    ? t(` (bản ${rev}, chưa xác nhận áp dụng)`, ` (revision ${rev}, not confirmed applied)`)
    : t(` (bản ${rev}, đã áp dụng bản ${applied})`, ` (revision ${rev}, applied ${applied})`));
}

function sgeRenderStatus() {
  const el = document.getElementById('sgeSync');
  if (!el || !sge.instance) return;
  const group = sge.group;
  el.textContent = sgeStatusText(group);
  el.hidden = !group;
  el.className = 'sge-sync form-warn' + (sge.instance && group && String(group.syncStatus || '') === 'SYNCED' ? ' sge-sync-ok' : '');
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
      <div class="form-warn sge-sync" id="sgeSync" role="status" hidden></div>
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
  // Hiện rõ rule đang có trên hạ tầng mà giao diện không biểu diễn được (vd. tham chiếu nhóm khác).
  const hidden = g ? (g.inboundRules || []).filter(r => String(r.cidr).startsWith('sg-')).length
    + (g.outboundRules || []).filter(r => String(r.cidr).startsWith('sg-')).length : 0;
  target.innerHTML = `${ICON('svc-security-group', 'ico-sm')}
    ${g ? `<code>${lfwEsc(g.groupId)}</code> (${lfwEsc(g.name)})` : `<span class="muted">${lfwEsc(tk('sgeLoading'))}</span>`}
    <span class="muted">· ${lfwEsc(inst.name || inst.id)} · <span class="mono">${lfwEsc(inst.id)}</span></span>
    ${hidden ? `<div class="muted" style="margin-top:4px">${lfwEsc(t('Có ' + hidden + ' rule tham chiếu nhóm khác chưa hiển thị ở đây; cấu hình lưu sẽ không bao gồm chúng.', hidden + ' rule(s) reference another group and are not shown here; saving will not keep them.'))}</div>` : ''}`;
  sgeRenderStatus();
}

async function openSgEditor(targetInst) {
  let inst = targetInst || null;
  if (!inst) {
    if (typeof selectedInstanceIds === 'undefined' || selectedInstanceIds.size !== 1) return;
    const selId = [...selectedInstanceIds][0];
    inst = typeof cachedInstances !== 'undefined' ? cachedInstances.find(i => i.id === selId) : null;
  }
  const id = inst && inst.id;
  if (!inst || !id) {
    showToast(tk('sgeWaitLaunch'), 'error');
    return;
  }
  // Máy đang có Kịch bản chuyển vùng ACTIVE: khóa sửa Security Group và bật pop-up nhắc nhở.
  if (String(inst.scenarioStatus || '').toUpperCase() === 'ACTIVE') {
    if (typeof showScenarioFreezePopup === 'function') {
      showScenarioFreezePopup(id, Boolean(targetInst));
    } else {
      showToast(t('Kịch bản chuyển vùng đang ACTIVE, hãy tạm dừng trước khi sửa Security Group.', 'Migration scenario is ACTIVE; pause it first.'), 'error');
    }
    return;
  }
  // Máy đang tạo / tạo thất bại chưa có tài nguyên mạng: không mở hộp thoại để tránh báo "đã lưu" mà không có gì để áp dụng.
  if (!sgeCanEdit(inst)) {
    showToast(tk('sgeWaitLaunch'), 'error');
    return;
  }
  sgeEnsureModal();
  sgeLabels();
  sge.instance = inst;
  sge.group = null;
  lfw.region = inst.region;
  lfw.inbound = [];
  lfw.outbound = [];
  const detailLink = document.getElementById('sgeDetailLink');
  if (detailLink) {
    detailLink.href = `/instance-detail.html?id=${encodeURIComponent(id)}#security`;
    detailLink.style.display = targetInst ? 'none' : '';
  }
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

/**
 * Phương án B: cấu hình trong editor là toàn bộ rule của Security Group của máy. Xóa SSH/ICMP hoặc toàn bộ
 * outbound sẽ thực sự đóng các quyền đó trên hạ tầng, nên phải xác nhận trước khi lưu.
 */
async function sgeConfirmRiskyRemoval() {
  const before = (sge.group && sge.group.inboundRules || []).map(r => String(r.protocol || '').toLowerCase() + '|'
    + Number(r.fromPort) + '|' + Number(r.toPort)).filter(Boolean);
  const hadSsh = before.includes('tcp|22|22');
  const hasSsh = lfw.inbound.some(r => String(r.protocol || '').toLowerCase() === 'tcp'
    && Number(r.from) === 22 && Number(r.to) === 22);
  const hadOutbound = (sge.group && (sge.group.outboundRules || []).length) > 0;
  const warnings = [];
  if (hadSsh && !hasSsh) warnings.push(t('Bỏ SSH (cổng 22) khỏi máy này', 'Removing SSH (port 22) from this instance'));
  if (hadOutbound && lfw.outbound.length === 0) warnings.push(t('Bỏ toàn bộ rule outbound', 'Removing all outbound rules'));
  if (!warnings.length) return true;
  return confirmDialog({
    title: t('Đóng quyền truy cập?', 'Close this access?'),
    message: t('Cấu hình này là toàn bộ tường lửa của máy. Khi áp dụng: ',
      'This configuration is the whole firewall of the instance. Applying it: ')
      + warnings.join('; ') + t('. Bạn có thể mất kết nối vào máy.', '. You may lose access to the instance.'),
    confirmText: t('Vẫn lưu', 'Save anyway'),
    danger: true
  });
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
  if (!(await sgeConfirmRiskyRemoval())) return;
  const btn = document.getElementById('sgeSaveBtn');
  const saving = sge.instance;
  btn.disabled = true;
  try {
    const body = lfwPayload();
    // Gửi revision đang hiển thị để backend từ chối nếu người khác đã sửa trước.
    body.expectedRevision = Number(sge.group.revision || 0);
    const g = await apiRequest(`/network/security-groups/instances/${encodeURIComponent(saving.id)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    // PUT 200/202 chỉ nghĩa là cấu hình đã được ghi và (có thể) đã gửi xuống hạ tầng.
    // Trạng thái syncStatus cho biết tường lửa của máy đã thực sự mở cổng hay chưa.
    const inCount = lfw.inbound.length;
    const outCount = lfw.outbound.length;
    // Snapshot chỉ được cập nhật khi lưu thành công, nếu không người dùng mất dấu thay đổi chưa lưu.
    sge.group = g || sge.group;
    sge.original = sgeSnapshot();
    const name = (g && g.name) || sge.group.name;
    closeModal('sgEditModal');
    const synced = g && String(g.syncStatus || '').toUpperCase() === 'SYNCED';
    const silent = !g || g.eventPublished === false;
    const msg = silent
      ? tk('sgeSavedNoSync').replace('{name}', lfwEsc(name)).replace('{in}', inCount).replace('{out}', outCount)
      : t(`Đã lưu rule của ${lfwEsc(name)}: ${inCount} inbound / ${outCount} outbound. ${sgeStatusText(g)}`,
          `Saved ${lfwEsc(name)}: ${inCount} inbound / ${outCount} outbound. ${sgeStatusText(g)}`);
    showToast(msg, synced ? 'success' : 'info');
    // Khung tóm tắt bên dưới đang mở tab Security thì vẽ lại cho khớp
    if (typeof loadInstances === 'function') loadInstances();
    if (typeof loadSecurityAndNetwork === 'function') loadSecurityAndNetwork();
  } catch (e) {
    // Giữ nguyên sge.original để dấu "chưa lưu" còn đúng, người dùng có thể sửa và lưu lại.
    showToast(t('Không lưu được rule: ', 'Could not save the rules: ') + lfwEsc(e.message), 'error');
  } finally {
    btn.disabled = false;
  }
}

// Nút chỉ sáng khi chọn đúng 1 máy còn tài nguyên mạng (giống nút Kết nối). Máy chưa có trong danh sách
// hoặc đang tạo thất bại / đã xóa thì không mở được hộp thoại.
function sgeSyncButton() {
  const btn = document.getElementById('btnEditSecurityGroup');
  if (!btn) return;
  const one = selectedInstanceIds.size === 1;
  const inst = one ? cachedInstances.find(i => i.id === [...selectedInstanceIds][0]) : null;
  const editable = sgeCanEdit(inst);
  btn.disabled = !one || !editable;
  btn.title = editable ? tk('sgeBtnTitle') : tk('sgeWaitLaunch');
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

// Đánh dấu nút Security group theo trạng thái thật của máy, không chỉ theo số máy đang chọn.
document.addEventListener('DOMContentLoaded', () => {
  if (typeof cachedInstances !== 'undefined' && typeof sgeSyncButton === 'function') sgeSyncButton();
});
