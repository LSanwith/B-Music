/* ============================================================
 * 网易云 Cookie 自助获取脚本（扫码登录 → 输出 MUSIC_U / __csrf）
 *
 * 用法：node tools/ncm-cookie.js
 * 步骤：
 *   1) 脚本生成二维码图片 ncm-qr.png 并自动打开
 *   2) 用【网易云音乐 App → 扫一扫】扫屏幕上的二维码并确认登录
 *   3) 脚本轮询登录状态，成功后输出 cookie 并保存到 ncm-cookie.txt
 *      （把 ncm-cookie.txt 里的内容发给我即可接入会员音源）
 * 说明：cookie 在你的本机生成（与你平时登录同一会话链路），
 *       仅写入本文件与你选择的服务器环境变量，请妥善保管。
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

(async () => {
  console.log('① 正在申请登录二维码…');
  const { unikey } = await getJSON('https://music.163.com/api/login/qrcode/unikey?type=1');
  if (!unikey) { console.error('申请二维码失败'); process.exit(1); }
  const loginUrl = 'https://music.163.com/login?codekey=' + encodeURIComponent(unikey);
  console.log('② 二维码已生成（ncm-qr.png 已自动打开）。');
  console.log('   请用【网易云音乐 App → 扫一扫】扫描并确认登录…');
  // 下载二维码图片到本地并打开
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(loginUrl);
  const out = path.join(__dirname, 'ncm-qr.png');
  await new Promise((resolve) => {
    https.get(qrUrl, (r) => {
      if (r.statusCode !== 200) { console.log('二维码下载失败，请手动打开：' + loginUrl); fs.writeFileSync(out, ''); resolve(); return; }
      const w = fs.createWriteStream(out);
      r.pipe(w); w.on('finish', resolve);
    }).on('error', () => resolve());
  });
  try { execFile('cmd', ['/c', 'start', '', out]); } catch (e) { console.log('未能自动打开图片，请手动查看 ncm-qr.png；或手机浏览器访问：' + loginUrl); }

  // 轮询登录状态：801 等待扫码 / 802 已扫待确认 / 803 登录成功 / 800 过期
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    let r;
    try { r = await getWithCookie('https://music.163.com/api/login/qrcode/client/login?key=' + unikey); }
    catch (e) { continue; }
    const code = (r.json && r.json.code) || 0;
    if (code === 801) { process.stdout.write('·'); continue; }
    if (code === 802) { console.log('\n已扫码，请在手机上点击【确认登录】…'); continue; }
    if (code === 800) { console.log('\n二维码已过期，请重新运行脚本。'); process.exit(1); }
    if (code === 803) {
      let mu = '', csrf = '';
      for (const c of r.cookies) {
        if (c.indexOf('MUSIC_U=') === 0) mu = c.slice(8).split(';')[0];
        if (c.indexOf('__csrf=') === 0) csrf = c.slice(8).split(';')[0];
      }
      if (!mu) { console.log('\n已登录但未取到 MUSIC_U（cookie 响应异常），请重试或改用浏览器获取。'); process.exit(1); }
      fs.writeFileSync(path.join(__dirname, 'ncm-cookie.txt'),
        'MUSIC_U=' + mu + '\n__csrf=' + csrf + '\n', 'utf8');
      console.log('\n✅ 登录成功！');
      console.log('   请打开 ncm-cookie.txt 复制全部内容发给我（或自行保存）：');
      console.log('   MUSIC_U=' + mu.slice(0, 24) + '…（完整见文件）');
      process.exit(0);
    }
    // 其它 code（如 405/502/风控）继续轮询
    await sleep(1000);
  }
  console.log('\n超时未完成扫码，请重新运行脚本尝试。');
  process.exit(1);
})().catch((e) => { console.error('脚本错误：', e.message); process.exit(1); });
