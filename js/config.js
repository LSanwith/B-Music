/* ============================================================
 * B·Music 网页版 · 全局配置
 *
 * 🔑 密钥安全（重要）
 * 红云点歌v4 / 落七七（18years）两个第三方源的私有密钥【不存放在
 * 客户端代码中】——公开仓库/浏览器里都不会出现。密钥只由服务端注入：
 *   - 本地（node server.js）：读取 ./key.local / ./ntkey.local
 *     （均被 .gitignore 排除，不随仓库上传）或环境变量
 *     HONGYUN_KEY / NT18_KEY；
 *   - 网页版（Vercel/Cloudflare）：由平台环境变量注入。
 * 浏览器发起的第三方源请求一律经同源代理（/proxy?hk=1 或 nt=1），
 * URL 中不携带密钥。
 * ============================================================ */
window.APP_CONFIG = {
  /* 网易云音乐 API 接口（多镜像：按顺序尝试，失败自动切下一个并记住可用的那个）
   * 说明：原主镜像 silence-music-api.cc.cd 域名 SSL 不稳（另有备份域名 https://sience-music-api-backup.de5.net），
   *       因此改为多镜像容灾；三个镜像都是标准 NeteaseCloudMusicApi 部署；Sanwith 需带 SKey（由代理注入）。 */
  API_MIRRORS: [
    'https://sience-music-api-backup.de5.net',
    'https://zm.wwoyun.cn',
    'https://www.sanwith.cc.cd',
    'https://music.mcseekeri.com',
  ],
  /* 兼容旧引用（= 镜像列表第一个） */
  API_PRIMARY: 'https://sience-music-api-backup.de5.net',

  /* 红云点歌v4（备用下载源） */
  HONGYUN_ENDPOINT: 'https://api.xunjinlu.fun/apis/wymusicv4',
  /* 客户端不保存密钥：代理注入（见上方说明） */
  HONGYUN_KEY: '',

  /* 落七七（18years）网易云整合源（辅助下载源，与红云并行竞速） */
  NT18_ENDPOINT: 'https://api.18years.ink/Interface/Netease/',
  /* 客户端不保存密钥：代理注入（nt=1，见上方说明） */
  NT18_KEY: '',

  /* Sanwith 网易云 API（辅助源：补充搜索、封面图片与解灰播放地址）
   * 说明：所有请求需带 SKey；密钥由服务端注入（代理 sw=1），浏览器 URL 不携带密钥。
   * 服务端密钥来源：Vercel 环境变量 SANWITH_SKEY；本地 ./skey.local 或同名环境变量。 */
  SANWITH_ENDPOINT: 'https://www.sanwith.cc.cd',
  SANWITH_SKEY: '',

  /* bugpk 网易云直链源（兜底播放源，无损及以下；无需密钥，经同源代理转发） */
  BUGPK_ENDPOINT: 'https://api.bugpk.com',

  /* oiapi 网易云完整直链源（兜底，无损及以下；无需密钥，经同源代理转发） */
  OIAPI_ENDPOINT: 'https://oiapi.net',

  /*
   * 本地代理路径：各上游接口的 CORS 响应头不稳定（CDN 层共享缓存 / 格式错误），
   * 因此通过同源代理转发（server.js 提供 /proxy）。
   *  - 通过 server.js / start.bat 启动时：自动走代理，最稳定；
   *  - 直接双击 index.html（file://）：无代理可用，自动退化为直连（尽力而为；
   *    密钥源除外——绝不带密钥直连，仅当本机服务器在跑时可用）。
   */
  PROXY_PATH: '/proxy',

  /* 音质选项（level 参数；超清母带 jymaster 为最高档） */
  QUALITY_LEVELS: [
    { key: 'jymaster', label: '超清母带', desc: 'FLAC · 最高音质' },
    { key: 'hires',    label: 'Hi-Res', desc: '高解析无损' },
    { key: 'lossless', label: '无损', desc: 'FLAC · 推荐' },
    { key: 'exhigh',   label: '极高', desc: '320Kbps' },
    { key: 'higher',   label: '较高', desc: '192Kbps' },
    { key: 'standard', label: '标准', desc: '128Kbps · 最省流量' },
  ],
  DEFAULT_QUALITY: 'lossless',
};
