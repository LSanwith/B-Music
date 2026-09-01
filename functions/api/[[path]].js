/* Cloudflare Pages Function：账号 + 数据同步 API（KV 持久化）
 * 路由：/api/register /api/login /api/logout /api/account/delete /api/data /api/captcha
 *
 * 部署要求：
 *  1. 在 Cloudflare 控制台创建 KV 命名空间（如 bmusic-db），并在 Pages 项目
 *     设置 → 绑定 中绑定为变量名 DB（绑定类型：KV）；
 *  2. 可选 Secret：HONGYUN_KEY（红云点歌密钥，供 /proxy hk=1 注入）。
 * 数据全部存于 KV 的单个键 'db' 内；多账号数据按 userId 完全隔离。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

async function readBody(req) {
  const t = await req.text();
  try { return t ? JSON.parse(t) : {}; } catch (e) { throw new Error('bad json'); }
}

function hex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); }

/* PBKDF2 哈希（WebCrypto，Workers 无需额外兼容标志） */
async function hashPass(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(String(salt)), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return hex(new Uint8Array(bits));
}
function newToken() { return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''); }
function newSalt() { return hex(crypto.getRandomValues(new Uint8Array(16))); }

async function loadDb(env) {
  if (!env.DB) return { users: {}, sessions: {}, data: {}, captchas: {} };
  const raw = await env.DB.get('db', 'text');
  return raw ? JSON.parse(raw) : { users: {}, sessions: {}, data: {}, captchas: {} };
}
async function saveDb(env, db) {
  if (env.DB) await env.DB.put('db', JSON.stringify(db));
}
function authUser(db, req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const uid = db.sessions[m[1]];
  return uid ? db.users[uid] || null : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = await loadDb(env);
  try {
    /* 人机验证（滑块拼图）：一次一题，5 分钟有效 */
    if (path === '/api/captcha' && method === 'GET') {
      const target = 35 + Math.floor(Math.random() * 45);
      const id = newToken().slice(0, 16);
      db.captchas = db.captchas || {};
      db.captchas[id] = { target, exp: Date.now() + 5 * 60 * 1000, used: false };
      await saveDb(env, db);
      return json(200, { id, target });
    }
    /* 注册：滑动验证通过后直接注册并登录；同邮箱+正确密码 = 二次注册直接登录 */
    if (path === '/api/register' && method === 'POST') {
      const b = await readBody(request);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!EMAIL_RE.test(email)) return json(400, { msg: '邮箱格式不正确' });
      if (password.length < 6) return json(400, { msg: '密码至少 6 位' });
      const existing = Object.values(db.users).find(u => u.email === email);
      if (existing) {
        if ((await hashPass(password, existing.salt)) === existing.passHash) {
          const token = newToken();
          db.sessions[token] = existing.id;
          await saveDb(env, db);
          return json(200, { token, email, existing: true });
        }
        return json(409, { msg: '该邮箱已注册，密码不正确；请返回登录' });
      }
      const cp = db.captchas && db.captchas[String(b.captchaId || '')];
      const pos = Number(b.pos);
      const dur = Number(b.duration);
      if (!cp || cp.used || cp.exp < Date.now() ||
          !(pos >= 0 && pos <= 100) || Math.abs(pos - cp.target) > 6 ||
          !(dur >= 300 && dur <= 15000)) {
        return json(400, { msg: '请完成滑动验证' });
      }
      cp.used = true;
      const id = String(Object.keys(db.users).reduce((m, k) => Math.max(m, parseInt(k, 10) || 0), 0) + 1);
      const salt = newSalt();
      db.users[id] = { id, email, salt, passHash: await hashPass(password, salt), createdAt: Date.now() };
      db.data[id] = { settings: {}, favSongs: [], favPlaylists: [] };
      const token = newToken();
      db.sessions[token] = id;
      await saveDb(env, db);
      return json(200, { token, email });
    }
    if (path === '/api/login' && method === 'POST') {
      const b = await readBody(request);
      const email = String(b.email || '').trim().toLowerCase();
      const user = Object.values(db.users).find(u => u.email === email);
      if (!user || (await hashPass(String(b.password || ''), user.salt)) !== user.passHash) {
        return json(401, { msg: '邮箱或密码错误' });
      }
      const token = newToken();
      db.sessions[token] = user.id;
      await saveDb(env, db);
      return json(200, { token, email: user.email });
    }
    const user = authUser(db, request);
    if (!user) return json(401, { msg: '未登录或登录已过期' });
    if (path === '/api/logout' && method === 'POST') {
      const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') || '');
      if (m) delete db.sessions[m[1]];
      await saveDb(env, db);
      return json(200, { ok: true });
    }
    if (path === '/api/account/delete' && method === 'POST') {
      delete db.users[user.id];
      delete db.data[user.id];
      Object.keys(db.sessions).forEach(t => { if (db.sessions[t] === user.id) delete db.sessions[t]; });
      await saveDb(env, db);
      return json(200, { ok: true });
    }
    if (path === '/api/data') {
      if (method === 'GET') {
        const d = db.data[user.id] || { settings: {}, favSongs: [], favPlaylists: [] };
        return json(200, d);
      }
      if (method === 'POST') {
        const b = await readBody(request);
        const d = db.data[user.id] || {};
        if (b.settings && typeof b.settings === 'object') d.settings = b.settings;
        if (Array.isArray(b.favSongs)) d.favSongs = b.favSongs;
        if (Array.isArray(b.favPlaylists)) d.favPlaylists = b.favPlaylists;
        db.data[user.id] = d;
        await saveDb(env, db);
        return json(200, { ok: true });
      }
      return json(405, { msg: 'method not allowed' });
    }
  } catch (e) {
    return json(400, { msg: e.message || 'bad request' });
  }
  return json(405, { msg: 'method not allowed' });
}
