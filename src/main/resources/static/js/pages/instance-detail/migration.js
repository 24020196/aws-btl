// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Tab Chuyển vùng: khóa, cooldown, lịch sử, xem lại log, Fast Migrate, pipeline 6 bước.

async function loadMigrationHistory() {
  try {
    const h = await apiRequest(`/migrations/history/${encodeURIComponent(det.id)}`);
    det.history = h;
    det.cooldownTotal = h.cooldownSeconds || 300;
    det.cooldownDeadline = Date.now() + (h.cooldownRemainingSeconds || 0) * 1000;
    renderLockAndCooldown();
    renderHistory();
    startCooldownTimer();
  } catch (err) {
    setHtml('historyBody', '<tr><td colspan="8" class="empty-cell">Không tải được lịch sử chuyển vùng.</td></tr>');
  }
}

function renderLockAndCooldown() {
  const h = det.history || {};
  const locked = !!h.migrationLock || det.running;
  setHtml('migLock', locked
    ? '<span class="lock-badge locked">🔒 LOCKED</span>'
    : '<span class="lock-badge">🔓 Unlocked</span>');
  setText('migLockHint', locked && h.lockStale && !det.running
    ? `Khóa từ ${fmtTime(h.lockAcquiredAt)} nhưng không còn tiến trình nào chạy (khóa treo). Bấm Fast Migrate để tự giải phóng và chuyển lại.`
    : locked
    ? `Khóa từ ${fmtTime(h.lockAcquiredAt)}. Lần chuyển khác sẽ bị từ chối.`
    : 'Ghi có điều kiện trên DynamoDB, chỉ một lần chuyển chạy tại một thời điểm.');
  setHtml('sumLock', locked ? '<span class="lock-badge locked">🔒 LOCKED</span>' : '<span class="lock-badge">🔓 Unlocked</span>');

  const region = (det.inst && det.inst.region) || h.currentRegion;
  setHtml('migRoute', `${regionTag(region)} <span class="muted">→</span> ${regionTag(otherRegion(region))}`);
  setText('migRouteHint', 'Elastic IP mới được cấp ở vùng đích.');
  document.getElementById('migTabDot').hidden = !locked;
  tickCooldown();
}

function startCooldownTimer() {
  if (det.cooldownTimer) clearInterval(det.cooldownTimer);
  det.cooldownTimer = setInterval(tickCooldown, 1000);
}

function tickCooldown() {
  const left = Math.max(0, Math.ceil((det.cooldownDeadline - Date.now()) / 1000));
  const total = det.cooldownTotal || 300;
  const bar = document.getElementById('migCooldownBar');
  if (left > 0) {
    setText('migCooldown', fmtCountdown(left));
    setText('migCooldownHint', `Mỗi máy phải nghỉ ${Math.round(total / 60)} phút giữa hai lần chuyển.`);
    document.getElementById('migCooldown').classList.add('active');
    if (bar) bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
  } else {
    setText('migCooldown', 'Sẵn sàng');
    setText('migCooldownHint', `Cooldown ${Math.round(total / 60)} phút, tính từ lần chuyển hoàn tất gần nhất.`);
    document.getElementById('migCooldown').classList.remove('active');
    if (bar) bar.style.width = '0%';
    if (det.cooldownTimer && !det.running) {
      clearInterval(det.cooldownTimer);
      det.cooldownTimer = null;
    }
  }
  renderActions();
}

const HISTORY_STATUS = {
  COMPLETED: 'state-running',
  IN_PROGRESS: 'state-migrating',
  FAILED: 'state-error',
  ROLLED_BACK: 'state-error'
};

function renderHistory() {
  const rows = (det.history && det.history.history) || [];
  setHtml('historyBody', rows.length
    ? rows.map((r, i) => `<tr class="hist-row" tabindex="0" data-idx="${i}" aria-label="Xem log lần chuyển vùng ${esc(r.migrationId)}">
        <td class="mono">${esc(r.migrationId)}</td>
        <td>${regionTag(r.sourceRegion)} <span class="muted">→</span> ${regionTag(r.destRegion)}</td>
        <td>${esc(fmtTime(r.startedAt))}</td>
        <td>${r.completedAt ? esc(fmtTime(r.completedAt)) : '<span class="muted">Chưa xong</span>'}</td>
        <td>${esc(fmtDuration(r.durationSeconds))}</td>
        <td>${r.downtimeSeconds ? `<strong class="rto">${esc(r.downtimeSeconds)}s</strong>` : '<span class="muted">–</span>'}</td>
        <td><span class="ec2-state ${HISTORY_STATUS[r.status] || 'state-stopped'}">${esc(r.status)}</span>${r.errorMessage ? `<div class="err-text">${esc(r.errorMessage)}</div>` : ''}</td>
        <td class="rule-actions"><span class="link-accent hist-open">Xem log →</span></td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty-cell">Máy ảo này chưa chuyển vùng lần nào.</td></tr>');
}

const MIG_STEP_NAMES = ['Dừng VM nguồn', 'Tạo EBS snapshot', 'Sao chép snapshot sang vùng đích', 'Tạo volume ở vùng đích', 'Khởi động VM ở vùng đích', 'Route 53 DNS cutover'];

function openMigrationLog(idx) {
  const r = ((det.history && det.history.history) || [])[idx];
  if (!r) return;
  const logs = r.logs || [];
  setText('migLogTitle', r.migrationId);
  setHtml('migLogStatus', `<span class="ec2-state ${HISTORY_STATUS[r.status] || 'state-stopped'}">${esc(r.status)}</span>`);
  setHtml('migLogRoute', `${regionTag(r.sourceRegion)} <span class="muted">→</span> ${regionTag(r.destRegion)}`);
  const stat = (label, value, cls = '') => `<div class="mig-log-stat"><div class="mig-sum-label">${label}</div><div class="${cls}">${value}</div></div>`;
  setHtml('migLogStats', [
    stat('Bắt đầu', esc(fmtTime(r.startedAt))),
    stat('Hoàn tất', r.completedAt ? esc(fmtTime(r.completedAt)) : 'Chưa xong'),
    stat('Tổng thời lượng', esc(fmtDuration(r.durationSeconds))),
    stat('Downtime (RTO)', r.downtimeSeconds ? `${esc(r.downtimeSeconds)} giây` : '–', 'rto')
  ].join(''));

  const failed = String(r.status).toUpperCase() === 'FAILED';
  const doneSteps = new Set(logs.map(l => (l.match(/Step (\d)\/6/) || [])[1]).filter(Boolean).map(Number));
  const lastDone = doneSteps.size ? Math.max(...doneSteps) : 0;
  setHtml('migLogSteps', MIG_STEP_NAMES.map((name, i) => {
    const n = i + 1;
    const line = logs.find(l => l.includes(`Step ${n}/6`));
    const time = line ? (line.match(/^\[([^\]]+)\]/) || [])[1] : '';
    const state = doneSteps.has(n) ? 'done' : (failed && n === lastDone + 1 ? 'fail' : 'skip');
    return `<li class="mig-log-step ${state}">
      <span class="mig-log-dot" aria-hidden="true">${state === 'done' ? '✓' : state === 'fail' ? '✕' : n}</span>
      <div><strong>${n}. ${name}</strong>${time ? ` <span class="muted mono">${esc(time)}</span>` : ''}
      <div class="muted">${line ? esc(line.replace(/^\[[^\]]+\]\s*Step \d\/6:\s*/, '')) : state === 'fail' ? esc(r.errorMessage || 'Thất bại ở bước này') : 'Không chạy tới bước này'}</div></div>
    </li>`;
  }).join(''));

  setHtml('migLogTerminal', logs.length
    ? logs.map(l => `<div class="${/ERROR/.test(l) ? 'log-err' : ''}">${esc(l)}</div>`).join('')
    : '<div class="muted">Lần chuyển vùng này chạy trước khi hệ thống bắt đầu lưu log, nên không có log chi tiết.</div>');
  openModal('migLogModal');
}

document.addEventListener('click', e => {
  const row = e.target.closest('#historyBody .hist-row');
  if (row) openMigrationLog(Number(row.dataset.idx));
});
document.addEventListener('keydown', e => {
  const row = e.target.closest && e.target.closest('#historyBody .hist-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMigrationLog(Number(row.dataset.idx)); }
});

// ---------------- Migration: trigger + live pipeline ----------------
// Sau khi bấm chuyển vùng: cuộn để khung 6 bước nằm giữa màn hình (nếu cao hơn màn hình thì đặt ngay dưới header).
function focusPipelineCard() {
  const card = document.getElementById('migPipelineCard');
  if (!card) return;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => {
    const header = document.querySelector('.header');
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const rect = card.getBoundingClientRect();
    const free = window.innerHeight - headerH;
    const offset = rect.height < free ? headerH + (free - rect.height) / 2 : headerH + 12;
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - offset), behavior: smooth ? 'smooth' : 'auto' });
    card.focus({ preventScroll: true });
    card.classList.remove('pipe-flash');
    void card.offsetWidth;
    card.classList.add('pipe-flash');
  });
}

function openMigrateModal() {
  const reason = migrationBlockReason();
  if (reason) {
    showToast(esc(reason), 'error');
    return;
  }
  const inst = det.inst;
  setHtml('migrateModalText', `<strong>${esc(inst.name)}</strong> sẽ được chuyển từ ${regionTag(inst.region)} sang ${regionTag(otherRegion(inst.region))}.`);
  const h = det.history || {};
  const rto = h.expectedDowntimeSeconds;
  setHtml('migrateModalFacts', `
    <div class="mig-fact"><span class="mig-sum-label">Downtime dự kiến</span>
      <strong class="rto">${rto ? '≈ ' + esc(rto) + ' giây' : '≈ 10–15 giây'}</strong>
      <span class="muted">${rto ? 'trung bình các lần trước của máy này' : 'chưa có lần chuyển nào để ước tính'}</span></div>
    <div class="mig-fact"><span class="mig-sum-label">Elastic IP</span>
      <strong class="mono">${esc(inst.publicIp || '–')} → IP mới</strong>
      <span class="muted">${inst.dnsDomain ? 'Truy cập qua ' + esc(inst.dnsDomain) + ' tự chuyển sau ≤ 60 giây (TTL)' : 'Nên dùng tên miền Route 53 để không phải đổi IP'}</span></div>
    <div class="mig-fact"><span class="mig-sum-label">Sau khi xong</span>
      <strong>Cooldown ${esc(Math.round((h.cooldownSeconds || 300) / 60))} phút</strong>
      <span class="muted">không chuyển vùng tiếp được trong thời gian này</span></div>`);
  openModal('migrateModal');
}

async function confirmMigrate() {
  const btn = document.getElementById('btnConfirmMigrate');
  btn.disabled = true;
  try {
    const res = await apiRequest('/migrations/trigger', { method: 'POST', body: JSON.stringify({ id: det.id }) });
    closeModal('migrateModal');
    switchDetailTab('migration');
    showToast('Đã bắt đầu chuyển vùng, đang theo dõi 6 bước', 'success');
    det.running = true;
    det.inst.status = 'MIGRATING';
    det.history = Object.assign({}, det.history, { migrationLock: true, lockStale: false, lockAcquiredAt: res && res.startedAt ? res.startedAt : Date.now() });
    renderInstance();
    renderLockAndCooldown();
    renderPipeline(res);
    startProgressPollingDetail();
    focusPipelineCard();
  } catch (err) {
    closeModal('migrateModal');
    showToast(`Không chuyển vùng được: ${esc(err.message)}`, 'error');
    loadMigrationHistory();
  } finally {
    btn.disabled = false;
  }
}

async function resumeRunningMigration() {
  try {
    const p = await apiRequest(`/migrations/progress/${encodeURIComponent(det.id)}`);
    if (p && p.status === 'IN_PROGRESS') {
      det.running = true;
      renderLockAndCooldown();
      renderPipeline(p);
      startProgressPollingDetail();
    } else if (p && (p.status === 'COMPLETED' || p.status === 'ROLLED_BACK')) {
      renderPipeline(p);
    }
  } catch (err) {
    // progress endpoint is optional for this page
  }
}

function startProgressPollingDetail() {
  if (det.pollTimer) clearInterval(det.pollTimer);
  det.pollTimer = setInterval(async () => {
    try {
      const p = await apiRequest(`/migrations/progress/${encodeURIComponent(det.id)}`);
      renderPipeline(p);
      if (p.status === 'COMPLETED' || p.status === 'ROLLED_BACK' || p.status === 'FAILED') {
        clearInterval(det.pollTimer);
        det.pollTimer = null;
        det.running = false;
        if (p.status === 'COMPLETED') {
          showToast(`Chuyển vùng hoàn tất, máy đang chạy ở ${esc(regionLabel(p.destRegion))}`, 'success');
        } else {
          showToast('Chuyển vùng thất bại, máy đã được giữ ở vùng nguồn', 'error');
        }
        await loadInstance();
        await Promise.all([loadMigrationHistory(), loadSecurityAndNetwork()]);
      }
    } catch (err) {
      clearInterval(det.pollTimer);
      det.pollTimer = null;
    }
  }, 1000);
}

function renderPipeline(p) {
  if (!p) return;
  const step = p.stepNumber || 0;
  const done = p.status === 'COMPLETED';
  const failed = p.status === 'ROLLED_BACK' || p.status === 'FAILED';
  const pct = done ? 100 : (p.progressPercent || 0);

  setText('pipePercent', `${pct}%`);
  const bar = document.getElementById('detPipeBar');
  bar.style.width = pct + '%';
  bar.parentElement.classList.toggle('failed', failed);

  document.querySelectorAll('#detPipeline .det-step').forEach(li => {
    const n = Number(li.dataset.step);
    const dot = li.querySelector('.det-step-dot');
    li.className = 'det-step';
    if (done || n < step) {
      li.classList.add('done');
      dot.textContent = '✓';
    } else if (n === step) {
      li.classList.add(failed ? 'failed' : 'active');
      dot.textContent = failed ? '✕' : String(n);
    } else {
      dot.textContent = String(n);
    }
  });

  const label = done ? 'Hoàn tất' : failed ? 'Thất bại, đã khôi phục' : p.status === 'IN_PROGRESS' ? 'Đang chạy' : 'Đang chờ';
  setText('logStatus', label);
  if (p.sourceRegion && p.destRegion) {
    setHtml('pipeSub', `${regionTag(p.sourceRegion)} <span class="muted">→</span> ${regionTag(p.destRegion)} · ${esc(p.currentStep || '')}`);
  }

  const term = document.getElementById('detTerminal');
  if (p.logs && p.logs.length) {
    term.innerHTML = p.logs.map(l => `<div>${esc(l)}</div>`).join('');
    term.scrollTop = term.scrollHeight;
  }
}
