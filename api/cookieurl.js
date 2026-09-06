/* Vercel Serverless Function：网易云会员音源（黑胶 cookie 服务端注入）
 *
 * 说明：
 *  - cookie 仅存于服务端环境变量 NETEASE_COOKIE（Vercel → Settings →
 *    Environment Variables → NETEASE_COOKIE = 完整 cookie 串），
 *    客户端代码/URL 中绝不出现；
 *  - 没有配置 cookie → 返回 503（前端自动静默跳过该路，其余源照常）；
 *  - 档位映射：jymaster/hires/lossless/exhigh/higher/standard。
 */
const LEVEL_BR = {
  jymaster: [999000, 'jymaster'],
  hires: [190000, 'hires'],
  lossless: [999000, 'lossless'],
  exhigh: [320000, 'exhigh'],
  higher: [192000, 'higher'],
  standard: [128000, 'standard'],
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ msg: 'method not allowed' });
  const cookie = (process.env.NETEASE_COOKIE || '').trim();
  if (!cookie) return res.status(503).json({ msg: 'cookie 未配置' });
  const id = String((req.query && req.query.id) || '');
  const level = String((req.query && req.query.level) || 'lossless');
  if (!/^\d+$/.test(id)) return res.status(400).json({ msg: 'bad id' });
  const [br, lv] = LEVEL_BR[level] || LEVEL_BR.lossless;
  try {
    const r = await fetch(
      'https://music.163.com/api/song/enhance/player/url?ids=' +
      encodeURIComponent('[' + id + ']') + '&br=' + br + '&level=' + lv,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://music.163.com/',
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(15000),
      });
    const j = await r.json().catch(() => ({}));
    const d = (j && j.data && j.data[0]) || {};
    if (d && d.url) {
      return res.status(200).json({ url: d.url, br: d.br || 0, level: d.level || lv, type: d.type || '' });
    }
    return res.status(404).json({ msg: '无源' });
  } catch (e) {
    return res.status(502).json({ msg: e.message || 'upstream error' });
  }
}
