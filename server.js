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
  return uid ? DB.users[uid] || null : null;
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

/** 账号 + 数据同步 API（设置/收藏上传下载；最近播放仅存本地） */
async function handleApi(req, res, urlPath) {
  const API_PATHS = ['/api/register', '/api/captcha', '/api/login',
    '/api/logout', '/api/account/delete', '/api/data',
    '/api/account/avatar', '/api/account/password', '/api/account/profile'];
  if (API_PATHS.indexOf(urlPath) < 0) return false;
  const method = req.method;
  try {
    /* 人机验证（滑块拼图）：服务端下发随机缺口位置，一次一题，5 分钟有效 */
    if (urlPath === '/api/captcha' && method === 'GET') {
      const target = 35 + Math.floor(Math.random() * 45); // 缺口位置 35%..80%
      const id = crypto.randomBytes(8).toString('hex');
      DB.captchas = DB.captchas || {};
      DB.captchas[id] = { target, exp: Date.now() + 5 * 60 * 1000, used: false };
      saveDb(DB);
      return sendJson(res, 200, { id, target });
    }
    if (urlPath === '/api/register' && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!EMAIL_RE.test(email)) return sendJson(res, 400, { msg: '邮箱格式不正确' });
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
      // 滑动验证：位置误差 ≤6%，拖动时长 300ms~15s（防脚本秒拖）
      const cp = DB.captchas && DB.captchas[String(b.captchaId || '')];
      const pos = Number(b.pos);
      const dur = Number(b.duration);
      if (!cp || cp.used || cp.exp < Date.now() ||
          !(pos >= 0 && pos <= 100) || Math.abs(pos - cp.target) > 6 ||
          !(dur >= 300 && dur <= 15000)) {
        return sendJson(res, 400, { msg: '请完成滑动验证' });
      }
      cp.used = true;
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
      const user = Object.values(DB.users).find(u => u.email === email);
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
  'https://www.sanwith.cc.cd',
  'https://silence-music-api.cc.cd',
  'https://api.xunjinlu.fun',
];

/** /proxy?u=<完整URL>[&hk=1] —— 同源转发上游 API，规避上游 CORS 响应头不稳定问题。
 *  hk=1 表示红云点歌请求：密钥由本代理注入上游 URL，浏览器请求中不暴露密钥。
 *  密钥来源优先级：环境变量 HONGYUN_KEY → 仓库根目录 ./key.local（被 gitignore，
 *  不随仓库上传）→ 未配置（红云请求将返回明确错误）。 */
const HONGYUN_KEY = (function () {
  if (process.env.HONGYUN_KEY) return process.env.HONGYUN_KEY;
  try {
    const p = require('path').join(__dirname, 'key.local');
    const v = require('fs').readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 无 key.local */ }
  return '';
})();

/* sanwith 站点 SKey（API 鉴权，供 /proxy 转发时注入 x-skey 头）：
 * 优先级：环境变量 SANWITH_SKEY → 仓库根目录 ./skey.local（被 gitignore） */
const SANWITH_SKEY = (function () {
  if (process.env.SANWITH_SKEY) return process.env.SANWITH_SKEY;
  try {
    const p = require('path').join(__dirname, 'skey.local');
    const v = require('fs').readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 无 skey.local */ }
  return '';
})();
async function handleProxy(req, res, urlPath) {
  if (urlPath !== '/proxy') return false;
  const u = new URL(req.url, 'http://localhost');
  const target = u.searchParams.get('u');
  const injectKey = u.searchParams.get('hk') === '1';
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
  if (injectKey) {
    if (dest.origin !== 'https://api.xunjinlu.fun') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"code":-1,"msg":"hk not allowed"}');
      return true;
    }
    dest.searchParams.set('key', HONGYUN_KEY); // 注入密钥，浏览器 URL 中不出现
  }
  try {
    const ctrl = AbortSignal.timeout(25000);
    const headers = { 'User-Agent': 'BMusicWeb/1.0' };
    // sanwith 站点的 SKey 鉴权：由本地 skey.local（gitignore）或环境变量提供，浏览器不可见
    if (dest.origin === 'https://www.sanwith.cc.cd' && SANWITH_SKEY) headers['x-skey'] = SANWITH_SKEY;
    const upstream = await fetch(dest, { signal: ctrl, headers });
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
