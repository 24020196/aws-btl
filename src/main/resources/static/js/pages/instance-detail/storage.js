// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Tab Lưu trữ: ổ gốc và các ổ đang gắn.

// ---------------- Storage ----------------
async function loadVolumes() {
  let list;
  try {
    list = await apiRequest('/volumes');
  } catch (err) {
    setHtml('volumesBody', '<tr><td colspan="7" class="empty-cell">Không tải được danh sách ổ đĩa.</td></tr>');
    return;
  }
  const mine = (list || []).filter(v => v.attachedInstanceId === det.id);
  setText('volCount', `(${mine.length + 1})`);
  const spec = FLAVOR_SPECS[det.inst.flavor];
  const rootId = det.inst.ebsVolumeId || `vol-${String(det.inst.id).replace('i-', '')}`;
  const rootRow = `<tr>
      <td class="mono">${esc(rootId)}</td><td>Root volume</td><td class="mono">/dev/vda</td>
      <td>${spec ? spec.defaultDisk : 10} GiB</td><td>gp3</td><td>3000 / 125 MB/s</td>
      <td><span class="ec2-state state-running">in-use</span></td></tr>`;
  setHtml('volumesBody', rootRow + mine.map(v => `<tr>
      <td class="mono">${esc(v.id)}</td>
      <td>${esc(v.name || '–')}</td>
      <td class="mono">${esc(v.device || '–')}</td>
      <td>${esc(v.sizeGb)} GiB</td>
      <td>${esc(v.volumeType || '–')}</td>
      <td>${esc(v.iops || '–')} / ${esc(v.throughput || '–')} MB/s</td>
      <td><span class="ec2-state ${String(v.status).toUpperCase() === 'IN_USE' || String(v.status).toLowerCase() === 'in-use' ? 'state-running' : 'state-pending'}">${esc(String(v.status || '').toLowerCase().replace('_', '-'))}</span></td>
    </tr>`).join(''));
}
