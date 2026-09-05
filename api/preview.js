/* Vercel Serverless Function：短链预览页（/s/<type>/<id> → og 卡片）
 *
 * 微信/QQ 等外部 App 抓取链接卡片时【不带 hash】，因此纯 hash 路由无法被
 * 爬虫识别；本函数把 /s/<type>/<id> 渲染成一个只含 og 元信息的最小 HTML，
 * 并自动跳回应用内落地页 /index.html#/<type>/<id>（meta refresh + JS 双保险）。
 * 路由由 vercel.json rewrite 映射：
 *   /s/:type/:id  →  /api/preview?type=:type&id=:id
 *
 * 元数据来源：镜像 https://silence-music-api.cc.cd （与 js/config.js
 * API_PRIMARY 一致），一律带 realIP（同 js/api.js REAL_IP），超时 10s。
 * 图片链接 http:// 一律转 https://；取不到图则省略 og:image（仍可预览标题）。
 */
const MIRROR = 'https://silence-music-api.cc.cd';
const REAL_IP = '116.25.146.177';
const TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (compatible; BMusicPreview/1.0)';

const TYPE_LABEL = { song: '歌曲', playlist: '歌单', album: '专辑', artist: '歌手' };

/* ---------- 转义与工具 ---------- */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** 图片地址一律 https（微信要求 og:image 为 https） */
function toHttpsImg(u) {
  if (!u) return '';
  if (/^http:\/\//i.test(u)) return 'https://' + u.slice(7);
  if (/^\/\//.test(u)) return 'https:' + u;
  return u;
}
function upUrl(path, params) {
  const u = new URL(path, MIRROR);
  u.searchParams.set('realIP', REAL_IP);
  if (params) {
    for (const k of Object.keys(params)) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') u.searchParams.set(k, params[k]);
    }
  }
  return u.toString();
}
function fetchJson(url) {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA } })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}

/* ---------- 各类型元数据提取 ---------- */
async function fetchMeta(type, id) {
  let j;
  if (type === 'song') {
    j = await fetchJson(upUrl('/song/detail', { ids: id }));
    const s = (j && j.songs && j.songs[0]) || null;
    if (!s || !s.name) throw new Error('no song');
    const ar = s.ar || s.artists || [];
    const artists = ar.map(a => a && a.name).filter(Boolean).join(' / ');
    const al = s.al || s.album || {};
    const img = toHttpsImg(al.picUrl || al.coverImgUrl || '');
    return {
      title: s.name,
      desc: '歌曲《' + s.name + '》' + (artists ? ' — ' + artists : ''),
      img: img,
    };
  }
  if (type === 'playlist') {
    j = await fetchJson(upUrl('/playlist/detail', { id: id }));
    const p = (j && j.playlist) || null;
    if (!p || !p.name) throw new Error('no playlist');
    const creator = (p.creator && p.creator.nickname) ? p.creator.nickname : '';
    const cnt = p.trackCount ? ' · 共 ' + p.trackCount + ' 首' : '';
    const img = toHttpsImg(p.coverImgUrl || '');
    return {
      title: p.name,
      desc: '歌单《' + p.name + '》' + (creator ? ' · 创建者：' + creator : '') + cnt,
      img: img,
    };
  }
  if (type === 'album') {
    j = await fetchJson(upUrl('/album', { id: id }));
    const a = (j && j.album) || null;
    if (!a || !a.name) throw new Error('no album');
    const artist = (a.artist && a.artist.name) || '';
    const img = toHttpsImg(a.picUrl || a.coverImgUrl || '');
    return {
      title: a.name,
      desc: '专辑《' + a.name + '》' + (artist ? ' — ' + artist : ''),
      img: img,
    };
  }
  // artist
  j = await fetchJson(upUrl('/artist/detail', { id: id }));
  const d = (j && j.data) || {};
  const a = d.artist || d;
  if (!a || !a.name) throw new Error('no artist');
  const img = toHttpsImg(a.img1v1Url || a.picUrl || a.cover || a.avatar || '');
  return {
    title: a.name,
    desc: '歌手：' + a.name,
    img: img,
  };
}

/* ---------- HTML 组装 ---------- */
/** 跳回应用落地页的相对根路径（预览页位于 /s/<type>/<id>，根相对路径解析正确） */
function landingPath(type, id) {
  return '/index.html#/' + type + '/' + id;
}

/** 带卡片预览的最小页 */
function previewHtml(title, desc, img, hash) {
  const t = escHtml(title);
  const d = escHtml(desc);
  const imgHref = escHtml(img);
  const imgMeta = imgHref
    ? '\n    <meta property="og:image" content="' + imgHref + '">'
    : '';
  // JSON.stringify 产生合法 JS 字符串字面量；再把 < 转义防 </script> 逃逸
  const jsHash = JSON.stringify(hash).replace(/</g, '\\u003c');
  const attrs = 'style="margin:0;background:#f5f6f8;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;text-align:center;padding:48px 16px;"';
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
    '<body ' + attrs + '>\n' +
    '  <a href="' + hash + '" style="text-decoration:none;color:inherit;">' + imgBody +
    '\n    <div style="margin-top:18px;font-size:19px;font-weight:600;line-height:1.4;">' + t + '</div>\n' +
    (d ? '    <div style="margin-top:6px;font-size:13px;color:#8a9099;line-height:1.6;">' + d + '</div>' : '') +
    '\n  </a>\n' +
    '  <p style="margin-top:28px;font-size:12px;color:#a6adb5;">正在打开 B·Music…</p>\n' +
    '</body>\n</html>\n';
}

/** 元数据不可用时的兜底页：无卡片，但浏览器访问仍能跳回应用 */
function fallbackHtml(hash, label) {
  const jsHash = JSON.stringify(hash).replace(/</g, '\\u003c');
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<title>' + label + ' · B·Music</title>\n' +
    '<meta http-equiv="refresh" content="0;url=\'' + hash + '\'">\n' +
    '<script>location.replace(' + jsHash + ');</script>\n' +
    '</head>\n' +
    '<body style="margin:0;background:#f5f6f8;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;text-align:center;padding:48px 16px;">\n' +
    '  <p style="font-size:15px;">' + label + '</p>\n' +
    '  <p style="margin-top:16px;font-size:12px;color:#a6adb5;">正在打开 B·Music…</p>\n' +
    '</body>\n</html>\n';
}

/* ---------- Vercel 入口 ---------- */
export default async function handler(req, res) {
  const sendHtml = (code, body, extra) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(code).send(body);
    return res;
  };
  if (req.method !== 'GET') {
    return sendHtml(404, fallbackHtml('/index.html', '预览不可用'));
  }
  const type = String((req.query && req.query.type) || '');
  const id = String((req.query && req.query.id) || '');
  const label = TYPE_LABEL[type];
  if (!label || !/^\d+$/.test(id)) {
    return sendHtml(404, fallbackHtml('/index.html', '无效链接'));
  }
  const hash = landingPath(type, id);
  try {
    const meta = await fetchMeta(type, id);
    return sendHtml(200, previewHtml(meta.title, meta.desc, meta.img, hash));
  } catch (e) {
    // 镜像超时/取不到元数据：返回 404（爬虫不产卡），浏览器仍会被 refresh 跳回应用
    return sendHtml(404, fallbackHtml(hash, label + '内容暂不可获取'));
  }
}
