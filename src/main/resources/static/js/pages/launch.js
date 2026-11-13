// Trang khởi tạo máy ảo (launch.html) và Key Pair - Tạ Duy Anh
// Chuẩn hóa giao diện AWS EC2 Console 2-column layout, loại bỏ hoàn toàn emoji, tích hợp icon sprite & i18n.

// 1. Đăng ký từ điển song ngữ trang Launch
registerI18n({
  launchBreadcrumb: ['Khởi tạo máy ảo', 'Launch an instance'],
  launchPageTitle: ['Khởi tạo máy ảo', 'Launch an instance'],
  launchSecName: ['Tên và nhãn', 'Name and tags'],
  launchInputName: ['Tên máy ảo (Instance name) *', 'Instance name *'],
  launchNameHint: ['Chỉ dùng chữ cái tiếng Anh (không dấu), số, dấu \'-\', \'_\' hoặc \'.\', từ 1 đến 63 ký tự.', 'Use only English alphanumeric characters, \'-\', \'_\' or \'.\', 1 to 63 characters.'],
  launchNameErr: ['Tên máy ảo không hợp lệ. Chỉ dùng chữ cái tiếng Anh (không dấu), số, dấu \'-\', \'_\' hoặc \'.\', từ 1 đến 63 ký tự và bắt đầu bằng chữ hoặc số.', 'Invalid instance name. Must use only English alphanumeric characters, \'-\', \'_\' or \'.\' (1-63 chars), starting with an alphanumeric char.'],
  launchSecRegion: ['Vùng mục tiêu', 'Target Region'],
  launchSecAmi: ['Ảnh hệ điều hành', 'Application and OS Images'],
  launchAmiHelp: ['Chọn ảnh hệ điều hành (Glance OS Image / AMI) được lưu trữ trên hạ tầng đám mây:', 'Select an operating system (Glance OS Image / AMI) hosted in the cloud:'],
  launchSecType: ['Loại máy ảo (Instance type)', 'Instance type'],
  launchSelectFlavor: ['Chọn Flavor (vCPU & RAM):', 'Select Flavor (vCPU & RAM):'],
  launchFlavorMatrixTitle: ['Danh sách Flavor cho phép', 'Allowed Flavors'],
  launchSecKey: ['Khóa xác thực (Key pair - login)', 'Key pair (login)'],
  launchKeyHelp: ['Chọn khóa SSH đã tạo trước đó hoặc khởi tạo Key Pair mới để tải file .pem:', 'Select an existing SSH key pair or create a new one to download .pem file:'],
  launchSelectKey: ['Tên Key Pair *', 'Key pair name *'],
  launchBtnCreateKey: ['Tạo Key Pair mới', 'Create new key pair'],
  launchSecStorage: ['Cấu hình lưu trữ & DNS', 'Configure storage & DNS'],
  launchVolType: ['Loại ổ đĩa Root', 'Root Volume type'],
  launchVolSize: ['Dung lượng Root Disk (GiB) *', 'Root Disk size (GiB) *'],
  launchDomainName: ['Tên miền Route 53 DNS', 'Route 53 DNS domain'],
  launchSummaryTitle: ['Tóm tắt cấu hình', 'Summary'],
  launchSumRegion: ['VÙNG MỤC TIÊU', 'TARGET REGION'],
  launchPemHint: ['File khóa riêng tư (.pem) chỉ được tải xuống 1 lần duy nhất khi tạo mới.', 'The private key file (.pem) can only be downloaded once, when the key pair is created.'],
  launchSumAmi: ['HỆ ĐIỀU HÀNH (AMI)', 'SOFTWARE IMAGE (AMI)'],
  launchSumKey: ['KHÓA XÁC THỰC (KEY PAIR)', 'KEY PAIR'],
  launchSumSg: ['NHÓM BẢO MẬT (SECURITY GROUP)', 'FIREWALL (SECURITY GROUP)'],
  launchSumSpecs: ['THÔNG SỐ PHẦN CỨNG', 'INSTANCE SPECIFICATIONS'],
  launchBtnSubmit: ['Khởi tạo máy ảo', 'Launch instance'],
  launchBtnCancel: ['Hủy bỏ', 'Cancel'],
  launchModalKeyTitle: ['Tạo SSH Key Pair mới', 'Create new SSH Key Pair'],
  launchModalKeyHelp: ['Hệ thống sẽ sinh cặp khóa RSA 2048-bit chuẩn PKCS#1. Khóa công khai lưu trên tài khoản đám mây, file khóa bí mật (.pem) sẽ tự động tải xuống.', 'RSA 2048-bit PKCS#1 key pair will be generated. The public key is stored, and the private .pem key will download automatically.'],
  launchModalKeyName: ['Tên Key Pair *', 'Key pair name *'],
  launchModalKeyType: ['Loại khóa', 'Key pair type'],
  launchModalKeySubmit: ['Tạo Key Pair & Tải .pem', 'Create Key Pair & Download .pem']
});

// 2. Khởi tạo trang Launch
function initLaunchPage() {
  if (!requireAuthGuard()) return;
  if (sessionStorage.getItem('xregion_launch_completed') === 'true') {
    sessionStorage.removeItem('xregion_launch_completed');
    window.location.replace('/instances.html');
    return;
  }

  window.addEventListener('pageshow', (event) => {
    const form = document.getElementById('launchInstancePageForm');
    if (event.persisted || sessionStorage.getItem('xregion_launch_completed') === 'true') {
      if (form) form.reset();
      sessionStorage.removeItem('xregion_launch_completed');
      window.location.replace('/instances.html');
    }
  });

  const form = document.getElementById('launchInstancePageForm');
  if (form) form.reset();

  renderUserBadge();
  clearApiError();
  loadKeyPairsDropdown();
  loadLaunchImagesAndFlavors();
  updatePageLaunchSummary();
}

// 3. Tải danh sách Key Pair
async function loadKeyPairsDropdown(selectedName = null) {
  const select = document.getElementById('instKeyPair');
  if (!select) return;
  try {
    const keys = await apiRequest('/keys');
    const currentVal = selectedName || select.value;
    if (keys && keys.length > 0) {
      select.innerHTML = keys.map(k => `<option value="${k.keyName}">${k.keyName} (${k.keyType || 'RSA 2048'} • ${k.keyFingerprint ? k.keyFingerprint.substring(0, 22) + '...' : ''})</option>`).join('');
      if (currentVal && keys.some(k => k.keyName === currentVal)) {
        select.value = currentVal;
      } else {
        select.value = keys[0].keyName;
      }
    } else {
      select.innerHTML = `<option value="">-- ` + t('Chưa có Key Pair nào (Bấm "+ Tạo Key Pair mới" bên cạnh)', 'No key pairs available (Click "+ Create new key pair" beside)') + ` --</option>`;
    }
    updatePageLaunchSummary();
  } catch (e) {
    console.warn('Could not load keypairs from API:', e);
  }
}

function openCreateKeyModal() {
  const input = document.getElementById('newKeyPairName') || document.getElementById('newKeyPairNameInput');
  if (input) input.value = '';
  openModal('createKeyModal');
  setTimeout(() => {
    if (input) input.focus();
  }, 100);
}

function downloadPemFile(filename, pemContent) {
  const cleanName = filename.endsWith('.pem') ? filename : `${filename}.pem`;
  const blob = new Blob([pemContent], { type: 'application/x-pem-file;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = cleanName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function submitCreateKeyModal(e) {
  e.preventDefault();
  const input = document.getElementById('newKeyPairName') || document.getElementById('newKeyPairNameInput');
  const name = input ? input.value.trim() : '';
  if (!name) return;

  const btn = document.getElementById('btnSubmitCreateKey');
  const origText = btn ? btn.innerHTML : tk('launchModalKeySubmit');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('ui-spinner', 'ico-spin')} <span>${t('Đang sinh khóa RSA 2048...', 'Generating RSA 2048 key...')}</span>`;
  }

  try {
    const res = await apiRequest('/keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    if (res && res.privateKey) {
      const actualKeyId = res.keyId || res.keyName || name;
      downloadPemFile(actualKeyId, res.privateKey);
      closeModal('createKeyModal');
      showToast(t(
        `Đã tạo Key Pair [${name}] và tải xuống ${name}.pem! Nếu SSH báo WARNING: UNPROTECTED PRIVATE KEY FILE!, hãy chạy icacls (Windows) hoặc chmod 400 (Linux/macOS) trong hộp Kết nối.`,
        `Created Key Pair [${name}] and downloaded ${name}.pem! If SSH warns UNPROTECTED PRIVATE KEY FILE!, run icacls (Windows) or chmod 400 (Linux/macOS) shown in Connect.`
      ), 'success');
      await loadKeyPairsDropdown(name);
      if (typeof updateEditInstanceSummary === 'function') {
        updateEditInstanceSummary();
      }
    } else {
      showToast(t('Tạo khóa thất bại: Không nhận được Private Key từ máy chủ.', 'Key creation failed: No private key received.'), 'error');
    }
  } catch (err) {
    showToast(t(`Lỗi tạo Key Pair: ${err.message}`, `Key Pair creation failed: ${err.message}`), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

// 4. Chọn Region & OS
function selectRegion(regionCode) {
  const regInput = document.getElementById('instRegion');
  if (regInput) regInput.value = regionCode;

  const optA = document.getElementById('optRegionA');
  const optB = document.getElementById('optRegionB');
  if (optA) optA.classList.toggle('selected', regionCode === 'us-east-1');
  if (optB) optB.classList.toggle('selected', regionCode === 'ap-southeast-2');

  const radioA = document.querySelector('input[name="regionRadio"][value="us-east-1"]');
  const radioB = document.querySelector('input[name="regionRadio"][value="ap-southeast-2"]');
  if (radioA) radioA.checked = (regionCode === 'us-east-1');
  if (radioB) radioB.checked = (regionCode === 'ap-southeast-2');

  updatePageLaunchSummary();
}

function selectOs(imageId, osName) {
  const imgInput = document.getElementById('instImage');
  if (imgInput) imgInput.value = imageId;

  // Thẻ OS được vẽ lại từ API /images với id="optOs-<imageId>"; giữ cả id cũ của bản HTML tĩnh
  const legacyIds = { 'img-u22': 'optOsUbuntu', 'img-deb12': 'optOsDebian', 'img-rocky9': 'optOsRocky', 'img-alp319': 'optOsAlpine' };
  document.querySelectorAll('[id^="optOs"]').forEach(card => {
    card.classList.toggle('selected', card.id === `optOs-${imageId}` || card.id === legacyIds[imageId]);
  });

  const radio = document.querySelector(`input[name="osRadio"][value="${imageId}"]`);
  if (radio) radio.checked = true;

  updatePageLaunchSummary();
}

// 5. Tải danh sách Images và Flavors động từ API
const dynamicOsMap = {};

// Nhãn dòng máy từ API /flavors chỉ có tiếng Việt: đổi sang tiếng Anh khi giao diện là EN
function launchSeriesLabel(series) {
  const s = series || t('Tiêu chuẩn', 'General purpose');
  return getLang() === 'en' ? s.replace('Tiêu chuẩn', 'General purpose').replace('Hiệu năng cao', 'Compute optimized') : s;
}

if (typeof onLangChange === 'function') {
  onLangChange(() => document.querySelectorAll('.launch-series').forEach(td => { td.textContent = launchSeriesLabel(td.dataset.series); }));
}

async function loadLaunchImagesAndFlavors() {
  const osGrid = document.getElementById('osOptionsGrid');
  const flavorSelect = document.getElementById('instFlavor');
  const flavorMatrixBody = document.getElementById('flavorMatrixBody');

  // Load OS Images
  if (osGrid) {
    try {
      const images = await apiRequest('/images');
      if (images && images.length > 0) {
        images.forEach(img => {
          // API có thể không trả distribution/version: chỉ ghép phần có giá trị để không hiện "(undefined)"
          const extra = [img.distribution, img.version].filter(Boolean).join(' ');
          dynamicOsMap[img.id] = extra ? `${img.name} (${extra})` : img.name;
        });

        const iconForDistro = (distro) => {
          const d = (distro || '').toLowerCase();
          if (d.includes('ubuntu')) return 'os-ubuntu';
          if (d.includes('debian')) return 'os-debian';
          if (d.includes('centos')) return 'os-centos';
          if (d.includes('rocky')) return 'os-rocky';
          if (d.includes('amazon') || d.includes('al2')) return 'os-amazon-linux';
          if (d.includes('win')) return 'os-windows';
          return 'os-linux';
        };

        const instInput = document.getElementById('instImage');
        const currentVal = instInput?.value;
        const hasValidCurrent = currentVal && images.some(img => img.id === currentVal);
        const targetImgVal = hasValidCurrent ? currentVal : images[0].id;
        if (instInput) instInput.value = targetImgVal;

        osGrid.innerHTML = images.map((img, idx) => {
          const isSelected = (img.id === targetImgVal);
          const iconId = iconForDistro(img.distribution);
          return `
            <div class="option-card ${isSelected ? 'selected' : ''}" id="optOs-${img.id}" onclick="selectOs('${img.id}', '${img.name}')">
              <input type="radio" name="osRadio" value="${img.id}" ${isSelected ? 'checked' : ''}>
              <div style="margin-bottom: 6px;">
                <svg class="ico ico-2xl" aria-hidden="true"><use href="/img/icons/sprite.svg#${iconId}"></use></svg>
              </div>
              <strong style="font-size: 13.5px; display: block; margin-bottom: 4px; color: #fff;">${img.distribution || img.name}</strong>
              <div style="font-size: 11.5px; color: var(--text-muted);">${img.version || img.architecture || 'x86_64'}</div>
            </div>
          `;
        }).join('');
      }
    } catch (e) {
      console.warn('Không thể tải Glance Images:', e);
    }
  }

  // Load Flavors
  if (flavorSelect) {
    try {
      const flavors = await apiRequest('/flavors');
      if (flavors && flavors.length > 0) {
        const m1Flavors = flavors.filter(f => f.name.startsWith('m1'));
        const otherFlavors = flavors.filter(f => !f.name.startsWith('m1'));

        let selectHtml = '';
        if (m1Flavors.length > 0) {
          selectHtml += `<optgroup label="── ` + t('Dòng Tiêu Chuẩn (General Purpose)', 'General Purpose (m1)') + ` ──">`;
          m1Flavors.forEach(f => {
            const isSel = f.name === 'm1.tiny' ? 'selected' : '';
            selectHtml += `<option value="${f.name}" ${isSel}>${f.name} — ${f.vcpus} vCPU • ${f.ramDisplay} • ${f.diskGb} GB Root Disk</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        if (otherFlavors.length > 0) {
          selectHtml += `<optgroup label="── ` + t('Dòng Nâng Cao (Compute / Memory)', 'Advanced Series') + ` ──">`;
          otherFlavors.forEach(f => {
            selectHtml += `<option value="${f.name}">${f.name} — ${f.vcpus} vCPU • ${f.ramDisplay} • ${f.diskGb} GB Root Disk</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        flavorSelect.innerHTML = selectHtml;

        if (flavorMatrixBody) {
          flavorMatrixBody.innerHTML = flavors.map(f => {
            const rowId = `row-${f.name.replace('.', '-')}`;
            const isDefault = f.name === 'm1.tiny';
            const seriesColor = f.name.startsWith('h1') ? '#a855f7' : '#38bdf8';
            return `
              <tr id="${rowId}" style="border-top: 1px solid rgba(255,255,255,0.05); ${isDefault ? 'background: rgba(56, 189, 248, 0.12);' : ''}">
                <td class="launch-series" data-series="${f.series || ''}" style="padding: 8px 12px; color: ${seriesColor}; font-weight: 600;">${launchSeriesLabel(f.series)}</td>
                <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; color: ${isDefault ? '#38bdf8' : '#fff'};">
                  ${f.name} ${isDefault ? '<span class="badge badge-active" style="font-size:10px; margin-left:4px;">Default</span>' : ''}
                </td>
                <td style="padding: 8px 12px; font-weight: ${isDefault ? '700' : '400'}; color: #fff;">${f.vcpus}</td>
                <td style="padding: 8px 12px; font-weight: ${isDefault ? '700' : '400'}; color: #fff;">${f.ramMb}</td>
                <td style="padding: 8px 12px; color: #34d399; font-weight: 600;">${f.diskGb}</td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (e) {
      console.warn('Không thể tải Nova Flavors từ API:', e);
    }
  }

  updatePageLaunchSummary();
}

// 6. Cập nhật Sticky Summary Panel bên phải
function updatePageLaunchSummary() {
  const regionEl = document.getElementById('instRegion');
  const imageEl = document.getElementById('instImage');
  const flavorEl = document.getElementById('instFlavor');
  const ebsEl = document.getElementById('instEbsSize');

  if (!regionEl || !imageEl || !flavorEl || !ebsEl) return;

  const region = regionEl.value;
  const isRegionA = region === 'us-east-1';
  const regionLabel = isRegionA ? 'Region A (N. Virginia)' : 'Region B (Sydney)';

  const osMap = {
    'img-u22': 'Ubuntu Server 22.04 LTS',
    'img-deb12': 'Debian 12 Bookworm',
    'img-rocky9': 'Rocky Linux 9 Enterprise',
    'img-alp319': 'Alpine Linux 3.19 Minimal'
  };
  const osLabel = dynamicOsMap[imageEl.value] || osMap[imageEl.value] || imageEl.value;

  const flavorVal = flavorEl.value;
  const spec = FLAVOR_SPECS[flavorVal] || FLAVOR_SPECS['m1.tiny'] || { vcpu: 1, ramDisplay: '512 MB', defaultDisk: 1 };
  const ebsSize = parseInt(ebsEl.value) || spec.defaultDisk || 1;

  const specsText = `${spec.vcpu} vCPU${spec.vcpu > 1 ? 's' : ''} • ${spec.ramDisplay} • ${ebsSize} GiB Root Disk`;

  const sumReg = document.getElementById('sumRegionText');
  const sumOs = document.getElementById('sumOsText');
  const sumSpecs = document.getElementById('sumSpecsText');
  const sumKey = document.getElementById('sumKeyText');

  if (sumReg) sumReg.textContent = regionLabel;
  if (sumOs) sumOs.textContent = osLabel;
  if (sumSpecs) sumSpecs.textContent = specsText;
  if (sumKey) {
    const kpEl = document.getElementById('instKeyPair');
    const val = kpEl ? kpEl.value.trim() : '';
    sumKey.textContent = val ? val : t('Mặc định (xregion-key)', 'Default (xregion-key)');
  }
  const sumSg = document.getElementById('sumSgText');
  if (sumSg && typeof lfwSummaryText === 'function') {
    sumSg.textContent = lfwSummaryText();
  }

  // Highlight dòng tương ứng trong bảng flavor
  const tableRows = document.querySelectorAll('#flavorMatrixBody tr');
  const targetRowId = `row-${flavorVal.replace('.', '-')}`;
  tableRows.forEach(row => {
    if (row.id === targetRowId) {
      row.style.background = 'rgba(56, 189, 248, 0.15)';
    } else {
      row.style.background = 'transparent';
    }
  });
}

// 7. Xử lý gửi Form tạo máy ảo
async function handleLaunchPageSubmit(e) {
  e.preventDefault();
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';

  // Kiểm tra tên máy ảo (chuẩn OpenStack / Hostname: alphanumeric, '-', '_', '.', 1-63 ký tự)
  const nameInput = document.getElementById('instName');
  const name = nameInput ? nameInput.value.trim() : '';
  const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
  if (!nameRegex.test(name)) {
    showToast(tk('launchNameErr'), 'error');
    if (nameInput) nameInput.focus();
    return;
  }

  // Kiểm tra dung lượng Root Disk (1..5 GiB)
  const ebsInput = document.getElementById('instEbsSize');
  const rawEbs = ebsInput ? Number(ebsInput.value) : 1;
  if (!Number.isInteger(rawEbs) || rawEbs < 1 || rawEbs > 5) {
    showToast(t('Dung lượng Root Disk phải từ 1 đến 5 GiB.', 'Root Disk size must be between 1 and 5 GiB.'), 'error');
    if (ebsInput) ebsInput.focus();
    return;
  }

  // Kiểm tra rule firewall (launch-firewall.js)
  const fwError = typeof lfwValidate === 'function' ? lfwValidate() : '';
  if (fwError) {
    showToast(fwError, 'error');
    return;
  }

  const btn = document.getElementById('btnLaunchInstance');
  const origText = btn ? btn.innerHTML : tk('launchBtnSubmit');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('ui-spinner', 'ico-spin')} <span>${t('Đang cấp phát máy ảo...', 'Launching instance...')}</span>`;
  }

  const payload = {
    name: document.getElementById('instName').value.trim(),
    region: document.getElementById('instRegion').value,
    flavor: document.getElementById('instFlavor').value,
    imageId: document.getElementById('instImage').value,
    keyPairName: document.getElementById('instKeyPair')?.value || 'xregion-key',
    ebsSizeGb: parseInt(document.getElementById('instEbsSize').value) || 1,
    domainName: document.getElementById('instDomain')?.value.trim() || ''
  };

  // SPEC-SF-01 bước 7: rule tường lửa đi cùng payload launch để pipeline và bản ghi
  // Security Group dùng đúng cấu hình người dùng vừa nhập (không tiêm rule mặc định).
  if (typeof lfwPayload === 'function') {
    Object.assign(payload, lfwPayload());
  }

  try {
    const res = await apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const form = document.getElementById('launchInstancePageForm');
    if (form) form.reset();
    sessionStorage.setItem('xregion_launch_completed', 'true');
    if (res && res.id) sessionStorage.setItem('xregion_pending_launch', res.id);

    showToast(t(`Đã tiếp nhận yêu cầu tạo [${payload.name}]. Theo dõi trạng thái trên danh sách máy ảo.`, `Launch requested for [${payload.name}]. Follow its status in the instance list.`), 'info');
    setTimeout(() => {
      window.location.replace('/instances.html');
    }, 800);
  } catch (err) {
    console.error('Launch failed:', err);
    if (errBox) {
      errBox.innerHTML = `<strong>${ICON('ui-error', 'ico-danger')} ${t('Lỗi khởi tạo máy ảo', 'Failed to launch instance')}:</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(t(`Lỗi khởi tạo: ${err.message}`, `Launch error: ${err.message}`), 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

// Global Window Exports
window.openCreateKeyModal = openCreateKeyModal;
window.submitCreateKeyModal = submitCreateKeyModal;
window.loadKeyPairsDropdown = loadKeyPairsDropdown;
window.downloadPemFile = downloadPemFile;
