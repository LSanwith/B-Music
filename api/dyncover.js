/* Vercel Serverless Function：动态歌曲封面（mp4）
 * 网易云 /api/songplay/dynamic-cover 需要登录 cookie：
 *   - 环境变量 NETEASE_COOKIE（与 /api/cookieurl 用的同一个黑胶 cookie）
 *   - 未配置时返回 { code: 200, url: '' }，前端自动用静态封面
 * 返回 { code: 200, url }：url 为空表示这首歌没有动态封面。
 */
const CACHE = new Map();          // songId -> { t, url }
const TTL = 30 * 60 * 1000;       // 30 分钟（videoPlayUrl 自带签名与过期时间）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const id = String((req.query && req.query.id) || '').replace(/[^\d]/g, '');
  if (!id) return res.status(400).json({ code: -1, msg: 'bad id' });

  const hit = CACHE.get(id);
  if (hit && Date.now() - hit.t < TTL) return res.status(200).json({ code: 200, url: hit.url });

  const cookie = String(process.env.NETEASE_COOKIE || '').trim();
  if (!cookie) return res.status(200).json({ code: 200, url: '', msg: 'no cookie' });

  try {
    const r = await fetch('https://music.163.com/api/songplay/dynamic-cover?songId=' + encodeURIComponent(id), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Referer': 'https://music.163.com/',
        'Cookie': cookie,
      },
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => ({}));
    let url = (j && j.data && j.data.videoPlayUrl) || '';
    if (url) url = url.replace(/^http:/, 'https:');   // https 页面不能加载 http 媒体
    CACHE.set(id, { t: Date.now(), url: url });
    return res.status(200).json({ code: 200, url: url });
  } catch (e) {
    return res.status(200).json({ code: 200, url: '', msg: 'upstream error' });
  }
}
