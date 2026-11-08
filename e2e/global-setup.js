// Chuẩn bị trước khi chạy test (Playwright globalSetup).
//
// Từ PR #28/#29, tạo / sửa / dừng máy ảo gửi sự kiện lên AWS API Gateway -> EventBridge -> Step Function
// (tạo máy thật trên OpenStack). Bộ test KHÔNG được chạm vào hạ tầng thật, nên ở đây:
//   1. Kiểm tra app đang dùng DynamoDB Local (E2E_DYNAMODB_ENDPOINT, mặc định http://localhost:8000).
//   2. Bật "Step Function giả" ở cổng 9999: nhận sự kiện của app, khi có instance.launch thì ghi máy vào
//      bảng XRegion-Nova với trạng thái ACTIVE (giống bước SyncDynamoDB thật) để máy lên RUNNING.
//   3. Kiểm tra app gửi sự kiện tới Step Function giả chứ không phải AWS thật.
// Sai một trong các bước trên thì dừng NGAY, không chạy bài test nào.
const http = require('http');

const DDB = process.env.E2E_DYNAMODB_ENDPOINT || 'http://localhost:8000';
const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT || 9999);
const BASE_URL = process.env.BASE_URL || 'http://localhost:8081';
// bcrypt của mật khẩu "E2eProbe!2026" (tài khoản kiểm tra, chỉ ghi vào DynamoDB Local)
const PROBE_HASH = '$2b$10$cUlZLEqhyQv7kMcMPkVPmep7V2CC9PFvc9EVzOz1jkUy7R7chn7g6';
const PROBE_PASSWORD = 'E2eProbe!2026';

function stop(msg) {
  throw new Error(`\n\n[e2e] DỪNG, chưa chạy bài test nào: ${msg}\n` +
    '      Xem mục "Chạy app cho e2e" trong e2e/README.md.\n');
}

let ddbKey = process.env.E2E_DYNAMODB_KEY || 'dummylocalkey';

/** Gọi API DynamoDB Local (không ký thật: DynamoDB Local không kiểm chữ ký). */
async function ddb(op, body, key = ddbKey) {
  const res = await fetch(DDB, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': `DynamoDB_20120810.${op}`,
      Authorization: `AWS4-HMAC-SHA256 Credential=${key}/20260101/ap-southeast-2/dynamodb/aws4_request, SignedHeaders=host, Signature=00`
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${op}: ${json.message || json.__type || res.status}`);
  return json;
}

/** Chọn access key để thấy đúng bộ bảng của app (DynamoDB Local không có -sharedDb thì mỗi key một bộ bảng). */
async function pickKey() {
  const candidates = [process.env.E2E_DYNAMODB_KEY, 'dummylocalkey', 'dummy_local_key', 'mock-local-key'].filter(Boolean);
  for (const k of candidates) {
    try {
      const { TableNames = [] } = await ddb('ListTables', {}, k);
      if (TableNames.includes('XRegion-Users')) return k;
    } catch { /* thử key khác */ }
  }
  return candidates[0];
}

const S = v => ({ S: String(v) });
const TABLES = [
  { TableName: 'XRegion-Users', keys: [['user_id', 'HASH']], gsi: [['username-index', 'username']] },
  { TableName: 'XRegion-Instances', keys: [['instance_id', 'HASH']] },
  { TableName: 'XRegion-Migrations', keys: [['instance_id', 'HASH'], ['migration_id', 'RANGE']] },
  { TableName: 'XRegion-Nova', keys: [['nova_id', 'HASH']], gsi: [['instance_id-index', 'instance_id']] }
];

/** Bản main mới không tự tạo bảng nữa: tạo các bảng còn thiếu trong DynamoDB Local. */
async function ensureTables() {
  const { TableNames = [] } = await ddb('ListTables', {});
  for (const t of TABLES) {
    if (TableNames.includes(t.TableName)) continue;
    const attrs = new Set([...t.keys.map(k => k[0]), ...(t.gsi || []).map(g => g[1])]);
    await ddb('CreateTable', {
      TableName: t.TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [...attrs].map(a => ({ AttributeName: a, AttributeType: 'S' })),
      KeySchema: t.keys.map(([AttributeName, KeyType]) => ({ AttributeName, KeyType })),
      ...(t.gsi ? {
        GlobalSecondaryIndexes: t.gsi.map(([IndexName, attr]) => ({
          IndexName, KeySchema: [{ AttributeName: attr, KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' }
        }))
      } : {})
    });
    console.log(`[e2e] Tạo bảng ${t.TableName} trong DynamoDB Local`);
  }
}

/** "Step Function giả": trả lời như API Gateway, máy được launch thì ghi XRegion-Nova = ACTIVE. */
function startFakeGateway(events) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/__events') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(events));
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* bỏ qua */ }
      const type = body['detail-type'] || body.detailType || body.DetailType;
      const d = body.detail || body.Detail || {};
      events.push({ type, detail: d, at: Date.now() });
      try {
        if (type === 'instance.launch' && d.instance_id) {
          const n = Math.floor(Math.random() * 200) + 20;
          await ddb('PutItem', {
            TableName: 'XRegion-Nova',
            Item: {
              nova_id: S(`nova-${d.instance_id}`),
              instance_id: S(d.instance_id),
              instance_name: S(d.instance_name),
              status: S('ACTIVE'),
              region: S(d.region || d.target_region || 'ap-southeast-2'),
              flavor: S(d.flavor || d.flavor_name || 'm1.small'),
              private_ip: S(`10.0.1.${n}`),
              elastic_ip: S(`3.27.${n}.${(n * 7) % 250 + 1}`),
              volume_id: S(`vol-${d.instance_id.slice(2, 10)}`),
              key_id: S(d.key_id || 'xregion-key'),
              security_group_id: S(d.instance_id),
              created_at: { N: String(Math.floor(Date.now() / 1000)) }
            }
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ FailedEntryCount: 0, Entries: [{ EventId: `e2e-${events.length}` }] }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', e => reject(e.code === 'EADDRINUSE'
      ? new Error(`Cổng ${GATEWAY_PORT} đang bị chiếm (lần chạy trước chưa tắt?)`) : e));
    server.listen(GATEWAY_PORT, '0.0.0.0', () => resolve(server));
  });
}

module.exports = async () => {
  // 1. App có chạy không
  try {
    await fetch(`${BASE_URL}/login.html`);
  } catch {
    stop(`không mở được ${BASE_URL}. Hãy chạy app trước.`);
  }

  // 2. DynamoDB Local có chạy không, tạo bảng còn thiếu
  try {
    ddbKey = await pickKey();
    await ensureTables();
  } catch (e) {
    stop(`không kết nối được DynamoDB Local ở ${DDB} (${e.message}).`);
  }

  // 3. App có đọc đúng DynamoDB Local đó không: ghi một tài khoản thẳng vào Local rồi đăng nhập qua app.
  //    App đang nối AWS thật thì không thấy tài khoản này -> dừng, không ghi gì lên AWS.
  const probeName = `e2eprobe${Date.now().toString(36)}`;
  const probeUserId = `usr-${probeName}`;
  await ddb('PutItem', {
    TableName: 'XRegion-Users',
    Item: {
      user_id: S(probeUserId), username: S(probeName), password: S(PROBE_HASH), full_name: S('E2E Probe'),
      role: S('ROLE_USER'), active: { BOOL: true }, created_at: { N: String(Date.now()) }
    }
  });
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: probeName, password: PROBE_PASSWORD })
  });
  if (!login.ok) {
    stop(`app ở ${BASE_URL} KHÔNG dùng DynamoDB Local ${DDB} (có thể đang nối bảng DynamoDB thật trên AWS).`);
  }
  const token = (await login.json()).data.token;

  // 4. Bật Step Function giả rồi kiểm tra app gửi sự kiện tới đây: sửa tên một máy chỉ có trong Local
  //    (app gửi sự kiện MODIFY). Máy này không tồn tại trên AWS nên dù lỡ gửi nhầm cũng không ảnh hưởng gì.
  const events = [];
  const server = await startFakeGateway(events);
  const probeVm = `i-e2e${Date.now().toString(36).slice(-5)}`;
  await ddb('PutItem', {
    TableName: 'XRegion-Instances',
    Item: { instance_id: S(probeVm), user_id: S(probeUserId), current_status: S('STOPPED') }
  });
  await fetch(`${BASE_URL}/api/instances/${probeVm}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'e2e-probe', flavor: 'm1.medium' })
  }).catch(() => null);
  const deadline = Date.now() + 5000;
  while (!events.some(e => e.detail && e.detail.instance_id === probeVm) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  await ddb('DeleteItem', { TableName: 'XRegion-Instances', Key: { instance_id: S(probeVm) } }).catch(() => {});
  await ddb('DeleteItem', { TableName: 'XRegion-Users', Key: { user_id: S(probeUserId) } }).catch(() => {});
  if (!events.some(e => e.detail && e.detail.instance_id === probeVm)) {
    server.close();
    stop(`app không gửi sự kiện tới Step Function giả ở cổng ${GATEWAY_PORT}. ` +
      'Có thể app đang gửi lên API Gateway thật trên AWS (tạo máy ảo thật!).');
  }
  events.length = 0;
  console.log(`[e2e] OK: app dùng DynamoDB Local ${DDB} và Step Function giả ở cổng ${GATEWAY_PORT}.`);

  return async () => { server.close(); };
};
