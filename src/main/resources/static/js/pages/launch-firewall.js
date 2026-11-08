// Trang Launch (launch.html), bước 6 "Firewall (security groups)" — Lực.
// Mỗi máy ảo có một Security Group riêng: người dùng soạn rule inbound/outbound ngay lúc tạo máy,
// tạo máy xong thì ghi bộ rule vào nhóm của máy qua PUT /api/network/security-groups/instances/{id}.
// Nạp sau launch.js. Mọi hàm/biến có tiền tố lfw để không trùng tên với file khác.

registerI18n({
  lfwTitle: ['Firewall (Security group)', 'Firewall (security group)'],
  lfwSub: ['Hệ thống tạo một Security Group riêng cho máy này. Chỉ lưu lượng khớp rule bên dưới mới được đi qua; sau khi tạo vẫn sửa được ở tab Security của máy.', 'A dedicated security group is created for this instance. Only traffic that matches the rules below is allowed; you can still edit them later in the instance Security tab.'],
  lfwInbound: ['Inbound rules', 'Inbound rules'],
  lfwOutbound: ['Outbound rules', 'Outbound rules'],
  lfwAddIn: ['+ Thêm inbound rule', '+ Add inbound rule'],
  lfwAddOut: ['+ Thêm outbound rule', '+ Add outbound rule'],
  lfwColType: ['Loại', 'Type'],
  lfwColPort: ['Cổng', 'Port range'],
  lfwColSource: ['Nguồn (CIDR)', 'Source (CIDR)'],
  lfwColDest: ['Đích (CIDR)', 'Destination (CIDR)'],
  lfwColDesc: ['Mô tả', 'Description'],
  lfwWarn: ['Có rule mở cổng khác HTTP/HTTPS cho 0.0.0.0/0 (toàn Internet). Nên giới hạn nguồn, ví dụ trong VPC 10.0.0.0/16.', 'A rule opens a non-HTTP/HTTPS port to 0.0.0.0/0 (the whole Internet). Consider restricting the source, e.g. the VPC 10.0.0.0/16.']
});

const LFW_TYPES = {
  ssh:        { label: 'SSH',          protocol: 'tcp',  from: 22,   to: 22 },
  http:       { label: 'HTTP',         protocol: 'tcp',  from: 80,   to: 80 },
  https:      { label: 'HTTPS',        protocol: 'tcp',  from: 443,  to: 443 },
  mysql:      { label: 'MySQL/Aurora', protocol: 'tcp',  from: 3306, to: 3306 },
  postgres:   { label: 'PostgreSQL',   protocol: 'tcp',  from: 5432, to: 5432 },
  rdp:        { label: 'RDP',          protocol: 'tcp',  from: 3389, to: 3389 },
  'custom-tcp': { label: 'Custom TCP', protocol: 'tcp',  from: 8080, to: 8080, custom: true },
  'custom-udp': { label: 'Custom UDP', protocol: 'udp',  from: 53,   to: 53, custom: true },
  icmp:       { label: 'All ICMP',     protocol: 'icmp', from: 0,    to: 65535 },
  all:        { label: 'All traffic',  protocol: 'all',  from: 0,    to: 65535 }
};

// Mặc định giống EC2 launch wizard: inbound mở SSH, outbound cho phép mọi lưu lượng.
const lfw = {
  inbound: [{ type: 'ssh', from: 22, to: 22, cidr: '0.0.0.0/0', description: 'SSH' }],
  outbound: [{ type: 'all', from: 0, to: 65535, cidr: '0.0.0.0/0', description: '' }]
};

function lfwEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lfwPortText(r) {
  const p = LFW_TYPES[r.type];
  if (p.protocol === 'all' || p.protocol === 'icmp') return 'All';
  return r.from === r.to ? String(r.from) : `${r.from}-${r.to}`;
}

function lfwRenderTable(dir) {
  const body = document.getElementById(dir === 'inbound' ? 'lfwInboundBody' : 'lfwOutboundBody');
  if (!body) return;
  const rows = lfw[dir];
  body.innerHTML = rows.length ? rows.map((r, i) => {
    const p = LFW_TYPES[r.type];
    const portCell = p.custom
      ? `<input class="form-input lfw-port" value="${lfwEsc(lfwPortText(r))}" placeholder="${t('8080 hoặc 8000-8100', '8080 or 8000-8100')}"
           aria-label="Port" onchange="lfwSetPort('${dir}', ${i}, this.value)">`
      : `<span class="mono">${lfwEsc(lfwPortText(r))}</span>`;
    return `<tr>
      <td><select class="form-select" aria-label="Type" onchange="lfwSetType('${dir}', ${i}, this.value)">
        ${Object.entries(LFW_TYPES).map(([k, v]) => `<option value="${k}" ${k === r.type ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select></td>
      <td>${portCell}</td>
      <td><input class="form-input mono" value="${lfwEsc(r.cidr)}" aria-label="CIDR" list="lfwCidrList"
           onchange="lfwSetField('${dir}', ${i}, 'cidr', this.value)"></td>
      <td><input class="form-input" value="${lfwEsc(r.description)}" maxlength="120" aria-label="Description"
           onchange="lfwSetField('${dir}', ${i}, 'description', this.value)"></td>
      <td class="lfw-del"><button type="button" class="ico-btn" title="${t('Xóa rule', 'Remove rule')}" aria-label="${t('Xóa rule', 'Remove rule')}"
           onclick="lfwRemove('${dir}', ${i})">${typeof ICON === 'function' ? ICON('ui-trash') : '×'}</button></td>
    </tr>`;
  }).join('')
    : `<tr><td colspan="5" class="lfw-empty">${dir === 'inbound'
        ? t('Không có inbound rule: mọi kết nối vào máy đều bị chặn (kể cả SSH).', 'No inbound rules: all incoming traffic is blocked (including SSH).')
        : t('Không có outbound rule: hệ thống sẽ dùng mặc định cho phép mọi lưu lượng đi ra.', 'No outbound rules: all outbound traffic will be allowed by default.')}</td></tr>`;
  const count = document.getElementById(dir === 'inbound' ? 'lfwInboundCount' : 'lfwOutboundCount');
  if (count) count.textContent = `(${rows.length})`;
}

function lfwRender() {
  lfwRenderTable('inbound');
  lfwRenderTable('outbound');
  const open = lfw.inbound.some(r => r.cidr.trim() === '0.0.0.0/0' && !['http', 'https'].includes(r.type));
  const warn = document.getElementById('lfwWarn');
  if (warn) warn.hidden = !open;
  if (typeof updatePageLaunchSummary === 'function') updatePageLaunchSummary();
}

function lfwAdd(dir) {
  lfw[dir].push(dir === 'inbound'
    ? { type: 'https', from: 443, to: 443, cidr: '0.0.0.0/0', description: '' }
    : { type: 'all', from: 0, to: 65535, cidr: '0.0.0.0/0', description: '' });
  lfwRender();
}

function lfwRemove(dir, i) {
  lfw[dir].splice(i, 1);
  lfwRender();
}

function lfwSetType(dir, i, type) {
  const p = LFW_TYPES[type];
  Object.assign(lfw[dir][i], { type, from: p.from, to: p.to });
  if (!lfw[dir][i].description || Object.values(LFW_TYPES).some(x => x.label === lfw[dir][i].description)) {
    lfw[dir][i].description = p.custom || type === 'all' ? '' : p.label;
  }
  lfwRender();
}

function lfwSetPort(dir, i, value) {
  const m = String(value).trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
  if (!m || +m[1] > 65535 || (m[2] && (+m[2] > 65535 || +m[2] < +m[1]))) {
    showToast(t('Cổng không hợp lệ. Nhập một số 0-65535 hoặc dải như 8000-8100.', 'Invalid port. Enter 0-65535 or a range like 8000-8100.'), 'error');
    lfwRender();
    return;
  }
  lfw[dir][i].from = +m[1];
  lfw[dir][i].to = m[2] ? +m[2] : +m[1];
}

function lfwSetField(dir, i, field, value) {
  lfw[dir][i][field] = String(value).trim();
  if (field === 'cidr') lfwRender();
}

// Kiểm tra trước khi tạo máy. Trả về chuỗi lỗi, rỗng nếu hợp lệ.
function lfwValidate() {
  const cidrOk = c => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(c) && c.split('/')[0].split('.').every(x => +x <= 255) && +c.split('/')[1] <= 32;
  for (const dir of ['inbound', 'outbound']) {
    for (const r of lfw[dir]) {
      if (!cidrOk(r.cidr)) {
        return t(`CIDR "${r.cidr}" không hợp lệ (${dir}). Ví dụ đúng: 0.0.0.0/0 hoặc 10.0.0.0/16.`, `Invalid CIDR "${r.cidr}" (${dir}). Example: 0.0.0.0/0 or 10.0.0.0/16.`);
      }
    }
  }
  return '';
}

function lfwPayload() {
  const map = r => ({
    protocol: LFW_TYPES[r.type].protocol,
    fromPort: r.from,
    toPort: r.to,
    cidr: r.cidr.trim(),
    description: (r.description || '').trim()
  });
  return { inboundRules: lfw.inbound.map(map), outboundRules: lfw.outbound.map(map) };
}

// Gọi sau khi POST /api/instances thành công: ghi rule vào Security Group riêng của máy vừa tạo.
async function lfwApplyToInstance(instanceId) {
  if (!instanceId) return false;
  try {
    await apiRequest(`/network/security-groups/instances/${encodeURIComponent(instanceId)}`, {
      method: 'PUT',
      body: JSON.stringify(lfwPayload())
    });
    return true;
  } catch (err) {
    showToast(t('Máy đã tạo nhưng chưa ghi được rule Security Group: ', 'Instance created but its security group rules were not saved: ') + lfwEsc(err.message), 'error');
    return false;
  }
}

function lfwSummaryText() {
  return t(`Riêng cho máy · ${lfw.inbound.length} inbound / ${lfw.outbound.length || 1} outbound`,
    `Dedicated · ${lfw.inbound.length} inbound / ${lfw.outbound.length || 1} outbound`);
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('lfwInboundBody')) lfwRender();
});
if (typeof onLangChange === 'function') onLangChange(() => { if (document.getElementById('lfwInboundBody')) lfwRender(); });
