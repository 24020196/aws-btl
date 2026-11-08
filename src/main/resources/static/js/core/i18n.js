// Song ngữ Việt/Anh, ô chọn ngôn ngữ và badge người dùng trên header.

// ============================================================
// GLOBAL LANGUAGE (i18n: Tiếng Việt & English) & USER BADGE
// ============================================================
function getLang() {
  return localStorage.getItem('xregion_lang') === 'en' ? 'en' : 'vi';
}

function t(viText, enText) {
  return getLang() === 'en' ? enText : viText;
}

// Comprehensive Bidirectional Phrase Dictionary for DOM Text Nodes & Placeholders across all pages
const I18N_PAIRS = [
  // --- index.html (Overview) ---
  ['Tổng Quan Hạ Tầng Điện Toán Đa Vùng', 'Multi-Region Cloud Compute Infrastructure Overview'],
  ['Quản lý vòng đời máy ảo NovaVM trên máy chủ Bare Metal, tự động sao chép ổ đĩa EBS gp3 và cắt chuyển định tuyến Route 53 DNS xuyên vùng không gián đoạn.', 'Manage NovaVM instances on Bare Metal hosts with automated EBS gp3 snapshot replication and seamless cross-region Route 53 DNS cutover.'],
  ['+ Khởi Tạo Máy Ảo', '+ Launch Instance'],
  ['Quản Lý Máy Ảo →', 'Manage Instances →'],
  ['Tổng số máy ảo', 'Total Compute Instances'],
  ['Vùng AWS đã kết nối', 'Connected AWS Regions'],
  ['Tổng dung lượng EBS', 'Total EBS Storage'],
  ['Sức khỏe hệ thống', 'Fleet Health Rate'],
  ['Hoạt động tốt', 'Operational'],
  ['• Mã vùng:', '• Region code:'],
  ['• Vai trò: Active Primary Production', '• Role: Active Primary Production'],
  ['• Định tuyến mạng: VPC Subnet', '• Network routing: VPC Subnet'],
  ['• Vai trò: Standby Secondary & Disaster Recovery', '• Role: Standby Secondary & Disaster Recovery'],
  ['Máy ảo tại vùng:', 'Instances in region:'],
  ['Chuyển vùng xuyên vùng (Cross-Region Migration)', 'Cross-Region Migration'],
  ['Tổng hợp từ bảng XRegion-Migrations cho các máy ảo của bạn.', 'Aggregated from XRegion-Migrations table for your instances.'],
  ['Chọn máy để chuyển vùng →', 'Select instance to migrate →'],
  ['Thành công', 'Completed'],
  ['Thất bại / rollback', 'Failed / Rollback'],
  ['Khóa được nhả tự động', 'Lock auto-released'],
  ['Đang chạy', 'Running'],
  ['Downtime TB (RTO)', 'Avg Downtime (RTO)'],
  ['Từ lúc dừng VM nguồn tới khi DNS đổi IP', 'From source VM stop to Route 53 DNS cutover'],
  ['Lần chuyển vùng gần nhất', 'Latest Cross-Region Migration'],
  ['Máy đang giữ migration_lock', 'Instances Holding migration_lock'],
  ['Đang tải…', 'Loading…'],
  ['Máy Ảo Đang Hoạt Động (Active Instances)', 'Active Compute Instances'],
  ['Xem Toàn Bộ Máy Ảo →', 'View All Instances →'],
  ['TÊN MÁY ẢO', 'INSTANCE NAME'],
  ['VÙNG HIỆN TẠI', 'CURRENT REGION'],
  ['DNS TÊN MIỀN', 'ROUTE 53 DNS'],
  ['TRẠNG THÁI', 'STATE'],
  ['CHI TIẾT', 'DETAILS'],
  ['THAO TÁC', 'ACTIONS'],
  ['IP NỘI BỘ', 'PRIVATE IP'],
  ['Đang tải dữ liệu máy ảo...', 'Loading compute instances...'],
  ['Nhật Ký Thao Tác Hệ Thống (Recent Audit Logs)', 'Recent System Audit Logs'],
  ['THỜI GIAN', 'TIMESTAMP'],
  ['NGƯỜI THỰC HIỆN', 'ACTOR'],
  ['HÀNH ĐỘNG', 'ACTION'],
  ['ĐỐI TƯỢNG', 'RESOURCE'],
  ['CHI TIẾT NHẬT KÝ', 'AUDIT DETAILS'],
  ['Đang tải nhật ký...', 'Loading audit logs...'],

  // --- instances.html ---
  ['Tổng số máy ảo', 'Total Instances'],
  ['Đang dừng', 'Stopped'],
  ['Đang chuyển vùng', 'Migrating'],
  ['Tất cả trạng thái', 'All statuses'],
  ['Đang chạy (ACTIVE)', 'Running (ACTIVE)'],
  ['Đã dừng (SHUTOFF)', 'Stopped (SHUTOFF)'],
  ['Đang chuyển vùng (MIGRATING)', 'Migrating'],
  ['Làm mới', 'Refresh'],
  ['Đang tải danh sách máy ảo...', 'Loading instances...'],
  ['Tìm theo tên hoặc ID...', 'Search by instance name or ID...'],

  // --- instance-detail.html ---
  ['Vùng:', 'Region:'],
  ['Trạng thái', 'Instance state'],
  ['Vùng hiện tại', 'Current region'],
  ['Khóa chuyển vùng', 'Migration lock'],
  ['Chi tiết', 'Details'],
  ['Bảo mật & Mạng', 'Security & Networking'],
  ['Lưu trữ', 'Storage'],
  ['Giám sát', 'Monitoring'],
  ['Chuyển vùng', 'Cross-Region Migration'],
  ['Phần cứng & Hệ điều hành', 'Hardware & OS Configuration'],
  ['Hệ điều hành', 'Operating System'],
  ['Nền tảng', 'Platform'],
  ['Ảo hóa', 'Virtualization'],
  ['KVM (OpenStack Nova) trên EC2 Bare Metal', 'KVM (OpenStack Nova) on EC2 Bare Metal'],
  ['Định danh & Truy cập', 'Identity & Access'],
  ['Tên máy ảo', 'Instance name'],
  ['Chủ sở hữu', 'Owner'],
  ['Trạng thái hiện tại', 'Current state'],
  ['User đăng nhập', 'SSH login user'],
  ['Kết nối', 'Connection'],
  ['Xem lệnh SSH', 'View SSH command'],
  ['Tường lửa ảo gắn vào card mạng của máy. Lưu lượng chỉ đi qua khi khớp ít nhất một rule.', 'Virtual firewall attached to the instance ENI. Traffic is permitted only when matching at least one rule.'],
  ['Đổi Security Group', 'Change Security Group'],
  ['+ Tạo Security Group', '+ Create Security Group'],
  ['+ Thêm rule', '+ Add rule'],
  ['+ Thêm outbound rule', '+ Add outbound rule'],
  ['Loại', 'Type'],
  ['Giao thức', 'Protocol'],
  ['Cổng', 'Port range'],
  ['Nguồn', 'Source'],
  ['Đích', 'Destination'],
  ['Mô tả', 'Description'],
  ['Máy ảo không có ENI riêng: nó dùng một secondary IP trên ENI của máy chủ EC2 Bare Metal, Elastic IP được NAT 1:1 vào IP đó.', 'The VM uses a secondary private IP on the EC2 Bare Metal host ENI with 1:1 Elastic IP NAT mapping.'],
  ['Gắn vào', 'Attached to'],
  ['Secondary IP (máy ảo)', 'Secondary IP (VM)'],
  ['Mạng & Route 53', 'VPC Network & Route 53'],
  ['Cập nhật Route 53 DNS', 'Update Route 53 DNS'],
  ['Tên miền', 'Domain name'],
  ['Bản ghi A đang trỏ tới', 'A-Record target IP'],
  ['Đồng bộ với Elastic IP', 'Synced with Elastic IP'],
  ['Thiết bị gốc (Root device)', 'Root Device Configuration'],
  ['Tên thiết bị gốc', 'Root device name'],
  ['Loại thiết bị', 'Device type'],
  ['Loại ổ đĩa', 'Volume type'],
  ['Dung lượng', 'Size'],
  ['Hiệu năng', 'Performance'],
  ['Block devices đang gắn', 'Attached Block Devices'],
  ['Khi chuyển vùng, ổ gốc được chụp snapshot và sao chép sang vùng đích. Ổ dữ liệu gắn thêm cần sao chép riêng bằng Cross-region copy.', 'During cross-region migration, the root volume is snapshotted and replicated to the destination region.'],
  ['Tên', 'Name'],
  ['Thiết bị', 'Device'],
  ['Tự làm mới mỗi phút', 'Auto-refresh every minute'],
  ['Hướng chuyển tiếp theo', 'Next migration route'],
  ['Tiến trình chuyển vùng (6 bước)', 'Cross-Region Migration Pipeline (6 Steps)'],
  ['Chưa có lần chuyển vùng nào đang chạy.', 'No active migration in progress.'],
  ['Dừng máy nguồn', 'Stop source VM'],
  ['Sao chép liên vùng', 'Cross-region copy'],
  ['Tạo volume đích', 'Create target volume'],
  ['Khởi động NovaVM', 'Boot target NovaVM'],
  ['Chuyển DNS', 'Cutover Route 53 DNS'],
  ['Log thời gian thực', 'Real-time migration log'],
  ['Đang chờ', 'Idle'],
  ['Log của từng bước sẽ hiện ở đây khi bạn bấm Fast Migrate.', 'Step-by-step execution logs will appear here when you trigger Fast Migrate.'],
  ['Lịch sử chuyển vùng', 'Migration History'],
  ['Bấm vào một dòng để xem lại log 6 bước của lần đó.', 'Click any row to inspect the detailed 6-step execution log.'],
  ['Vùng nguồn → Vùng đích', 'Source → Destination'],
  ['Bắt đầu', 'Started at'],
  ['Hoàn tất', 'Completed at'],
  ['Thời lượng', 'Duration'],

  // --- launch.html ---
  ['Khởi Tạo Máy Ảo Mới', 'Launch New Instance'],
  ['Cấu hình máy chủ ảo hóa liên vùng. Sau khi khởi tạo, dữ liệu có thể tự động sao chép và di chuyển giữa các vùng hạ tầng theo kịch bản.', 'Configure a cross-region compute instance with automated EBS gp3 replication and Route 53 DNS failover.'],
  ['Tên Máy Ảo (Instance Name)', 'Instance Name & Tags'],
  ['Tên Máy Ảo *', 'Instance Name *'],
  ['vd: my-web-server', 'e.g. my-web-server'],
  ['Vùng Cấp Phát (Target Region)', 'Target AWS Region'],
  ['Mã vùng:', 'Region code:'],
  ['Ảnh Hệ Điều Hành (Application and OS Images)', 'Application and OS Images (AMI / Glance)'],
  ['Chọn ảnh máy ảo hệ điều hành (Glance OS Image) lưu trữ trên cụm Bare Metal:', 'Select a base operating system image (Glance OS Image) for your instance:'],
  ['Gói Cấu Hình Máy Ảo (Flavor)', 'Instance Type (Flavor)'],
  ['Chọn Flavor:', 'Select Instance Type:'],
  ['📋 Danh Sách Flavor Cho Phép', '📋 Available Instance Types'],
  ['Dòng', 'Series'],
  ['Tên Flavor', 'Instance Type'],
  ['Tiêu chuẩn (m1)', 'General Purpose (m1)'],
  ['Hiệu năng cao (h1)', 'High Performance (h1)'],
  ['Khóa Xác Thực SSH (Key Pair - Login)', 'Key Pair (SSH Login)'],
  ['Chọn khóa SSH đã tạo trước đó hoặc khởi tạo Key Pair mới để tải file', 'Select an existing SSH key pair or create a new key pair to download the'],
  ['Tên Key Pair *', 'Key Pair Name *'],
  ['🔑 + Tạo Key Pair Mới (.pem)', '🔑 + Create New Key Pair (.pem)'],
  ['Ổ Đĩa Root EBS & Tên Miền DNS', 'Root EBS Volume & Route 53 DNS'],
  ['Loại Ổ Đĩa', 'Volume Type'],
  ['Dung Lượng Root Disk (GB) *', 'Root Volume Size (GiB) *'],
  ['Tên Miền Route 53 DNS', 'Route 53 DNS Domain'],
  ['vd: my-app.xregion.net', 'e.g. my-app.xregion.net'],
  ['Tóm Tắt Cấu Hình', 'Summary'],
  ['VÙNG ĐÃ CHỌN', 'TARGET REGION'],
  ['HỆ ĐIỀU HÀNH (OS)', 'OPERATING SYSTEM (AMI)'],
  ['KHÓA XÁC THỰC (KEY PAIR)', 'SSH KEY PAIR'],
  ['THÔNG SỐ PHẦN CỨNG', 'INSTANCE SPECIFICATIONS'],
  ['🚀 Khởi Tạo Máy Ảo', '🚀 Launch Instance'],
  ['Hủy bỏ (Cancel)', 'Cancel'],

  // --- account-tokens.html ---
  ['Quản Lý Tài Khoản & API Token Xác Thực', 'Account Profile & API Access Tokens'],
  ['Thông Tin Tài Khoản', 'Account Information'],
  ['Tên đăng nhập:', 'Username:'],
  ['Họ và tên:', 'Full name:'],
  ['Vai trò (Role):', 'Role:'],
  ['Ngày khởi tạo:', 'Created at:'],
  ['Đổi Mật Khẩu', 'Change Password'],
  ['Mật khẩu hiện tại', 'Current password'],
  ['Nhập mật khẩu hiện tại', 'Enter current password'],
  ['Mật khẩu mới', 'New password'],
  ['Nhập mật khẩu mới', 'Enter new password'],
  ['Cập Nhật Mật Khẩu', 'Update Password'],
  ['Tạo API Token Xác Thực Mới', 'Generate New Personal Access Token'],
  ['API Token được tạo riêng biệt với phiên đăng nhập Web Dashboard, lưu trữ vào DynamoDB và dùng để gọi trực tiếp các dịch vụ qua AWS API Gateway (Edge-Optimized).', 'Personal API tokens are stored in DynamoDB and used to authenticate direct API requests via AWS API Gateway (Edge-Optimized).'],
  ['Tên gợi nhớ của Token', 'Token description / name'],
  ['Ví dụ: CI/CD Deployment, CLI Tool, Monitoring System', 'e.g. CI/CD Deployment, CLI Tool, Monitoring System'],
  ['Thời hạn hiệu lực', 'Expiration'],
  ['1 Tháng (30 ngày)', '1 Month (30 days)'],
  ['3 Tháng (90 ngày)', '3 Months (90 days)'],
  ['6 Tháng (180 ngày)', '6 Months (180 days)'],
  ['Không thời hạn (No Date / Vĩnh viễn)', 'No Expiration (Never expires)'],
  ['+ Sinh API Token Mới', '+ Generate New Token'],
  ['API Token của bạn đã được khởi tạo thành công!', 'Your new API token has been generated!'],
  ['Sao Chép Token', 'Copy Token'],
  ['Danh Sách API Token Đã Cấp Phát', 'Issued API Access Tokens'],
  ['Làm Mới', 'Refresh'],
  ['TÊN TOKEN', 'TOKEN NAME'],
  ['MÃ TOKEN (TRÍCH XUẤT)', 'TOKEN PREFIX'],
  ['NGÀY TẠO', 'CREATED AT'],
  ['HẠN DÙNG', 'EXPIRES AT'],
  ['Hướng Dẫn Gọi AWS API Gateway (Edge-Optimized)', 'AWS API Gateway (Edge-Optimized) cURL Guide'],
  ['Endpoint đã được tối ưu hóa toàn cầu qua mạng CloudFront Edge. Sử dụng lệnh cURL sau để gửi sự kiện vào Amazon EventBridge:', 'Global edge-optimized endpoint via CloudFront. Use the following cURL command to publish lifecycle events to Amazon EventBridge:']
];

const VI_TO_EN_DICT = new Map();
const EN_TO_VI_DICT = new Map();
I18N_PAIRS.forEach(([vi, en]) => {
  VI_TO_EN_DICT.set(vi.trim(), en);
  EN_TO_VI_DICT.set(en.trim(), vi);
});

// ============================================================
// CHUẨN HÓA I18N MỚI: REGISTRY & DATA-I18N KEY
// ============================================================
const GLOBAL_I18N_REGISTRY = {};
const LANG_CHANGE_LISTENERS = [];

function registerI18n(dict) {
  if (!dict || typeof dict !== 'object') return;
  Object.keys(dict).forEach(k => {
    GLOBAL_I18N_REGISTRY[k] = dict[k];
  });
  if (document.body) {
    applyPageTranslations();
  }
}

function tk(key, fallback = '') {
  const isEn = getLang() === 'en';
  const item = GLOBAL_I18N_REGISTRY[key];
  if (!item) return fallback || key;
  if (Array.isArray(item)) return isEn ? (item[1] ?? item[0] ?? key) : (item[0] ?? key);
  if (typeof item === 'object') return isEn ? (item.en || item.vi || key) : (item.vi || item.en || key);
  return item;
}

function onLangChange(fn) {
  if (typeof fn === 'function') {
    LANG_CHANGE_LISTENERS.push(fn);
  }
}

// Đăng ký bộ từ điển dùng chung chuẩn AWS Console
registerI18n({
  navDashboard: ['Bảng điều khiển EC2', 'EC2 Dashboard'],
  navInstances: ['Máy ảo', 'Instances'],
  navLaunch: ['Khởi tạo máy ảo', 'Launch instance'],
  navTokens: ['API Token', 'API Tokens'],
  navSidebarTitle: ['Menu điều hướng', 'EC2 Navigation'],
  navCollapseSidebar: ['Thu gọn / Mở rộng Sidebar', 'Collapse / Expand sidebar'],
  navImages: ['Hình ảnh máy ảo', 'Images'],
  navAmis: ['AMIs', 'AMIs'],
  navStorage: ['Lưu trữ đàn hồi (EBS)', 'Elastic Block Store'],
  navVolumes: ['Ổ đĩa (Volumes)', 'Volumes'],
  navSnapshots: ['Bản sao nhanh (Snapshots)', 'Snapshots'],
  navNetwork: ['Mạng & Bảo mật', 'Network & Security'],
  navSecurityGroups: ['Nhóm bảo mật (Security Groups)', 'Security Groups'],
  navElasticIps: ['IP đàn hồi (Elastic IPs)', 'Elastic IPs'],
  navKeyPairs: ['Cặp khóa (Key Pairs)', 'Key Pairs'],
  navMigration: ['Di chuyển liên vùng', 'Migration'],
  navCrossRegion: ['Chuyển vùng liên vùng', 'Cross-Region Migration'],
  navAccount: ['Tài khoản & Xác thực', 'Account & Access'],
  navComingSoon: ['Sắp ra mắt', 'Coming soon'],

  actInstanceState: ['Trạng thái máy ảo', 'Instance state'],
  actActions: ['Hành động', 'Actions'],
  actConnect: ['Kết nối', 'Connect'],
  actStart: ['Khởi động', 'Start'],
  actStop: ['Dừng', 'Stop'],
  actReboot: ['Khởi động lại', 'Reboot'],
  actTerminate: ['Xóa máy ảo', 'Terminate'],
  actRefresh: ['Làm mới', 'Refresh'],
  actViewDetails: ['Xem chi tiết', 'View details'],

  stRunning: ['Đang chạy', 'Running'],
  stStopped: ['Đã dừng', 'Stopped'],
  stPending: ['Đang khởi tạo', 'Pending'],
  stStopping: ['Đang dừng', 'Stopping'],
  stRebooting: ['Đang khởi động lại', 'Rebooting'],
  stShuttingDown: ['Đang xóa', 'Shutting-down'],
  stTerminated: ['Đã xóa', 'Terminated'],
  stMigrating: ['Đang chuyển vùng', 'Migrating'],

  tabDetails: ['Chi tiết', 'Details'],
  tabSecurity: ['Bảo mật', 'Security'],
  tabNetworking: ['Mạng', 'Networking'],
  tabStorage: ['Lưu trữ', 'Storage'],
  tabMonitoring: ['Giám sát', 'Monitoring'],
  tabMigration: ['Chuyển vùng', 'Migration'],

  commonCopy: ['Sao chép', 'Copy'],
  commonCopied: ['Đã sao chép!', 'Copied!'],
  commonCancel: ['Hủy bỏ', 'Cancel'],
  commonSave: ['Lưu thay đổi', 'Save changes'],
  commonLoading: ['Đang tải…', 'Loading…'],
  commonSignOut: ['Đăng xuất', 'Sign out'],
  commonSignIn: ['Đăng nhập', 'Sign in'],
  commonSignUp: ['Đăng ký', 'Sign up']
});

function setGlobalLang(lang) {
  const normalized = lang === 'en' ? 'en' : 'vi';
  localStorage.setItem('xregion_lang', normalized);
  renderUserBadge();
  applyPageTranslations();

  // Gọi các listener đã đăng ký
  LANG_CHANGE_LISTENERS.forEach(fn => {
    try { fn(normalized); } catch (e) { console.error('onLangChange error:', e); }
  });

  // Refresh dynamic views on whichever page is currently open (Backward Compatibility)
  if (typeof refreshEditSectionLabels === 'function' && document.getElementById('editInstanceForm')) {
    refreshEditSectionLabels();
    if (typeof updateEditInstanceSummary === 'function') updateEditInstanceSummary();
  }
  if (document.getElementById('overviewTotalInstances') && typeof initOverviewPage === 'function') {
    initOverviewPage();
    if (typeof loadMigrationSummary === 'function') loadMigrationSummary();
  }
  if (typeof filterInstancesUI === 'function' && document.getElementById('instanceTableBody')) {
    loadInstances();
  }
  if (typeof det !== 'undefined' && det && det.inst && typeof renderInstance === 'function') {
    det.actionsKey = '';
    renderInstance();
    if (typeof renderSecurityGroups === 'function') renderSecurityGroups();
    if (typeof renderNetwork === 'function') renderNetwork();
    if (typeof loadMigrationHistory === 'function') loadMigrationHistory();
  }
  if (typeof updatePageLaunchSummary === 'function' && document.getElementById('launchInstancePageForm')) {
    updatePageLaunchSummary();
  }
}

function applyPageTranslations() {
  const isEn = getLang() === 'en';
  document.documentElement.lang = isEn ? 'en' : 'vi';

  // 1. Áp dụng chuẩn mới qua data-i18n (key-based)
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (GLOBAL_I18N_REGISTRY[key] !== undefined) {
      el.textContent = tk(key);
    }
  });

  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (GLOBAL_I18N_REGISTRY[key] !== undefined) {
      el.innerHTML = tk(key);
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (GLOBAL_I18N_REGISTRY[key] !== undefined) {
      el.setAttribute('placeholder', tk(key));
    }
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (GLOBAL_I18N_REGISTRY[key] !== undefined) {
      el.setAttribute('title', tk(key));
    }
  });

  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria');
    if (GLOBAL_I18N_REGISTRY[key] !== undefined) {
      el.setAttribute('aria-label', tk(key));
    }
  });

  // 2. LEGACY: Translate all elements with explicit data-i18n-vi / data-i18n-en
  document.querySelectorAll('[data-i18n-vi]').forEach(el => {
    const txt = isEn ? el.getAttribute('data-i18n-en') : el.getAttribute('data-i18n-vi');
    if (txt !== null) el.textContent = txt;
  });

  // 3. LEGACY: Translate top sub-navigation links across pages not yet migrated to sidebar
  const navMap = [
    { href: '/index.html', vi: 'Trang Chủ Tổng Quan', en: 'Overview Dashboard' },
    { href: '/instances.html', vi: 'Danh Sách Máy Ảo', en: 'Instances' },
    { href: '/launch.html', vi: 'Khởi Tạo Máy Ảo (+ Launch VM)', en: 'Launch Instance (+ Launch VM)' },
    { href: '/account-tokens.html', vi: 'Tài Khoản & API Token', en: 'Account & API Tokens' }
  ];
  navMap.forEach(item => {
    document.querySelectorAll(`.sub-nav a[href="${item.href}"]`).forEach(a => {
      const svg = a.querySelector('svg');
      const label = isEn ? item.en : item.vi;
      if (svg) {
        a.innerHTML = '';
        a.appendChild(svg);
        a.appendChild(document.createTextNode(' ' + label));
      } else {
        a.textContent = label;
      }
    });
  });

  // 4. LEGACY: Walk DOM text nodes and translate matching phrases losslessly
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const parentTag = node.parentElement ? node.parentElement.tagName : '';
      if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'CODE') continue;
      const raw = node.nodeValue;
      const trimmed = raw.trim().replace(/\s+/g, ' ');
      if (!trimmed) continue;
      if (isEn && VI_TO_EN_DICT.has(trimmed)) {
        node.nodeValue = VI_TO_EN_DICT.get(trimmed);
      } else if (!isEn && EN_TO_VI_DICT.has(trimmed)) {
        node.nodeValue = EN_TO_VI_DICT.get(trimmed);
      }
    }

    // Translate input placeholders
    document.querySelectorAll('input[placeholder]').forEach(inp => {
      const p = inp.getAttribute('placeholder').trim();
      if (isEn && VI_TO_EN_DICT.has(p)) {
        inp.setAttribute('placeholder', VI_TO_EN_DICT.get(p));
      } else if (!isEn && EN_TO_VI_DICT.has(p)) {
        inp.setAttribute('placeholder', EN_TO_VI_DICT.get(p));
      }
    });
  }
}

function renderUserBadge() {
  const container = document.getElementById('userBadgeContainer');
  if (!container) return;

  const token = localStorage.getItem('xregion_jwt');
  const user = localStorage.getItem('xregion_user') || 'Admin';
  const lang = getLang();

  const iconGlobe = typeof ICON === 'function' ? ICON('ui-globe', 'ico-sm') : '';
  const iconUser = typeof ICON === 'function' ? ICON('ui-user', 'ico-sm') : '';
  const iconLogout = typeof ICON === 'function' ? ICON('ui-logout', 'ico-sm') : '';

  const langSelectorHtml = `
    <div style="display: inline-flex; align-items: center; gap: 6px;">
      ${iconGlobe}
      <select class="header-lang-select" onchange="setGlobalLang(this.value)" aria-label="Language">
        <option value="vi" ${lang === 'vi' ? 'selected' : ''}>Tiếng Việt (VN)</option>
        <option value="en" ${lang === 'en' ? 'selected' : ''}>English (US)</option>
      </select>
    </div>
  `;

  if (token) {
    container.innerHTML = `
      ${langSelectorHtml}
      <span style="font-weight: 600; color: #fff; display: inline-flex; align-items: center; gap: 6px;">
        ${iconUser} <span>${user}</span>
      </span>
      <button class="btn btn-secondary btn-sm" onclick="logout()" style="padding: 4px 10px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">
        ${iconLogout} <span>${tk('commonSignOut', t('Đăng xuất', 'Sign out'))}</span>
      </button>
    `;
  } else {
    container.innerHTML = `
      ${langSelectorHtml}
      <a href="/login.html" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 12px; text-decoration: none;">${tk('commonSignIn', t('Đăng Nhập', 'Sign in'))}</a>
      <a href="/register.html" class="btn btn-primary btn-sm" style="padding: 4px 10px; font-size: 12px; text-decoration: none; margin-left: 6px;">${tk('commonSignUp', t('Đăng Ký', 'Sign up'))}</a>
    `;
  }
  applyPageTranslations();
}
