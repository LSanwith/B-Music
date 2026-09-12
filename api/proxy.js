/* Vercel Serverless Function：同源转发代理（替代本地 server.js 的 /proxy）
 * vercel.json 将 /proxy 重写到此函数。
 *  - 仅允许转发白名单域名（防开放代理滥用）
 *  - hk=1 表示红云点歌请求：密钥由服务端注入，浏览器请求中不暴露密钥
 *  - nt=1 表示落七七（18years）整合源请求：密钥同样由服务端注入
 * Secrets：HONGYUN_KEY（红云点歌密钥；不设则 hk=1 返回 500，红云兜底不可用）
 *          NT18_KEY（落七七密钥；不设则 nt=1 返回 500，落七七辅助源不可用）
 *          SANWITH_SKEY（Sanwith 网易云 API 密钥；不设则 sw=1 返回 500） */
const PROXY_ALLOWED = [
  'https://silence-music-api.cc.cd',
  'https://sience-music-api-backup.de5.net',
  'https://zm.wwoyun.cn',
  'https://music.mcseekeri.com',
  'https://api.xunjinlu.fun',
  'https://api.18years.ink',
  'https://api.bugpk.com',
  'https://oiapi.net',
  'https://www.sanwith.cc.cd',
];

/* 二进制上传（听歌识曲音频）：优先使用运行时已缓冲的 body，缺失时读原始流 */
const MAX_UPLOAD = 12 * 1024 * 1024; // 12MB 上限

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function getBody(req) {
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b);
  if (b && typeof b === 'object') {
    // 运行时已按表单/JSON 解析：还原为查询串形式（一般不会走到这里）
    const usp = new URLSearchParams();
    Object.keys(b).forEach(k => usp.set(k, b[k]));
    return Buffer.from(usp.toString());
  }
  return await readRawBody(req);
}

export default async function handler(req, res) {
  const target = req.query.u;
  const hk = req.query.hk === '1';
  const nt = req.query.nt === '1';
  const sw = req.query.sw === '1';
  if (!target) return res.status(400).json({ code: -1, msg: 'missing u' });
  let dest;
  try { dest = new URL(target); } catch (e) { return res.status(400).json({ code: -1, msg: 'bad url' }); }
  if (PROXY_ALLOWED.indexOf(dest.origin) < 0 || dest.protocol !== 'https:') {
    return res.status(403).json({ code: -1, msg: 'forbidden' });
  }
  if (hk || nt || sw) {
    const isHkDest = dest.origin === 'https://api.xunjinlu.fun';
    const isNtDest = dest.origin === 'https://api.18years.ink';
    const isSwDest = dest.origin === 'https://www.sanwith.cc.cd';
    if ((hk && !isHkDest) || (nt && !isNtDest) || (sw && !isSwDest)) {
      return res.status(403).json({ code: -1, msg: 'key not allowed for this origin' });
    }
    const key = hk ? (process.env.HONGYUN_KEY || '')
      : (nt ? (process.env.NT18_KEY || '') : (process.env.SANWITH_SKEY || ''));
    if (!key) {
      return res.status(500).json({ code: -1, msg: (hk ? 'HONGYUN_KEY' : (nt ? 'NT18_KEY' : 'SANWITH_SKEY')) + ' not set' });
    }
    if (sw) dest.searchParams.set('SKey', key);
    else dest.searchParams.set('key', key);
  }
  // POST（音频上传等）：透传方法与原始 body
  const isPost = req.method && req.method !== 'GET' && req.method !== 'HEAD';
  const fwd = { headers: { 'User-Agent': 'BMusicWeb/1.0' }, signal: AbortSignal.timeout(45000) };
  if (isPost) {
    fwd.method = req.method;
    if (req.headers['content-type']) fwd.headers['Content-Type'] = req.headers['content-type'];
    try { fwd.body = await getBody(req); } catch (e) { return res.status(413).json({ code: -1, msg: 'upload too large' }); }
  }
  let upstream;
  try {
    upstream = await fetch(dest, fwd);
  } catch (e) {
    return res.status(502).json({ code: -1, msg: 'proxy upstream error' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (upstream.headers.get('content-type')) {
    res.setHeader('Content-Type', upstream.headers.get('content-type'));
  }
  res.status(upstream.status);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}
