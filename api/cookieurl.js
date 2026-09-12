/* Vercel Serverless Function：网易云会员音源（黑胶/SVIP cookie 服务端注入）
 *
 * 实现：服务端带 cookie 请求 Silence 增强库（其实现了网易 eapi 母带通道）
 *      /song/url/v1?id=&level=&unlock=1&cookie=<NETEASE_COOKIE>
 *  安全：只向第三方转发 MUSIC_U + __csrf 两个字段（最小暴露面），
 *  其余 cookie 字段永不离开服务器；不写入任何日志/客户端。
 */
/* 多镜像：原 silence-music-api.cc.cd 域名已失效，按顺序尝试 */
const MIRRORS = ['https://zm.wwoyun.cn', 'https://music.mcseekeri.com'];

/** 从完整 cookie 串裁剪为最小会话（仅 MUSIC_U + __csrf） */
function minimizeCookie(full) {
  const mu = /MUSIC_U=([^;]+)/.exec(full);
  const cs = /__csrf=([^;]+)/.exec(full);
  let out = mu ? 'MUSIC_U=' + mu[1] : '';
  if (cs) out += (out ? '; ' : '') + '__csrf=' + cs[1];
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ msg: 'method not allowed' });
  const cookie = minimizeCookie((process.env.NETEASE_COOKIE || '').trim());
  if (!cookie) return res.status(503).json({ msg: 'cookie 未配置' });
  const id = String((req.query && req.query.id) || '');
  const level = String((req.query && req.query.level) || 'lossless');
  if (!/^\d+$/.test(id)) return res.status(400).json({ msg: 'bad id' });
  try {
    let j = null;
    for (let i = 0; i < MIRRORS.length && !j; i++) {
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
        if (dd && dd.url) j = jj;
      } catch (e) { /* 换下一个镜像 */ }
    }
    const d = (j && j.data && j.data[0]) || {};
  } catch (e) {
    return res.status(502).json({ msg: e.message || 'upstream error' });
  }
}
