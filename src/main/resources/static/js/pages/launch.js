// Trang khởi tạo máy ảo (launch.html) và Key Pair.
// instance-edit.html cũng nạp file này vì dùng chung phần Key Pair.

// 4. LAUNCH INSTANCE PAGE (launch.html)
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
      select.innerHTML = `<option value="">-- Chưa có Key Pair nào (Bấm "+ Tạo Key Pair Mới" bên cạnh) --</option>`;
    }
    updatePageLaunchSummary();
  } catch (e) {
    console.warn('Could not load keypairs from API:', e);
  }
}

function openCreateKeyModal() {
  const input = document.getElementById('newKeyPairName');
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
  const input = document.getElementById('newKeyPairName');
  const name = input ? input.value.trim() : '';
  if (!name) return;

  const btn = document.getElementById('btnSubmitCreateKey');
  const origText = btn ? btn.innerHTML : '⬇ Tạo Key Pair & Tải .pem';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang sinh khóa RSA 2048...';
  }

  try {
    const res = await apiRequest('/keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    if (res && res.privateKey) {
      downloadPemFile(name, res.privateKey);
      closeModal('createKeyModal');
      showToast(`Đã tạo Key Pair [${name}] và tải xuống ${name}.pem thành công!`, 'success');
      await loadKeyPairsDropdown(name);
      if (typeof updateEditInstanceSummary === 'function') {
        updateEditInstanceSummary();
      }
    } else {
      showToast(`Tạo khóa thất bại: Không nhận được Private Key từ máy chủ. Vui lòng thử lại.`, 'error');
    }
  } catch (err) {
    showToast(`Lỗi tạo Key Pair: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function promptCreateKey() {
  openCreateKeyModal();
}

function selectRegion(regionCode) {
  document.getElementById('instRegion').value = regionCode;
  document.getElementById('optRegionA').classList.toggle('selected', regionCode === 'ap-southeast-2');
  document.getElementById('optRegionB').classList.toggle('selected', regionCode === 'us-east-1');
  
  const radioA = document.querySelector('input[name="regionRadio"][value="ap-southeast-2"]');
  const radioB = document.querySelector('input[name="regionRadio"][value="us-east-1"]');
  if (radioA) radioA.checked = (regionCode === 'ap-southeast-2');
  if (radioB) radioB.checked = (regionCode === 'us-east-1');

  updatePageLaunchSummary();
}

let dynamicOsMap = {};

function selectOs(imageId, osName) {
  selectDynamicOs(imageId, osName);
}

function selectDynamicOs(imageId, osName) {
  const hiddenInput = document.getElementById('instImage');
  if (hiddenInput) hiddenInput.value = imageId;

  const cards = document.querySelectorAll('#osOptionsGrid .option-card');
  cards.forEach(c => c.classList.remove('selected'));

  const target = document.getElementById(`optOs_${String(imageId).replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  if (target) target.classList.add('selected');

  const radio = document.querySelector(`input[name="osRadio"][value="${imageId}"]`);
  if (radio) radio.checked = true;

  updatePageLaunchSummary();
}

async function loadLaunchImagesAndFlavors() {
  // 1. Tải danh sách Glance Image từ DynamoDB qua API /api/images
  const osGrid = document.getElementById('osOptionsGrid');
  if (osGrid) {
    try {
      const images = await apiRequest('/images');
      if (images && images.length > 0) {
        osGrid.innerHTML = '';
        dynamicOsMap = {};
        images.forEach((img, index) => {
          dynamicOsMap[img.id] = img.name;
          const isSelected = index === 0;
          if (isSelected) {
            document.getElementById('instImage').value = img.id;
          }
          const lower = (img.name || '').toLowerCase();
          let iconClass = 'icon-ubuntu';
          let iconLetter = 'U';
          if (lower.includes('alpine')) {
            iconClass = 'icon-alpine';
            iconLetter = 'A';
          } else if (lower.includes('debian')) {
            iconClass = 'icon-debian';
            iconLetter = 'D';
          } else if (lower.includes('rocky')) {
            iconClass = 'icon-rocky';
            iconLetter = 'R';
          } else if (lower.includes('windows')) {
            iconClass = 'icon-windows';
            iconLetter = 'W';
          }

          const card = document.createElement('div');
          card.className = `option-card ${isSelected ? 'selected' : ''}`;
          card.id = `optOs_${String(img.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          card.onclick = () => selectDynamicOs(img.id, img.name);
          card.innerHTML = `
            <input type="radio" name="osRadio" value="${img.id}" ${isSelected ? 'checked' : ''}>
            <div class="option-icon ${iconClass}">${iconLetter}</div>
            <strong style="font-size: 13px; display: block; margin-bottom: 4px;">${img.name}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${img.osType || 'Linux'} • ${img.sizeGb || 10} GB Image</div>
          `;
          osGrid.appendChild(card);
        });
      }
    } catch (e) {
      console.warn('Không thể tải Glance Images từ DynamoDB:', e);
    }
  }

  // 2. Tải danh sách Nova Flavor từ DynamoDB qua API /api/flavors
  const flavorSelect = document.getElementById('instFlavor');
  const flavorMatrixBody = document.getElementById('flavorMatrixBody');
  if (flavorSelect) {
    try {
      const flavors = await apiRequest('/flavors');
      if (flavors && flavors.length > 0) {
        // Cập nhật cấu hình FLAVOR_SPECS toàn cục
        flavors.forEach(f => {
          FLAVOR_SPECS[f.name] = {
            vcpu: f.vcpus,
            ramMb: f.ramMb,
            ramDisplay: f.ramDisplay,
            defaultDisk: f.diskGb
          };
        });

        const m1Flavors = flavors.filter(f => f.name.startsWith('m1'));
        const h1Flavors = flavors.filter(f => f.name.startsWith('h1'));
        const otherFlavors = flavors.filter(f => !f.name.startsWith('m1') && !f.name.startsWith('h1'));

        let selectHtml = '';
        if (m1Flavors.length > 0) {
          selectHtml += `<optgroup label="── Dòng Tiêu Chuẩn (m1) ──">`;
          m1Flavors.forEach(f => {
            const isDef = f.name === 'm1.medium';
            selectHtml += `<option value="${f.name}" ${isDef ? 'selected' : ''}>${f.name} — ${f.vcpus} vCPU${f.vcpus > 1 ? 's' : ''} • ${f.ramDisplay} • ${f.diskGb} GB Root Disk ${isDef ? '[Mặc định]' : ''}</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        if (h1Flavors.length > 0) {
          selectHtml += `<optgroup label="── Dòng Hiệu Năng Cao (h1) ──">`;
          h1Flavors.forEach(f => {
            selectHtml += `<option value="${f.name}">${f.name} — ${f.vcpus} vCPUs • ${f.ramDisplay} • ${f.diskGb} GB Root Disk</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        if (otherFlavors.length > 0) {
          selectHtml += `<optgroup label="── Dòng Khác ──">`;
          otherFlavors.forEach(f => {
            selectHtml += `<option value="${f.name}">${f.name} — ${f.vcpus} vCPU • ${f.ramDisplay} • ${f.diskGb} GB Root Disk</option>`;
          });
          selectHtml += `</optgroup>`;
        }
        flavorSelect.innerHTML = selectHtml;

        // Render bảng ma trận Flavor
        if (flavorMatrixBody) {
          flavorMatrixBody.innerHTML = flavors.map(f => {
            const rowId = `row-${f.name.replace('.', '-')}`;
            const isMedium = f.name === 'm1.medium';
            const seriesColor = f.name.startsWith('h1') ? '#a855f7' : '#38bdf8';
            return `
              <tr id="${rowId}" style="border-top: 1px solid rgba(255,255,255,0.05); ${isMedium ? 'background: rgba(56, 189, 248, 0.12);' : ''}">
                <td style="padding: 8px 12px; color: ${seriesColor}; font-weight: 600;">${f.series || 'Tiêu chuẩn'}</td>
                <td style="padding: 8px 12px; font-family: monospace; font-weight: 700; color: ${isMedium ? '#38bdf8' : '#fff'};">${f.name} ${isMedium ? '★' : ''}</td>
                <td style="padding: 8px 12px; font-weight: ${isMedium ? '700' : '400'}; color: #fff;">${f.vcpus}</td>
                <td style="padding: 8px 12px; font-weight: ${isMedium ? '700' : '400'}; color: #fff;">${f.ramMb}</td>
                <td style="padding: 8px 12px; color: #34d399; font-weight: 600;">${f.diskGb}</td>
              </tr>
            `;
          }).join('');
        }
      }
    } catch (e) {
      console.warn('Không thể tải Nova Flavors từ DynamoDB:', e);
    }
  }

  updatePageLaunchSummary();
}

function updatePageLaunchSummary() {
  const regionEl = document.getElementById('instRegion');
  const imageEl = document.getElementById('instImage');
  const flavorEl = document.getElementById('instFlavor');
  const ebsEl = document.getElementById('instEbsSize');

  if (!regionEl || !imageEl || !flavorEl || !ebsEl) return;

  const region = regionEl.value;
  const isRegionA = region.includes('southeast');
  const regionLabel = isRegionA ? 'Region A (Singapore / Sydney)' : 'Region B (N. Virginia)';

  const osMap = {
    'img-u22': 'Ubuntu Server 22.04 LTS',
    'img-deb12': 'Debian 12 Bookworm',
    'img-rocky9': 'Rocky Linux 9 Enterprise',
    'img-alp319': 'Alpine Linux 3.19 Minimal'
  };
  const osLabel = dynamicOsMap[imageEl.value] || osMap[imageEl.value] || imageEl.value;

  const flavorVal = flavorEl.value;
  const spec = FLAVOR_SPECS[flavorVal] || FLAVOR_SPECS['m1.medium'] || { vcpu: 2, ramDisplay: '4 GB', defaultDisk: 10 };
  const ebsSize = parseInt(ebsEl.value) || spec.defaultDisk || 10;

  const specsText = `${spec.vcpu} vCPU${spec.vcpu > 1 ? 's' : ''} • ${spec.ramDisplay} • ${ebsSize} GB Root Disk`;

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
    sumKey.textContent = val ? val : 'Mặc định (xregion-key)';
  }
  const sumSg = document.getElementById('sumSgText');
  if (sumSg && typeof lfwSummaryText === 'function') {
    sumSg.textContent = lfwSummaryText();
  }

  // Highlight selected row in specification matrix table
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

async function handleLaunchPageSubmit(e) {
  e.preventDefault();
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';

  // Bước 6: kiểm tra rule Security Group trước khi tạo máy (launch-firewall.js)
  const fwError = typeof lfwValidate === 'function' ? lfwValidate() : '';
  if (fwError) {
    showToast(fwError, 'error');
    return;
  }

  const btn = document.getElementById('btnLaunchInstance');
  const origText = btn ? btn.innerHTML : '🚀 Launch Instance';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang cấp phát máy ảo EC2 & ổ đĩa EBS...';
  }

  const payload = {
    name: document.getElementById('instName').value.trim(),
    region: document.getElementById('instRegion').value,
    flavor: document.getElementById('instFlavor').value,
    imageId: document.getElementById('instImage').value,
    keyPairName: document.getElementById('instKeyPair')?.value || 'xregion-key',
    ebsSizeGb: parseInt(document.getElementById('instEbsSize').value) || 10,
    domainName: document.getElementById('instDomain').value.trim()
  };

  try {
    const res = await apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // Ghi rule inbound/outbound vào Security Group riêng của máy vừa tạo
    if (res && res.id && typeof lfwApplyToInstance === 'function') {
      await lfwApplyToInstance(res.id);
    }

    const form = document.getElementById('launchInstancePageForm');
    if (form) form.reset();
    sessionStorage.setItem('xregion_launch_completed', 'true');

    showToast(`Khởi tạo máy ảo [${payload.name}] (${res ? res.id : ''}) thành công!`, 'success');
    setTimeout(() => {
      window.location.replace('/instances.html');
    }, 800);
  } catch (err) {
    console.error('Launch failed:', err);
    if (errBox) {
      errBox.innerHTML = `<strong>❌ Lỗi khởi tạo máy ảo (POST /api/instances):</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi khởi tạo: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}
