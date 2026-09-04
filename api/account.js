/* Vercel Serverless Function：账号 + 数据同步 API
 *
 * 路由由 vercel.json 显式 rewrite 映射（避免动态段文件名在 Vercel 上
 * 不可靠）：
 *   /api/captcha        → /api/account?r=captcha        (GET)
 *   /api/register       → /api/account?r=register       (POST)
 *   /api/login          → /api/account?r=login          (POST)
 *   /api/logout         → /api/account?r=logout         (POST)
 *   /api/account/delete → /api/account?r=delete         (POST)
 *   /api/data           → /api/account?r=data           (GET/POST)
 *
 * 持久化：
 *  - 推荐：Vercel KV（Redis）—— 控制台 Storage → KV → 创建并连接到本项目，
 *    会自动注入 KV_REST_API_URL / KV_REST_API_TOKEN 环境变量；
 *  - 未连接 KV 时退化为内存存储（冷启动/重启后数据不保证保留）。
 * Secret：HONGYUN_KEY（红云点歌密钥，供 /api/proxy 的 hk=1 注入，可选） */
import crypto from 'crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let MEM = null; // 内存兜底

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

async function loadDb() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const r = await fetch(process.env.KV_REST_API_URL + '/get/db', {
        headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
      });
      const j = await r.json();
      if (j && j.result) return JSON.parse(j.result);
    } catch (e) { /* 降级内存 */ }
  }
  return MEM || { users: {}, sessions: {}, data: {}, captchas: {} };
}
async function saveDb(db) {
  MEM = db;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      await fetch(process.env.KV_REST_API_URL + '/set/db', {
        method: 'POST',
        body: JSON.stringify(db),
        headers: {
          Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) { /* 内存兜底 */ }
  }
}
function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function authUser(db, req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const uid = db.sessions[m[1]];
  return uid ? db.users[uid] || null : null;
}

export default async function handler(req, res) {
  const r = String((req.query && req.query.r) || '');
  const method = req.method;
  const db = await loadDb();
  try {
    /* 人机验证（滑块拼图）：一次一题，5 分钟有效 */
    if (r === 'captcha' && method === 'GET') {
      const target = 35 + Math.floor(Math.random() * 45);
      const id = crypto.randomBytes(8).toString('hex');
      db.captchas = db.captchas || {};
      db.captchas[id] = { target, exp: Date.now() + 5 * 60 * 1000, used: false };
      await saveDb(db);
      return res.status(200).json({ id, target });
    }
    /* 注册：滑动验证通过后直接注册并登录；同邮箱+正确密码 = 二次注册直接登录 */
    if (r === 'register' && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!EMAIL_RE.test(email)) return res.status(400).json({ msg: '邮箱格式不正确' });
      if (password.length < 6) return res.status(400).json({ msg: '密码至少 6 位' });
      const existing = Object.values(db.users).find(u => u.email === email);
      if (existing) {
        if (hashPass(password, existing.salt) === existing.passHash) {
          const token = crypto.randomBytes(24).toString('hex');
          db.sessions[token] = existing.id;
          await saveDb(db);
          return res.status(200).json({ token, email, existing: true });
        }
        return res.status(409).json({ msg: '该邮箱已注册，密码不正确；请返回登录' });
      }
      const cp = db.captchas && db.captchas[String(b.captchaId || '')];
      const pos = Number(b.pos);
      const dur = Number(b.duration);
      if (!cp || cp.used || cp.exp < Date.now() ||
          !(pos >= 0 && pos <= 100) || Math.abs(pos - cp.target) > 6 ||
          !(dur >= 300 && dur <= 15000)) {
        return res.status(400).json({ msg: '请完成滑动验证' });
      }
      cp.used = true;
      const id = String(Object.keys(db.users).reduce((m, k) => Math.max(m, parseInt(k, 10) || 0), 0) + 1);
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[id] = { id, email, salt, passHash: hashPass(password, salt), createdAt: Date.now() };
      db.data[id] = { settings: {}, favSongs: [], favPlaylists: [] };
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = id;
      await saveDb(db);
      return res.status(200).json({ token, email });
    }
    if (r === 'login' && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const user = Object.values(db.users).find(u => u.email === email);
      if (!user || hashPass(String(b.password || ''), user.salt) !== user.passHash) {
        return res.status(401).json({ msg: '邮箱或密码错误' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = user.id;
      await saveDb(db);
      return res.status(200).json({ token, email: user.email });
    }
    const user = authUser(db, req);
    if (!user) return res.status(401).json({ msg: '未登录或登录已过期' });
    if (r === 'logout' && method === 'POST') {
      const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
      if (m) delete db.sessions[m[1]];
      await saveDb(db);
      return res.status(200).json({ ok: true });
    }
    if (r === 'delete' && method === 'POST') {
      delete db.users[user.id];
      delete db.data[user.id];
      Object.keys(db.sessions).forEach(t => { if (db.sessions[t] === user.id) delete db.sessions[t]; });
      await saveDb(db);
      return res.status(200).json({ ok: true });
    }
    if (r === 'data') {
      if (method === 'GET') {
        const d = db.data[user.id] || { settings: {}, favSongs: [], favPlaylists: [] };
        return res.status(200).json(d);
      }
      if (method === 'POST') {
        const b = await readBody(req);
        const d = db.data[user.id] || {};
        if (b.settings && typeof b.settings === 'object') d.settings = b.settings;
        if (Array.isArray(b.favSongs)) d.favSongs = b.favSongs;
        if (Array.isArray(b.favPlaylists)) d.favPlaylists = b.favPlaylists;
        db.data[user.id] = d;
        await saveDb(db);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ msg: 'method not allowed' });
    }
  } catch (e) {
    return res.status(400).json({ msg: e.message || 'bad request' });
  }
  return res.status(405).json({ msg: 'method not allowed' });
}
