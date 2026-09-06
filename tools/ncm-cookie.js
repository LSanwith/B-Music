/* ============================================================
 * 网易云 Cookie 自助获取脚本（扫码登录 → 母带权限自检 → 保存）
 *
 * 用法：node tools/ncm-cookie.js
 * 步骤：
 *   1) 生成二维码（ncm-qr.png 自动打开）
 *   2) 网易云 App 扫一扫 → 确认登录
 *   3) 脚本自动【母带权限自检】：用超清母带档请求测试歌
 *      （《I Knew It, I Knew You》3390083812，若权开级即 jymaster）
 *   4) 输出检测结果 + 保存 cookie 到 ncm-cookie.txt / netease_cookie.txt
 * 检测结论说明：
 *   - 超清母带 ✓  → 当前 cookie 可开母带；把 ncm-cookie.txt 发我接入
 *   - 无损（SVIP 档）→ 缺黑钻/音质权益；本 cookie 只能拿到无损
 *   - 受限/无源   → cookie 无效或账号有限制
 * ============================================================ */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function getWithCookie(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve({ json: (() => { try { return JSON.parse(d); } catch (e) { return { raw: d }; } })(), cookies: r.headers['set-cookie'] || [] }));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 母带权限自检：请求测试歌的超清母带档 */
function checkMaster(cookie) {
  return new Promise((resolve) => {
    https.get('https://music.163.com/api/song/enhance/player/url?ids=%5B3390083812%5D&br=999000&level=jymaster', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/', Cookie: cookie },
    }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const d0 = (j.data && j.data[0]) || {};
          resolve({ code: j.code, level: d0.level, br: d0.br || 0 });
        } catch (e) { resolve({ code: 0 }); }
      });
    }).on('error', () => resolve({ code: 0 }));
  });
}

(async () => {
  console.log('① 正在申请登录二维码…');
  const { unikey } = await getJSON('https://music.163.com/api/login/qrcode/unikey?type=1');
  if (!unikey) { console.error('申请二维码失败'); process.exit(1); }
  const loginUrl = 'https://music.163.com/login?codekey=' + encodeURIComponent(unikey);
  console.log('② 二维码已生成，正在用浏览器打开（新标签）…');
  console.log('   请用【网易云音乐 App → 扫一扫】并确认登录…');
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(loginUrl);
  // 每次下载到【新文件名】（防图片查看器缓存旧图），再打开本地文件（路径无 &，规避 cmd start 转义）
  const out = path.join(__dirname, 'ncm-qr-' + unikey.slice(0, 8) + '.png');
  await new Promise((resolve) => {
    https.get(qrUrl, (r) => {
      const w = fs.createWriteStream(out);
      r.pipe(w); w.on('finish', resolve);
    }).on('error', () => resolve());
  });
  // 打开本地二维码图片（无 & 转义问题，新文件名必为最新）
  try { execFile('cmd', ['/c', 'start', '', out]); } catch (e) { console.log('请手动打开二维码图片：' + out); }

  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    let r;
    try { r = await getWithCookie('https://music.163.com/api/login/qrcode/client/login?key=' + unikey + '&type=1'); }
    catch (e) { continue; }
    const code = (r.json && r.json.code) || 0;
    if (code === 801) { process.stdout.write('·'); continue; }
    if (code === 802) { console.log('\n已扫码，请在手机上点击【确认登录】…'); continue; }
    if (code === 800) { console.log('\n二维码已过期，请重新运行。'); process.exit(1); }
    if (code === 803) {
      let mu = '', csrf = '';
      for (const c of r.cookies) {
        if (c.indexOf('MUSIC_U=') === 0) mu = c.slice(8).split(';')[0];
        if (c.indexOf('__csrf=') === 0) csrf = c.slice(8).split(';')[0];
      }
      if (!mu) { console.log('\n未取到 MUSIC_U，请重试。'); process.exit(1); }
      const cookieStr = 'MUSIC_U=' + mu + (csrf ? '; __csrf=' + csrf : '');
      console.log('\n✅ 登录成功！正在做【母带权限自检】（测试歌：I Knew It, I Knew You…）');
      const chk = await checkMaster(cookieStr);
      /* ④ 权限结论 */
      if (chk.level === 'jymaster') {
        console.log('   ★★★ 超清母带【已解锁】 ★★★   → 当前 cookie 可开母带，直接接入即可');
      } else if (chk.level === 'hires' || chk.level === 'sky' || chk.level === 'dolby') {
        console.log('   高解析档可用：' + chk.level + '（Hi-Res/环绕级）');
      } else if (chk.level === 'lossless') {
        console.log('   无损 FLAC（SVIP 档）——母带需开通【黑钻/Hi-Res 音质权益】后重新获取 cookie；本 cookie 接入后最高无损');
      } else {
        console.log('   受限或无有效源（code=' + chk.code + '）——cookie 可能未登录/无权限，请确认账号状态');
      }
      fs.writeFileSync(path.join(__dirname, 'ncm-cookie.txt'),
        'MUSIC_U=' + mu + '\n__csrf=' + csrf + '\n', 'utf8');
      fs.writeFileSync(path.join(__dirname, 'netease_cookie.txt'),
        cookieStr + '\n', 'utf8');
      console.log('\n📄 已保存：ncm-cookie.txt（发我接入用）+ netease_cookie.txt（本地检测用）');
      process.exit(0);
    }
  }
  console.log('\n超时未完成扫码。');
  process.exit(1);
})().catch((e) => { console.error('脚本错误：', e.message); process.exit(1); });
