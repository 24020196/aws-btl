// Trang chi tiết máy ảo (instance-detail.html) — Lực.
// Các file trong js/pages/instance-detail/ dùng chung biến toàn cục `det` và các hàm tiện ích trong core.js.
// Thứ tự nạp: core.js → migration.js → dialogs.js → security.js → storage.js → monitoring.js
// Tab Giám sát: biểu đồ SVG, khoảng thời gian, tự làm mới, cảnh báo CPU.

registerI18n({
  detMonSimTitle: ['Chỉ số được sinh mô phỏng ở backend (MonitoringService), chưa đọc từ CloudWatch thật', 'Metrics are simulated by the backend (MonitoringService), not read from real CloudWatch'],
  detMonSim: ['Dữ liệu mô phỏng', 'Simulated data'],
  detMonRange: ['Khoảng thời gian', 'Time range'],
  detMonAuto: ['Tự làm mới mỗi phút', 'Auto refresh every minute'],
  detMonAlarmPeriod: ['% trong 1 chu kỳ', '% for 1 period']
});

// ---------------- Monitoring (inline SVG) ----------------
function svgChart(series, opts) {
  const W = 480, H = 170, L = 40, R = 10, T = 12, B = 24;
  const pts = series[0].values.length;
  if (!pts) return `<p class="muted">${t('Chưa có dữ liệu.', 'No data yet.')}</p>`;
  const all = series.flatMap(s => s.values);
  let max = opts.max;
  if (!max) {
    const raw = Math.max(1, ...all) * 1.1 / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(v => v >= raw);
    max = step * 4;
  }
  const x = i => L + (pts === 1 ? 0 : i * (W - L - R) / (pts - 1));
  const y = v => T + (H - T - B) * (1 - v / max);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = max * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="mon-grid-line"/>
      <text x="${L - 6}" y="${y(v) + 3}" class="mon-axis" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');
  const every = Math.max(1, Math.ceil(pts / 5));
  const labels = opts.times.map((t, i) => (i % every === 0 || i === pts - 1)
    ? `<text x="${x(i)}" y="${H - 6}" class="mon-axis" text-anchor="${i === pts - 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${t}</text>` : '').join('');
  const lines = series.map(s => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${d}L${x(pts - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    return `<path d="${area}" fill="${s.color}" opacity="0.10"/><path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`
      + s.values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${opts.threshold && v > opts.threshold ? 3.6 : pts > 24 ? 1.4 : 2.2}" fill="${opts.threshold && v > opts.threshold ? '#f87171' : s.color}"><title>${opts.times[i]} · ${s.name}: ${v}${opts.unit}</title></circle>`).join('');
  }).join('');
  const thr = opts.threshold
    ? `<line x1="${L}" x2="${W - R}" y1="${y(opts.threshold)}" y2="${y(opts.threshold)}" class="mon-threshold"/>
       <text x="${W - R}" y="${y(opts.threshold) - 4}" class="mon-threshold-label" text-anchor="end">Alarm ${opts.threshold}${opts.unit}</text>` : '';
  const legend = series.length > 1
    ? `<div class="mon-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="mon-svg" role="img" aria-label="${esc(opts.label)}">${grid}${labels}${lines}${thr}</svg>${legend}`;
}

async function loadMetrics() {
  let data;
  try {
    data = await apiRequest(`/metrics/instances/${encodeURIComponent(det.id)}?hours=${det.monHours || 1}`);
  } catch (err) {
    ['chartCpu', 'chartRam', 'chartNet', 'chartDisk'].forEach(id => setHtml(id, `<p class="muted">${t('Không tải được chỉ số.', 'Could not load metrics.')}</p>`));
    return;
  }
  const ts = (Array.isArray(data) ? data : (data && data.timeSeries) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  const stopped = !isRunningStatus(det.inst.status) && det.inst.status !== 'MIGRATING';
  const val = k => ts.map(p => stopped ? 0 : Number(p[k]) || 0);
  const times = ts.map(p => new Date(p.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }));
  const hours = det.monHours || 1;
  det.monPeriodMin = hours >= 12 ? 15 : 5;
  const last = arr => arr.length ? arr[arr.length - 1] : 0;
  const cpu = val('cpuUsage'), ram = val('ramUsage'), nin = val('networkIn'), nout = val('networkOut'), disk = val('diskIo');
  setHtml('chartCpu', svgChart([{ name: 'CPU', values: cpu, color: '#22d3ee' }], { max: 100, unit: '%', times, label: 'CPU utilization', threshold: CPU_ALARM }));
  renderCpuAlarm(cpu, ts, stopped);
  setHtml('chartRam', svgChart([{ name: 'RAM', values: ram, color: '#a78bfa' }], { max: 100, unit: '%', times, label: 'Memory utilization' }));
  setHtml('chartNet', svgChart([{ name: 'In', values: nin, color: '#34d399' }, { name: 'Out', values: nout, color: '#fbbf24' }], { unit: ' Mbps', times, label: 'Network' }));
  setHtml('chartDisk', svgChart([{ name: 'Disk', values: disk, color: '#f472b6' }], { unit: ' IOPS', times, label: 'Disk IO' }));
  setText('monCpuNow', last(cpu) + '%');
  setText('monRamNow', last(ram) + '%');
  setText('monNetNow', `${last(nin)} / ${last(nout)} Mbps`);
  setText('monDiskNow', last(disk) + ' IOPS');
  det.monUpdatedAt = Date.now();
  renderMonSub();
}

function renderMonSub() {
  const hours = det.monHours || 1;
  setText('monTitle', t(`Chỉ số ${hours} giờ qua`, `Metrics for the last ${hours} hour${hours > 1 ? 's' : ''}`));
  const period = det.monPeriodMin || 5;
  const at = det.monUpdatedAt ? new Date(det.monUpdatedAt).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'vi-VN', { hour12: false }) : '–';
  setText('monSub', t(`Basic monitoring, chu kỳ ${period} phút như CloudWatch. Cập nhật lúc ${at}.`,
    `Basic monitoring, ${period}-minute period like CloudWatch. Updated ${at}.`));
}

// ---------------- Monitoring: range, auto refresh, CPU alarm ----------------
const CPU_ALARM = 80;

function renderCpuAlarm(cpu, ts, stopped) {
  const el = document.getElementById('cpuAlarmState');
  const bar = document.getElementById('cpuAlarm');
  if (!el || !bar) return;
  setText('cpuAlarmThreshold', CPU_ALARM);
  let state = 'OK';
  if (stopped || !cpu.length) state = 'INSUFFICIENT_DATA';
  else if (cpu[cpu.length - 1] > CPU_ALARM) state = 'ALARM';
  el.textContent = state === 'INSUFFICIENT_DATA' ? 'Insufficient data' : state === 'ALARM' ? 'In alarm' : 'OK';
  bar.dataset.state = state;
  const breaches = cpu.map((v, i) => ({ v, t: ts[i] && ts[i].timestamp })).filter(p => p.v > CPU_ALARM);
  setText('cpuAlarmNote', stopped
    ? t('Máy không chạy nên không có dữ liệu.', 'The instance is not running, so there is no data.')
    : breaches.length
      ? t(`${breaches.length} lần vượt ngưỡng, gần nhất lúc ${new Date(breaches[breaches.length - 1].t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}.`,
          `${breaches.length} breach(es), latest at ${new Date(breaches[breaches.length - 1].t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}.`)
      : t('Không lần nào vượt ngưỡng trong khoảng này.', 'No breaches in this range.'));
}

function scheduleMetricsRefresh(tab) {
  clearInterval(det.monTimer);
  det.monTimer = null;
  const auto = document.getElementById('monAuto');
  if (tab === 'monitoring' && auto && auto.checked) {
    det.monTimer = setInterval(() => { if (!document.hidden) loadMetrics(); }, 60000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderMonSub();
  document.querySelectorAll('.seg-btn[data-hours]').forEach(b => b.addEventListener('click', () => {
    det.monHours = Number(b.dataset.hours);
    document.querySelectorAll('.seg-btn[data-hours]').forEach(x => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    loadMetrics();
  }));
  const auto = document.getElementById('monAuto');
  if (auto) auto.addEventListener('change', () => scheduleMetricsRefresh((location.hash || '').replace('#', '')));
});
