/* 邮件发送（注册验证码）
 *
 * 用 Nodemailer（MIT，https://github.com/nodemailer/nodemailer）—— Node 生态最通用的发信库。
 * 默认走 QQ 邮箱 SMTP（本应用只允许 QQ 邮箱注册，同域投递送达率最好、免费、无需第三方服务）：
 *   1) 登录 QQ 邮箱 → 设置 → 账户 → 开启「POP3/SMTP服务」→ 生成「授权码」（16 位）
 *   2) 配置环境变量（Vercel 项目 Settings → Environment Variables；本地写 ./mail.local）：
 *        SMTP_HOST  smtp.qq.com
 *        SMTP_PORT  465
 *        SMTP_USER  你的QQ邮箱（如 123456@qq.com）
 *        SMTP_PASS  上面生成的授权码（不是QQ密码）
 *        SMTP_FROM  可选，默认 = SMTP_USER
 *  也兼容其它服务商（Resend/Brevo/Gmail 等）——换 HOST/PORT/USER/PASS 即可。
 */
import nodemailer from 'nodemailer';

let _transport = null;

export function mailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport() {
  if (_transport) return _transport;
  const port = Number(process.env.SMTP_PORT || 465);
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465, // 465 = 隐式 TLS；587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });
  return _transport;
}

/** 发送验证码邮件（务必 await：Vercel 函数在响应后会暂停后台任务） */
export async function sendCodeMail(to, code, minutes) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const mins = minutes || 10;
  const subject = 'B·Music 注册验证码：' + code;
  const text = '你的 B·Music 注册验证码是 ' + code + '，' + mins + ' 分钟内有效。若非本人操作请忽略本邮件。';
  const html =
    '<div style="max-width:520px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;background:#0b0b0e;color:#e8e8ee;border-radius:16px;padding:28px 26px">' +
    '<div style="font-size:18px;font-weight:800;letter-spacing:.5px">B·Music <span style="font-weight:400;opacity:.6;font-size:13px">网页版</span></div>' +
    '<div style="margin:18px 0 8px;font-size:14px;opacity:.8">你的注册验证码是</div>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#fa2d3c;margin:6px 0 16px">' + code + '</div>' +
    '<div style="font-size:13px;line-height:1.8;opacity:.72">验证码 ' + mins + ' 分钟内有效，请勿转发给他人。<br>若非你本人操作，忽略本邮件即可。</div>' +
    '<div style="margin-top:22px;padding-top:14px;border-top:1px solid rgba(255,255,255,.12);font-size:12px;opacity:.5">本邮件由系统自动发送，请勿直接回复。</div>' +
    '</div>';
  return transport().sendMail({ from: '"B·Music" <' + from + '>', to: to, subject: subject, text: text, html: html });
}
