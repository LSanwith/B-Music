/* Vercel Serverless Function：网易云会员音源（黑胶/SVIP cookie 服务端注入）
 *
 * 实现：服务端带 cookie 请求 Silence 增强库（其实现了网易 eapi 母带通道）
 *      /song/url/v1?id=&level=&unlock=1&cookie=<NETEASE_COOKIE>
 *  安全：只向第三方转发 MUSIC_U + __csrf 两个字段（最小暴露面），
 *  其余 cookie 字段永不离开服务器；不写入任何日志/客户端。
 *
 * 返回：{ url, br, level, type }；拿不到地址或仍是试听片段时返回 404（交给其它音源）。
 */
/* 多镜像：官方 silence 新域名优先，其余镜像兜底 */
const MIRRORS = ['https://silence-music-api.de5.net', 'https://zm.wwoyun.cn', 'https://music.mcseekeri.com'];

/** 从完整 cookie 串裁剪为最小会话（仅 MUSIC_U + __csrf） */
function minimizeCookie(full) {
  const mu = /MUSIC_U=([^;]+)/.exec(full);
  const cs = /__csrf=([^;]+)/.exec(full);
  let out = mu ? 'MUSIC_U=' + mu[1] : '';
  if (cs) out += (out ? '; ' : '') + '__csrf=' + cs[1];
  return out;
}

/** 是否试听片段：响应带 freeTrialInfo 即为被截取的试听 */
function isTrial(d) {
  const t = d && d.freeTrialInfo;
  if (!t) return false;
  if (typeof t === 'string') return t !== 'null' && t !== 'undefined' && t !== '{}' && t.length > 0;
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ msg: 'method not allowed' });
  const cookie = minimizeCookie((process.env.NETEASE_COOKIE || '').trim());
  if (!cookie) return res.status(503).json({ msg: 'cookie 未配置' });
  const id = String((req.query && req.query.id) || '');
  const level = String((req.query && req.query.level) || 'lossless');
  if (!/^\d+$/.test(id)) return res.status(400).json({ msg: 'bad id' });
  try {
    let d = null;
    let lastMsg = '';
    for (let i = 0; i < MIRRORS.length && !d; i++) {
      const u = new URL(MIRRORS[i] + '/song/url/v1');
      u.searchParams.set('id', id);
      u.searchParams.set('level', level);
      u.searchParams.set('unlock', '1');
      u.searchParams.set('cookie', cookie);
      try {
        const r = await fetch(u.toString(), {
          headers: { 'User-Agent': 'BMusicWeb/1.0' },
          signal: AbortSignal.timeout(20000),
        });
        const jj = await r.json().catch(() => ({}));
        const dd = (jj && jj.data && jj.data[0]) || {};
        if (dd && dd.url && !isTrial(dd)) d = dd;
        else if (dd && dd.url) lastMsg = 'only trial';
      } catch (e) {
        lastMsg = e.message || 'upstream error';
      }
    }
    if (!d) return res.status(404).json({ msg: lastMsg || '无源' });
    return res.status(200).json({
      url: String(d.url).replace(/^http:\/\//i, 'https://'),
      br: d.br || 0,
      level: d.level || level,
      type: d.type || '',
    });
  } catch (e) {
    return res.status(502).json({ msg: (e && e.message) || 'upstream error' });
  }
}
