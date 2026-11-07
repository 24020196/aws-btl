// Trang chủ (index.html): số liệu tổng quan, vùng, bảng máy ảo, nhật ký.

// ============================================================
// PAGE INITIALIZERS: OVERVIEW, INSTANCES, DETAIL, LAUNCH
// ============================================================

// 1. OVERVIEW PAGE (index.html)
async function initOverviewPage() {
  if (!requireAuthGuard()) return;
  renderUserBadge();
  clearApiError();

  const elTotal = document.getElementById('overviewTotalInstances');
  const elRun = document.getElementById('overviewRunningCount');
  const elStorage = document.getElementById('overviewStorageGb');
  const elRegA = document.getElementById('regionAInstanceCount');
  const elRegB = document.getElementById('regionBInstanceCount');
  const tbodyInst = document.getElementById('overviewInstanceTableBody');
  const tbodyLogs = document.getElementById('overviewAuditLogsBody');

  // Load Instances
  try {
    const instances = await apiRequest('/instances');
    const list = instances || [];
    const total = list.length;
    const running = list.filter(i => {
      const s = (i.status || '').toUpperCase();
      return s === 'RUNNING' || s === 'ACTIVE';
    }).length;
    const regA = list.filter(i => (i.region || '').includes('southeast')).length;
    const regB = list.filter(i => (i.region || '').includes('us-east')).length;

    if (elTotal) elTotal.textContent = total;
    if (elRun) elRun.textContent = t(`${running} Đang chạy`, `${running} Running`);
    if (elRegA) elRegA.textContent = t(`${regA} máy ảo`, `${regA} instance${regA === 1 ? '' : 's'}`);
    if (elRegB) elRegB.textContent = t(`${regB} máy ảo`, `${regB} instance${regB === 1 ? '' : 's'}`);

    if (tbodyInst) {
      if (list.length === 0) {
        tbodyInst.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--text-muted);">${t('Chưa có máy ảo nào.', 'No instances found.')} <a href="/launch.html" style="color: var(--accent-cyan); font-weight: 700;">${t('+ Khởi tạo ngay', '+ Launch now')}</a></td></tr>`;
      } else {
        tbodyInst.innerHTML = '';
        list.slice(0, 5).forEach(inst => {
          const cfg = getStatusBadgeConfig(inst.status);
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><a href="/instance-detail.html?id=${inst.id}" style="color:var(--accent-cyan); font-weight:700; text-decoration:none; font-family:monospace;">${inst.id}</a></td>
            <td><strong>${inst.name}</strong></td>
            <td>${inst.regionName || inst.region}</td>
            <td><span class="badge" style="background:#1e293b; color:#94a3b8;">${inst.flavor}</span></td>
            <td><code>${inst.publicIp || t('Chưa gán', 'None')}</code></td>
            <td><span style="color:var(--accent-cyan);">${inst.dnsDomain || 'N/A'}</span></td>
            <td><span class="badge ${cfg.cssClass}"><span class="status-dot ${cfg.dotClass}"></span>${cfg.label}</span></td>
            <td><a href="/instance-detail.html?id=${inst.id}" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 11px; text-decoration:none;">Xem Chi Tiết →</a></td>
          `;
          tbodyInst.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error('Failed to load overview instances:', err);
    if (elTotal) elTotal.textContent = 'ERR';
    if (elRun) elRun.textContent = 'Lỗi API';
    if (tbodyInst) {
      tbodyInst.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 24px; color: #f87171; background: rgba(239, 68, 68, 0.05); border-radius: 8px;">❌ Không thể tải danh sách máy ảo từ API (GET /api/instances): ${err.message}</td></tr>`;
    }
  }

  // Load Volumes to calculate storage
  try {
    const volumes = await apiRequest('/volumes');
    if (volumes && elStorage) {
      const totalGb = volumes.reduce((sum, v) => sum + (v.sizeGb || 0), 0);
      elStorage.textContent = totalGb;
    }
  } catch (err) {
    if (elStorage) elStorage.textContent = '50';
  }

  // Load Audit Logs
  try {
    const logs = await apiRequest('/logs?limit=5');
    if (tbodyLogs) {
      if (!logs || logs.length === 0) {
        tbodyLogs.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">Chưa có nhật ký vận hành.</td></tr>';
      } else {
        tbodyLogs.innerHTML = '';
        logs.slice(0, 5).forEach(l => {
          const tr = document.createElement('tr');
          const time = l.timestamp ? formatSyncedDateTime(l.timestamp) : 'N/A';
          tr.innerHTML = `
            <td style="color:var(--text-muted); font-size:12px;">${time}</td>
            <td><strong>${l.username || 'admin'}</strong></td>
            <td><span class="badge" style="background:#1e293b; color:var(--accent-cyan);">${l.action}</span></td>
            <td><code>${l.resourceType}</code></td>
            <td style="color:#cbd5e1;">${l.details}</td>
          `;
          tbodyLogs.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error('Failed to load logs for overview:', err);
  }
}
