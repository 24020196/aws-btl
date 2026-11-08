// Trang sửa máy ảo (instance-edit.html). Cần nạp sau pages/launch.js.

// 5. MODIFY / EDIT INSTANCE PAGE (instance-edit.html?id=...&section=...) - AWS EC2 Dedicated Setting Pages
let currentEditingInstance = null;
let currentEditSection = 'instance-type';

const EC2_EDIT_SECTIONS = {
  'instance-type': {
    titleVi: 'Đổi loại máy ảo (Change instance type)',
    titleEn: 'Change instance type',
    subtitleVi: 'Bạn chỉ có thể đổi sang loại máy ảo tương thích với kiến trúc hiện tại và khi máy ảo đã dừng (Stopped).',
    subtitleEn: 'You can change the instance type only if the current instance type and the instance type that you want are compatible.',
    btnVi: 'Thay đổi (Change)',
    btnEn: 'Change',
    requiresStop: true
  },
  'security-groups': {
    titleVi: 'Đổi nhóm bảo mật (Change security groups)',
    titleEn: 'Change security groups',
    subtitleVi: 'Security Group đóng vai trò tường lửa ảo kiểm soát lưu lượng mạng ra vào card mạng (ENI) của máy ảo.',
    subtitleEn: 'Security groups act as a virtual firewall for your instance to control inbound and outbound traffic.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'elastic-ip': {
    titleVi: 'Quản lý địa chỉ Elastic IP',
    titleEn: 'Manage Elastic IP address',
    subtitleVi: 'Cấp phát địa chỉ IPv4 công khai tĩnh mới từ vùng hiện tại hoặc gỡ bỏ địa chỉ IP hiện tại khỏi máy ảo.',
    subtitleEn: 'Associate a static Public IPv4 address from the regional pool or disassociate the current address.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'dns': {
    titleVi: 'Cập nhật tên miền Route 53 DNS',
    titleEn: 'Change Route 53 DNS record',
    subtitleVi: 'Cập nhật bản ghi tên miền định tuyến đa vùng Route 53 Hosted Zone gắn với máy ảo.',
    subtitleEn: 'Update the Route 53 Hosted Zone A-Record associated with this compute instance.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'storage': {
    titleVi: 'Mở rộng ổ cứng gốc EBS (Modify EBS volume)',
    titleEn: 'Modify EBS root volume',
    subtitleVi: 'Tăng dung lượng ổ đĩa gốc EBS (gp3) trực tiếp khi máy đang hoạt động mà không cần dừng máy.',
    subtitleEn: 'Expand the root EBS Elastic Volume (gp3) capacity online without stopping the instance.',
    btnVi: 'Mở rộng ổ đĩa',
    btnEn: 'Modify',
    requiresStop: false
  },
  'key-pair': {
    titleVi: 'Đổi khóa truy cập SSH Key Pair',
    titleEn: 'Change SSH key pair',
    subtitleVi: 'Chọn một khóa RSA hiện có hoặc tạo khóa .pem mới để đăng nhập SSH vào máy ảo.',
    subtitleEn: 'Select an existing RSA key pair or create a new .pem key pair for SSH access.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'tags': {
    titleVi: 'Đổi tên máy ảo & nhãn (Change instance name & tags)',
    titleEn: 'Change instance name & tags',
    subtitleVi: 'Nhãn (Tag) giúp định danh và quản lý tài nguyên máy ảo xuyên vùng trên bảng điều khiển.',
    subtitleEn: 'A tag is a label that you assign to an AWS resource. Each tag consists of a key and an optional value.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  },
  'cooldown': {
    titleVi: 'Đổi thời gian chờ Cooldown chuyển vùng',
    titleEn: 'Change migration cooldown',
    subtitleVi: 'Cấu hình thời gian nghỉ tối thiểu giữa hai lần di trú máy ảo liên vùng liên tiếp.',
    subtitleEn: 'Configure the minimum cooldown duration between consecutive cross-region migrations.',
    btnVi: 'Lưu thay đổi',
    btnEn: 'Save',
    requiresStop: false
  }
};

function getFlavorSeriesLabel(flavor) {
  if (!flavor) return t('Tiêu chuẩn đa dụng (M1 Series)', 'General Purpose (M1 Series)');
  if (flavor.startsWith('h1.')) return t('Bộ nhớ & Hiệu năng cao (H1 Series)', 'High Memory / Compute (H1 Series)');
  return t('Tiêu chuẩn đa dụng (M1 Series)', 'General Purpose (M1 Series)');
}

function toggleFlavorComparison() {
  const box = document.getElementById('flavorComparisonBox');
  const icon = document.getElementById('cmpToggleIcon');
  if (!box) return;
  const hidden = box.style.display === 'none';
  box.style.display = hidden ? 'block' : 'none';
  if (icon) icon.textContent = hidden ? '▼' : '▶';
}

function refreshEditSectionLabels() {
  const secMeta = EC2_EDIT_SECTIONS[currentEditSection] || EC2_EDIT_SECTIONS['instance-type'];
  const title = t(secMeta.titleVi, secMeta.titleEn);
  const subtitle = t(secMeta.subtitleVi, secMeta.subtitleEn);
  const btnText = t(secMeta.btnVi, secMeta.btnEn);

  const titleEl = document.getElementById('editPageTitle');
  if (titleEl) titleEl.textContent = title;
  const subEl = document.getElementById('editPageSubtitle');
  if (subEl) subEl.textContent = subtitle;
  const bcActionEl = document.getElementById('editBreadcrumbActionName');
  if (bcActionEl) bcActionEl.textContent = title;
  const saveBtn = document.getElementById('btnSaveEditInstance');
  if (saveBtn) saveBtn.textContent = btnText;
  document.title = `${title} - XRegion-EC2`;

  if (currentEditingInstance) {
    applyEditInstanceStateLock(currentEditingInstance.status);
  }
}

function applyEditInstanceStateLock(status) {
  const isStopped = (status === 'SHUTOFF' || status === 'STOPPED');
  const badge = document.getElementById('editInstStatusBadge');
  if (badge) {
    badge.textContent = isStopped ? t('Đã dừng (Stopped)', 'Stopped') : (status === 'ACTIVE' ? t('Đang chạy (Running)', 'Running') : status);
    badge.className = 'badge ' + (status === 'ACTIVE' ? 'badge-active' :
                                   status === 'MIGRATING' ? 'badge-migrating' :
                                   isStopped ? 'badge-shutoff' : 'badge-error');
  }

  const secMeta = EC2_EDIT_SECTIONS[currentEditSection] || EC2_EDIT_SECTIONS['instance-type'];
  const flavorSelect = document.getElementById('editInstFlavor');
  const flavorWrap = document.getElementById('flavorSelectWrap');
  const saveBtn = document.getElementById('btnSaveEditInstance');
  const saveWrap = document.getElementById('saveBtnWrap');
  const stopTooltip = t(
    'Cần dừng máy ảo (Stop instance) trước khi thay đổi Instance type',
    'The instance must be stopped before changing its instance type'
  );

  if (flavorSelect) {
    flavorSelect.disabled = !isStopped;
    flavorSelect.style.opacity = isStopped ? '1' : '0.55';
    flavorSelect.style.cursor = isStopped ? 'pointer' : 'not-allowed';
    flavorSelect.title = isStopped ? '' : stopTooltip;
  }
  if (flavorWrap) {
    flavorWrap.classList.toggle('is-stop-locked', !isStopped);
    if (!isStopped) {
      flavorWrap.setAttribute('data-tooltip', stopTooltip);
    } else {
      flavorWrap.removeAttribute('data-tooltip');
    }
  }

  if (secMeta.requiresStop) {
    if (saveBtn) {
      saveBtn.disabled = !isStopped;
      saveBtn.title = isStopped ? '' : stopTooltip;
    }
    if (saveWrap) {
      saveWrap.classList.toggle('is-stop-locked', !isStopped);
      if (!isStopped) {
        saveWrap.setAttribute('data-tooltip', stopTooltip);
      } else {
        saveWrap.removeAttribute('data-tooltip');
      }
    }
  }
}

async function initEditInstancePage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  const urlParams = new URLSearchParams(window.location.search);
  const instanceId = urlParams.get('id');
  const rawSec = urlParams.get('section') || 'instance-type';
  currentEditSection = EC2_EDIT_SECTIONS[rawSec] ? rawSec : 'instance-type';

  // Activate only the requested section panel
  document.querySelectorAll('.ec2-sec-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${currentEditSection}`);
  });

  refreshEditSectionLabels();

  if (!instanceId) {
    showApiError('/instances/{id}', 'Không tìm thấy tham số ID máy ảo cần chỉnh sửa trên URL.');
    return;
  }

  const detailUrl = `/instance-detail.html?id=${encodeURIComponent(instanceId)}`;
  const bcLink = document.getElementById('editBreadcrumbDetailLink');
  if (bcLink) {
    bcLink.textContent = instanceId;
    bcLink.href = detailUrl;
  }
  const cardIdLink = document.getElementById('editCardInstanceLink');
  if (cardIdLink) cardIdLink.href = detailUrl;
  const cancelBtn = document.getElementById('btnCancelEditInstance');
  if (cancelBtn) cancelBtn.href = detailUrl;

  try {
    const inst = await apiRequest(`/instances/${instanceId}`);
    if (!inst) {
      throw new Error(`Không tìm thấy máy ảo [${instanceId}]`);
    }
    currentEditingInstance = inst;

    document.getElementById('editRoInstanceId').textContent = inst.id;
    const nameParen = document.getElementById('editRoInstanceNameParen');
    if (nameParen) nameParen.textContent = `(${inst.name || inst.id})`;
    const roReg = document.getElementById('editRoRegion');
    if (roReg) roReg.textContent = `${inst.regionName || inst.region} (${inst.region})`;
    const roPriv = document.getElementById('editRoPrivateIp');
    if (roPriv) roPriv.textContent = inst.privateIp || '10.0.1.10';
    const roVol = document.getElementById('editRoVolumeId');
    if (roVol) roVol.textContent = inst.volumeId || 'vol-default';
    const roPubIp = document.getElementById('editRoPublicIp');
    if (roPubIp) roPubIp.textContent = inst.publicIp || '–';

    // Populate Instance Type fields
    const curFlavorSpec = FLAVOR_SPECS[inst.flavor] || FLAVOR_SPECS['m1.medium'];
    const curFlavorDisp = document.getElementById('editCurrentFlavorDisplay');
    if (curFlavorDisp) {
      curFlavorDisp.textContent = inst.flavor || 'm1.medium';
    }
    const flavorSelect = document.getElementById('editInstFlavor');
    if (flavorSelect && inst.flavor) {
      flavorSelect.value = inst.flavor;
    }
    applyEditInstanceStateLock(inst.status);

    // Populate Name, DNS, Security Group, Elastic IP, EBS, Key Pair, Cooldown
    const nameInput = document.getElementById('editInstName');
    if (nameInput) nameInput.value = inst.name || inst.id;

    const curDnsDisp = document.getElementById('editCurrentDnsDisplay');
    if (curDnsDisp) curDnsDisp.textContent = inst.dnsDomain || `${(inst.name || inst.id).toLowerCase()}.xregion.net`;
    const domainInput = document.getElementById('editInstDomain');
    if (domainInput) {
      domainInput.value = inst.dnsDomain || `${(inst.name || inst.id).toLowerCase()}.xregion.net`;
    }

    const curSgDisp = document.getElementById('editCurrentSgDisplay');
    if (curSgDisp) curSgDisp.textContent = inst.securityGroupId || 'sg-default';
    const sgSelect = document.getElementById('editInstSecurityGroup');
    if (sgSelect && inst.securityGroupId) {
      if (!Array.from(sgSelect.options).some(o => o.value === inst.securityGroupId)) {
        const opt = document.createElement('option');
        opt.value = inst.securityGroupId;
        opt.textContent = `${inst.securityGroupId} (Attached to ENI)`;
        sgSelect.prepend(opt);
      }
      sgSelect.value = inst.securityGroupId;
    }

    const eipSelect = document.getElementById('editInstElasticIpAction');
    if (eipSelect) {
      eipSelect.value = 'KEEP';
    }

    const currentEbsGb = inst.ebsSizeGb || curFlavorSpec.defaultDisk || 20;
    currentEditingInstance.ebsSizeGb = currentEbsGb;
    const curEbsDisp = document.getElementById('editCurrentEbsDisplay');
    if (curEbsDisp) {
      curEbsDisp.textContent = `${currentEbsGb} GiB`;
    }
    const ebsInput = document.getElementById('editInstEbsSize');
    if (ebsInput) {
      ebsInput.value = currentEbsGb;
      ebsInput.min = currentEbsGb;
    }

    const cooldownInput = document.getElementById('editInstCooldown');
    if (cooldownInput) {
      cooldownInput.value = inst.cooldownSeconds != null ? inst.cooldownSeconds : 300;
    }

    const curKeyDisp = document.getElementById('editCurrentKeyDisplay');
    if (curKeyDisp) curKeyDisp.textContent = inst.keyName || 'xregion-key';
    await loadKeyPairsDropdown(inst.keyName || 'xregion-key');
    const keySelect = document.getElementById('instKeyPair');
    if (keySelect && inst.keyName && !Array.from(keySelect.options).some(o => o.value === inst.keyName)) {
      const opt = document.createElement('option');
      opt.value = inst.keyName;
      opt.textContent = `${inst.keyName} (Current instance key)`;
      keySelect.prepend(opt);
      keySelect.value = inst.keyName;
    }

    updateEditInstanceSummary();
  } catch (err) {
    console.error('Failed to load instance for editing:', err);
    showApiError(`/instances/${instanceId}`, err.message);
  }
}

function updateEditInstanceSummary() {
  const nameEl = document.getElementById('editInstName');
  const flavorEl = document.getElementById('editInstFlavor');
  const ebsEl = document.getElementById('editInstEbsSize');
  if (!nameEl || !flavorEl) return;

  const newName = nameEl.value.trim() || (currentEditingInstance ? currentEditingInstance.name : '--');
  const newFlavor = flavorEl.value;
  const oldEbs = currentEditingInstance?.ebsSizeGb || 20;
  const newEbs = ebsEl ? (parseInt(ebsEl.value) || oldEbs) : oldEbs;

  const dnsPreview = document.getElementById('editDnsPreview');
  if (dnsPreview) {
    dnsPreview.textContent = `${newName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.xregion.net`;
  }

  // Validate EBS Elastic Volume No-Downsize rule when on storage section
  if (currentEditSection === 'storage') {
    const downsizeWarn = document.getElementById('ebsDownsizeWarning');
    const minEbsSpan = document.getElementById('minAllowedEbsGb');
    const saveBtn = document.getElementById('btnSaveEditInstance');
    if (minEbsSpan) minEbsSpan.textContent = oldEbs;
    if (newEbs < oldEbs) {
      if (downsizeWarn) downsizeWarn.style.display = 'block';
      if (saveBtn) saveBtn.disabled = true;
    } else {
      if (downsizeWarn) downsizeWarn.style.display = 'none';
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // Update Instance Type Comparison Table (AWS EC2 style)
  const oldFlavor = currentEditingInstance?.flavor || 'm1.medium';
  const oldSpec = FLAVOR_SPECS[oldFlavor] || FLAVOR_SPECS['m1.medium'];
  const newSpec = FLAVOR_SPECS[newFlavor] || FLAVOR_SPECS['m1.medium'];

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setText('cmpHeaderCurrent', oldFlavor);
  setText('cmpHeaderNew', newFlavor);
  setText('cmpSeriesCurrent', getFlavorSeriesLabel(oldFlavor));
  setText('cmpSeriesNew', getFlavorSeriesLabel(newFlavor));
  setText('cmpVcpuCurrent', `${oldSpec.vcpu} (${oldSpec.vcpu} core${oldSpec.vcpu > 1 ? 's' : ''})`);
  setText('cmpVcpuNew', `${newSpec.vcpu} (${newSpec.vcpu} core${newSpec.vcpu > 1 ? 's' : ''})`);
  setText('cmpRamCurrent', oldSpec.ramDisplay.replace('GB', 'GiB'));
  setText('cmpRamNew', newSpec.ramDisplay.replace('GB', 'GiB'));
}

async function handleEditInstanceSubmit(e) {
  e.preventDefault();
  if (!currentEditingInstance) return;

  const errBox = document.getElementById('editErrorBox');
  if (errBox) errBox.style.display = 'none';

  const isStopped = (currentEditingInstance.status === 'SHUTOFF' || currentEditingInstance.status === 'STOPPED');
  if (currentEditSection === 'instance-type' && !isStopped) {
    showToast('Cần dừng máy ảo (Stop instance) trước khi thay đổi Instance type!', 'error');
    return;
  }

  const oldEbs = currentEditingInstance.ebsSizeGb || 20;
  const newEbs = parseInt(document.getElementById('editInstEbsSize')?.value) || oldEbs;
  if (currentEditSection === 'storage' && newEbs < oldEbs) {
    showToast(`AWS EBS không cho phép giảm dung lượng ổ đĩa xuống dưới ${oldEbs} GiB!`, 'error');
    return;
  }

  const secMeta = EC2_EDIT_SECTIONS[currentEditSection] || EC2_EDIT_SECTIONS['instance-type'];
  const secTitle = t(secMeta.titleVi, secMeta.titleEn);
  const btn = document.getElementById('btnSaveEditInstance');
  const origText = btn ? btn.innerHTML : t(secMeta.btnVi, secMeta.btnEn);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = t('Đang lưu...', 'Saving...');
  }

  const payload = {
    name: document.getElementById('editInstName').value.trim(),
    flavor: document.getElementById('editInstFlavor').value,
    keyPairName: document.getElementById('instKeyPair')?.value || currentEditingInstance.keyName || 'xregion-key',
    domainName: document.getElementById('editInstDomain')?.value.trim() || '',
    cooldownSeconds: parseInt(document.getElementById('editInstCooldown')?.value) || 300,
    securityGroupId: document.getElementById('editInstSecurityGroup')?.value || currentEditingInstance.securityGroupId || 'sg-default',
    elasticIpAction: document.getElementById('editInstElasticIpAction')?.value || 'KEEP',
    ebsSizeGb: newEbs
  };

  try {
    await apiRequest(`/instances/${currentEditingInstance.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    showToast(t(`Đã cập nhật [${secTitle}] cho máy ảo ${currentEditingInstance.id} thành công!`, `Successfully updated [${secTitle}] for instance ${currentEditingInstance.id}!`), 'success');
    setTimeout(() => {
      window.location.replace(`/instance-detail.html?id=${currentEditingInstance.id}`);
    }, 600);
  } catch (err) {
    if (errBox) {
      errBox.innerHTML = `<strong>${ICON('ui-error', 'ico-danger')} ${t('Lỗi cập nhật:', 'Update error:')}</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi cập nhật: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}
