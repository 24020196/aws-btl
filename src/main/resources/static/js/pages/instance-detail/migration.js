// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Tab Chuyển vùng: khóa, cooldown, lịch sử, xem lại log, Fast Migrate, pipeline 6 bước.

registerI18n({
  detMigNext: ['Hướng chuyển tiếp theo', 'Next migration'],
  detPipeAria: ['Tiến trình chuyển vùng', 'Migration progress'],
  detPipeTitle: ['Tiến trình chuyển vùng (6 bước)', 'Migration progress (6 steps)'],
  detPipeIdle: ['Chưa có lần chuyển vùng nào đang chạy.', 'No migration is running.'],
  detStep1: ['Dừng máy nguồn', 'Stop source VM'],
  detStep2: ['Snapshot EBS', 'EBS snapshot'],
  detStep3: ['Sao chép liên vùng', 'Cross-region copy'],
  detStep4: ['Tạo volume đích', 'Create target volume'],
  detStep5: ['Khởi động NovaVM', 'Boot NovaVM'],
  detStep6: ['Chuyển DNS', 'Switch DNS'],
  detLogLive: ['Log thời gian thực', 'Live log'],
  detLogWaiting: ['Đang chờ', 'Waiting'],
  detLogHint: ['Log của từng bước sẽ hiện ở đây khi bạn bấm Fast Migrate.', 'Step logs appear here when you start Fast Migrate.'],
  detHistTitle: ['Lịch sử chuyển vùng', 'Migration history'],
  detHistSub: ['Bấm vào một dòng để xem lại log 6 bước của lần đó.', 'Click a row to view the 6-step log of that migration.'],
  detHistRoute: ['Vùng nguồn → Vùng đích', 'Source → Destination'],
  detHistStart: ['Bắt đầu', 'Started'],
  detHistEnd: ['Hoàn tất', 'Completed'],
  detHistDuration: ['Thời lượng', 'Duration'],
  detHistRtoTitle: ['Thời gian dịch vụ gián đoạn: từ lúc dừng VM nguồn tới khi Route 53 trỏ sang IP mới', 'Service interruption: from stopping the source VM until Route 53 points to the new IP'],
  detMigModalTitle: ['Chuyển vùng máy ảo?', 'Migrate instance?'],
  detMigNote1: ['Máy nguồn dừng trong lúc tạo snapshot cuối, dịch vụ tạm gián đoạn.', 'The source VM stops while the final snapshot is taken, so the service is briefly interrupted.'],
  detMigNote2: ['Elastic IP mới được cấp ở vùng đích, bản ghi Route 53 tự trỏ sang.', 'A new Elastic IP is allocated in the destination region and the Route 53 record follows it.'],
  detMigNote3: ['Nếu một bước lỗi, hệ thống nhả khóa và giữ máy ở vùng nguồn.', 'If a step fails, the lock is released and the instance stays in the source region.'],
  detMigStart: ['Bắt đầu chuyển vùng', 'Start migration'],
  detLogModalTitle: ['Chi tiết lần chuyển vùng', 'Migration details'],
  detLogSaved: ['Log đã lưu trong XRegion-Migrations', 'Log stored in XRegion-Migrations'],
  detCopyLog: ['Sao chép log', 'Copy log'],
  detCopy: ['Sao chép', 'Copy']
});

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
    setHtml('historyBody', `<tr><td colspan="8" class="empty-cell">${t('Không tải được lịch sử chuyển vùng.', 'Could not load migration history.')}</td></tr>`);
  }
}

function renderLockAndCooldown() {
  const h = det.history || {};
  const locked = !!h.migrationLock || det.running;
  const lockHtml = locked
    ? `<span class="lock-badge locked">${ICON('ui-lock', 'ico-sm')} LOCKED</span>`
    : `<span class="lock-badge">${ICON('ui-unlock', 'ico-sm')} Unlocked</span>`;
  setHtml('migLock', lockHtml);
  setText('migLockHint', locked && h.lockStale && !det.running
    ? t(`Khóa từ ${fmtTime(h.lockAcquiredAt)} nhưng không còn tiến trình nào chạy (khóa treo). Bấm Fast Migrate để tự giải phóng và chuyển lại.`,
        `Locked since ${fmtTime(h.lockAcquiredAt)} but nothing is running (stale lock). Fast Migrate releases it and migrates again.`)
    : locked
    ? t(`Khóa từ ${fmtTime(h.lockAcquiredAt)}. Lần chuyển khác sẽ bị từ chối.`, `Locked since ${fmtTime(h.lockAcquiredAt)}. Other migrations are rejected.`)
    : t('Ghi có điều kiện trên DynamoDB, chỉ một lần chuyển chạy tại một thời điểm.', 'Conditional write on DynamoDB: only one migration runs at a time.'));
  setHtml('sumLock', lockHtml);

  const region = (det.inst && det.inst.region) || h.currentRegion;
  setHtml('migRoute', `${regionTag(region)} <span class="muted">→</span> ${regionTag(otherRegion(region))}`);
  setText('migRouteHint', t('Elastic IP mới được cấp ở vùng đích.', 'A new Elastic IP is allocated in the destination region.'));
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
    setText('migCooldownHint', t(`Mỗi máy phải nghỉ ${Math.round(total / 60)} phút giữa hai lần chuyển.`, `Each instance waits ${Math.round(total / 60)} minutes between migrations.`));
    document.getElementById('migCooldown').classList.add('active');
    if (bar) bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
  } else {
    setText('migCooldown', t('Sẵn sàng', 'Ready'));
    setText('migCooldownHint', t(`Cooldown ${Math.round(total / 60)} phút, tính từ lần chuyển hoàn tất gần nhất.`, `${Math.round(total / 60)}-minute cooldown after the last completed migration.`));
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
    ? rows.map((r, i) => `<tr class="hist-row" tabindex="0" data-idx="${i}" aria-label="${t('Xem log lần chuyển vùng', 'View migration log')} ${esc(r.migrationId)}">
        <td class="mono">${esc(r.migrationId)}</td>
        <td>${regionTag(r.sourceRegion)} <span class="muted">→</span> ${regionTag(r.destRegion)}</td>
        <td>${esc(fmtTime(r.startedAt))}</td>
        <td>${r.completedAt ? esc(fmtTime(r.completedAt)) : `<span class="muted">${t('Chưa xong', 'Not finished')}</span>`}</td>
        <td>${esc(fmtDuration(r.durationSeconds))}</td>
        <td>${r.downtimeSeconds ? `<strong class="rto">${esc(r.downtimeSeconds)}s</strong>` : '<span class="muted">–</span>'}</td>
        <td><span class="ec2-state ${HISTORY_STATUS[r.status] || 'state-stopped'}">${esc(r.status)}</span>${r.errorMessage ? `<div class="err-text">${esc(r.errorMessage)}</div>` : ''}</td>
        <td class="rule-actions"><span class="link-accent hist-open">Xem log →</span></td>
      </tr>`).join('')
    : `<tr><td colspan="8" class="empty-cell">${t('Máy ảo này chưa chuyển vùng lần nào.', 'This instance has not been migrated yet.')}</td></tr>`);
}

const MIG_STEP_NAMES = [
  ['Dừng VM nguồn', 'Stop source VM'], ['Tạo EBS snapshot', 'Create EBS snapshot'], ['Sao chép snapshot sang vùng đích', 'Copy snapshot to destination region'],
  ['Tạo volume ở vùng đích', 'Create volume in destination region'], ['Khởi động VM ở vùng đích', 'Boot VM in destination region'], ['Route 53 DNS cutover', 'Route 53 DNS cutover']
];

function openMigrationLog(idx) {
  const r = ((det.history && det.history.history) || [])[idx];
  if (!r) return;
  const logs = r.logs || [];
  setText('migLogTitle', r.migrationId);
  setHtml('migLogStatus', `<span class="ec2-state ${HISTORY_STATUS[r.status] || 'state-stopped'}">${esc(r.status)}</span>`);
  setHtml('migLogRoute', `${regionTag(r.sourceRegion)} <span class="muted">→</span> ${regionTag(r.destRegion)}`);
  const stat = (label, value, cls = '') => `<div class="mig-log-stat"><div class="mig-sum-label">${label}</div><div class="${cls}">${value}</div></div>`;
  setHtml('migLogStats', [
    stat(t('Bắt đầu', 'Started'), esc(fmtTime(r.startedAt))),
    stat(t('Hoàn tất', 'Completed'), r.completedAt ? esc(fmtTime(r.completedAt)) : t('Chưa xong', 'Not finished')),
    stat(t('Tổng thời lượng', 'Total duration'), esc(fmtDuration(r.durationSeconds))),
    stat('Downtime (RTO)', r.downtimeSeconds ? t(`${esc(r.downtimeSeconds)} giây`, `${esc(r.downtimeSeconds)} s`) : '–', 'rto')
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
      <span class="mig-log-dot" aria-hidden="true">${state === 'done' ? ICON('ui-check', 'ico-sm') : state === 'fail' ? ICON('ui-close', 'ico-sm') : n}</span>
      <div><strong>${n}. ${t(name[0], name[1])}</strong>${time ? ` <span class="muted mono">${esc(time)}</span>` : ''}
      <div class="muted">${line ? esc(line.replace(/^\[[^\]]+\]\s*Step \d\/6:\s*/, '')) : state === 'fail' ? esc(r.errorMessage || t('Thất bại ở bước này', 'Failed at this step')) : 'Không chạy tới bước này'}</div></div>
    </li>`;
  }).join(''));

  setHtml('migLogTerminal', logs.length
    ? logs.map(l => `<div class="${/ERROR/.test(l) ? 'log-err' : ''}">${esc(l)}</div>`).join('')
    : `<div class="muted">${t('Lần chuyển vùng này chạy trước khi hệ thống bắt đầu lưu log, nên không có log chi tiết.', 'This migration ran before logs were stored, so there is no detailed log.')}</div>`);
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
  setHtml('migrateModalText', t(`<strong>${esc(inst.name)}</strong> sẽ được chuyển từ ${regionTag(inst.region)} sang ${regionTag(otherRegion(inst.region))}.`,
    `<strong>${esc(inst.name)}</strong> will move from ${regionTag(inst.region)} to ${regionTag(otherRegion(inst.region))}.`));
  const h = det.history || {};
  const rto = h.expectedDowntimeSeconds;
  setHtml('migrateModalFacts', `
    <div class="mig-fact"><span class="mig-sum-label">${t('Downtime dự kiến', 'Expected downtime')}</span>
      <strong class="rto">${rto ? '≈ ' + esc(rto) + t(' giây', ' s') : t('≈ 10–15 giây', '≈ 10–15 s')}</strong>
      <span class="muted">${rto ? t('trung bình các lần trước của máy này', 'average of previous migrations') : t('chưa có lần chuyển nào để ước tính', 'no previous migration to estimate from')}</span></div>
    <div class="mig-fact"><span class="mig-sum-label">Elastic IP</span>
      <strong class="mono">${esc(inst.publicIp || '–')} → ${t('IP mới', 'new IP')}</strong>
      <span class="muted">${inst.dnsDomain ? t('Truy cập qua ' + esc(inst.dnsDomain) + ' tự chuyển sau ≤ 60 giây (TTL)', esc(inst.dnsDomain) + ' follows within ≤ 60 s (TTL)') : t('Nên dùng tên miền Route 53 để không phải đổi IP', 'Use the Route 53 domain to avoid changing IPs')}</span></div>
    <div class="mig-fact"><span class="mig-sum-label">${t('Sau khi xong', 'Afterwards')}</span>
      <strong>Cooldown ${esc(Math.round((h.cooldownSeconds || 300) / 60))} ${t('phút', 'min')}</strong>
      <span class="muted">${t('không chuyển vùng tiếp được trong thời gian này', 'no further migration during this time')}</span></div>`);
  openModal('migrateModal');
}

async function confirmMigrate() {
  const btn = document.getElementById('btnConfirmMigrate');
  btn.disabled = true;
  try {
    const res = await apiRequest(`/migrations/trigger?lang=${getLang()}`, { method: 'POST', body: JSON.stringify({ id: det.id }) });
    closeModal('migrateModal');
    switchDetailTab('migration');
    showToast(t('Đã bắt đầu chuyển vùng, đang theo dõi 6 bước', 'Migration started, following the 6 steps'), 'success');
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
    showToast(t('Không chuyển vùng được: ', 'Could not migrate: ') + esc(err.message), 'error');
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
          showToast(t(`Chuyển vùng hoàn tất, máy đang chạy ở ${esc(regionLabel(p.destRegion))}`, `Migration completed, the instance is running in ${esc(regionLabel(p.destRegion))}`), 'success');
        } else {
          showToast(t('Chuyển vùng thất bại, máy đã được giữ ở vùng nguồn', 'Migration failed, the instance stays in the source region'), 'error');
        }
        await loadInstance();
        await Promise.all([loadMigrationHistory(), loadSecurityAndNetwork(), loadSnapshots()]);
      }
    } catch (err) {
      clearInterval(det.pollTimer);
      det.pollTimer = null;
    }
  }, 1000);
}

function renderPipeline(p) {
  if (!p) return;
  det.lastProgress = p;
  // Nội dung do JS ghi, không để applyPageTranslations ghi đè lại chữ mặc định khi đổi ngôn ngữ
  ['pipeSub', 'logStatus'].forEach(id => { const el = document.getElementById(id); if (el) el.removeAttribute('data-i18n'); });
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
      dot.innerHTML = ICON('ui-check-circle');
    } else if (n === step) {
      li.classList.add(failed ? 'failed' : 'active');
      dot.innerHTML = failed ? ICON('ui-error') : ICON('ui-spinner', 'ico-spin');
    } else {
      dot.textContent = String(n);
    }
  });

  const label = done ? t('Hoàn tất', 'Completed') : failed ? t('Thất bại, đã khôi phục', 'Failed, rolled back') : p.status === 'IN_PROGRESS' ? t('Đang chạy', 'Running') : t('Đang chờ', 'Waiting');
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
