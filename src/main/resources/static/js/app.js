// XRegion Dashboard Client-side JavaScript

const API_BASE = '/api';
let authToken = localStorage.getItem('xregion_jwt') || '';
let performanceChart = null;
let migrationPollInterval = null;

// Tab Routing
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

// Modal Helpers
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
}

// Authenticated Fetch wrapper
async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {})
  };

  try {
    const res = await fetch(API_BASE + endpoint, { ...options, headers });
    if (res.status === 401) {
      openModal('loginModal');
      throw new Error('Chưa xác thực hoặc phiên đăng nhập hết hạn.');
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Lỗi xử lý yêu cầu.');
    }
    return data.data;
  } catch (err) {
    console.error('API Error:', err);
    alert('Thông báo: ' + err.message);
    throw err;
  }
}

// Authentication
async function submitLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;

  try {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok && data.data && data.data.token) {
      authToken = data.data.token;
      localStorage.setItem('xregion_jwt', authToken);
      document.getElementById('userNameDisplay').textContent = data.data.fullName || username;
      closeModal('loginModal');
      loadInstances();
    } else {
      alert('Đăng nhập thất bại: ' + (data.message || 'Sai thông tin'));
    }
  } catch (err) {
    alert('Lỗi đăng nhập: ' + err.message);
  }
}

function logout() {
  localStorage.removeItem('xregion_jwt');
  authToken = '';
  openModal('loginModal');
}

// TAB 1: COMPUTE
let cachedInstances = [];

async function loadInstances() {
  try {
    const instances = await apiRequest('/instances');
    cachedInstances = instances || [];
    const select = document.getElementById('scInstanceSelect');
    const metricSelect = document.getElementById('metricVmSelect');

    if (select) select.innerHTML = '';
    if (metricSelect) metricSelect.innerHTML = '';

    // Update 4 Summary Cards (Hình 2.2)
    const total = cachedInstances.length;
    const running = cachedInstances.filter(i => i.status === 'ACTIVE').length;
    const stopped = cachedInstances.filter(i => i.status === 'SHUTOFF').length;
    const migrating = cachedInstances.filter(i => i.status === 'MIGRATING').length;
    const regionACount = cachedInstances.filter(i => (i.region || '').includes('southeast')).length;

    const elTotal = document.getElementById('statTotalInstances');
    const elRegA = document.getElementById('statRegionACount');
    const elRun = document.getElementById('statRunningInstances');
    const elStop = document.getElementById('statStoppedInstances');
    const elMig = document.getElementById('statMigratingInstances');
    const elBadge = document.getElementById('instanceCountBadge');

    if (elTotal) elTotal.textContent = total;
    if (elRegA) elRegA.textContent = `${regionACount} in Region A`;
    if (elRun) elRun.textContent = running;
    if (elStop) elStop.textContent = stopped;
    if (elMig) elMig.textContent = migrating;
    if (elBadge) elBadge.textContent = `(${total})`;

    cachedInstances.forEach(inst => {
      if (select) {
        select.innerHTML += `<option value="${inst.id}">${inst.name} (${inst.id}) - ${inst.region}</option>`;
      }
      if (metricSelect) {
        metricSelect.innerHTML += `<option value="${inst.id}">${inst.name} (${inst.id})</option>`;
      }
    });

    filterInstancesUI();
  } catch (err) {
    console.error('Failed to load instances:', err);
  }
}

function filterInstancesUI() {
  const tbody = document.getElementById('instanceTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = (document.getElementById('instanceSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('instanceStatusFilter')?.value || 'ALL';

  const filtered = cachedInstances.filter(inst => {
    const matchText = !q || (inst.name || '').toLowerCase().includes(q) || (inst.id || '').toLowerCase().includes(q);
    const matchStatus = statusFilter === 'ALL' || inst.status === statusFilter;
    return matchText && matchStatus;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 20px;">Chưa có máy ảo nào khớp bộ lọc. Bấm "+ Launch Instance" để tạo máy ảo mới.</td></tr>';
    return;
  }

  filtered.forEach(inst => {
    const badgeClass = inst.status === 'ACTIVE' ? 'badge-active' :
                       inst.status === 'MIGRATING' ? 'badge-migrating' :
                       inst.status === 'SHUTOFF' ? 'badge-shutoff' : 'badge-error';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-family:monospace; color:var(--accent-cyan); font-weight:700;">${inst.id}</td>
      <td><strong>${inst.name}</strong></td>
      <td>${inst.regionName || inst.region}</td>
      <td><span class="badge" style="background:#1e293b; color:#94a3b8;">${inst.flavor}</span></td>
      <td><code>${inst.privateIp}</code></td>
      <td><code>${inst.publicIp || 'Chưa gán'}</code></td>
      <td><span style="color:var(--accent-cyan);">${inst.dnsDomain || 'N/A'}</span></td>
      <td><span class="badge ${badgeClass}">${inst.status}</span></td>
      <td>
        <div style="display:flex; gap:4px;">
          ${inst.status === 'ACTIVE' 
            ? `<button class="btn btn-secondary btn-sm" onclick="instanceAction('${inst.id}', 'STOP')">Dừng</button>` 
            : `<button class="btn btn-success btn-sm" onclick="instanceAction('${inst.id}', 'START')">Bật</button>`}
          <button class="btn btn-secondary btn-sm" onclick="instanceAction('${inst.id}', 'REBOOT')">Reboot</button>
          <button class="btn btn-primary btn-sm" onclick="triggerDirectMigration('${inst.id}')">⚡ Fast Migrate</button>
          <button class="btn btn-danger btn-sm" onclick="instanceAction('${inst.id}', 'TERMINATE')">Xóa</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openLaunchModal() {
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
    'img-rocky9': 'Rocky Linux 9',
    'img-alp319': 'Alpine Linux 3.19 Minimal'
  };
  const osLabel = osMap[imageEl.value] || 'Ubuntu Server 22.04 LTS';

  const flavorVal = flavorEl.value;
  const ebsSize = parseInt(ebsEl.value) || 50;

  let specsText = `2 vCPU, 4 GB RAM, ${ebsSize} GB EBS SSD`;
  let baseHourly = 0.08;
  if (flavorVal === 'm1.small') {
    specsText = `1 vCPU, 2 GB RAM, ${ebsSize} GB EBS SSD`;
    baseHourly = 0.04;
  } else if (flavorVal === 'c5.large') {
    specsText = `4 vCPU, 8 GB RAM, ${ebsSize} GB EBS SSD`;
    baseHourly = 0.16;
  }

  // Adjust by region factor (Region B N. Virginia is ~25% cheaper)
  const regionMultiplier = isRegionA ? 1.0 : 0.75;
  const ebsHourly = (ebsSize * 0.08) / 720.0;
  const totalHourly = (baseHourly * regionMultiplier) + ebsHourly;
  const totalMonthly = totalHourly * 720.0;

  const sumReg = document.getElementById('sumRegionText');
  const sumOs = document.getElementById('sumOsText');
  const sumSpecs = document.getElementById('sumSpecsText');
  const sumHour = document.getElementById('sumCostHour');
  const sumMonth = document.getElementById('sumCostMonth');

  if (sumReg) sumReg.textContent = regionLabel;
  if (sumOs) sumOs.textContent = osLabel;
  if (sumSpecs) sumSpecs.textContent = specsText;
  if (sumHour) sumHour.textContent = `$${totalHourly.toFixed(3)}`;
  if (sumMonth) sumMonth.textContent = `~$${totalMonthly.toFixed(2)} / month`;
}

async function instanceAction(id, action) {
  if (action === 'TERMINATE' && !confirm('Bạn có chắc chắn muốn xóa máy ảo ' + id + '?')) {
    return;
  }
  try {
    await apiRequest(`/instances/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    loadInstances();
  } catch (err) {
    console.error(err);
  }
}

async function submitLaunch(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('instName').value,
    region: document.getElementById('instRegion').value,
    flavor: document.getElementById('instFlavor').value,
    imageId: document.getElementById('instImage').value,
    ebsSizeGb: parseInt(document.getElementById('instEbsSize').value) || 50,
    domainName: document.getElementById('instDomain').value
  };

  try {
    await apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('launchModal');
    loadInstances();
  } catch (err) {
    console.error(err);
  }
}

// TAB 2: STORAGE
async function loadVolumes() {
  try {
    const volumes = await apiRequest('/volumes');
    const tbody = document.getElementById('volumeTableBody');
    tbody.innerHTML = '';

    if (!volumes || volumes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 20px;">Chưa có ổ đĩa nào.</td></tr>';
      return;
    }

    volumes.forEach(vol => {
      const isAttached = vol.status === 'IN_USE';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace; color:var(--accent-green); font-weight:700;">${vol.id}</td>
        <td><strong>${vol.name}</strong></td>
        <td>${vol.sizeGb} GB</td>
        <td>${vol.volumeType}</td>
        <td>${vol.iops} IOPS / ${vol.throughput} MB/s</td>
        <td>${vol.region}</td>
        <td>${vol.attachedInstanceName} ${vol.device ? `(${vol.device})` : ''}</td>
        <td><span class="badge ${isAttached ? 'badge-active' : 'badge-shutoff'}">${vol.status}</span></td>
        <td>
          <div style="display:flex; gap:4px;">
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
    console.error(err);
  }
}

async function submitCreateVolume(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('volName').value,
    sizeGb: parseInt(document.getElementById('volSize').value) || 20,
    region: document.getElementById('volRegion').value,
    volumeType: 'gp3'
  };

  try {
    await apiRequest('/volumes', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeModal('createVolumeModal');
    loadVolumes();
  } catch (err) {
    console.error(err);
  }
}

async function detachVolume(id) {
  try {
    await apiRequest(`/volumes/${id}/detach`, { method: 'POST' });
    loadVolumes();
  } catch (err) {
    console.error(err);
  }
}

async function promptAttachVolume(volId) {
  const instanceId = prompt('Nhập ID máy ảo cần gắn ổ đĩa (VD: vm-syd-01):');
  if (!instanceId) return;
  try {
    await apiRequest(`/volumes/${volId}/attach`, {
      method: 'POST',
      body: JSON.stringify({ instanceId, device: '/dev/vdb' })
    });
    loadVolumes();
  } catch (err) {
    console.error(err);
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
    alert('Đã kích hoạt sao chép snapshot xuyên vùng sang ' + body.destinationRegion);
    loadVolumes();
  } catch (err) {
    console.error(err);
  }
}

async function deleteVolume(id) {
  if (!confirm('Xóa ổ đĩa ' + id + '?')) return;
  try {
    await apiRequest(`/volumes/${id}`, { method: 'DELETE' });
    loadVolumes();
  } catch (err) {
    console.error(err);
  }
}

// TAB 3: IMAGES
async function loadImages() {
  try {
    const images = await apiRequest('/images');
    const grid = document.getElementById('imageGrid');
    grid.innerHTML = '';

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
    console.error(err);
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
      const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleString() : 'N/A';
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

// Initial bootstrap
window.addEventListener('DOMContentLoaded', () => {
  if (!authToken) {
    // Attempt auto-login with default admin credentials for quick access
    submitLogin({
      preventDefault: () => {}
    });
  } else {
    loadInstances();
  }
});

