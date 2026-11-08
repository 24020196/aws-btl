// Chỉ trang icons-preview.html — đọc sprite và hiển thị toàn bộ icon, bấm để copy snippet.

const ICON_SPRITE_URL = '/img/icons/sprite.svg';

const ICON_GROUPS = [
  { prefix: 'svc-', title: 'Dịch vụ đám mây (svc-*)', note: 'màu theo nhóm dịch vụ' },
  { prefix: 'ui-', title: 'Thao tác giao diện (ui-*)', note: 'ăn theo màu chữ - currentColor' },
  { prefix: 'os-', title: 'Hệ điều hành (os-*)', note: 'dùng ở trang Launch / chi tiết máy' }
];

function iconSnippet(id) {
  return '<svg class="ico" aria-hidden="true"><use href="' + ICON_SPRITE_URL + '#' + id + '"></use></svg>';
}

function showIconToast(msg) {
  const toast = document.getElementById('ipToast');
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showIconToast._timer);
  showIconToast._timer = setTimeout(() => { toast.hidden = true; }, 1600);
}

function copyIconSnippet(id) {
  const text = iconSnippet(id);
  const done = () => showIconToast('Đã copy: #' + id);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  done();
}

function buildIconItem(icon) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ip-item';
  btn.dataset.search = (icon.id + ' ' + icon.title).toLowerCase();
  btn.innerHTML = iconSnippet(icon.id) +
    '<span class="ip-item-id"></span><span class="ip-item-title"></span>';
  btn.querySelector('.ip-item-id').textContent = icon.id;
  btn.querySelector('.ip-item-title').textContent = icon.title;
  btn.addEventListener('click', () => copyIconSnippet(icon.id));
  return btn;
}

function renderIconGroups(icons) {
  const root = document.getElementById('ipGroups');
  root.innerHTML = '';
  ICON_GROUPS.forEach(group => {
    const list = icons.filter(i => i.id.startsWith(group.prefix));
    const section = document.createElement('section');
    section.className = 'ip-group';
    const h2 = document.createElement('h2');
    h2.textContent = group.title + ' ';
    const small = document.createElement('small');
    small.textContent = list.length + ' icon · ' + group.note;
    h2.appendChild(small);
    const grid = document.createElement('div');
    grid.className = 'ip-grid';
    list.forEach(icon => grid.appendChild(buildIconItem(icon)));
    section.append(h2, grid);
    root.appendChild(section);
  });
}

function filterIcons(keyword) {
  const q = keyword.trim().toLowerCase();
  document.querySelectorAll('.ip-item').forEach(el => {
    el.style.display = !q || el.dataset.search.includes(q) ? '' : 'none';
  });
}

async function initIconPreview() {
  try {
    const res = await fetch(ICON_SPRITE_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
    const icons = Array.from(doc.querySelectorAll('symbol')).map(s => ({
      id: s.id,
      title: (s.querySelector('title') || {}).textContent || ''
    }));
    renderIconGroups(icons);
  } catch (err) {
    document.getElementById('ipGroups').innerHTML =
      '<p class="ip-error">Không tải được sprite: ' + err.message + '</p>';
  }
  document.getElementById('ipSearch').addEventListener('input', e => filterIcons(e.target.value));
}

document.addEventListener('DOMContentLoaded', initIconPreview);

