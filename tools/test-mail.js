/* 发信配置自检 + 测试发信（本地工具）
 *
 * 用法：
 *   node tools/test-mail.js                        # 只做连接/认证自检（不真发信）
 *   node tools/test-mail.js 收件人@qq.com           # 认证 + 真发一封测试邮件
 *
 * 配置来源与 server.js 一致：环境变量优先，其次仓库根目录的 mail.local。
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const root = path.join(__dirname, '..');
const conf = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || '',
};
if (!conf.host || !conf.user || !conf.pass) {
  try {
    fs.readFileSync(path.join(root, 'mail.local'), 'utf8').split(/\r?\n/).forEach((line) => {
      const m = /^\s*(SMTP_[A-Z]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) return;
      if (m[1] === 'SMTP_HOST') conf.host = m[2];
      else if (m[1] === 'SMTP_PORT') conf.port = Number(m[2]) || 465;
      else if (m[1] === 'SMTP_USER') conf.user = m[2];
      else if (m[1] === 'SMTP_PASS') conf.pass = m[2];
      else if (m[1] === 'SMTP_FROM') conf.from = m[2];
    });
  } catch (e) { /* 无 mail.local */ }
}

const to = process.argv[2] || '';

(async () => {
  console.log('配置：host=' + (conf.host || '(空)') + '  port=' + conf.port +
    '  user=' + (conf.user || '(空)') + '  pass=' + (conf.pass ? conf.pass.length + ' 位' : '(空)') +
    '  from=' + (conf.from || conf.user || '(空)'));
  if (!conf.host || !conf.user || !conf.pass) {
    console.log('✗ 配置不完整：请在 mail.local 或环境变量里补齐 SMTP_HOST / SMTP_USER / SMTP_PASS');
    process.exit(1);
  }
  const tr = nodemailer.createTransport({
    host: conf.host, port: conf.port, secure: conf.port === 465,
    auth: { user: conf.user, pass: conf.pass },
    connectionTimeout: 12000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  try {
    await tr.verify();
    console.log('✓ SMTP 连接与认证成功（' + conf.host + ':' + conf.port + '）');
  } catch (e) {
    console.log('✗ 认证失败：' + String(e.message).replace(/\s+/g, ' '));
    process.exit(1);
  }
  if (!to) {
    console.log('（未给收件人，只做了自检。要真发一封：node tools/test-mail.js 你的邮箱@qq.com）');
    tr.close();
    return;
  }
  const code = String(100000 + Math.floor(Math.random() * 900000));
  try {
    const info = await tr.sendMail({
      from: (conf.from || conf.user),
      to: to,
      subject: 'B·Music 发信测试：' + code,
      text: '这是一封发信测试邮件，验证码示例 ' + code + '。收到即表示 SMTP 配置可用。',
      html: '<div style="font-family:sans-serif;font-size:15px">这是一封 <b>B·Music</b> 发信测试邮件<br>验证码示例：<b style="font-size:22px;color:#fa2d3c">' + code + '</b></div>',
    });
    console.log('✓ 已发送到 ' + to + '  messageId=' + info.messageId);
    console.log('  对方服务器响应：' + (info.response || '').replace(/\s+/g, ' '));
  } catch (e) {
    console.log('✗ 发送失败：' + String(e.message).replace(/\s+/g, ' '));
    process.exit(1);
  } finally {
    tr.close();
  }
})();
