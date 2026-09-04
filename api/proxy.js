/* Vercel Serverless Function：同源转发代理（替代本地 server.js 的 /proxy）
 * vercel.json 将 /proxy 重写到此函数。
 *  - 仅允许转发白名单域名（防开放代理滥用）
 *  - hk=1 表示红云点歌请求：密钥由服务端注入，浏览器请求中不暴露密钥
 * Secret：HONGYUN_KEY（红云点歌密钥；不设则 hk=1 返回 500，红云兜底不可用） */
const PROXY_ALLOWED = [
  'https://www.sanwith.cc.cd',
  'https://silence-music-api.cc.cd',
  'https://api.xunjinlu.fun',
];

export default async function handler(req, res) {
  const target = req.query.u;
  const injectKey = req.query.hk === '1';
  if (!target) return res.status(400).json({ code: -1, msg: 'missing u' });
  let dest;
  try { dest = new URL(target); } catch (e) { return res.status(400).json({ code: -1, msg: 'bad url' }); }
  if (PROXY_ALLOWED.indexOf(dest.origin) < 0 || dest.protocol !== 'https:') {
    return res.status(403).json({ code: -1, msg: 'forbidden' });
  }
  if (injectKey) {
    if (dest.origin !== 'https://api.xunjinlu.fun') return res.status(403).json({ code: -1, msg: 'hk not allowed' });
    const key = process.env.HONGYUN_KEY || '';
    if (!key) return res.status(500).json({ code: -1, msg: 'HONGYUN_KEY not set' });
    dest.searchParams.set('key', key);
  }
  let upstream;
  try {
    // sanwith 站点启用 SKey 鉴权后需带 x-skey 头（值由部署环境 SANWITH_SKEY 提供，浏览器不可见）
    const headers = { 'User-Agent': 'BMusicWeb/1.0' };
    if (dest.origin === 'https://www.sanwith.cc.cd' && process.env.SANWITH_SKEY) {
      headers['x-skey'] = process.env.SANWITH_SKEY;
    }
    upstream = await fetch(dest, {
      headers,
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
