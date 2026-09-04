# ▲ 部署到 Vercel（域名：www.bmusic.de5.net）

仓库根目录即应用（`index.html` + `css/` + `js/`），后端位于 `api/`（Vercel Serverless Functions）：

| 文件 | 作用 |
| --- | --- |
| `api/[[path]].js` | 账号 API（注册/登录/滑动验证/数据同步），catch-all `/api/*` |
| `api/proxy.js` | 上游转发代理（CORS 规避 + 红云密钥注入），`vercel.json` 把 `/proxy` 重写过来 |

## 一、连接仓库部署

1. [vercel.com](https://vercel.com) → **Add New → Project** → 导入 `LSanwith/B-Music`；
2. 框架预设：**Other**（无需配置，默认根目录即仓库根）；
3. 部署完成后打开 `https://<项目>.vercel.app/`，应能注册/登录/播放。

## 二、KV 持久化（账号数据，必须）

1. 控制台 → **Storage** → **Create Database** → **KV (Redis)** → 创建（免费档即可）；
2. 创建后选 **Connect to Project** → 选择本项目；
3. Vercel 会自动注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 环境变量，无需手动配置。

> 不连 KV 也能跑，但数据只存在函数内存中，冷启动后会丢失。

## 三、密钥 Secret（红云点歌兜底，可选但推荐）

项目 → **Settings** → **Environment Variables** → 添加：

| 名称 | 值 |
| --- | --- |
| `HONGYUN_KEY` | 你的红云点歌密钥（形如 sk-xxxx…，在红云设置页获取） |

添加后重新部署（或触发一次 Deployments → Redeploy）。

## 四、自定义域名 www.bmusic.de5.net

项目 → **Settings** → **Domains** → 输入 `www.bmusic.de5.net` → Add。

## 五、DNS 解析记录（在你当前 DNS 服务商配置）

| 主机记录 | 类型 | 值 |
| --- | --- | --- |
| `www` | CNAME | `cname.vercel-dns.com` |
| `bmusic.de5.net`（根域，可选） | A | `76.76.21.21` |

> 根域 A 记录 `76.76.21.21` 是 Vercel 官方给出的解析地址（会自动 301 到 www）；
> 若 DNS 托管在 Cloudflare，也可用 CNAME flattening 指向 `cname.vercel-dns.com`。

## 六、部署后自检

1. 打开 `https://www.bmusic.de5.net/`；
2. 浏览器访问 `https://www.bmusic.de5.net/api/captcha` 应返回 `{"id":"...","target":..}`；
3. 注册账号（滑动验证 → 直接注册登录）→ 收藏一首 → 退出 → 重登，确认数据恢复（KV 已连时）；
4. 播放任意歌曲，确认 F12 网络面板中 API 都走同域 `/proxy`。

## 注意

- 本地开发仍用 `node server.js`（数据在 `data/db.json`）；线上数据在 Vercel KV，两者互不相通。
- `data/` 已被 `.gitignore` 排除，请勿提交到 GitHub（公开仓库）。
- 本仓库同时保留了 `functions/`（Cloudflare Pages 版），Vercel 会忽略它，互不影响。
