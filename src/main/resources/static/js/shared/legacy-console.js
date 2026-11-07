// Code của giao diện console một trang cũ (tab Storage/Images/Network/Migration/Monitoring).
// Trang danh sách máy ảo vẫn dùng triggerDirectMigration -> switchTab -> các hàm load* ở đây.
// Chỉ instances.html nạp file này.

function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-card').forEach(el => el.classList.remove('active'));

  const activePane = document.getElementById('tab-' + tabId);
  if (activePane) activePane.classList.add('active');

  const navCards = document.querySelectorAll('.nav-card');
  const tabs = ['compute', 'storage', 'images', 'network', 'migration', 'monitoring'];
  const idx = tabs.indexOf(tabId);
  if (idx !== -1 && navCards[idx]) {
    navCards[idx].classList.add('active');
  }

  // Refresh tab data
  if (tabId === 'compute') loadInstances();
  if (tabId === 'storage') loadVolumes();
  if (tabId === 'images') loadImages();
  if (tabId === 'network') loadNetwork();
  if (tabId === 'migration') loadScenarios();
  if (tabId === 'monitoring') {
    loadMonitoringOverview();
    loadAuditLogs();
  }
}

function openLaunchModal() {
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';
  openModal('launchModal');
  updateLaunchSummary();
}

function updateLaunchSummary() {
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
  const osLabel = osMap[imageEl.value] || 'Ubuntu Server 22.04 LTS';

  const flavorVal = flavorEl.value;
  const spec = FLAVOR_SPECS[flavorVal] || FLAVOR_SPECS['m1.medium'];
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
}

async function submitLaunch(e) {
  e.preventDefault();
  const errBox = document.getElementById('launchErrorBox');
  if (errBox) errBox.style.display = 'none';

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.innerHTML : '🚀 Launch Compute Instance';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '⏳ Đang khởi tạo máy ảo...';
  }

  const body = {
    name: document.getElementById('instName').value.trim(),
    region: document.getElementById('instRegion').value,
    flavor: document.getElementById('instFlavor').value,
    imageId: document.getElementById('instImage').value,
    keyPairName: document.getElementById('instKeyPair')?.value || 'xregion-key',
    securityGroup: document.getElementById('instSecurityGroup')?.value || 'sg-default',
    ebsSizeGb: parseInt(document.getElementById('instEbsSize').value) || 10,
    domainName: document.getElementById('instDomain').value.trim()
  };

  try {
    const res = await apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('launchModal');
    showToast(`Đã khởi tạo máy ảo ${body.name} (${res ? res.id : ''}) thành công!`, 'success');
    loadInstances();
  } catch (err) {
    console.error('Launch instance failed:', err);
    if (errBox) {
      errBox.innerHTML = `<strong>❌ Lỗi khởi tạo máy ảo (POST /api/instances):</strong><br>${err.message}`;
      errBox.style.display = 'block';
    }
    showToast(`Lỗi khởi tạo máy ảo: ${err.message}`, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
  }
}

// TAB 2: STORAGE
async function loadVolumes() {
  const tbody = document.getElementById('volumeTableBody');
  try {
    const volumes = await apiRequest('/volumes');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!volumes || volumes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 20px; color: var(--text-muted);">Chưa có ổ đĩa nào trong kho lưu trữ.</td></tr>';
      return;
    }

    volumes.forEach(vol => {
      const isAttached = vol.status === 'IN_USE';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace; color:var(--accent-green); font-weight:700;">${vol.id}</td>
        <td><strong>${vol.name}</strong></td>
        <td>${vol.sizeGb} GB</td>
        <td><span class="badge" style="background:#1e293b; color:#38bdf8;">${vol.volumeType}</span></td>
        <td>${vol.iops} IOPS / ${vol.throughput} MB/s</td>
        <td>${vol.region}</td>
        <td>${vol.attachedInstanceName} ${vol.device ? `(${vol.device})` : ''}</td>
        <td><span class="badge ${isAttached ? 'badge-active' : 'badge-shutoff'}">${vol.status}</span></td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            ${isAttached 
              ? `<button class="btn btn-secondary btn-sm" onclick="detachVolume('${vol.id}')">Tháo</button>` 
              : `<button class="btn btn-success btn-sm" onclick="promptAttachVolume('${vol.id}')">Gắn</button>`}
            <button class="btn btn-primary btn-sm" onclick="openCopySnapshotModal('${vol.id}', '${vol.name}', '${vol.region}')">Snapshot Xuyên Vùng</button>
            <button class="btn btn-danger btn-sm" onclick="deleteVolume('${vol.id}')">Xóa</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load volumes:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 24px; color: #f87171; background: rgba(239, 68, 68, 0.05); border-radius: 8px;">❌ Không thể tải danh sách ổ đĩa từ API (GET /api/volumes): ${err.message}</td></tr>`;
    }
  }
}

async function submitCreateVolume(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('volName').value.trim(),
    sizeGb: parseInt(document.getElementById('volSize').value) || 20,
    region: document.getElementById('volRegion').value,
    volumeType: 'gp3'
  };

  try {
    const res = await apiRequest('/volumes', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('createVolumeModal');
    showToast(`Đã cấp phát ổ đĩa ${body.name} (${res ? res.id : ''}) thành công!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to create volume:', err);
    showToast(`Lỗi cấp phát ổ đĩa: ${err.message}`, 'error');
  }
}

async function detachVolume(id) {
  try {
    await apiRequest(`/volumes/${id}/detach`, { method: 'POST' });
    showToast(`Đã tháo ổ đĩa ${id} thành công!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to detach volume:', err);
    showToast(`Lỗi tháo ổ đĩa: ${err.message}`, 'error');
  }
}

async function promptAttachVolume(volId) {
  const instanceId = prompt('Nhập ID máy ảo cần gắn ổ đĩa (VD: i-0a3f9c21e7b4d5810):');
  if (!instanceId) return;
  try {
    await apiRequest(`/volumes/${volId}/attach`, {
      method: 'POST',
      body: JSON.stringify({ instanceId: instanceId.trim(), device: '/dev/vdb' })
    });
    showToast(`Đã gắn ổ đĩa ${volId} vào máy ảo ${instanceId}!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to attach volume:', err);
    showToast(`Lỗi gắn ổ đĩa: ${err.message}`, 'error');
  }
}

function openCopySnapshotModal(volId, name, region) {
  document.getElementById('copyVolId').value = volId;
  document.getElementById('copySrcRegion').value = region;
  document.getElementById('copyVolNameDisplay').value = `${name} (${volId}) [${region}]`;
  document.getElementById('copyDestRegion').value = region.includes('southeast') ? 'us-east-1' : 'ap-southeast-2';
  openModal('copySnapshotModal');
}

async function submitCopySnapshot(e) {
  e.preventDefault();
  const body = {
    volumeId: document.getElementById('copyVolId').value,
    sourceRegion: document.getElementById('copySrcRegion').value,
    destinationRegion: document.getElementById('copyDestRegion').value,
    description: 'Cross-region copy triggered from UI'
  };

  try {
    await apiRequest('/volumes/cross-region-copy', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('copySnapshotModal');
    showToast('Đã kích hoạt sao chép snapshot xuyên vùng sang ' + body.destinationRegion, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to copy snapshot cross region:', err);
    showToast(`Lỗi sao chép snapshot: ${err.message}`, 'error');
  }
}

async function deleteVolume(id) {
  if (!confirm('Bạn có chắc chắn muốn xóa ổ đĩa ' + id + '?')) return;
  try {
    await apiRequest(`/volumes/${id}`, { method: 'DELETE' });
    showToast(`Đã xóa ổ đĩa ${id} thành công!`, 'success');
    loadVolumes();
  } catch (err) {
    console.error('Failed to delete volume:', err);
    showToast(`Lỗi xóa ổ đĩa: ${err.message}`, 'error');
  }
}

// TAB 3: IMAGES
async function loadImages() {
  const grid = document.getElementById('imageGrid');
  try {
    const images = await apiRequest('/images');
    if (!grid) return;
    grid.innerHTML = '';

    if (!images || images.length === 0) {
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding: 24px; color: var(--text-muted);">Không có OS Image nào.</div>';
      return;
    }

    images.forEach(img => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.marginBottom = '0';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <span class="badge badge-active">${img.osType}</span>
          <span style="font-size:11px; color:var(--text-muted);">${img.visibility}</span>
        </div>
        <h3 style="font-size:15px; margin-bottom:8px;">${img.name}</h3>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Glance ID: <code>${img.glanceId}</code></p>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted);">
          <span>Dung lượng: ${img.sizeGb} GB</span>
          <span>Trạng thái: <strong>${img.status}</strong></span>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load images:', err);
    if (grid) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 30px; background: rgba(239, 68, 68, 0.05); border-radius: 8px; color: #f87171;">❌ Không thể tải kho ảnh hệ điều hành từ API (GET /api/images):<br><span style="font-family: monospace; font-size: 12px; color: #cbd5e1;">${err.message}</span></div>`;
    }
  }
}

// TAB 4: NETWORK
async function loadNetwork() {
  try {
    const net = await apiRequest('/network');
    const vpcContainer = document.getElementById('vpcContainer');
    const dnsBody = document.getElementById('dnsTableBody');

    vpcContainer.innerHTML = '';
    dnsBody.innerHTML = '';

    // Render VPCs
    if (net.vpcs) {
      net.vpcs.forEach(vpc => {
        const box = document.createElement('div');
        box.className = 'card';
        box.style.flex = '1';
        box.style.marginBottom = '0';
        box.innerHTML = `
          <div style="font-weight:700; font-size:15px; color:var(--accent-purple); margin-bottom:8px;">
            ${vpc.name} (${vpc.region})
          </div>
          <div style="font-size:13px; color:var(--text-muted); line-height:1.6;">
            <div>CIDR Block: <code>${vpc.cidr}</code></div>
            <div>Subnet ID: <code>${vpc.primarySubnetId || 'N/A'}</code></div>
            <div>Gateway: Internet Gateway & NAT Active</div>
          </div>
        `;
        vpcContainer.appendChild(box);
      });
    }

    // Render DNS Records
    if (net.dnsRecords) {
      net.dnsRecords.forEach(dns => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${dns.domainName}</strong></td>
          <td><span class="badge" style="background:#3b82f6; color:white;">A</span></td>
          <td><code>${dns.targetIp}</code></td>
          <td>${dns.ttl}s</td>
          <td><span class="badge badge-active">${dns.status || 'SYNCED'}</span></td>
        `;
        dnsBody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error(err);
  }
}

async function submitUpdateDns(e) {
  e.preventDefault();
  const body = {
    domainName: document.getElementById('dnsDomainInput').value,
    targetIp: document.getElementById('dnsTargetIpInput').value,
    ttl: parseInt(document.getElementById('dnsTtlInput').value) || 60
  };

  try {
    await apiRequest('/network/dns', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('dnsModal');
    alert('Đã cập nhật bản ghi Route 53 DNS thành công!');
    loadNetwork();
  } catch (err) {
    console.error(err);
  }
}

// TAB 5: MIGRATION (6-Step Pipeline Coordinator)
async function loadScenarios() {
  try {
    const scenarios = await apiRequest('/migrations/scenarios');
    const tbody = document.getElementById('scenarioTableBody');
    tbody.innerHTML = '';

    if (!scenarios || scenarios.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">Chưa có kịch bản di trú nào. Bấm "+ Tạo Kịch Bản" để cấu hình.</td></tr>';
      return;
    }

    scenarios.forEach(sc => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace; color:var(--accent-pink); font-weight:700;">${sc.id}</td>
        <td><strong>${sc.name}</strong></td>
        <td><code>${sc.targetInstanceId}</code></td>
        <td>${sc.sourceRegion} ➔ ${sc.destRegion}</td>
        <td><span class="badge badge-active">${sc.triggerType}</span></td>
        <td><code>${sc.cronExpression || 'Manual'}</code></td>
        <td>${sc.cooldownMinutes} phút</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="triggerDirectMigration('${sc.id}')">Chạy Kịch Bản Ngay</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

async function submitCreateScenario(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('scName').value,
    targetInstanceId: document.getElementById('scInstanceSelect').value,
    sourceRegion: document.getElementById('scSrcRegion').value,
    destRegion: document.getElementById('scDstRegion').value,
    triggerType: document.getElementById('scTriggerType').value,
    cooldownMinutes: parseInt(document.getElementById('scCooldown').value) || 60
  };

  try {
    await apiRequest('/migrations/scenarios', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('scenarioModal');
    loadScenarios();
  } catch (err) {
    console.error(err);
  }
}

async function triggerDirectMigration(targetId) {
  if (!confirm('Bạn có chắc chắn muốn kích hoạt chuyển vùng ngay lập tức cho ' + targetId + '?')) {
    return;
  }

  // Switch to migration tab to show live progress
  switchTab('migration');

  try {
    const res = await apiRequest('/migrations/trigger', {
      method: 'POST',
      body: JSON.stringify({ id: targetId })
    });

    const instanceId = res.instanceId;
    startProgressPolling(instanceId);
  } catch (err) {
    console.error(err);
  }
}

function startProgressPolling(instanceId) {
  if (migrationPollInterval) clearInterval(migrationPollInterval);

  const term = document.getElementById('terminalLogs');
  term.innerHTML = `[${new Date().toLocaleTimeString()}] Bắt đầu theo dõi tiến trình di trú cho máy ảo ${instanceId}...<br>`;

  migrationPollInterval = setInterval(async () => {
    try {
      const data = await apiRequest(`/migrations/progress/${instanceId}`);
      updatePipelineUI(data);

      if (data.status === 'COMPLETED' || data.status === 'ROLLED_BACK') {
        clearInterval(migrationPollInterval);
        loadInstances();
      }
    } catch (err) {
      clearInterval(migrationPollInterval);
    }
  }, 1000);
}

function updatePipelineUI(data) {
  const bar = document.getElementById('pipelineBar');
  const term = document.getElementById('terminalLogs');
  const percent = data.progressPercent || 0;
  bar.style.width = percent + '%';

  const step = data.stepNumber || 0;
  for (let i = 1; i <= 6; i++) {
    const circle = document.getElementById('stepCircle' + i);
    circle.className = 'step-circle';
    if (i < step) {
      circle.classList.add('completed');
    } else if (i === step) {
      circle.classList.add('active');
    }
  }

  if (data.logs && data.logs.length > 0) {
    term.innerHTML = data.logs.join('<br>');
    term.scrollTop = term.scrollHeight;
  }
}

// TAB 6: MONITORING & LOGS
async function loadMonitoringOverview() {
  loadMetrics();
}

async function loadMetrics() {
  const select = document.getElementById('metricVmSelect');
  const instanceId = select.value || 'vm-syd-01';

  try {
    const data = await apiRequest(`/metrics/instances/${instanceId}`);
    renderCostCards(data.costSummary);
    renderPerformanceChart(data.timeSeries);
  } catch (err) {
    console.error(err);
  }
}

function renderCostCards(costs) {
  if (!costs) return;
  const container = document.getElementById('costCards');
  container.innerHTML = `
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-cyan);">
      <div style="font-size:12px; color:var(--text-muted);">Sydney Compute (ap-southeast-2)</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.sydneyComputeMonthly}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-green);">
      <div style="font-size:12px; color:var(--text-muted);">EBS gp3 Storage Sydney</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.sydneyStorageMonthly}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-purple);">
      <div style="font-size:12px; color:var(--text-muted);">N. Virginia Standby (us-east-1)</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.virginiaComputeMonthly}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-pink);">
      <div style="font-size:12px; color:var(--text-muted);">Truyền Dữ Liệu X-Region</div>
      <div style="font-size:22px; font-weight:800; color:white; margin-top:4px;">$${costs.crossRegionDataTransfer}/tháng</div>
    </div>
    <div class="card" style="margin-bottom:0; border-left: 4px solid var(--accent-amber);">
      <div style="font-size:12px; color:var(--text-muted);">Tổng Chi Phí Ước Tính</div>
      <div style="font-size:22px; font-weight:800; color:#38bdf8; margin-top:4px;">$${costs.totalMonthlyEstimated}/tháng</div>
    </div>
  `;
}

function renderPerformanceChart(timeSeries) {
  if (!timeSeries) return;
  const ctx = document.getElementById('performanceChart').getContext('2d');

  const labels = timeSeries.map(p => new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const cpuData = timeSeries.map(p => p.cpuUsage);
  const ramData = timeSeries.map(p => p.ramUsage);

  if (performanceChart) {
    performanceChart.destroy();
  }

  performanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'CPU Usage (%)',
          data: cpuData,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.1)',
          tension: 0.3,
          fill: true
        },
        {
          label: 'RAM Usage (%)',
          data: ramData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.3,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' }
        },
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#f8fafc' }
        }
      }
    }
  });
}

async function loadAuditLogs() {
  try {
    const logs = await apiRequest('/logs?limit=50');
    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Chưa có nhật ký nào.</td></tr>';
      return;
    }

    logs.forEach(log => {
      const tr = document.createElement('tr');
      const timeStr = log.timestamp ? formatSyncedDateTime(log.timestamp) : 'N/A';
      tr.innerHTML = `
        <td style="color:var(--text-muted); font-size:12px;">${timeStr}</td>
        <td><strong>${log.username || 'system'}</strong></td>
        <td><span class="badge" style="background:#1e293b; color:var(--accent-cyan);">${log.action}</span></td>
        <td>${log.resourceType}</td>
        <td><code>${log.resourceId}</code></td>
        <td style="color:#cbd5e1;">${log.details}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

// 3. INSTANCE DETAIL PAGE (instance-detail.html)
async function initDetailPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  const urlParams = new URLSearchParams(window.location.search);
  const instanceId = urlParams.get('id');

  if (!instanceId) {
    showApiError('/instances/{id}', 'Không tìm thấy tham số ID máy ảo trong URL. Vui lòng quay lại danh sách máy ảo.');
    return;
  }

  const bcId = document.getElementById('breadcrumbInstanceId');
  if (bcId) bcId.textContent = instanceId;

  try {
    const inst = await apiRequest(`/instances/${instanceId}`);
    if (!inst) {
      throw new Error(`Không tìm thấy thông tin máy ảo với ID [${instanceId}]`);
    }

    // Populate header & summary card
    const nameEl = document.getElementById('detInstanceName');
    if (nameEl) nameEl.textContent = inst.name || inst.id;
    const idEl = document.getElementById('detInstanceId');
    if (idEl) idEl.textContent = inst.id;
    const sumIdEl = document.getElementById('summaryCardId');
    if (sumIdEl) sumIdEl.textContent = inst.id;
    const regNameEl = document.getElementById('detRegionName');
    if (regNameEl) regNameEl.textContent = inst.regionName || inst.region;
    const regCodeEl = document.getElementById('detRegionCode');
    if (regCodeEl) regCodeEl.textContent = `(${inst.region})`;

    const badge = document.getElementById('detStatusBadge');
    const cfg = getStatusBadgeConfig(inst.status);
    if (badge) {
      badge.className = 'badge ' + cfg.cssClass;
      badge.innerHTML = `<span class="status-dot ${cfg.dotClass}"></span>${cfg.label}`;
    }

    const sumStat = document.getElementById('detSummaryStatus');
    if (sumStat) {
      sumStat.innerHTML = `<span class="badge ${cfg.cssClass}"><span class="status-dot ${cfg.dotClass}"></span>${cfg.label}</span>`;
    }

    // Populate Summary & Tabs
    const spec = FLAVOR_SPECS[inst.flavor] || FLAVOR_SPECS['m1.medium'];
    const specDesc = spec ? ` (${spec.vcpu} vCPU • ${spec.ramDisplay})` : '';
    const flavEl = document.getElementById('detFlavor');
    if (flavEl) flavEl.textContent = `${inst.flavor}${specDesc}`;

    const detKeyEl = document.getElementById('detKeyName');
    if (detKeyEl) detKeyEl.textContent = inst.keyName || 'xregion-key';
    const detSgEl = document.getElementById('detSecurityGroup');
    if (detSgEl) detSgEl.textContent = inst.securityGroup || 'sg-default';
    const detPrivEl = document.getElementById('detPrivateIp');
    if (detPrivEl) detPrivEl.textContent = inst.privateIp || '10.0.1.10';
    const detPubEl = document.getElementById('detPublicIp');
    if (detPubEl) detPubEl.textContent = inst.publicIp || 'Chưa gán';
    const detDnsEl = document.getElementById('detDnsDomain');
    if (detDnsEl) detDnsEl.textContent = inst.dnsDomain || 'N/A';
    const detUpEl = document.getElementById('detUpdatedAt');
    if (detUpEl) detUpEl.textContent = inst.updatedAt ? formatSyncedDateTime(inst.updatedAt) : 'Vừa xong';

    const cdEl = document.getElementById('detCooldownDisplay');
    if (cdEl) {
      cdEl.textContent = inst.cooldownSeconds && inst.cooldownSeconds > 0 ? `${inst.cooldownSeconds}s (Đang cooldown)` : '0 giây (Sẵn sàng)';
    }

    // Tab 1: Details
    const tfName = document.getElementById('tabFlavorName');
    if (tfName) tfName.textContent = inst.flavor;
    const tfVcpu = document.getElementById('tabFlavorVcpu');
    if (tfVcpu) tfVcpu.textContent = spec ? spec.vcpu : 2;
    const tfRam = document.getElementById('tabFlavorRam');
    if (tfRam) tfRam.textContent = spec ? spec.ramDisplay : '4 GB';
    const tfDisk = document.getElementById('tabFlavorDisk');
    if (tfDisk) tfDisk.textContent = spec ? spec.defaultDisk : 10;
    const tInstName = document.getElementById('tabInstanceName');
    if (tInstName) tInstName.textContent = inst.name || inst.id;
    const tInstId = document.getElementById('tabInstanceId');
    if (tInstId) tInstId.textContent = inst.id;
    const tRegName = document.getElementById('tabRegionName');
    if (tRegName) tRegName.textContent = `${inst.regionName || inst.region} [${inst.region}]`;
    const tUser = document.getElementById('tabUsername');
    if (tUser) tUser.textContent = inst.username || 'admin';

    // Tab 2: Networking & Security
    const tNetDns = document.getElementById('tabNetDns');
    if (tNetDns) tNetDns.textContent = inst.dnsDomain || 'N/A';
    const tNetPub = document.getElementById('tabNetPublicIp');
    if (tNetPub) tNetPub.textContent = inst.publicIp || 'Chưa gán';
    const tNetPriv = document.getElementById('tabNetPrivateIp');
    if (tNetPriv) tNetPriv.textContent = inst.privateIp || '10.0.1.10';
    const tNetSg = document.getElementById('tabNetSecurityGroup');
    if (tNetSg) tNetSg.textContent = inst.securityGroup || 'sg-default';
    const tNetKey = document.getElementById('tabNetKeyName');
    if (tNetKey) tNetKey.textContent = inst.keyName || 'xregion-key';

    // Tab 3: Migration
    const tMigCur = document.getElementById('tabMigCurrentRegion');
    if (tMigCur) tMigCur.textContent = `${inst.regionName || inst.region} (${inst.region})`;
    const isSydney = (inst.region || '').includes('Sydney') || (inst.region || '').includes('Region A');
    const tMigTar = document.getElementById('tabMigTargetRegion');
    if (tMigTar) tMigTar.textContent = isSydney ? 'Melbourne (Region B - ap-southeast-4)' : 'Sydney (Region A - ap-southeast-2)';
    const tMigUp = document.getElementById('tabMigUpdatedAt');
    if (tMigUp) tMigUp.textContent = inst.updatedAt ? formatSyncedDateTime(inst.updatedAt) : 'Vừa xong';

    const isRunning = (inst.status || '').toUpperCase() === 'RUNNING' || (inst.status || '').toUpperCase() === 'ACTIVE';
    const isTrans = cfg.isTransitioning;
    const isTerminated = (inst.status || '').toUpperCase() === 'TERMINATED';

    const tabMigBtn = document.getElementById('tabMigrateActionBtn');
    if (tabMigBtn) {
      tabMigBtn.disabled = !isRunning || isTrans || isTerminated;
      tabMigBtn.onclick = () => triggerDirectMigration(inst.id);
    }

    // Render Actions Toolbar (disables buttons if instance is transitioning)
    const actionsContainer = document.getElementById('detailActionButtons');
    if (actionsContainer) {
      actionsContainer.innerHTML = `
        <button class="btn btn-secondary" onclick="initDetailPage()" title="Làm mới trạng thái">⟳ Làm Mới</button>
        <a href="/instance-edit.html?id=${inst.id}" class="btn btn-secondary ${isTrans || isTerminated ? 'disabled' : ''}" style="text-decoration:none; color:var(--accent-cyan);" ${isTrans || isTerminated ? 'tabindex="-1"' : ''}>✏️ Chỉnh Sửa</a>
        ${isRunning
          ? `<button class="btn btn-secondary ${isTrans ? 'disabled' : ''}" ${isTrans ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'STOP')">⏸ Dừng Máy (Stop)</button>`
          : `<button class="btn btn-success ${isTrans || isTerminated ? 'disabled' : ''}" ${isTrans || isTerminated ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'START')">▶ Bật Máy (Start)</button>`}
        <button class="btn btn-secondary ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'REBOOT')">🔄 Reboot</button>
        <button class="btn btn-primary ${!isRunning || isTrans ? 'disabled' : ''}" ${!isRunning || isTrans ? 'disabled' : ''} onclick="triggerDirectMigration('${inst.id}')">⚡ Fast Migrate X-Region</button>
        <button class="btn btn-danger ${isTrans || isTerminated ? 'disabled' : ''}" ${isTrans || isTerminated ? 'disabled' : ''} onclick="executeDetailAction('${inst.id}', 'TERMINATE')">🗑 Xóa Máy Ảo</button>
      `;
    }

    // Auto-refresh if currently transitioning
    if (isTrans) {
      setTimeout(initDetailPage, 2500);
    }
  } catch (err) {
    console.error('Failed to load instance detail:', err);
    showApiError(`/instances/${instanceId}`, err.message);
    document.getElementById('detInstanceName').textContent = 'Lỗi Tải Dữ Liệu';
  }
}

async function executeDetailAction(id, action) {
  if (action === 'TERMINATE' && !confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn máy ảo [${id}]?`)) {
    return;
  }

  try {
    await apiRequest(`/instances/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    showToast(`Đã gửi lệnh [${action}] đến máy ảo ${id}!`, 'success');

    if (action === 'TERMINATE') {
      setTimeout(() => {
        window.location.href = '/instances.html';
      }, 1000);
    } else {
      initDetailPage();
    }
  } catch (err) {
    showToast(`Lỗi thao tác ${action}: ${err.message}`, 'error');
  }
}
