// Menu "Hành động" nhiều cấp kiểu AWS EC2 cho MỘT máy ảo — Lực.
// Dùng chung cho trang chi tiết (instance-detail/core.js) và trang danh sách (instances.js) để hai menu giống hệt nhau.
// Nạp sau 5 file core (cần t(), tk(), ICON()). CSS: css/actions-menu.css.

function ec2ActionsEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Trả về HTML các nhóm (Cài đặt máy ảo, Mạng, Bảo mật, Lưu trữ) cho máy inst
function ec2ActionsGroupsHtml(inst) {
  const status = String(inst.status || '').toUpperCase();
  const powered = ['RUNNING', 'ACTIVE'].includes(status);
  const busy = ['PENDING', 'BUILDING', 'STOPPING', 'REBOOTING', 'SHUTTING_DOWN', 'TERMINATING', 'MIGRATING'].includes(status)
    || inst.migrationLock === true;
  const esc = ec2ActionsEsc;

  const editLink = (section, labelVi, labelEn, requiresStop = false, immutableVi = '', immutableEn = '') => {
    const label = t(labelVi, labelEn);
    const url = `/instance-edit.html?id=${encodeURIComponent(inst.id)}&section=${section}`;
    if (immutableVi) {
      const msg = t(immutableVi, immutableEn || immutableVi);
      return `<span role="menuitem" aria-disabled="true" class="ec2-actions-item is-disabled" data-tooltip="${esc(msg)}" title="${esc(msg)}">${label}</span>`;
    }
    if (requiresStop && (powered || busy)) {
      const stopMsg = t('Cần dừng máy ảo trước khi dùng "' + labelVi + '"', `Stop the instance before using "${labelEn}"`);
      return `<span role="menuitem" aria-disabled="true" class="ec2-actions-item is-disabled" data-tooltip="${esc(stopMsg)}" title="${esc(stopMsg)}">${label}</span>`;
    }
    return `<a role="menuitem" href="${url}" class="ec2-actions-item">${label}</a>`;
  };

  return `
    <div class="ec2-actions-group">
      <button type="button" class="ec2-actions-trigger"><span>${t('Cài đặt máy ảo', 'Instance settings')}</span>${ICON('ui-chevron-right', 'ico-sm')}</button>
      <div class="ec2-actions-submenu">
        <div class="ec2-actions-subhead">${t('Quản lý vòng đời & Nhãn', 'Protection and lifecycle management')}</div>
        ${editLink('tags', 'Đổi tên máy ảo và tag', 'Change instance name & tags', false)}
        ${editLink('cooldown', 'Đổi thời gian chờ Cooldown', 'Change migration cooldown', false)}
        <div class="ec2-actions-sep"></div>
        <div class="ec2-actions-subhead">${t('Cấu hình phần cứng', 'Instance configuration')}</div>
        ${editLink('instance-type', 'Đổi loại máy ảo', 'Change instance type', true)}
        ${editLink('cpu-options', 'Tùy chọn CPU', 'Change CPU options', true, 'Cần dừng máy ảo trước khi đổi tùy chọn CPU', 'Instance must be stopped to modify CPU options')}
      </div>
    </div>
    <div class="ec2-actions-group">
      <button type="button" class="ec2-actions-trigger"><span>${tk('tabNetworking')}</span>${ICON('ui-chevron-right', 'ico-sm')}</button>
      <div class="ec2-actions-submenu">
        <div class="ec2-actions-subhead">${t('Địa chỉ IP & Tên miền', 'IP & DNS configuration')}</div>
        ${editLink('elastic-ip', 'Quản lý địa chỉ Elastic IP', 'Manage Elastic IP address', false)}
        ${editLink('dns', 'Cập nhật tên miền Route 53 DNS', 'Change Route 53 DNS record', false)}
        ${editLink('vpc', 'Đổi mạng VPC / Subnet', 'Change VPC / Subnet', false, 'Không thể đổi trực tiếp VPC/Subnet. Vui lòng dùng Fast Migrate X-Region để chuyển vùng', 'VPC/Subnet cannot be changed directly. Use Fast Migrate X-Region instead')}
      </div>
    </div>
    <div class="ec2-actions-group">
      <button type="button" class="ec2-actions-trigger"><span>${tk('tabSecurity')}</span>${ICON('ui-chevron-right', 'ico-sm')}</button>
      <div class="ec2-actions-submenu">
        <div class="ec2-actions-subhead">${t('Tường lửa & Khóa truy cập', 'Access & Firewall')}</div>
        ${editLink('key-pair', 'Đổi Key pair SSH', 'Change SSH key pair', false)}
      </div>
    </div>
    <div class="ec2-actions-group">
      <button type="button" class="ec2-actions-trigger"><span>${tk('tabStorage')}</span>${ICON('ui-chevron-right', 'ico-sm')}</button>
      <div class="ec2-actions-submenu">
        <div class="ec2-actions-subhead">${t('Ổ đĩa EBS Elastic Volumes', 'EBS Elastic Volumes')}</div>
        ${editLink('storage', 'Mở rộng ổ cứng gốc EBS (gp3)', 'Modify EBS root volume (gp3)', false)}
      </div>
    </div>`;
}
