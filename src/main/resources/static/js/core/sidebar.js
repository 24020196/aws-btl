// Dùng chung mọi trang — Sidebar navigation đưa thanh điều hướng ngang xuống dạng sidebar dọc.
// Sửa file này phải báo cả nhóm.

const SIDEBAR_ITEMS = [
  {
    id: 'dashboard',
    href: '/index.html',
    titleKey: 'navDashboard',
    fallbackVi: 'Trang Chủ Overview',
    fallbackEn: 'Overview Dashboard',
    icon: 'ui-dashboard'
  },
  {
    id: 'instances',
    href: '/instances.html',
    titleKey: 'navInstances',
    fallbackVi: 'Danh Sách Máy Ảo',
    fallbackEn: 'Instances',
    icon: 'ui-server'
  },
  {
    id: 'launch',
    href: '/launch.html',
    titleKey: 'navLaunch',
    fallbackVi: 'Khởi Tạo Máy Ảo (+ Launch VM)',
    fallbackEn: 'Launch Instance (+ Launch VM)',
    icon: 'ui-plus'
  }
];

function isSidebarCollapsed() {
  return localStorage.getItem('xregion_sidebar_collapsed') === 'true';
}

function setSidebarCollapsed(collapsed) {
  localStorage.setItem('xregion_sidebar_collapsed', collapsed ? 'true' : 'false');
  const aside = document.getElementById('appSidebar');
  if (aside) {
    aside.classList.toggle('collapsed', collapsed);
  }
}

function toggleSidebarCollapse() {
  setSidebarCollapsed(!isSidebarCollapsed());
}

function closeMobileSidebar() {
  const aside = document.getElementById('appSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (aside) aside.classList.remove('open');
  if (backdrop) backdrop.classList.remove('active');
}

function openMobileSidebar() {
  const aside = document.getElementById('appSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (aside) aside.classList.add('open');
  if (backdrop) backdrop.classList.add('active');
}

function initMobileControls() {
  // Backdrop
  let backdrop = document.getElementById('sidebarBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', closeMobileSidebar);
    document.body.appendChild(backdrop);
  }

  // Mobile menu toggle button in header
  const logoContainer = document.querySelector('.header .logo-container');
  if (logoContainer && !document.getElementById('sidebarMobileToggle')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sidebarMobileToggle';
    btn.className = 'sidebar-mobile-toggle';
    btn.title = 'Menu';
    btn.setAttribute('aria-label', 'Open navigation menu');
    btn.innerHTML = typeof ICON === 'function' ? ICON('ui-menu', 'ico-md') : '';
    btn.addEventListener('click', () => {
      const aside = document.getElementById('appSidebar');
      if (aside && aside.classList.contains('open')) {
        closeMobileSidebar();
      } else {
        openMobileSidebar();
      }
    });
    logoContainer.prepend(btn);
  }
}

function renderSidebar() {
  const aside = document.getElementById('appSidebar');
  if (!aside) return;

  const activeKey = (aside.dataset.active || '').trim();
  const collapsed = isSidebarCollapsed();
  aside.classList.toggle('collapsed', collapsed);

  const isEn = typeof getLang === 'function' ? getLang() === 'en' : false;
  const headerTitle = typeof tk === 'function' ? tk('navSidebarTitle', (isEn ? 'EC2 Navigation' : 'Menu điều hướng')) : (isEn ? 'EC2 Navigation' : 'Menu điều hướng');
  const collapseTitle = typeof tk === 'function' ? tk('navCollapseSidebar', (isEn ? 'Collapse / Expand sidebar' : 'Thu gọn / Mở rộng Sidebar')) : (isEn ? 'Collapse / Expand sidebar' : 'Thu gọn / Mở rộng Sidebar');

  let html = `
    <div class="sidebar-header">
      <div class="sidebar-header-title">${headerTitle}</div>
      <button type="button" class="sidebar-collapse-btn" onclick="toggleSidebarCollapse()" title="${collapseTitle}">
        ${typeof ICON === 'function' ? ICON('ui-sidebar', 'ico-md') : ''}
      </button>
    </div>
    <nav class="sidebar-nav" aria-label="Main Navigation">
  `;

  SIDEBAR_ITEMS.forEach(item => {
    const isActive = item.id === activeKey;
    const title = typeof tk === 'function'
      ? tk(item.titleKey, (isEn ? item.fallbackEn : item.fallbackVi))
      : (isEn ? item.fallbackEn : item.fallbackVi);
    const iconHtml = typeof ICON === 'function' ? ICON(item.icon, 'ico-md') : '';
    const activeClass = isActive ? 'active' : '';

    html += `
      <a href="${item.href}" class="sidebar-item ${activeClass}" title="${title}">
        ${iconHtml}
        <span class="sidebar-item-text">${title}</span>
      </a>
    `;
  });

  html += '</nav>';
  aside.innerHTML = html;
}

function initSidebar() {
  const aside = document.getElementById('appSidebar');
  if (!aside) return;

  initMobileControls();
  renderSidebar();

  if (typeof onLangChange === 'function') {
    onLangChange(() => renderSidebar());
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebar);
} else {
  initSidebar();
}
