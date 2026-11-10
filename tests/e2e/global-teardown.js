// Dọn dẹp tài nguyên sau khi chạy xong bộ test Playwright trên AWS thật (hoặc chạy qua npm run cleanup).
//
// Trách nhiệm:
//   1. Đọc state phiên làm việc từ %TEMP%/xregion-e2e/state.json.
//   2. Gọi GET /api/instances để lấy danh sách máy của user e2e.
//   3. Với mỗi máy (RUNNING, STOPPED, FAILED), gửi action TERMINATE.
//   4. Chờ Step Functions dọn dẹp và bản ghi bị xóa cứng (Hard Delete) khỏi hệ thống.
//   5. Xóa Key Pair đã tạo cho user.
//   6. Dọn dẹp file state nếu toàn bộ hoàn tất an toàn.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.tmpdir(), 'xregion-e2e', 'state.json');

async function teardown() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('[teardown] Không tìm thấy file state.json. Không có tài nguyên e2e cần dọn.');
    return;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    console.error(`[teardown] Không đọc được state.json: ${err.message}`);
    return;
  }

  const { baseUrl, user, keyPairName } = state;
  if (!baseUrl || !user?.token) {
    console.warn('[teardown] Thiếu baseUrl hoặc token trong state.json.');
    return;
  }

  console.log(`[teardown] Bắt đầu dọn dẹp tài nguyên cho user [${user.username}] tại ${baseUrl}...`);

  // 1. Lấy danh sách toàn bộ máy của user e2e
  let instances = [];
  try {
    const listRes = await fetch(`${baseUrl}/api/instances`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    if (listRes.ok) {
      const body = await listRes.json();
      instances = body.data || [];
    }
  } catch (err) {
    console.error(`[teardown] Lỗi lấy danh sách instances: ${err.message}`);
  }

  console.log(`[teardown] Tìm thấy ${instances.length} máy ảo cần xử lý.`);

  // 2. Gửi lệnh TERMINATE cho các máy còn tồn tại
  const terminatingIds = [];
  for (const inst of instances) {
    const id = inst.id || inst.instanceId;
    const status = (inst.status || '').toUpperCase();
    console.log(`[teardown] Máy [${id}] - Tên: ${inst.name} - Trạng thái: ${status}`);

    if (['RUNNING', 'STOPPED', 'FAILED', 'SHUTTING_DOWN', 'STARTING', 'STOPPING'].includes(status)) {
      try {
        const termRes = await fetch(`${baseUrl}/api/instances/${id}/actions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${user.token}`
          },
          body: JSON.stringify({ action: 'TERMINATE' })
        });
        if (termRes.ok) {
          console.log(`[teardown] Đã gửi lệnh TERMINATE cho máy [${id}].`);
          terminatingIds.push(id);
        } else {
          const errBody = await termRes.text();
          console.warn(`[teardown] Không gửi được TERMINATE cho máy [${id}] (${termRes.status}): ${errBody}`);
        }
      } catch (err) {
        console.warn(`[teardown] Lỗi kết nối khi terminate [${id}]: ${err.message}`);
      }
    } else {
      terminatingIds.push(id);
    }
  }

  // 3. Chờ các máy biến mất hoàn toàn khỏi danh sách (Hard Delete)
  if (terminatingIds.length > 0) {
    console.log(`[teardown] Đang chờ ${terminatingIds.length} máy hoàn tất dọn dẹp và biến mất (tối đa 10 phút)...`);
    const deadline = Date.now() + 600_000;
    const remaining = new Set(terminatingIds);

    while (Date.now() < deadline && remaining.size > 0) {
      await new Promise(r => setTimeout(r, 6000));
      try {
        const checkRes = await fetch(`${baseUrl}/api/instances`, {
          headers: { Authorization: `Bearer ${user.token}` }
        });
        if (checkRes.ok) {
          const body = await checkRes.json();
          const currentIds = new Set((body.data || []).map(i => i.id || i.instanceId));
          for (const id of Array.from(remaining)) {
            if (!currentIds.has(id)) {
              console.log(`[teardown] Máy [${id}] đã bị xóa cứng hoàn toàn.`);
              remaining.delete(id);
            }
          }
        }
      } catch {
        // bỏ qua lỗi gián đoạn mạng
      }
    }

    if (remaining.size > 0) {
      console.error(`[teardown] CẢNH BÁO: Còn lại ${remaining.size} máy chưa kịp xóa: ${Array.from(remaining).join(', ')}`);
    } else {
      console.log('[teardown] Tất cả các máy ảo e2e đã được xóa sạch!');
    }
  }

  // 4. Xóa Key Pair đã tạo
  if (keyPairName) {
    try {
      console.log(`[teardown] Đang xóa Key Pair [${keyPairName}]...`);
      const keyDelRes = await fetch(`${baseUrl}/api/keys/${encodeURIComponent(keyPairName)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.token}` }
      });
      if (keyDelRes.ok) {
        console.log(`[teardown] Đã xóa Key Pair [${keyPairName}].`);
      } else {
        console.warn(`[teardown] Không xóa được Key Pair [${keyPairName}]: ${keyDelRes.status}`);
      }
    } catch (err) {
      console.warn(`[teardown] Lỗi khi xóa Key Pair [${keyPairName}]: ${err.message}`);
    }
  }

  // 5. Xóa file state.json nếu an toàn
  try {
    fs.unlinkSync(STATE_FILE);
    console.log('[teardown] Đã xóa file state.json phiên làm việc.');
  } catch {
    // bỏ qua nếu file đã bị xóa
  }

  console.log('[teardown] Hoàn tất dọn dẹp môi trường test e2e.');
}

module.exports = teardown;

if (require.main === module) {
  teardown().catch(err => {
    console.error('[teardown] Lỗi nghiêm trọng:', err);
    process.exit(1);
  });
}
