/* B·Music 网页版 · 极简本地静态服务器（零依赖）
 * 用法: node server.js   （默认端口 8899，可用 PORT 环境变量修改）
 * 附带本地 JSON 数据库（data/db.json）：账号 + 设置/收藏云同步
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8899;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------- 本地数据库（JSON 文件） ---------------- */
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return { users: {}, sessions: {}, data: {} }; }
}
function saveDb(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}
const DB = loadDb();
let _uid = Object.keys(DB.users).reduce((m, k) => Math.max(m, parseInt(k, 10) || 0), 0);

function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(\S+)$/.exec(h);
  if (!m) return null;
  const uid = DB.sessions[m[1]];
  const u = uid ? DB.users[uid] || null : null;
  if (u && u.banned) { delete DB.sessions[m[1]]; saveDb(DB); return null; } // 封禁账号令牌立即失效
  return u;
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
  return res; // 必须返回 truthy，告知调用方响应已发送
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QQ_MAIL_RE = /^[A-Za-z0-9._%+-]+@(qq\.com|foxmail\.com)$/i; // 仅允许 QQ 邮箱
const QQ_MAIL_MSG = '仅支持 QQ 邮箱注册（@qq.com / @foxmail.com）';


/** ===== Altcha 人机验证（开源 PoW，MIT）=====
 *  签发：salt=hex(rand12)+'&'，challenge=SHA256(salt+number)，signature=HMAC_SHA256(key, challenge)
 *  校验：用 payload 的 salt+number 重算 challenge，并重算 signature 比对
 */
const ALTCHA_KEY = process.env.ALTCHA_HMAC_KEY || 'bmusic-altcha-hmac-2026-secret';
function altchaCreate(maxnumber) {
  const mx = maxnumber || 100000;
  const salt = crypto.randomBytes(12).toString('hex') + '&';
  const number = crypto.randomInt(mx);
  const challenge = crypto.createHash('sha256').update(salt + number).digest('hex');
  const signature = crypto.createHmac('sha256', ALTCHA_KEY).update(challenge).digest('hex');
  return { algorithm: 'SHA-256', challenge, maxnumber: mx, salt, signature };
}
function altchaVerify(payload) {
  try {
    let p = payload;
    if (typeof p === 'string') p = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    if (!p || !p.salt || p.number === undefined || p.number === null || !p.challenge || !p.signature) return false;
    const challenge = crypto.createHash('sha256').update(String(p.salt) + String(p.number)).digest('hex');
    const signature = crypto.createHmac('sha256', ALTCHA_KEY).update(String(p.challenge)).digest('hex');
    return challenge === p.challenge && signature === p.signature;
  } catch (e) { return false; }
}

/** 清洗 AI 历史消息：保证 assistant(tool_calls) 与 tool 响应严格配对（否则上游 400） */
function sanitizeAiMessages(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || !m.role) continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const need = m.tool_calls.map(tc => tc.id);
      const got = [];
      let j = i + 1;
      while (j < list.length && list[j] && list[j].role === 'tool') { got.push(list[j].tool_call_id); j++; }
      if (!need.every(id => got.indexOf(id) >= 0)) continue;
      out.push({
        role: 'assistant', content: m.content || '',
        tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments } })),
      });
      for (let k = i + 1; k < j; k++) out.push({ role: 'tool', tool_call_id: list[k].tool_call_id, content: String(list[k].content == null ? '' : list[k].content) });
      i = j - 1;
    } else if (m.role === 'tool') {
      continue;
    } else {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content) });
    }
  }
  return out;
}

/** 账号 + 数据同步 API（设置/收藏上传下载；最近播放仅存本地） */
async function handleApi(req, res, urlPath) {
  const API_PATHS = ['/api/register', '/api/captcha', '/api/login',
    '/api/logout', '/api/account/delete', '/api/data',
    '/api/account/avatar', '/api/account/password', '/api/account/profile',
    '/api/cookieurl', '/api/ai', '/api/qq/check'];
  if (API_PATHS.indexOf(urlPath) < 0) return false;
  const method = req.method;
  try {
    /* HiBetter AI 助手：服务端注入 DeepSeek 密钥（本地读 ai.local，环境变量优先） */
    if (urlPath === '/api/ai' && method === 'POST') {
      const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
      let key = process.env.DEEPSEEK_KEY || '';
      if (!key) {
        try { key = require('fs').readFileSync(require('path').join(__dirname, 'ai.local'), 'utf8').trim(); } catch (e) {}
      }
      if (!key) return sendJson(503, { ok: false, msg: 'AI 未配置（缺少 ai.local / DEEPSEEK_KEY）' });
      let body = null;
      try {
        const chunks = [];
        await new Promise((resolve, reject) => {
          req.on('data', (c) => chunks.push(c));
          req.on('end', resolve);
          req.on('error', reject);
        });
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (e) { return sendJson(400, { ok: false, msg: 'bad body' }); }
      if (!body || !Array.isArray(body.messages)) return sendJson(400, { ok: false, msg: 'bad body' });
      // 用户自定义模型配置（可选）：优先使用用户自己的地址/密钥/模型
      const custom = body.custom || null;
      const wantsCustom = !!(custom && (String(custom.baseUrl || '').trim() || String(custom.model || '').trim()));
      if (wantsCustom && !String(custom.apiKey || '').trim()) {
        return sendJson(400, { ok: false, msg: '自定义模型必须填写你自己的 API Key（不能使用本站内置密钥）' });
      }
      const useKey = (custom && custom.apiKey) ? String(custom.apiKey).trim() : key;
      let useUrl = (custom && custom.baseUrl) ? String(custom.baseUrl).trim() : 'https://api.deepseek.com/chat/completions';
      if (!/^https?:\/\//i.test(useUrl)) return sendJson(400, { ok: false, msg: 'API 网址需以 http(s):// 开头' });
      if (useUrl.indexOf('/chat/completions') < 0) useUrl = useUrl.replace(/\/+$/, '') + '/chat/completions';
      const useModel = (custom && custom.model) ? String(custom.model).trim() : (process.env.AI_MODEL || 'deepseek-flash');
      const payload = {
        model: useModel,
        messages: sanitizeAiMessages(sanitizeAiMessages(body.messages.slice(-30)).slice(-24)),
        reasoning_effort: (custom && custom.effort) ? String(custom.effort) : (process.env.AI_EFFORT || 'medium'),
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
        max_tokens: Math.min(2048, body.max_tokens || 900),
      };
      if (Array.isArray(body.tools) && body.tools.length) {
        payload.tools = body.tools;
        payload.tool_choice = body.tool_choice || 'auto';
      }
      try {
        const r = await fetch(useUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + useKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return sendJson(r.status, { ok: false, msg: (j && j.error && j.error.message) || ('HTTP ' + r.status) });
        const choice = (j.choices && j.choices[0]) || {};
        const msg = choice.message || {};
        return sendJson(200, {
          ok: true,
          message: { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls || null, reasoning: msg.reasoning_content || '' },
          finish_reason: choice.finish_reason || '',
          usage: j.usage || null,
        });
      } catch (e) {
        return sendJson(502, { ok: false, msg: e.message || 'upstream error' });
      }
    }
    /* 网易云会员音源（黑胶 cookie 仅存本地 netease_cookie.txt，不随仓库分发；
     *  经 Silence 增强库 eapi 通道 → 母带级音源） */
    if (urlPath === '/api/cookieurl' && method === 'GET') {
      const fsx = require('fs');
      const pts = require('path');
      let cookie = '';
      try { cookie = fsx.readFileSync(pts.join(__dirname, 'netease_cookie.txt'), 'utf8').trim(); } catch (e) {}
      // 最小化：仅转发 MUSIC_U + __csrf 两个字段
      const muM = /MUSIC_U=([^;]+)/.exec(cookie);
      const csM = /__csrf=([^;]+)/.exec(cookie);
      cookie = (muM ? 'MUSIC_U=' + muM[1] : '') + (csM ? (muM ? '; ' : '') + '__csrf=' + csM[1] : '');
      const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
      if (!cookie) return sendJson(503, { msg: 'cookie 未配置' });
      const id = String((req.url.match(/[?&]id=(\d+)/) || [])[1] || '');
      const lvl = String(((req.url.match(/[?&]level=([a-z]+)/) || [])[1]) || 'lossless');
      if (!id) return sendJson(400, { msg: 'bad id' });
      try {
        const u2 = new URL('https://silence-music-api.cc.cd/song/url/v1');
        u2.searchParams.set('id', id);
        u2.searchParams.set('level', lvl);
        u2.searchParams.set('unlock', '1');
        u2.searchParams.set('cookie', cookie);
        const r = await fetch(u2.toString(), {
          headers: { 'User-Agent': 'BMusicWeb/1.0' },
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => ({}));
        const d = (j && j.data && j.data[0]) || {};
        if (d && d.url) {
          return sendJson(200, { url: String(d.url).replace(/^http:\/\//i, 'https://'), br: d.br || 0, level: d.level || lvl, type: d.type || '' });
        }
        return sendJson(404, { msg: '无源' });
      } catch (e) {
        return sendJson(502, { msg: e.message || 'upstream error' });
      }
    }
    /* 人机验证（Altcha 开源 PoW）：签发 challenge，前端解题，注册时校验 */
    if (urlPath === '/api/captcha' && method === 'GET') {
      // Altcha 人机验证：签发 PoW challenge（前端 altcha-widget 解题）
      return sendJson(res, 200, altchaCreate(100000));
    }
    /* QQ 号校验：注册前先验证 QQ 号是否有效（前端据此显示“正在验证”提示） */
    if (urlPath === '/api/qq/check' && method === 'GET') {
      const qq = String((req.url.match(/[?&]qq=(\d{5,12})/) || [])[1] || '');
      if (!qq) return sendJson(res, 400, { ok: false, msg: 'QQ 号格式不正确' });
      try {
        const r = await fetch('https://api.xunjinlu.fun/api/qq/name.php?qq=' + qq, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => ({}));
        const d = (j && j.data) || {};
        const nick = d.nickname || d.name || '';
        if (j && j.code === 200 && nick) return sendJson(res, 200, { ok: true, qq, nickname: nick, avatar: d.avatar || d.imgurl || '' });
        return sendJson(res, 200, { ok: false, qq, msg: '未查询到该 QQ 号（不影响注册）' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, qq, msg: 'QQ 校验服务暂不可用（不影响注册）' });
      }
    }
    if (urlPath === '/api/register' && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!EMAIL_RE.test(email)) return sendJson(res, 400, { msg: '邮箱格式不正确' });
      if (!QQ_MAIL_RE.test(email)) return sendJson(res, 400, { msg: QQ_MAIL_MSG });
      if (password.length < 6) return sendJson(res, 400, { msg: '密码至少 6 位' });
      // 已注册邮箱：密码正确则视为“二次注册=直接登录”，否则明确提示
      const existing = Object.values(DB.users).find(u => u.email === email);
      if (existing) {
        if (hashPass(password, existing.salt) === existing.passHash) {
          const token = newToken();
          DB.sessions[token] = existing.id;
          saveDb(DB);
          return sendJson(res, 200, { token, email, existing: true, avatar: existing.avatar || '' });
        }
        return sendJson(res, 409, { msg: '该邮箱已注册，密码不正确；请返回登录' });
      }
      // Altcha 人机验证：校验 payload（重算 challenge + signature）
      if (!altchaVerify(b.altcha)) return sendJson(res, 400, { msg: '请完成人机验证' });
      const id = String(++_uid);
      const salt = crypto.randomBytes(16).toString('hex');
      DB.users[id] = { id, email, salt, passHash: hashPass(password, salt), createdAt: Date.now() };
      DB.data[id] = { settings: {}, favSongs: [], favPlaylists: [] };
      const token = newToken();
      DB.sessions[token] = id;
      saveDb(DB);
      return sendJson(res, 200, { token, email, avatar: '' });
    }
    if (urlPath === '/api/login' && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!QQ_MAIL_RE.test(email)) return sendJson(res, 403, { msg: '本服务仅接受 QQ 邮箱账号（@qq.com / @foxmail.com），其它邮箱一律无效' });
      const user = Object.values(DB.users).find(u => u.email === email);
      if (user && user.banned) {
        Object.keys(DB.sessions).forEach(t => { if (DB.sessions[t] === user.id) delete DB.sessions[t]; });
        saveDb(DB);
        return sendJson(res, 403, { msg: '该账号已被封禁，无法登录' });
      }
      if (!user || hashPass(String(b.password || ''), user.salt) !== user.passHash) {
        return sendJson(res, 401, { msg: '邮箱或密码错误' });
      }
      const token = newToken();
      DB.sessions[token] = user.id;
      saveDb(DB);
      return sendJson(res, 200, { token, email: user.email, avatar: user.avatar || '' });
    }
    const user = authUser(req);
    if (!user) return sendJson(res, 401, { msg: '未登录或登录已过期' });
    // 当前账号公开资料（仅 email/avatar，绝不返回 salt/passHash），
    // 供多端在启动/回前台时拉取最新头像，实现跨设备头像同步
    if (urlPath === '/api/account/profile' && method === 'GET') {
      return sendJson(res, 200, { email: user.email, avatar: user.avatar || '' });
    }
    if (urlPath === '/api/account/avatar' && method === 'POST') {
      const b = await readBody(req);
      const avatar = String(b.avatar || '').trim();
      if (avatar && !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(avatar)) {
        return sendJson(res, 400, { msg: '头像格式不正确' });
      }
      if (avatar.length > 400000) {
        return sendJson(res, 400, { msg: '头像数据过大' });
      }
      user.avatar = avatar; // '' 表示清除头像
      saveDb(DB);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/account/password' && method === 'POST') {
      const b = await readBody(req);
      const oldPw = String(b.old || '');
      const nextPw = String(b.next || '');
      if (hashPass(oldPw, user.salt) !== user.passHash) {
        return sendJson(res, 400, { msg: '原密码不正确' });
      }
      if (nextPw.length < 6) {
        return sendJson(res, 400, { msg: '新密码至少 6 位' });
      }
      user.salt = crypto.randomBytes(16).toString('hex');
      user.passHash = hashPass(nextPw, user.salt);
      saveDb(DB);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/logout' && method === 'POST') {
      const h = req.headers['authorization'] || '';
      const m = /^Bearer\s+(\S+)$/.exec(h);
      if (m) delete DB.sessions[m[1]];
      saveDb(DB);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/account/delete' && method === 'POST') {
      const b = await readBody(req);
      if (!b || hashPass(String(b.password || ''), user.salt) !== user.passHash) {
        return sendJson(res, 403, { msg: '密码不正确，无法注销账号' });
      }
      delete DB.users[user.id];
      delete DB.data[user.id];
      Object.keys(DB.sessions).forEach(t => { if (DB.sessions[t] === user.id) delete DB.sessions[t]; });
      saveDb(DB);
      return sendJson(res, 200, { ok: true });
    }
    if (urlPath === '/api/data') {
      if (method === 'GET') {
        const d = DB.data[user.id] || { settings: {}, favSongs: [], favPlaylists: [] };
        return sendJson(res, 200, d);
      }
      if (method === 'POST') {
        const b = await readBody(req);
        const d = DB.data[user.id] || {};
        if (b.settings && typeof b.settings === 'object') d.settings = b.settings;
        if (Array.isArray(b.favSongs)) d.favSongs = b.favSongs;
        if (Array.isArray(b.favPlaylists)) d.favPlaylists = b.favPlaylists;
        if (Array.isArray(b.myPlaylists)) d.myPlaylists = b.myPlaylists;
        DB.data[user.id] = d;
        saveDb(DB);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { msg: 'method not allowed' });
    }
  } catch (e) {
    return sendJson(res, 400, { msg: e.message || 'bad request' });
  }
  return sendJson(res, 405, { msg: 'method not allowed' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* 仅允许代理以下上游（防止开放代理滥用） */
const PROXY_ALLOWED = [
  'https://silence-music-api.cc.cd',
  'https://api.xunjinlu.fun',
  'https://api.18years.ink',
  'https://api.bugpk.com',
  'https://oiapi.net',
];

/** /proxy?u=<完整URL>[&hk=1][&nt=1] —— 同源转发上游 API，规避上游 CORS 响应头不稳定问题。
 *  hk=1 表示红云点歌请求：密钥由本代理注入上游 URL，浏览器请求中不暴露密钥。
 *  nt=1 表示落七七（18years）整合源请求：密钥同样由本代理注入。
 *  密钥来源优先级：环境变量 → 仓库根目录密钥文件（均被 gitignore，不随仓库上传）：
 *    HONGYUN_KEY → ./key.local ；NT18_KEY → ./ntkey.local
 *  未配置（请求将返回明确错误）。 */
const HONGYUN_KEY = (function () {
  if (process.env.HONGYUN_KEY) return process.env.HONGYUN_KEY;
  try {
    const p = require('path').join(__dirname, 'key.local');
    const v = require('fs').readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 无 key.local */ }
  return '';
})();
const NT18_KEY = (function () {
  if (process.env.NT18_KEY) return process.env.NT18_KEY;
  try {
    const p = require('path').join(__dirname, 'ntkey.local');
    const v = require('fs').readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 无 ntkey.local */ }
  return '';
})();

async function handleProxy(req, res, urlPath) {
  if (urlPath !== '/proxy') return false;
  const u = new URL(req.url, 'http://localhost');
  const target = u.searchParams.get('u');
  const hk = u.searchParams.get('hk') === '1'; // 红云点歌
  const nt = u.searchParams.get('nt') === '1'; // 落七七（18years）
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"code":-1,"msg":"missing u"}');
    return true;
  }
  let dest;
  try { dest = new URL(target); } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"code":-1,"msg":"bad url"}');
    return true;
  }
  if (!PROXY_ALLOWED.includes(dest.origin) || !/^https:$/.test(dest.protocol)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"code":-1,"msg":"forbidden"}');
    return true;
  }
  if (hk || nt) {
    const isHkDest = dest.origin === 'https://api.xunjinlu.fun';
    const isNtDest = dest.origin === 'https://api.18years.ink';
    if ((hk && !isHkDest) || (nt && !isNtDest)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"code":-1,"msg":"key not allowed for this origin"}');
      return true;
    }
    const key = hk ? HONGYUN_KEY : NT18_KEY; // 注入密钥，浏览器 URL 中不出现
    if (!key) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"code":-1,"msg":"' + (hk ? 'HONGYUN_KEY' : 'NT18_KEY') + ' not set"}');
      return true;
    }
    dest.searchParams.set('key', key);
  }
  try {
    const ctrl = AbortSignal.timeout(45000);
    const headers = { 'User-Agent': 'BMusicWeb/1.0' };
    const opts = { signal: ctrl, headers };
    // POST（听歌识曲音频上传等）：透传方法与原始 body
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      opts.method = req.method;
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      const chunks = [];
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > 12 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
          chunks.push(c);
        });
        req.on('end', resolve);
        req.on('error', reject);
      }).catch(() => {});
      if (chunks.length) opts.body = Buffer.concat(chunks);
    }
    const upstream = await fetch(dest, opts);
    const ctype = upstream.headers.get('content-type') || 'application/json';
    res.writeHead(upstream.status, {
      'Content-Type': ctype,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end('{"code":-1,"msg":"proxy upstream error"}');
  }
  return true;
}

/* ---------------- 短链预览页 /s/<type>/<id> ----------------
 * 与 api/preview.js（Vercel）行为一致：服务端直接 fetch 备用镜像取元数据，
 * 渲染仅含 og 元信息的最小 HTML（微信/QQ 卡片预览用），并带 meta refresh
 * 自动跳回应用落地页 /index.html#/<type>/<id>；镜像不可用时返回简化 HTML
 * 仍带跳转（/proxy、/api 等既有逻辑不受影响）。 */
const SHORT_LABEL = { song: '歌曲', playlist: '歌单', album: '专辑', artist: '歌手' };

function _previewHtml(title, desc, img, hash) {
  const t = String(title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const d = String(desc || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const imgHref = img ? String(img).replace(/&/g, '&amp;').replace(/"/g, '&quot;') : '';
  const imgMeta = imgHref ? '\n    <meta property="og:image" content="' + imgHref + '">' : '';
  const jsHash = JSON.stringify(hash).replace(/</g, '\\u003c');
  const imgBody = imgHref
    ? '\n    <img src="' + imgHref + '" alt="" style="width:168px;height:168px;border-radius:12px;object-fit:cover;box-shadow:0 8px 24px rgba(0,0,0,.16);">'
    : '';
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    '<title>' + t + ' · B·Music</title>\n' +
    '<meta property="og:title" content="' + t + '">\n' +
    '<meta property="og:description" content="' + d + '">\n' +
    '<meta property="og:site_name" content="B·Music">' + imgMeta + '\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta http-equiv="refresh" content="0;url=\'' + hash + '\'">\n' +
    '<script>location.replace(' + jsHash + ');</script>\n' +
    '</head>\n' +
    '<body style="margin:0;background:#f5f6f8;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;text-align:center;padding:48px 16px;">\n' +
    '  <a href="' + hash + '" style="text-decoration:none;color:inherit;">' + imgBody +
    '\n    <div style="margin-top:18px;font-size:19px;font-weight:600;line-height:1.4;">' + t + '</div>\n' +
    (d ? '    <div style="margin-top:6px;font-size:13px;color:#8a9099;line-height:1.6;">' + d + '</div>' : '') +
    '\n  </a>\n' +
    '  <p style="margin-top:28px;font-size:12px;color:#a6adb5;">正在打开 B·Music…</p>\n' +
    '</body>\n</html>\n';
}
function _previewFallback(hash, label) {
  const jsHash = JSON.stringify(hash).replace(/</g, '\\u003c');
  const t = String(label || '预览不可用');
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<title>' + t + ' · B·Music</title>\n' +
    '<meta http-equiv="refresh" content="0;url=\'' + hash + '\'">\n' +
    '<script>location.replace(' + jsHash + ');</script>\n' +
    '</head>\n' +
    '<body style="margin:0;background:#f5f6f8;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;text-align:center;padding:48px 16px;">\n' +
    '  <p style="font-size:15px;">' + t + '</p>\n' +
    '  <p style="margin-top:16px;font-size:12px;color:#a6adb5;">正在打开 B·Music…</p>\n' +
    '</body>\n</html>\n';
}
function sendPreviewHtml(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
  return true;
}
/** 从备用镜像拉元数据：图片一律转 https；失败抛错由调用方兜底 */
async function handleShortLink(res, type, id) {
  const label = SHORT_LABEL[type];
  const hash = '/index.html#/' + type + '/' + id;
  if (!label || !/^\d+$/.test(id)) return sendPreviewHtml(res, 404, _previewFallback('/index.html', '无效链接'));
  const base = 'https://silence-music-api.cc.cd';
  const realIP = '116.25.146.177';
  const buildUrl = (path, params) => {
    const u = new URL(path, base);
    u.searchParams.set('realIP', realIP);
    for (const k of Object.keys(params)) u.searchParams.set(k, params[k]);
    return u.toString();
  };
  const toHttps = (u) => {
    if (!u) return '';
    if (/^http:\/\//i.test(u)) return 'https://' + u.slice(7);
    if (/^\/\//.test(u)) return 'https:' + u;
    return u;
  };
  try {
    const fetchJson = async (url) => {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BMusicPreview/1.0)' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    };
    let j, title = '', desc = '', img = '';
    if (type === 'song') {
      j = await fetchJson(buildUrl('/song/detail', { ids: id }));
      const s = (j.songs || [])[0];
      if (!s || !s.name) throw new Error('no song');
      const ar = s.ar || s.artists || [];
      const artists = ar.map(a => a && a.name).filter(Boolean).join(' / ');
      const al = s.al || s.album || {};
      title = s.name;
      desc = '歌曲《' + s.name + '》' + (artists ? ' — ' + artists : '');
      img = toHttps(al.picUrl || al.coverImgUrl || '');
    } else if (type === 'playlist') {
      j = await fetchJson(buildUrl('/playlist/detail', { id: id }));
      const p = (j.playlist) || {};
      if (!p.name) throw new Error('no playlist');
      const creator = (p.creator && p.creator.nickname) ? p.creator.nickname : '';
      title = p.name;
      desc = '歌单《' + p.name + '》' + (creator ? ' · 创建者：' + creator : '') + (p.trackCount ? ' · 共 ' + p.trackCount + ' 首' : '');
      img = toHttps(p.coverImgUrl || '');
    } else if (type === 'album') {
      j = await fetchJson(buildUrl('/album', { id: id }));
      const a = (j.album) || {};
      if (!a.name) throw new Error('no album');
      title = a.name;
      desc = '专辑《' + a.name + '》' + ((a.artist && a.artist.name) ? ' — ' + a.artist.name : '');
      img = toHttps(a.picUrl || a.coverImgUrl || '');
    } else { // artist
      j = await fetchJson(buildUrl('/artist/detail', { id: id }));
      const d = (j.data) || {};
      const a = d.artist || d;
      if (!a || !a.name) throw new Error('no artist');
      title = a.name;
      desc = '歌手：' + a.name;
      img = toHttps(a.img1v1Url || a.picUrl || a.cover || a.avatar || '');
    }
    return sendPreviewHtml(res, 200, _previewHtml(title, desc, img, hash));
  } catch (e) {
    // 镜像不可用：返回简单 HTML，仍带 meta refresh 跳回应用
    return sendPreviewHtml(res, 200, _previewFallback(hash, label + '内容暂不可获取'));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // CORS 预检（file:// 页面跨域访问本机服务器时需要）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (await handleApi(req, res, urlPath)) return;
    if (await handleProxy(req, res, urlPath)) return;
    // 短链预览页 /s/<type>/<id>（行为同 api/preview.js；须在静态文件分发前）
    const shortLink = /^\/s\/(song|playlist|album|artist)\/(\d+)$/.exec(urlPath);
    if (shortLink) {
      await handleShortLink(res, shortLink[1], shortLink[2]);
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end('Server Error');
  }
});

server.listen(PORT, () => {
  if (!HONGYUN_KEY) {
    console.log('⚠️ 未找到红云密钥：请创建 key.local（与 server.js 同目录，内容为你的 sk- 开头密钥）');
    console.log('   或设置环境变量 HONGYUN_KEY，否则红云兜底源不可用（其余功能正常）');
  }
  if (!NT18_KEY) {
    console.log('⚠️ 未找到落七七密钥：请创建 ntkey.local（与 server.js 同目录，内容为接口 key）');
    console.log('   或设置环境变量 NT18_KEY，否则落七七辅助源不可用（其余功能正常）');
  }
  const url = `http://localhost:${PORT}/`;
  console.log('┌──────────────────────────────────────┐');
  console.log('│  B·Music 网页版 已启动                │');
  console.log(`│  ${url}`);
  console.log('│  按 Ctrl+C 停止                      │');
  console.log('└──────────────────────────────────────┘');
  // 自动打开浏览器
  const start = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  require('child_process').exec(`${start} "${url}"`, () => {});
});
