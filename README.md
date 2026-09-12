# B·Music 网页版 🎵

一款可直接双击运行的本地音乐播放器（Web 版），支持搜索、歌单、滚动歌词、音质选择、收藏、账号云同步等功能。

> 🌐 **部署到 Cloudflare Pages** 见 [`CLOUDFLARE.md`](CLOUDFLARE.md)；
> **部署到 Vercel**（含 `api/` Serverless 函数与 KV 持久化）见 [`VERCEL.md`](VERCEL.md)。

## ✨ 功能

- **发现音乐**：Banner 轮播、推荐歌单、新歌速递、热门搜索
- **搜索**：单曲 / 歌单 / 专辑 / 歌手 四种类型，分页加载
- **歌单**：歌单广场（分类 + 热门/最新）、歌单详情、排行榜（官方榜 + 更多榜单）
- **播放**：底部播放栏 + 全屏播放页（Apple Music 布局：大封面 → 歌名/歌手 → 进度条+时间 → 音质小字 → 播放控制（模式/上一首/播放/下一首/收藏）→ 音量条；进度与音量条等宽、白色、极简无圆点，喇叭图标分居两侧），播放队列（显示"正在播放第 X 首"）、列表循环 / 单曲循环 / 随机
- **歌词**：基础 LRC 整段显示（活动行纯白、其余行灰色+模糊），左对齐大字号、**随唱平滑上移**（GPU 合成滚动）、可手动滚动预览（预览时不模糊）；右下角**固定工具栏**（不随歌词滚动）：翻译 / 歌单列表 / 歌词显示开关；含双语译文（字号随设置联动）；占位文案（加载中/纯音乐/加载失败）居中于封面中心、不可滚动不可选择
- **音质**：标准 / 较高 / 极高 / 无损 / Hi-Res / 超清母带（jymaster）六档；播放栏与播放页仅**纯展示**当前音质（小字、不可点击），在**设置**中切换；播放失败自动降级
- **图标**：阿里 iconfont 集合 #21274（iOS 风格）全套图标，集中管理于 `js/icons.js`，网页图标为音符；已禁用右键菜单，界面元素不可长按选中（歌词与输入框可选中）
- **收藏**：收藏歌曲、收藏歌单（侧边栏快捷入口）、最近播放，保存在本机浏览器；**登录账号后**，设置 + 收藏歌曲 + 收藏歌单自动云端同步（最近播放仅存本机）
- **账号**：QQ 邮箱等任意邮箱注册/登录；注册需**滑动验证**（拖到缺口）+ **密码二次确认**，完成后直接注册并登录（无需邮箱验证码）
- **下载**：歌曲列表「下载」按钮（优先走红云点歌下载接口，失败自动换源）
- **其他**：音量/静音、系统媒体键（Media Session）、空格/方向键快捷键、响应式（手机可用）

## 🚀 运行

**方式一（推荐）**：双击 `start.bat` —— 自动用本地服务器打开（需 Node.js）。

**方式二**：无 Node 环境直接双击 `index.html` 即可使用（功能完整）。

**方式三**：命令行启动

```bash
node server.js        # 默认端口 8899，浏览器自动打开
# 或指定端口
PORT=8080 node server.js
```

## 🔌 数据源

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| 搜索/歌单/歌词/详情 | `sience-music-api-backup.de5.net`（silence 备份域名）、`zm.wwoyun.cn`、`www.sanwith.cc.cd`（Sanwith，需 SKey）、`music.mcseekeri.com` | 网易云音乐 API（多镜像自动容灾；原 `silence-music-api.cc.cd` 域名 SSL 不稳） |
| 辅助搜索 / 解灰直链 | `www.sanwith.cc.cd`（Sanwith API） | 歌曲搜索与镜像并行、结果偏少时合并补充；`/song/url/match` 作为播放兜底（SKey 由代理 `sw=1` 注入） |
| 播放地址兜底 / 解锁 | `api.xunjinlu.fun/apis/wymusicv4`（红云点歌v4） | 镜像拿不到直链时兜底 |
| 播放地址竞速 / 解锁 | `api.18years.ink/Interface/Netease/`（落七七） | 与红云并行竞速，VIP 歌常用此源解锁 |

### 注册邮箱验证码（发信）

注册流程：填邮箱/密码 → **Altcha 人机验证** → 「发送验证码」→ 收邮件填 6 位码 → 注册。
发信用 [Nodemailer](https://github.com/nodemailer/nodemailer)（MIT），可用任意 SMTP 服务商，
配置只有 4 个变量（`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`，`SMTP_FROM` 可选），换服务商不用改代码。

**推荐服务商（免费额度，2026 年实测）**

| 服务商 | 免费额度 | 折合每月 | 说明 |
| --- | --- | --- | --- |
| **Brevo**（推荐） | 300 封/天 | **≈ 9000 封** | 免费额度最大、老牌稳定；`smtp-relay.brevo.com:587`，用户名 = 面板给的 SMTP 登录名，密码 = SMTP Key |
| Mailjet | 200 封/天 | 6000 封 | `in-v3.mailjet.com:587`，用户名 = API Key，密码 = Secret Key |
| Resend | 100 封/天 | 3000 封 | 开发者体验最好；`smtp.resend.com:465`，用户名 `resend`，密码 = API Key |
| QQ 邮箱 SMTP | 自有额度 | — | 免费但需邮箱授权码、限流较严；`smtp.qq.com:465` |
| SendGrid / Mailgun | 已取消免费额度（仅试用） | — | 不建议 |

**配置步骤（以 Brevo 为例）**

1. [brevo.com](https://www.brevo.com) 注册（免费，无需信用卡）；
2. Settings → Senders, Domains & Dedicated IPs → **Domains** 添加 `de5.net`，按提示到域名 DNS
   加 DKIM/验证记录（想快速验证也可先只验证一个发件邮箱）；
3. Settings → **SMTP & API** → SMTP 页签：复制 SMTP 登录名（形如 `xxxxx001@smtp-brevo.com`），
   并生成一个 **SMTP key**；
4. 本地：把这几行填进 `mail.local`（模板已备好，去掉注释即可），重启本地服务；
   线上（Vercel）：Settings → Environment Variables 配同名变量，然后 Redeploy；
5. 自检：`node tools/test-mail.js 你的邮箱@qq.com`（先认证自检、再真发一封测试邮件）。

服务端限制：必须先过人机验证才发信；同一邮箱 60 秒内只能发一次、每天最多 10 次；
验证码 10 分钟有效、最多试 5 次、注册成功即失效。未配置 SMTP 时接口返回 503 并提示，不影响其它功能。


播放地址解析顺序（**并行竞速**）：**镜像接口（下载直链 → 播放直链）→ 红云点歌v4 → 落七七**，全部失败才提示无法播放。

### 完整音频（拒绝试听片段）

网易云 `/song/url/v1` 对未登录/非会员会返回**试听片段**（响应带 `freeTrialInfo`
起止时间，如 30 秒试听）。本应用：

- 一律**拒绝带 `freeTrialInfo` 的试听链接**；
- 优先使用 `/song/download/url/v1` 客户端**下载直链**（完整音频，免费歌可达 Hi-Res）；
- VIP 歌曲自动落到**红云点歌v4** 获取完整源（实测 VIP 歌可拿到完整 FLAC）；
- 全部来源都拿不到完整音频时才提示无法播放，绝不播放试听片段。

### 关于跨域（CORS）与本地代理

三个上游接口的 CORS 响应头并不可靠（silence 的 CDN 共享缓存会偶发返回
错误的 `Access-Control-Allow-Origin`；红云点歌返回格式错误的 `*,*`），因此：

- 通过 `start.bat` / `node server.js` 启动时，页面**自动走同源代理**
  （`server.js` 提供的 `/proxy`，仅允许转发上述三个域名），彻底绕开 CORS 问题；
- 直接双击 `index.html`（`file://` 模式）时无代理可用，自动退化为直连并自动重试，
  属于尽力而为模式，部分接口可能因上游 CORS 不稳定而失败；
- 音频播放本身不依赖 CORS（媒体元素直连 CDN），下载功能使用 CDN 的
  `Access-Control-Allow-Origin: *` 直接抓取。

## 🔑 密钥说明（重要）

红云点歌接口的私有密钥位于 `js/config.js` 的 `HONGYUN_KEY`。该密钥：

- **只发送到 `api.xunjinlu.fun` 这一个地址**，不会发送给任何其他域名；
- 请**不要**把它分享给他人、上传公开仓库或部署到公网服务器；
- 可以在应用内「设置 → 红云点歌备用接口 Key」随时更换（保存在本机浏览器，覆盖内置值）。

> 本应用为纯前端静态应用，密钥无法做到绝对保密（浏览器内可见）。如需更安全，
> 建议自行部署一个极简后端代理（如 Cloudflare Worker）来保管密钥。

## 📁 项目结构

```
music/
├── index.html        # 应用外壳
├── css/style.css     # 全部样式（Apple Music 风格主题）
├── js/
│   ├── config.js     # ★ 接口地址与密钥（注意保护）
│   ├── icons.js      # 图标库（阿里 iconfont 风格 SVG，可整体替换）
│   ├── api.js        # API 层：搜索/歌单/歌词(YRC)/播放地址降级链/同源代理
│   ├── player.js     # 播放器核心：队列/模式/音质/降级
│   ├── lrc.js        # LRC + YRC 逐字歌词解析
│   ├── store.js      # 本地存储：收藏/最近播放/设置
│   ├── ui.js         # UI 工具
│   └── app.js        # 主应用：路由/视图/逐字歌词滚动/队列/设置
├── server.js         # 零依赖本地服务器 + /proxy 同源代理
├── start.bat         # Windows 一键启动
└── README.md
```

## 📝 说明

- 歌曲直链有时效性（约 20 分钟），请勿长期缓存；
- 部分 VIP / 版权受限歌曲无法获取播放地址，属正常现象，会提示并跳过；
- 所有收藏数据仅保存在本机浏览器 localStorage 中。
