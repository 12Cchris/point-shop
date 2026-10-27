/* 포인트 상점 서버 v2.1.0
   - 포인트·구매 검증은 전부 서버에서 합니다 (브라우저에서 조작 불가)
   - 데이터는 Firebase Firestore에 저장되며, 미설정 시 로컬 data.json 에 저장됩니다 */
const express = require('./lib/http-app');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FirestoreClient } = require('./lib/firestore');
const PRODUCTS = require('./products');

const VERSION = '2.1.0';
const PORT = process.env.PORT || 3000;
const SHOP_NAME = process.env.SHOP_NAME || '작은 상점';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (process.env.RENDER_EXTERNAL_URL && !process.env.ADMIN_PIN) {
  console.error('✖ Render에서 ADMIN_PIN 환경변수를 설정해야 서버를 시작할 수 있습니다.');
  process.exit(1);
}

if (ADMIN_PIN === '1234') {
  console.warn('⚠ 관리자 비밀번호가 기본값(1234)입니다. 환경변수 ADMIN_PIN 으로 꼭 바꿔주세요.');
}
if (ADMIN_SECRET) {
  console.log('🔒 관리자 2단계 보안(ADMIN_SECRET) 활성화');
}

/* ---------- Firebase 초기화 ---------- */
let firestoreDoc = null;
try {
  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    // 일반 JSON 또는 base64 인코딩 지원
    const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    serviceAccount = JSON.parse(jsonStr);
  } else {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      serviceAccount = require(keyPath);
    }
  }

  if (serviceAccount) {
    firestoreDoc = new FirestoreClient(serviceAccount);
    console.log('✔ Firebase Firestore 연동 성공 (클라우드 저장 활성화)');
  } else {
    console.log('ℹ Firebase 인증 정보가 없어 로컬 파일(data.json) 모드로 동작합니다.');
  }
} catch (err) {
  console.error('⚠ Firebase 초기화 실패 (로컬 모드로 대체):', err.message);
}

/* ---------- 데이터 로드 / 저장 ---------- */
let db = { members: {}, history: [], sold: {}, products: [] };

function loadLocal() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (d && d.members) return { members: d.members, history: d.history || [], sold: d.sold || {}, products: d.products || [] };
  } catch (e) {}
  return { members: {}, history: [], sold: {}, products: [] };
}

function ensureDefaults() {
  if (!Array.isArray(db.products) || !db.products.length) {
    db.products = PRODUCTS.map(p => ({ ...p }));
  }
  // 기존 히스토리에 id 및 status 기본값 보장
  (db.history || []).forEach(h => {
    if (!h.id) h.id = 'h' + crypto.randomBytes(6).toString('hex');
    if (h.type === '구매' && !h.status) h.status = 'pending';
  });
}

async function initData() {
  if (firestoreDoc) {
    try {
      const d = await firestoreDoc.get('point_shop', 'state');
      if (d && (d.members || d.history || d.sold || d.products)) {
        db = { members: d.members || {}, history: d.history || [], sold: d.sold || {}, products: d.products || [] };
        ensureDefaults();
        console.log(`✔ Firebase에서 데이터를 불러왔습니다. (회원 ${Object.keys(db.members).length}명, 상품 ${db.products.length}종, 내역 ${db.history.length}건)`);
        return;
      } else {
        db = loadLocal();
        ensureDefaults();
        await firestoreDoc.set(db, 'point_shop', 'state');
        console.log('✔ 로컬 데이터를 Firebase에 최초 동기화했습니다.');
        return;
      }
    } catch (err) {
      console.error('⚠ Firebase 데이터 로드 실패, 로컬 데이터를 사용합니다:', err.message);
    }
  }
  db = loadLocal();
  ensureDefaults();
}

let saveTimer = null;
async function performSave() {
  // 1. 로컬 파일 백업 (비동기 atomic 쓰기)
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(db));
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (e) {
    console.error('⚠ 로컬 데이터 저장 실패:', e.message);
  }

  // 2. Firebase Firestore 비동기 저장
  if (firestoreDoc) {
    firestoreDoc.set(db, 'point_shop', 'state').catch(err => {
      console.error('⚠ Firebase 저장 중 오류 발생:', err.message);
    });
  }
}

function save() {
  // 잦은 호출 시 디바운싱(50ms)으로 파일 I/O 및 네트워크 부하 최소화
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      performSave();
    }, 50);
  }
}

// 프로세스 종료 시 미저장 데이터 안전 보장
async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await performSave();
  }
}
process.on('SIGINT', async () => { await flushSave(); process.exit(0); });
process.on('SIGTERM', async () => { await flushSave(); process.exit(0); });
const uid = () => 'm' + crypto.randomBytes(5).toString('hex');
const nowStr = () => new Date().toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
function log(m, type, amount, detail, extra = {}) {
  const item = {
    id: 'h' + crypto.randomBytes(6).toString('hex'),
    t: nowStr(),
    mid: m.id,
    name: m.name,
    type,
    amount,
    detail,
    balance: m.points,
    ...extra,
  };
  if (type === '구매' && !item.status) item.status = 'pending';
  db.history.unshift(item);
  if (db.history.length > 2000) db.history.length = 2000;
  return item;
}
const allProducts = () => db.products || PRODUCTS;
const remain = p => (p.stock == null ? null : Math.max(0, p.stock - (db.sold[p.id] || 0)));
const publicProducts = () => allProducts().map(p => ({
  id: p.id, name: p.name, price: p.price, desc: p.desc || '', img: p.img || '', remain: remain(p), stock: p.stock,
}));
const publicMember = m => ({ id: m.id, name: m.name, points: m.points });

/* ---------- 세션 / 로그인 제한 ---------- */
const sessions = new Map();   // token -> { role, mid, exp }
const TTL = { member: 30 * 60 * 1000, admin: 2 * 60 * 60 * 1000 };
function newSession(role, mid) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, mid, exp: Date.now() + TTL[role] });
  return token;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, s] of sessions) if (s.exp < t) sessions.delete(k);
}, 60 * 1000).unref();

const fails = new Map();      // ip -> { n, until }
function locked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function fail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 8) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
  fails.set(ip, f);
}
// 메모리 누수 방지: 5분마다 만료된 실패 기록 청소
setInterval(() => {
  const t = Date.now();
  for (const [ip, f] of fails) {
    if (f.until <= t) fails.delete(ip);
  }
}, 5 * 60 * 1000).unref();

const same = (a, b) => {
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

function auth(role) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const s = sessions.get(token);
    if (!s || s.exp < Date.now() || s.role !== role) return res.status(401).json({ error: '로그인이 필요합니다.' });
    s.exp = Date.now() + TTL[role];
    req.session = s;
    next();
  };
}

/* ---------- 앱 ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

app.get('/api/info', (req, res) => res.json({ name: SHOP_NAME, version: VERSION, requireSecret: Boolean(ADMIN_SECRET) }));
app.get('/api/products', (req, res) => res.json(publicProducts()));

/* 회원 */
app.post('/api/login', (req, res) => {
  if (locked(req.ip)) return bad(res, '시도가 너무 많아요. 5분 뒤에 다시 해주세요.', 429);
  const name = String((req.body || {}).name || '').trim();
  const code = String((req.body || {}).code || '');
  const m = Object.values(db.members).find(x => x.name === name);
  if (!m || !same(m.code, code)) { fail(req.ip); return bad(res, '이름 또는 확인 코드가 맞지 않습니다.', 401); }
  res.json({ token: newSession('member', m.id), member: publicMember(m) });
});
app.post('/api/logout', (req, res) => {
  sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (sessions.get(token)?.role === 'admin') sessions.delete(token);
  res.json({ ok: true });
});
app.get('/api/me', auth('member'), (req, res) => {
  const m = db.members[req.session.mid];
  if (!m) return bad(res, '회원 정보가 없습니다.', 401);
  const mine = db.history.filter(h => h.mid === m.id && h.type === '구매').slice(0, 10);
  res.json({ member: publicMember(m), history: mine, products: publicProducts() });
});
app.post('/api/buy', auth('member'), (req, res) => {
  const m = db.members[req.session.mid];
  if (!m) return bad(res, '회원 정보가 없습니다.', 401);
  const items = (req.body || {}).items;
  if (!items || typeof items !== 'object') return bad(res, '장바구니가 비어 있어요.');
  let total = 0;
  const lines = [];
  for (const [id, q] of Object.entries(items)) {
    const p = allProducts().find(x => x.id === id);
    const n = Number(q);
    if (!p || !Number.isInteger(n) || n < 1 || n > 99) return bad(res, '잘못된 상품입니다.');
    const r = remain(p);
    if (r !== null && n > r) return bad(res, `${p.name}의 남은 수량이 부족해요.`);
    total += p.price * n;
    lines.push({ p, n });
  }
  if (!lines.length) return bad(res, '장바구니가 비어 있어요.');
  if (m.points < total) return bad(res, `포인트가 ${total - m.points} P 모자라요.`);
  lines.forEach(({ p, n }) => { db.sold[p.id] = (db.sold[p.id] || 0) + n; });
  m.points -= total;
  const detail = lines.map(({ p, n }) => `${p.name} ×${n}`).join(', ');
  log(m, '구매', -total, detail, { items: { ...items } });
  save();
  res.json({ ok: true, detail, member: publicMember(m), products: publicProducts() });
});

/* 회원 환불 요청 */
app.post('/api/refund-request', auth('member'), (req, res) => {
  const { historyId } = req.body || {};
  const h = db.history.find(x => x.id === historyId);
  if (!h) return bad(res, '구매 내역을 찾을 수 없습니다.', 404);
  if (h.mid !== req.session.mid) return bad(res, '본인의 구매 내역만 환불 요청할 수 있습니다.', 403);
  if (h.type !== '구매') return bad(res, '구매 내역만 환불 요청이 가능합니다.');
  if (h.status === 'refunded') return bad(res, '이미 환불 완료된 내역입니다.');
  if (h.status === 'refund_pending') return bad(res, '이미 환불 요청되어 관리자 승인 대기 중입니다.');
  if (h.status && h.status !== 'pending') return bad(res, '지급 대기 중인 구매만 환불 요청할 수 있습니다.');

  h.status = 'refund_pending';
  save();
  res.json({ ok: true, status: 'refund_pending' });
});

/* 관리자 */
app.post('/api/admin/login', (req, res) => {
  if (locked(req.ip)) return bad(res, '시도가 너무 많아요. 5분 뒤에 다시 해주세요.', 429);
  const b = req.body || {};
  const pin = String(b.pin || '');
  const secret = String(b.secret || '').trim();

  const pinOk = same(ADMIN_PIN, pin);
  const secretOk = !ADMIN_SECRET || same(ADMIN_SECRET, secret);

  if (!pinOk || !secretOk) {
    fail(req.ip);
    return bad(res, '비밀번호 또는 보안 시크릿 키가 맞지 않습니다.', 401);
  }
  res.json({ token: newSession('admin') });
});
app.get('/api/admin/state', auth('admin'), (req, res) => {
  const members = db.members && typeof db.members === 'object' && !Array.isArray(db.members) ? Object.values(db.members) : [];
  const history = Array.isArray(db.history) ? db.history : [];
  const sold = db.sold && typeof db.sold === 'object' ? db.sold : {};
  const products = Array.isArray(allProducts()) ? allProducts().filter(p => p && typeof p === 'object' && !Array.isArray(p)) : [];
  if (members.length !== Object.keys(db.members || {}).length || history !== db.history || sold !== db.sold || products.length !== (Array.isArray(allProducts()) ? allProducts().length : 0)) {
    console.error('[DATA] Invalid state shape while building /api/admin/state; returning only valid entries.');
  }
  res.json({
    members,
    history: history.slice(0, 500),
    products: products.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      desc: p.desc || '',
      img: p.img || '',
      stock: p.stock == null ? null : p.stock,
      sold: sold[p.id] || 0,
      remain: p.stock == null ? null : Math.max(0, p.stock - (sold[p.id] || 0))
    })),
  });
});
app.post('/api/admin/products', auth('admin'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const price = b.price === '' || b.price === null || b.price === undefined ? NaN : Number(b.price);
  if (!name) return bad(res, '상품명을 입력하세요.');
  if (name.length > 100) return bad(res, '상품명은 100자 이하로 입력하세요.');
  if (!Number.isSafeInteger(price) || price < 0 || price > 1e9) return bad(res, '가격은 0 이상 10억 이하의 정수로 입력하세요.');
  const desc = String(b.desc || '').trim();
  if (desc.length > 500) return bad(res, '상품 설명은 500자 이하로 입력하세요.');
  const stock = b.stock === '' || b.stock === null || b.stock === undefined ? null : Number(b.stock);
  if (stock !== null && (!Number.isSafeInteger(stock) || stock < 0 || stock > 1e9)) return bad(res, '재고는 0 이상 10억 이하의 정수로 입력하세요.');
  const prod = {
    id: 'p' + crypto.randomBytes(4).toString('hex'),
    name,
    price,
    desc,
    stock,
    img: String(b.img || '').trim(),
  };
  if (!Array.isArray(db.products)) db.products = [];
  db.products.push(prod);
  save();
  res.json({ ok: true, product: prod });
});
app.put('/api/admin/products/:id', auth('admin'), (req, res) => {
  const prod = allProducts().find(p => p.id === req.params.id);
  if (!prod) return bad(res, '상품을 찾을 수 없습니다.', 404);
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) return bad(res, '상품명을 입력하세요.');
    if (name.length > 100) return bad(res, '상품명은 100자 이하로 입력하세요.');
    prod.name = name;
  }
  if (b.price !== undefined) {
    const price = b.price === '' || b.price === null ? NaN : Number(b.price);
    if (!Number.isSafeInteger(price) || price < 0 || price > 1e9) return bad(res, '가격은 0 이상 10억 이하의 정수로 입력하세요.');
    prod.price = price;
  }
  if (b.desc !== undefined) {
    const desc = String(b.desc || '').trim();
    if (desc.length > 500) return bad(res, '상품 설명은 500자 이하로 입력하세요.');
    prod.desc = desc;
  }
  if (b.stock !== undefined) {
    if (b.stock === '' || b.stock === null) prod.stock = null;
    else {
      const stock = Number(b.stock);
      if (!Number.isSafeInteger(stock) || stock < 0 || stock > 1e9) return bad(res, '재고는 0 이상 10억 이하의 정수로 입력하세요.');
      prod.stock = stock;
    }
  }
  if (b.img !== undefined) prod.img = String(b.img || '').trim();
  save();
  res.json({ ok: true, product: prod });
});
app.delete('/api/admin/products/:id', auth('admin'), (req, res) => {
  if (!Array.isArray(db.products)) db.products = [];
  db.products = db.products.filter(p => p.id !== req.params.id);
  save();
  res.json({ ok: true });
});
app.post('/api/admin/history/:id/status', auth('admin'), (req, res) => {
  const h = db.history.find(x => x.id === req.params.id);
  if (!h) return bad(res, '내역을 찾을 수 없습니다.', 404);
  if (h.type !== '구매' || h.status === 'refunded' || h.status === 'refund_pending') return bad(res, '이 내역의 지급 상태를 변경할 수 없습니다.');
  h.status = h.status === 'done' ? 'pending' : 'done';
  save();
  res.json({ ok: true, status: h.status });
});
app.post('/api/admin/history/:id/refund-approve', auth('admin'), (req, res) => {
  const h = db.history.find(x => x.id === req.params.id);
  if (!h) return bad(res, '내역을 찾을 수 없습니다.', 404);
  if (h.status === 'refunded') return bad(res, '이미 환불 처리된 건입니다.');
  if (h.type !== '구매' || ![undefined, 'pending', 'refund_pending'].includes(h.status)) return bad(res, '환불 가능한 구매 내역이 아닙니다.');

  const refundAmount = Math.abs(h.amount);
  if (!Number.isSafeInteger(refundAmount) || refundAmount < 0) return bad(res, '환불 금액이 올바르지 않습니다.');
  const m = db.members[h.mid];
  if (m) {
    m.points += refundAmount;
  }

  // 재고 복구
  if (h.items && typeof h.items === 'object') {
    for (const [pid, q] of Object.entries(h.items)) {
      if (db.sold[pid]) {
        db.sold[pid] = Math.max(0, db.sold[pid] - q);
      }
    }
  }

  h.status = 'refunded';
  if (m) {
    log(m, '환불', refundAmount, `환불 완료 (${h.detail})`);
  }
  save();
  res.json({ ok: true, member: m ? publicMember(m) : null });
});
app.post('/api/admin/history/:id/refund-reject', auth('admin'), (req, res) => {
  const h = db.history.find(x => x.id === req.params.id);
  if (!h) return bad(res, '내역을 찾을 수 없습니다.', 404);
  if (h.status !== 'refund_pending') return bad(res, '환불 대기 상태가 아닙니다.');

  h.status = 'pending'; // 다시 지급 대기 상태로 복귀
  save();
  res.json({ ok: true, status: 'pending' });
});
app.post('/api/admin/members', auth('admin'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const pt = b.points === '' || b.points === null || b.points === undefined ? 0 : Number(b.points);
  let code = String(b.code || '').trim();
  if (!name) return bad(res, '이름을 입력하세요.');
  if (name.length > 20) return bad(res, '이름은 20자 이하로 해주세요.');
  if (!Number.isSafeInteger(pt) || pt < 0 || pt > 1e9) return bad(res, '포인트는 0 이상 10억 이하의 정수로 입력하세요.');
  if (code && (code.length < 4 || code.length > 64)) return bad(res, '확인 코드는 4자 이상 64자 이하로 입력하세요.');
  if (Object.values(db.members).some(m => m.name === name)) return bad(res, '이미 있는 이름입니다.');
  if (!code) code = String(crypto.randomInt(1000, 10000));
  const m = { id: uid(), name, points: pt, code };
  db.members[m.id] = m;
  if (pt > 0) log(m, '지급', pt, '최초 등록');
  save();
  res.json({ ok: true, member: m });
});
app.post('/api/admin/members/:id/points', auth('admin'), (req, res) => {
  const m = db.members[req.params.id];
  if (!m) return bad(res, '회원을 찾을 수 없어요.', 404);
  const { mode } = req.body || {};
  const rawValue = (req.body || {}).value;
  const v = rawValue === '' || rawValue === null || rawValue === undefined ? NaN : Number(rawValue);
  if (!Number.isSafeInteger(v) || v < 0 || v > 1e9) return bad(res, '0 이상 10억 이하의 정수를 입력하세요.');
  if (mode === 'add') {
    if (m.points + v > 1e9) return bad(res, '회원 포인트는 최대 10억 P까지 설정할 수 있어요.');
    m.points += v; log(m, '지급', v, '관리자 지급');
  }
  else if (mode === 'sub') {
    if (v > m.points) return bad(res, '보유 포인트보다 많이 차감할 수 없어요.');
    m.points -= v; log(m, '차감', -v, '관리자 차감');
  } else if (mode === 'set') {
    const d = v - m.points; m.points = v; log(m, '설정', d, `${v.toLocaleString('ko-KR')} P로 설정`);
  } else return bad(res, '잘못된 요청입니다.');
  save();
  res.json({ ok: true, member: m });
});
app.post('/api/admin/members/:id/code', auth('admin'), (req, res) => {
  const m = db.members[req.params.id];
  if (!m) return bad(res, '회원을 찾을 수 없어요.', 404);
  const code = String((req.body || {}).code || '').trim();
  if (code.length < 4 || code.length > 64) return bad(res, '확인 코드는 4자 이상 64자 이하로 입력하세요.');
  m.code = code;
  for (const [k, s] of sessions) if (s.mid === m.id) sessions.delete(k);
  save();
  res.json({ ok: true });
});
app.delete('/api/admin/members/:id', auth('admin'), (req, res) => {
  const m = db.members[req.params.id];
  if (!m) return bad(res, '회원을 찾을 수 없어요.', 404);
  delete db.members[m.id];
  for (const [k, s] of sessions) if (s.mid === m.id) sessions.delete(k);
  save();
  res.json({ ok: true });
});
app.get('/api/admin/export', auth('admin'), (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="point-shop-backup.json"');
  res.json(db);
});
app.post('/api/admin/import', auth('admin'), (req, res) => {
  const d = req.body || {};
  if (!d.members || typeof d.members !== 'object' || Array.isArray(d.members) || !Array.isArray(d.history)) return bad(res, '올바른 백업 파일이 아닙니다.');
  const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validMembers = Object.entries(d.members).every(([id, m]) => isRecord(m)
    && /^m[0-9a-f]{10}$/.test(id) && m.id === id && typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 20
    && Number.isSafeInteger(m.points) && m.points >= 0 && m.points <= 1e9
    && typeof m.code === 'string' && m.code.length >= 4 && m.code.length <= 64);
  if (!validMembers) return bad(res, '회원 데이터 형식이 올바르지 않습니다.');
  if (!d.history.every(h => isRecord(h) && typeof h.type === 'string'
    && (h.id === undefined || (typeof h.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(h.id))))) return bad(res, '내역 데이터 형식이 올바르지 않습니다.');
  if (d.sold !== undefined && (!d.sold || typeof d.sold !== 'object' || Array.isArray(d.sold))) return bad(res, '판매 데이터 형식이 올바르지 않습니다.');
  if (d.sold && !Object.values(d.sold).every(v => Number.isSafeInteger(v) && v >= 0)) return bad(res, '판매 수량 형식이 올바르지 않습니다.');
  if (d.products !== undefined && (!Array.isArray(d.products) || d.products.some(p => !isRecord(p)
    || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id)
    || typeof p.name !== 'string' || !p.name.length || p.name.length > 100
    || !Number.isSafeInteger(p.price) || p.price < 0 || p.price > 1e9
    || (p.stock != null && (!Number.isSafeInteger(p.stock) || p.stock < 0 || p.stock > 1e9))))) return bad(res, '상품 데이터 형식이 올바르지 않습니다.');
  db = {
    members: d.members,
    history: d.history,
    sold: d.sold || {},
    products: Array.isArray(d.products) ? d.products : PRODUCTS.map(p => ({ ...p }))
  };
  sessions.forEach((s, k) => { if (s.role === 'member') sessions.delete(k); });
  save();
  res.json({ ok: true });
});
app.post('/api/admin/reset', auth('admin'), (req, res) => {
  db = { members: {}, history: [], sold: {}, products: Array.isArray(db.products) ? db.products : PRODUCTS.map(p => ({ ...p })) };
  sessions.forEach((s, k) => { if (s.role === 'member') sessions.delete(k); });
  save();
  res.json({ ok: true });
});

initData().then(() => {
  app.listen(PORT, () => {
    console.log(`포인트 상점 v${VERSION} → http://localhost:${PORT}`);
    // Render 무료 플랜 슬립 방지 (RENDER_EXTERNAL_URL 또는 APP_URL 설정 시 13분 주기 self-ping)
    const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
    if (APP_URL) {
      const pingUrl = APP_URL.replace(/\/+$/, '') + '/api/info';
      setInterval(() => {
        fetch(pingUrl).catch(() => {});
      }, 13 * 60 * 1000).unref();
      console.log(`✔ 자동 슬립 방지 활성화: 13분 주기 (${pingUrl})`);
    }
  });
});
