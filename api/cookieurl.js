/* Vercel Serverless Function：网易云会员音源（黑胶/SVIP cookie 服务端注入）
 *
 * 实现：服务端带 cookie 请求 Silence 增强库（其实现了网易 eapi 母带通道）
 *      /song/url/v1?id=&level=&unlock=1&cookie=<NETEASE_COOKIE>
 *  - cookie 仅存于服务端环境变量 NETEASE_COOKIE，客户端/URL 不出现；
 *  - 未配置 cookie → 503（前端静默跳过该路）；
 *  - 档位：jymaster/hires/lossless/exhigh/higher/standard 直传。
 */
const SILENCE = 'https://silence-music-api.cc.cd';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ msg: 'method not allowed' });
  const cookie = (process.env.NETEASE_COOKIE || '').trim();
  if (!cookie) return res.status(503).json({ msg: 'cookie 未配置' });
  const id = String((req.query && req.query.id) || '');
  const level = String((req.query && req.query.level) || 'lossless');
  if (!/^\d+$/.test(id)) return res.status(400).json({ msg: 'bad id' });
  try {
    const u = new URL(SILENCE + '/song/url/v1');
    u.searchParams.set('id', id);
    u.searchParams.set('level', level);
    u.searchParams.set('unlock', '1');
    u.searchParams.set('cookie', cookie);
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': 'BMusicWeb/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    const d = (j && j.data && j.data[0]) || {};
    if (d && d.url) {
      return res.status(200).json({
        url: d.url.replace(/^http:\/\//i, 'https://'),
        br: d.br || 0, level: d.level || level, type: d.type || '',
      });
    }
    return res.status(404).json({ msg: '无源' });
  } catch (e) {
    return res.status(502).json({ msg: e.message || 'upstream error' });
  }
}
