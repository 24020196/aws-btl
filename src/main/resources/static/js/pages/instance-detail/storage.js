// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Tab Lưu trữ: ổ gốc, các ổ đang gắn và snapshot sinh ra khi chuyển vùng.

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

// ---------------- Snapshots (GET /api/migrations/snapshots?instanceId=) ----------------
async function loadSnapshots() {
  let list;
  try {
    list = await apiRequest(`/migrations/snapshots?instanceId=${encodeURIComponent(det.id)}`);
  } catch (err) {
    setText('snapCount', '');
    setHtml('snapshotsBody', `<tr><td colspan="6" class="empty-cell">${t('Không tải được danh sách snapshot.', 'Could not load snapshots.')}</td></tr>`);
    return;
  }
  list = list || [];
  setText('snapCount', `(${list.length})`);
  setHtml('snapshotsBody', list.length
    ? list.map(sn => `<tr>
        <td class="mono nowrap">${esc(sn.snapshotId)}</td>
        <td class="nowrap">${regionTag(sn.region)}</td>
        <td class="mono nowrap">${esc(sn.sourceSnapshotId || "–")}</td>
        <td>${esc(sn.description || '–')}</td>
        <td><span class="ec2-state ${sn.state === 'completed' ? 'state-running' : 'state-error'}">${esc(sn.state)}</span></td>
        <td class="nowrap">${esc(fmtTime(sn.startedAt))}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty-cell">${t('Chưa có snapshot nào. Snapshot được tạo khi máy chuyển vùng.', 'No snapshots yet. Snapshots are created when the instance migrates.')}</td></tr>`);
}
