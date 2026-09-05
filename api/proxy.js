/* Vercel Serverless Function：同源转发代理（替代本地 server.js 的 /proxy）
 * vercel.json 将 /proxy 重写到此函数。
 *  - 仅允许转发白名单域名（防开放代理滥用）
 *  - hk=1 表示红云点歌请求：密钥由服务端注入，浏览器请求中不暴露密钥
 *  - nt=1 表示落七七（18years）整合源请求：密钥同样由服务端注入
 * Secrets：HONGYUN_KEY（红云点歌密钥；不设则 hk=1 返回 500，红云兜底不可用）
 *          NT18_KEY（落七七密钥；不设则 nt=1 返回 500，落七七辅助源不可用） */
const PROXY_ALLOWED = [
  'https://silence-music-api.cc.cd',
  'https://api.xunjinlu.fun',
  'https://api.18years.ink',
];

export default async function handler(req, res) {
  const target = req.query.u;
  const hk = req.query.hk === '1';
  const nt = req.query.nt === '1';
  if (!target) return res.status(400).json({ code: -1, msg: 'missing u' });
  let dest;
  try { dest = new URL(target); } catch (e) { return res.status(400).json({ code: -1, msg: 'bad url' }); }
  if (PROXY_ALLOWED.indexOf(dest.origin) < 0 || dest.protocol !== 'https:') {
    return res.status(403).json({ code: -1, msg: 'forbidden' });
  }
  if (hk || nt) {
    const isHkDest = dest.origin === 'https://api.xunjinlu.fun';
    const isNtDest = dest.origin === 'https://api.18years.ink';
    if ((hk && !isHkDest) || (nt && !isNtDest)) {
      return res.status(403).json({ code: -1, msg: 'key not allowed for this origin' });
    }
    const key = hk ? (process.env.HONGYUN_KEY || '') : (process.env.NT18_KEY || '');
    if (!key) {
      return res.status(500).json({ code: -1, msg: (hk ? 'HONGYUN_KEY' : 'NT18_KEY') + ' not set' });
    }
    dest.searchParams.set('key', key);
  }
  let upstream;
  try {
    upstream = await fetch(dest, {
      headers: { 'User-Agent': 'BMusicWeb/1.0' },
      signal: AbortSignal.timeout(25000),
    });
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
