/* 포인트 상점 서버 v2.1.0
   - 포인트·구매 검증은 전부 서버에서 합니다 (브라우저에서 조작 불가)
   - 데이터는 Firebase Firestore에 영구 보존되며, 미설정 시 로컬 data.json 에 저장됩니다 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const PRODUCTS = require('./products');

const VERSION = '2.1.0';
const PORT = process.env.PORT || 3000;
const SHOP_NAME = process.env.SHOP_NAME || '작은 상점';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

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
    const app = initializeApp({ credential: cert(serviceAccount) });
    const fsDb = getFirestore(app);
    firestoreDoc = fsDb.collection('point_shop').doc('state');
    console.log('✔ Firebase Firestore 연동 성공 (영구 보존 활성화)');
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
      const snap = await firestoreDoc.get();
      if (snap.exists) {
        const d = snap.data();
        db = { members: d.members || {}, history: d.history || [], sold: d.sold || {}, products: d.products || [] };
        ensureDefaults();
        console.log(`✔ Firebase에서 데이터를 불러왔습니다. (회원 ${Object.keys(db.members).length}명, 상품 ${db.products.length}종, 내역 ${db.history.length}건)`);
        return;
      } else {
        db = loadLocal();
        ensureDefaults();
        await firestoreDoc.set(db);
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

function save() {
  // 1. 로컬 파일 백업
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {}

  // 2. Firebase Firestore 비동기 저장
  if (firestoreDoc) {
    firestoreDoc.set(db).catch(err => {
      console.error('⚠ Firebase 저장 중 오류 발생:', err.message);
    });
  }
}
const uid = () => 'm' + crypto.randomBytes(5).toString('hex');
const nowStr = () => new Date().toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
function log(m, type, amount, detail) {
  const item = {
    id: 'h' + crypto.randomBytes(6).toString('hex'),
    t: nowStr(),
    mid: m.id,
    name: m.name,
    type,
    amount,
    detail,
    balance: m.points,
  };
  if (type === '구매') item.status = 'pending';
  db.history.unshift(item);
  if (db.history.length > 2000) db.history.length = 2000;
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
app.use(express.static(path.join(__dirname, 'public')));
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
  log(m, '구매', -total, detail);
  save();
  res.json({ ok: true, detail, member: publicMember(m), products: publicProducts() });
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
  res.json({
    members: Object.values(db.members),
    history: db.history.slice(0, 500),
    products: allProducts().map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      desc: p.desc || '',
      img: p.img || '',
      stock: p.stock == null ? null : p.stock,
      sold: db.sold[p.id] || 0,
      remain: remain(p)
    })),
  });
});
app.post('/api/admin/products', auth('admin'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const price = parseInt(b.price);
  if (!name) return bad(res, '상품명을 입력하세요.');
  if (isNaN(price) || price < 0) return bad(res, '가격을 0 이상 숫자로 입력하세요.');
  const stock = (b.stock === '' || b.stock === null || isNaN(parseInt(b.stock))) ? null : Math.max(0, parseInt(b.stock));
  const prod = {
    id: 'p' + crypto.randomBytes(4).toString('hex'),
    name,
    price,
    desc: String(b.desc || '').trim(),
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
    prod.name = name;
  }
  if (b.price !== undefined) {
    const price = parseInt(b.price);
    if (isNaN(price) || price < 0) return bad(res, '가격을 0 이상 숫자로 입력하세요.');
    prod.price = price;
  }
  if (b.desc !== undefined) prod.desc = String(b.desc || '').trim();
  if (b.stock !== undefined) {
    prod.stock = (b.stock === '' || b.stock === null || isNaN(parseInt(b.stock))) ? null : Math.max(0, parseInt(b.stock));
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
  h.status = h.status === 'done' ? 'pending' : 'done';
  save();
  res.json({ ok: true, status: h.status });
});
app.post('/api/admin/members', auth('admin'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const pt = parseInt(b.points) || 0;
  let code = String(b.code || '').trim();
  if (!name) return bad(res, '이름을 입력하세요.');
  if (name.length > 20) return bad(res, '이름은 20자 이하로 해주세요.');
  if (pt < 0 || pt > 1e9) return bad(res, '포인트 범위가 올바르지 않아요.');
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
  const v = parseInt((req.body || {}).value);
  if (isNaN(v) || v < 0 || v > 1e9) return bad(res, '0 이상의 숫자를 입력하세요.');
  if (mode === 'add') { m.points += v; log(m, '지급', v, '관리자 지급'); }
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
  if (code.length < 4) return bad(res, '확인 코드는 4자 이상이어야 해요.');
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
  if (!d.members || typeof d.members !== 'object' || !Array.isArray(d.history)) return bad(res, '올바른 백업 파일이 아닙니다.');
  db = { members: d.members, history: d.history, sold: d.sold || {} };
  sessions.forEach((s, k) => { if (s.role === 'member') sessions.delete(k); });
  save();
  res.json({ ok: true });
});
app.post('/api/admin/reset', auth('admin'), (req, res) => {
  db = { members: {}, history: [], sold: {} };
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
