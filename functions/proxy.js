/* Cloudflare Pages Function：同源转发代理（替代本地 server.js 的 /proxy）
 *  - 仅允许转发白名单域名（防开放代理滥用）
 *  - hk=1 表示红云点歌请求：密钥由边缘注入，浏览器请求中不暴露密钥
 *  - nt=1 表示落七七（18years）整合源请求：密钥同样由边缘注入
 * 依赖 Secret：HONGYUN_KEY（红云点歌密钥；不设则 hk=1 返回 500，红云兜底不可用）
 *              NT18_KEY（落七七密钥；不设则 nt=1 返回 500，落七七辅助源不可用） */
const PROXY_ALLOWED = [
  'https://silence-music-api.cc.cd',
  'https://api.xunjinlu.fun',
  'https://api.18years.ink',
];

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const target = u.searchParams.get('u');
  const hk = u.searchParams.get('hk') === '1';
  const nt = u.searchParams.get('nt') === '1';
  if (!target) return json(400, { code: -1, msg: 'missing u' });
  let dest;
  try { dest = new URL(target); } catch (e) { return json(400, { code: -1, msg: 'bad url' }); }
  if (PROXY_ALLOWED.indexOf(dest.origin) < 0 || dest.protocol !== 'https:') {
    return json(403, { code: -1, msg: 'forbidden' });
  }
  if (hk || nt) {
    const isHkDest = dest.origin === 'https://api.xunjinlu.fun';
    const isNtDest = dest.origin === 'https://api.18years.ink';
    if ((hk && !isHkDest) || (nt && !isNtDest)) {
      return json(403, { code: -1, msg: 'key not allowed for this origin' });
    }
    const key = hk ? (env.HONGYUN_KEY || '') : (env.NT18_KEY || '');
    if (!key) return json(500, { code: -1, msg: (hk ? 'HONGYUN_KEY' : 'NT18_KEY') + ' not set' });
    dest.searchParams.set('key', key);
  }
  let res;
  try {
    res = await fetch(dest, {
      headers: { 'User-Agent': 'BMusicWeb/1.0' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return json(502, { code: -1, msg: 'proxy upstream error' });
  }
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}
