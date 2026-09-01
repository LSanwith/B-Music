/* ============================================================
 * B·Music 网页版 · 全局配置
 *
 * ⚠️ 密钥安全提醒 ⚠️
 * 下方 HONGYUN_KEY 是「红云点歌v4」接口的私有访问密钥。
 * 它只应被发送到 api.xunjinlu.fun 这一个地址，请勿：
 *   - 上传到公开仓库 / 网盘 / 聊天群
 *   - 分享给任何人
 * 本应用仅在「主接口无法取得播放地址」时，才会携带该密钥
 * 请求红云点歌接口作为兜底。
 *
 * 你可以在 设置 → 红云点歌备用接口 Key 中覆盖它
 * （覆盖值保存在本机浏览器 localStorage 中）。
 * ============================================================ */
window.APP_CONFIG = {
  /* 网易云音乐 API（增强版）主接口 */
  API_PRIMARY: 'https://www.sanwith.cc.cd',

  /* 网易云音乐 API 备用接口 */
  API_SECONDARY: 'https://silence-music-api.cc.cd',

  /* 红云点歌v4（备用下载源） */
  HONGYUN_ENDPOINT: 'https://api.xunjinlu.fun/apis/wymusicv4',
  /* 🔑 私有密钥 —— 保护好它！ */
  HONGYUN_KEY: '',

  /*
   * 本地代理路径：三个上游接口的 CORS 响应头不稳定（CDN 层共享缓存 / 格式错误），
   * 因此通过同源代理转发（server.js 提供 /proxy）。
   *  - 通过 server.js / start.bat 启动时：自动走代理，最稳定；
   *  - 直接双击 index.html（file://）：无代理可用，自动退化为直连（尽力而为）。
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
