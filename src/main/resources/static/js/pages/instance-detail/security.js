// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Tab Security (Security Group riêng của máy, thêm/xóa rule inbound/outbound) và tab Networking (VPC/ENI, Route 53).

registerI18n({
  detSgSub: ['Mỗi máy ảo có một Security Group riêng. Lưu lượng chỉ đi qua khi khớp ít nhất một rule inbound/outbound.', 'Each instance has its own security group. Traffic is allowed only if it matches at least one inbound/outbound rule.'],
  detRuleAdd: ['+ Thêm inbound rule', '+ Add inbound rule'],
  detRuleAddOut: ['+ Thêm outbound rule', '+ Add outbound rule'],
  detRuleFilter: ['Lọc rule (cổng, nguồn, mô tả…)', 'Filter rules (port, source, description…)'],
  detRuleFilterAria: ['Lọc rule inbound và outbound', 'Filter inbound and outbound rules'],
  detColProto: ['Giao thức', 'Protocol'],
  detColSource: ['Nguồn', 'Source'],
  detColDest: ['Đích', 'Destination'],
  detColActions: ['Thao tác', 'Actions'],
  detNetTitle: ['Mạng & Route 53', 'Networking & Route 53'],
  detDnsUpdate: ['Cập nhật Route 53 DNS', 'Update Route 53 record'],
  detDomain: ['Tên miền', 'Domain name'],
  detDnsTarget: ['Bản ghi A đang trỏ tới', 'A record points to'],
  detDnsSync: ['Đồng bộ với Elastic IP', 'Matches Elastic IP'],
  detEniTitle: ['Giao diện mạng (ENI)', 'Network interface (ENI)'],
  detEniSub: ['Máy ảo không có ENI riêng: nó dùng một secondary IP trên ENI của máy chủ EC2 Bare Metal, Elastic IP được NAT 1:1 vào IP đó.', 'The instance has no ENI of its own: it uses a secondary IP on the EC2 Bare Metal host ENI, and the Elastic IP is 1:1 NATed to that IP.'],
  detEniAttached: ['Gắn vào', 'Attached to'],
  detEniSecondary: ['Secondary IP (máy ảo)', 'Secondary IP (instance)'],
  detRuleModalTitle: ['Thêm rule', 'Add rule'],
  detRuleDir: ['Chiều', 'Direction'],
  detRuleIn: ['Inbound (vào máy)', 'Inbound'],
  detRuleOut: ['Outbound (ra ngoài)', 'Outbound'],
  detRulePorts: ['Cổng (hoặc dải cổng)', 'Port range'],
  detRuleTo: ['đến', 'to'],
  detRuleCidrTitle: ['CIDR, ví dụ 0.0.0.0/0 hoặc 10.0.0.0/16', 'CIDR, e.g. 0.0.0.0/0 or 10.0.0.0/16'],
  detRuleAnywhere: ['Mọi nơi 0.0.0.0/0', 'Anywhere 0.0.0.0/0'],
  detRuleWarn: ['Cổng này đang mở cho toàn Internet. Chỉ nên làm vậy với HTTP/HTTPS.', 'This port is open to the whole Internet. Only do this for HTTP/HTTPS.'],
  detRuleDesc: ['Mô tả (không bắt buộc)', 'Description (optional)'],
  detRuleDescPh: ['Ví dụ: API nội bộ', 'e.g. internal API'],
  detRuleSubmit: ['Thêm rule', 'Add rule'],
  detDnsTitle: ['Cập nhật bản ghi Route 53', 'Update Route 53 record'],
  detDnsTargetIp: ['Trỏ tới IP', 'Target IP'],
  detDnsIpTitle: ['Địa chỉ IPv4', 'IPv4 address'],
  detDnsTtl: ['TTL (giây)', 'TTL (seconds)'],
  detDnsNote: ['Mặc định là Elastic IP hiện tại của máy. Sau mỗi lần chuyển vùng, hệ thống tự cập nhật bản ghi này.', 'Defaults to the current Elastic IP. The record is updated automatically after every migration.'],
  detDnsSubmit: ['Cập nhật DNS', 'Update DNS']
});

// ---------------- Security groups & network ----------------
// SPEC-04 §5: backend đã loại bỏ hẳn GET /api/network (dữ liệu VPC/ENI giả lập). Trang này chỉ
// gọi các endpoint nghiệp vụ còn lại; bản ghi DNS được hiển thị theo đúng cách backend sinh ra
// nó (dns + elastic_ip, TTL 60) thay vì gọi endpoint đã bị xóa.
async function loadSecurityAndNetwork() {
  // Mỗi máy có đúng một Security Group riêng (backend tự tạo nếu máy chưa có).
  const attached = document.getElementById('tab-security')
    ? await apiRequest(`/network/security-groups?instanceId=${encodeURIComponent(det.id)}`).catch(() => null)
    : null;
  det.groups = attached || [];
  det.vpc = null;
  const publicIp = det.inst.publicIp && det.inst.publicIp !== 'Chưa gán' ? det.inst.publicIp : '';
  det.dns = (det.inst.dnsDomain && publicIp)
    ? { domainName: det.inst.dnsDomain, targetIp: publicIp, ttl: 60 }
    : null;
  renderSecurityGroups();
  renderNetwork();
}

function ruleType(rule) {
  const p = rule.protocol;
  if (p === 'all') return 'All traffic';
  if (p === 'icmp') return 'All ICMP';
  if (p === 'tcp' && rule.fromPort === rule.toPort) {
    const known = { 22: 'SSH', 80: 'HTTP', 443: 'HTTPS', 3306: 'MySQL/Aurora', 5432: 'PostgreSQL', 3389: 'RDP' };
    if (known[rule.fromPort]) return known[rule.fromPort];
  }
  return p === 'udp' ? 'Custom UDP' : 'Custom TCP';
}

function rulePorts(rule) {
  if (rule.protocol === 'all' || rule.protocol === 'icmp') return 'All';
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort} – ${rule.toPort}`;
}

function ruleRows(direction) {
  const rows = [];
  det.groups.forEach(g => {
    (g[direction === 'inbound' ? 'inboundRules' : 'outboundRules'] || []).forEach(r => rows.push({ g, r }));
  });
  return rows;
}

function ruleMatches(g, r, q) {
  if (!q) return true;
  return [g.groupId, g.name, r.ruleId, ruleType(r), r.protocol, rulePorts(r), r.cidr, r.description]
    .some(v => String(v || '').toLowerCase().includes(q));
}

function renderSecurityGroups() {
  setHtml('sgChips', det.groups.length
    ? det.groups.map(g => `
        <span class="sg-chip" title="${esc(g.description || g.name)}">
          ${ICON('svc-security-group', 'ico-md')} <span class="muted">Security group</span> <code>${esc(g.groupId)}</code> <span>(${esc(g.name)})</span>
        </span>`).join('')
    : `<span class="muted">${t('Không tải được Security Group của máy.', 'Could not load the security group.')}</span>`);

  const filterEl = document.getElementById('ruleFilter');
  const q = filterEl ? filterEl.value.trim().toLowerCase() : '';
  ['inbound', 'outbound'].forEach(dir => {
    const all = ruleRows(dir);
    const rows = all.filter(({ g, r }) => ruleMatches(g, r, q));
    setText(dir + 'Count', q ? `(${rows.length}/${all.length})` : `(${all.length})`);
    setHtml(dir + 'RulesBody', rows.length
      ? rows.map(({ g, r }) => {
          const open = dir === 'inbound' && r.cidr === '0.0.0.0/0' && ![80, 443].includes(r.fromPort);
          return `<tr>
            <td class="mono muted">${esc(r.ruleId || '–')}</td>
            <td>${esc(ruleType(r))}</td>
            <td class="mono">${esc(rulePorts(r))}</td>
            <td><span class="proto">${esc(String(r.protocol).toUpperCase())}</span></td>
            <td class="mono nowrap">${esc(r.cidr)}${open ? ` <span class="tag-open" title="${t('Mở cho toàn Internet', 'Open to the whole Internet')}">${t('mở công khai', 'public')}</span>` : ''}</td>
            <td>${esc(r.description || '–')}</td>
            <td class="rule-actions">${r.deletable
              ? `<button class="btn btn-danger btn-sm" onclick="deleteRule('${esc(g.groupId)}', '${esc(r.ruleId)}', '${dir}')" aria-label="${t('Xóa rule', 'Delete rule')} ${esc(ruleType(r))} ${esc(rulePorts(r))}">${t('Xóa', 'Delete')}</button>`
              : '<span class="muted">–</span>'}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="7" class="empty-cell">${q && all.length
          ? t(`Không có ${dir} rule nào khớp "${esc(q)}".`, `No ${dir} rules match "${esc(q)}".`)
          : t(`Chưa có ${dir} rule nào. Bấm "Thêm ${dir} rule" để mở cổng.`, `No ${dir} rules. Choose "Add ${dir} rule" to open a port.`)}</td></tr>`);
  });
}

function renderNetwork() {
  const inst = det.inst;
  const vpc = det.vpc;
  setText('netVpcId', vpc ? vpc.id : '–');
  setText('netVpcCidr', vpc ? vpc.cidr : '');
  setText('netSubnetId', vpc ? vpc.primarySubnetId : '–');
  setText('netSubnetCidr', vpc && vpc.primarySubnetCidr ? vpc.primarySubnetCidr : '');
  setText('netPrivateIp', inst.privateIp || '–');
  const pubIp = inst.publicIp && inst.publicIp !== 'Chưa gán' ? inst.publicIp : '–';
  setText('netPublicIp', pubIp);
  setText('netDomain', inst.dnsDomain || '–');
  setHtml('eniBody', vpc && vpc.bareMetalEniId
    ? `<tr>
        <td class="mono">${esc(vpc.bareMetalEniId)}</td>
        <td>EC2 Bare Metal · ${esc(vpc.primarySubnetId || '')}</td>
        <td class="mono">${esc(vpc.bareMetalPrivateIp || '–')}</td>
        <td class="mono">${esc(inst.privateIp || '–')}</td>
        <td class="mono">${esc(pubIp)}</td>
        <td>1:1 NAT (iptables DNAT/SNAT)</td>
        <td><span class="muted">${t('Tắt (để định tuyến IP máy ảo)', 'Disabled (to route the instance IP)')}</span></td>
      </tr>`
    : `<tr><td colspan="7" class="empty-cell">${t('Máy ảo không có ENI riêng: dùng NAT 1:1 trên ENI dùng chung của máy chủ.', 'No dedicated ENI: the instance uses 1:1 NAT on the shared host ENI.')}</td></tr>`);

  const target = det.dns ? det.dns.targetIp : null;
  setText('netDnsTarget', target || t('Chưa có bản ghi', 'No record'));
  setText('netDnsTtl', det.dns ? t(`${det.dns.ttl} giây`, `${det.dns.ttl} seconds`) : '–');
  if (!target) {
    setHtml('netDnsSync', `<span class="sync-bad">${t('Chưa tạo bản ghi A', 'No A record yet')}</span>`);
  } else if (target === inst.publicIp) {
    setHtml('netDnsSync', `<span class="sync-ok">${t('Khớp Elastic IP', 'Matches Elastic IP')}</span>`);
  } else {
    setHtml('netDnsSync', `<span class="sync-bad">${t('Lệch: đang trỏ', 'Mismatch: points to')} ${esc(target)}</span>`);
  }

  const chip = document.getElementById('vpcCidrChip');
  if (chip) {
    chip.dataset.cidr = vpc ? vpc.cidr : '10.0.0.0/16';
    chip.textContent = t(`Trong VPC ${chip.dataset.cidr}`, `Within VPC ${chip.dataset.cidr}`);
  }
}

function openAddRuleModal(direction) {
  if (!det.groups.length) {
    showToast(t('Chưa tải được Security Group của máy, thử làm mới trang.', 'The security group is not loaded yet, try refreshing.'), 'error');
    return;
  }
  document.getElementById('ruleDirection').value = direction;
  document.getElementById('ruleGroup').value = det.groups[0].groupId;
  document.getElementById('ruleType').value = 'custom-tcp';
  document.getElementById('ruleDesc').value = '';
  setRuleCidr('0.0.0.0/0');
  applyRulePreset();
  openModal('addRuleModal');
}

function applyRulePreset() {
  const p = RULE_PRESETS[document.getElementById('ruleType').value];
  const from = document.getElementById('ruleFromPort');
  const to = document.getElementById('ruleToPort');
  from.value = p.from;
  to.value = p.to === null ? '' : p.to;
  const fixed = !document.getElementById('ruleType').value.startsWith('custom');
  from.readOnly = fixed;
  to.readOnly = fixed;
  const dir = document.getElementById('ruleDirection').value;
  setText('addRuleTitle', dir === 'inbound' ? t('Thêm inbound rule', 'Add inbound rule') : t('Thêm outbound rule', 'Add outbound rule'));
  setText('ruleCidrLabel', dir === 'inbound' ? t('Nguồn (CIDR)', 'Source (CIDR)') : t('Đích (CIDR)', 'Destination (CIDR)'));
  checkRuleWarning();
}

function setRuleCidr(cidr) {
  document.getElementById('ruleCidr').value = cidr;
  checkRuleWarning();
}

function checkRuleWarning() {
  const dir = document.getElementById('ruleDirection').value;
  const type = document.getElementById('ruleType').value;
  const cidr = document.getElementById('ruleCidr').value.trim();
  document.getElementById('ruleWarn').hidden = !(dir === 'inbound' && cidr === '0.0.0.0/0' && !['http', 'https'].includes(type));
}

async function submitAddRule(e) {
  e.preventDefault();
  const dir = document.getElementById('ruleDirection').value;
  const preset = RULE_PRESETS[document.getElementById('ruleType').value];
  const from = parseInt(document.getElementById('ruleFromPort').value, 10);
  const toRaw = document.getElementById('ruleToPort').value;
  const to = toRaw === '' ? from : parseInt(toRaw, 10);
  if (to < from) {
    showToast(t('Cổng kết thúc phải lớn hơn hoặc bằng cổng bắt đầu', 'The end port must be greater than or equal to the start port'), 'error');
    return;
  }
  const rule = {
    protocol: preset.protocol,
    fromPort: from,
    toPort: to,
    cidr: document.getElementById('ruleCidr').value.trim(),
    description: document.getElementById('ruleDesc').value.trim()
  };
  const body = { groupId: document.getElementById('ruleGroup').value };
  body[dir === 'inbound' ? 'inboundRules' : 'outboundRules'] = [rule];
  try {
    const res = await apiRequest('/network/security-groups', { method: 'POST', body: JSON.stringify(body) });
    closeModal('addRuleModal');
    showToast(res && res.rulesAdded === 0 ? t('Rule này đã có sẵn, không thêm mới', 'This rule already exists') : t(`Đã thêm ${dir} rule vào ${esc(body.groupId)}`, `Added ${dir} rule to ${esc(body.groupId)}`), 'success');
    loadSecurityAndNetwork();
  } catch (err) {
    showToast(t('Không thêm được rule: ', 'Could not add rule: ') + esc(err.message), 'error');
  }
}

async function deleteRule(groupId, ruleId, dir) {
  const g = det.groups.find(x => x.groupId === groupId);
  const r = g && (g[dir === 'inbound' ? 'inboundRules' : 'outboundRules'] || []).find(x => x.ruleId === ruleId);
  const label = r ? `${ruleType(r)}${rulePorts(r) === 'All' ? '' : ' ' + rulePorts(r)} ${dir === 'inbound' ? t('từ', 'from') : t('tới', 'to')} ${r.cidr}` : ruleId;
  if (!(await confirmDialog({
    title: t(`Xóa ${dir} rule?`, `Delete ${dir} rule?`),
    message: t(`Rule <code>${esc(label)}</code> sẽ bị xóa khỏi <code>${esc(groupId)}</code>. Lưu lượng khớp rule này bị chặn ngay lập tức.`,
      `Rule <code>${esc(label)}</code> will be removed from <code>${esc(groupId)}</code>. Matching traffic is blocked immediately.`)
      + (dir === 'inbound' && r && r.protocol === 'tcp' && r.fromPort <= 22 && r.toPort >= 22 ? `<br><span class="confirm-warn">${t('Đây là rule mở cổng SSH: xóa đi có thể khiến bạn mất kết nối tới máy.', 'This rule opens SSH: deleting it may lock you out of the instance.')}</span>` : ''),
    confirmText: t('Xóa rule', 'Delete rule'),
    danger: true
  }))) return;
  try {
    await apiRequest(`/network/security-groups/${encodeURIComponent(groupId)}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    showToast(t('Đã xóa rule ', 'Deleted rule ') + esc(label), 'success');
    loadSecurityAndNetwork();
  } catch (err) {
    showToast(t('Không xóa được rule: ', 'Could not delete rule: ') + esc(err.message), 'error');
  }
}

function openDnsModal() {
  document.getElementById('dnsDomain').value = det.inst.dnsDomain || '';
  document.getElementById('dnsTarget').value = det.inst.publicIp && det.inst.publicIp !== 'Chưa gán' ? det.inst.publicIp : '';
  document.getElementById('dnsTtl').value = det.dns ? det.dns.ttl : 60;
  openModal('dnsModal');
}

async function submitDnsUpdate(e) {
  e.preventDefault();
  const body = {
    domainName: document.getElementById('dnsDomain').value.trim(),
    targetIp: document.getElementById('dnsTarget').value.trim(),
    ttl: parseInt(document.getElementById('dnsTtl').value, 10) || 60
  };
  try {
    await apiRequest('/network/dns', { method: 'POST', body: JSON.stringify(body) });
    closeModal('dnsModal');
    showToast(t(`Đã cập nhật ${esc(body.domainName)} trỏ tới ${esc(body.targetIp)}`, `${esc(body.domainName)} now points to ${esc(body.targetIp)}`), 'success');
    loadSecurityAndNetwork();
  } catch (err) {
    showToast(t('Không cập nhật được DNS: ', 'Could not update DNS: ') + esc(err.message), 'error');
  }
}

['ruleDirection', 'ruleCidr'].forEach(id => {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => (id === 'ruleDirection' ? applyRulePreset() : checkRuleWarning()));
  });
});
