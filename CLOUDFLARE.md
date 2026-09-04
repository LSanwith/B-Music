# ☁️ 部署到 Cloudflare Pages（域名：www.sanwith.de5.net）

本目录已包含 **Cloudflare Pages Functions**（`functions/` 下的代理与账号 API），
部署后 `/proxy` 与 `/api/*` 会在 Cloudflare 边缘运行，账号/收藏云同步使用 KV 持久化。

## 一、上传到 GitHub

1. 在 github.com 新建一个**私有仓库**（如 `b-music-web`），不要勾选任何初始化文件；
2. 在项目目录执行（已初始化好 git 与 `.gitignore`，data/ 不会上传）：

```bash
git add -A
git commit -m "B·Music 网页版 v1.5"
git branch -M main
git remote add origin https://github.com/<你的用户名>/b-music-web.git
git push -u origin main
```

## 二、Cloudflare Pages 部署

> ⚠️ 仓库里应用位于 `music/` 子目录，**必须**在构建设置里把根目录指到 `music/`，
> 否则 `functions/` 不会被识别、静态文件也找不到。

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers 和 Pages** → **创建** → **Pages** → **连接到 Git**，授权并选择 `LSanwith/B-Music` 仓库；
2. 构建设置：
   - **根目录（Root directory）：`music`** ← 关键！
   - 框架预设：**无（None）**
   - 构建命令：留空
   - 构建输出目录：`/`（相对根目录，保持默认）
   - 环境变量：无需
3. 保存并部署（`music/functions/` 会被自动识别为 Pages Functions）。

## 三、KV 绑定（账号数据持久化，必须）

1. 控制台 → **Workers 和 Pages** → **KV** → 创建命名空间，如 `bmusic-db`；
2. 进入 Pages 项目 → **设置** → **绑定** → **添加绑定**：
   - 类型：**KV 命名空间**
   - 变量名：`DB`
   - 选择命名空间：`bmusic-db`
3. 重新部署一次让绑定生效。

## 四、密钥 Secret（红云点歌兜底，可选但推荐）

Pages 项目 → **设置** → **环境变量**（生产环境）→ 添加：

| 变量名 | 值 |
| --- | --- |
| `HONGYUN_KEY` | 你的红云点歌密钥（形如 sk-xxxx…，在红云设置页获取） |

（勾选"加密"；不设置则红云兜底不可用，网易云主/备接口仍正常。）

## 五、绑定域名 www.sanwith.de5.net

Pages 项目 → **自定义域** → **设置自定义域** → 输入 `www.sanwith.de5.net` → 保存。
（若 de5.net 的 DNS 已托管在 Cloudflare，此处会自动生成 DNS 记录；否则按下方手动添加。）

## 六、DNS 解析记录（在你当前 DNS 服务商处配置）

| 主机记录 | 类型 | 值 / 目标 | TTL |
| --- | --- | --- | --- |
| `www` | CNAME | `<你的项目名>.pages.dev`（项目部署后显示的域名） | 自动 |
| `sanwith.de5.net`（@ 根域，可选） | CNAME / ALIAS | `<你的项目名>.pages.dev` | 自动 |

- 若你的 DNS 服务商不支持根域 CNAME（多数国内服务商支持 ALIAS/隐形转发），
  可用 A 记录指向 Cloudflare 的 Pages 地址：`192.0.2.1`（与 `192.0.2.2` 二选一即可）；
- 只访问 `www` 子域的话，仅配置第一条即可；
- **更省事的方式**：把 de5.net 的域名**添加到 Cloudflare 托管**（改 NS 到 Cloudflare），
  然后在 Pages 自定义域里直接添加 `www.sanwith.de5.net` 与 `sanwith.de5.net`，
  Cloudflare 会自动创建 DNS 记录并处理根域跳转，无需手动配置。

## 七、部署后自检

1. 打开 `https://www.sanwith.de5.net`；
2. 注册账号（滑动验证 → 直接注册登录）→ 收藏一首歌 → 退出 → 重登，确认数据恢复；
3. 播放任意歌曲，确认 `/proxy` 生效（F12 网络面板中 API 请求都走同域 `/proxy`）。

## 注意

- 本地开发仍用 `node server.js`（数据在 `data/db.json`）；云端数据在 Cloudflare KV，
  两者互不相通，账号需分别在两端注册。
- 云端密码哈希使用 PBKDF2（Workers 环境），与本地 scrypt 不同，属正常。
- `data/` 已被 `.gitignore` 排除，不会上传到 GitHub。
