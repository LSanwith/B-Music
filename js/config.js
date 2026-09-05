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
  /* 网易云音乐 API 接口（唯一镜像源；原 sanwith 主接口已停用） */
  API_PRIMARY: 'https://silence-music-api.cc.cd',

  /* 红云点歌v4（备用下载源） */
  HONGYUN_ENDPOINT: 'https://api.xunjinlu.fun/apis/wymusicv4',
  /* 客户端不保存密钥：代理注入（见上方说明） */
  HONGYUN_KEY: '',

  /* 落七七（18years）网易云整合源（辅助下载源，与红云并行竞速） */
  NT18_ENDPOINT: 'https://api.18years.ink/Interface/Netease/',
  /* 客户端不保存密钥：代理注入（nt=1，见上方说明） */
  NT18_KEY: '',

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
