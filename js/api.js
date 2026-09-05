/* ============================================================
 * API 层
 *  镜像源: silence-music-api.cc.cd  (网易云音乐API)
 *  兜底/辅助源: 红云点歌v4 + 落七七(18years 网易云整合源)
 *          (仅用于播放地址/歌词；后两者密钥仅发往各自的代理，
 *          浏览器 URL 不携带密钥)
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const PRIMARY = CFG.API_PRIMARY;

  /* ---------- 基础请求 ---------- */
  function buildApiUrl(base, path, params) {
    const url = new URL(path, base);
    if (params) {
      for (const k of Object.keys(params)) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
          url.searchParams.set(k, params[k]);
        }
      }
    }
    return url.toString();
  }

  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * 上游接口（silence / 红云 / 落七七）的 CORS 响应头不可靠：
   *  - silence：CDN 共享缓存导致 Access-Control-Allow-Origin 偶尔是别的 origin；
   *  - 红云点歌：返回格式错误的 "*,*"。
   * 因此 http(s) 页面优先走同源代理 /proxy（server.js 提供）；
   * file:// 双击打开时，若本机 8899 服务器在运行则自动探测并走它的代理/API
   * （探测成功设 window.APP_LOCAL_SERVER），否则退化为直连（尽力而为）。
   */
  let _proxyState = 'auto'; // auto | on | off
  let _localServer = null;

  /*
   * 代理请求并发上限：搜索/解析会同时打多个上游代理请求，慢网络下（镜像 20s+）
   * 浏览器同源 6 连接很快被占满，导致登录/退出等界面请求排队"点了没反应"。
   * 限制最多 4 个代理请求在飞，永远给界面关键请求留出通道。
   */
  const MAX_PROXY_INFLIGHT = 4;
  let _proxyInflight = 0;
  let _proxyWaiters = [];
  function _acquireProxySlot() {
    if (_proxyInflight < MAX_PROXY_INFLIGHT) {
      _proxyInflight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => _proxyWaiters.push(resolve));
  }
  function _releaseProxySlot() {
    const w = _proxyWaiters.shift();
    if (w) w();
    else _proxyInflight--;
  }

  /** file:// 模式下探测本机服务器（127.0.0.1:8899），供代理与账号 API 使用 */
  function probeLocalServer() {
    if (location.protocol !== 'file:' || _localServer) return;
    try {
      fetch('http://127.0.0.1:8899/api/captcha', { signal: AbortSignal.timeout(1200) })
        .then((r) => {
          if (r.ok) {
            _localServer = 'http://127.0.0.1:8899';
            window.APP_LOCAL_SERVER = _localServer;
            _proxyState = 'on';
          }
        }).catch(() => { /* 服务器未运行 */ });
    } catch (e) { /* 忽略 */ }
  }
  probeLocalServer();

  /* 密钥注入型第三方源：代理标志 + 展示名（密钥不进入浏览器 URL）
   *  - hk=1 → 红云点歌（api.xunjinlu.fun）
   *  - nt=1 → 落七七 18years 整合源（api.18years.ink） */
  const KEYED_SOURCES = {};
  KEYED_SOURCES[CFG.HONGYUN_ENDPOINT] = { flag: 'hk', name: '红云点歌' };
  if (CFG.NT18_ENDPOINT) KEYED_SOURCES[CFG.NT18_ENDPOINT] = { flag: 'nt', name: '落七七' };

  async function request(base, path, params, timeoutMs) {
    const keyed = KEYED_SOURCES[base] || null;
    // 密钥源请求不携带 key：代理注入（hk=1 / nt=1），URL 中不暴露密钥
    const target = buildApiUrl(base, path, params);
    const proxyPath = window.APP_CONFIG.PROXY_PATH;
    const viaHttp = proxyPath && location.protocol !== 'file:';
    const viaLocal = location.protocol === 'file:' && !!_localServer; // file:// + 本机服务器在跑

    // 1) 走代理（http 同源代理，或 file:// 下的本机服务器代理）
    if ((viaHttp || viaLocal) && _proxyState !== 'off') {
      try {
        const base0 = viaLocal ? _localServer : '';
        const u = base0 + proxyPath + '?u=' + encodeURIComponent(target) + (keyed ? '&' + keyed.flag + '=1' : '');
        await _acquireProxySlot();
        let res;
        try {
          res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs || 30000) });
        } finally {
          _releaseProxySlot();
        }
        if (res.status === 404 || res.status === 405) {
          // 只有“代理端点本身不存在”（返回 HTML/非 JSON）才关闭代理走直连；
          // 代理存在但上游 404（如接口路由挂了）视为上游失败，保留代理
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          const body = await res.text();
          if (ct.indexOf('json') >= 0 || /^\s*[\[{]/.test(body)) {
            throw new Error('proxy HTTP ' + res.status);
          }
          _proxyState = 'off'; // 页面不在本应用服务器上，无代理
        } else if (!res.ok) {
          throw new Error('proxy HTTP ' + res.status); // 上游失败：代理本身可用，保留
        } else {
          _proxyState = 'on';
          return await res.json();
        }
      } catch (e) {
        if (String(e.message).indexOf('proxy HTTP') === 0) throw e;
        if (keyed) throw e; // 密钥源不回退直连（避免密钥暴露在 URL）
        _proxyState = 'off';     // 其它请求：关闭代理后走直连
      }
    }
    if (keyed) {
      // 无代理可用（file:// 且本机服务器未运行）：第三方源上游 CORS 头非法，直连必然被
      // 浏览器拦截，且会暴露密钥——直接给出明确提示，不发起注定失败的带 key 请求
      const err = new Error(location.protocol === 'file:'
        ? keyed.name + '接口需经本机服务器代理（请双击 start.bat 启动，或访问网页版）'
        : '无法获取播放地址');
      throw err;
    }
    // 直连模式（file:// 或代理不可用），失败重试一次
    try {
      return await fetchJson(target, timeoutMs);
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
      return await fetchJson(target, timeoutMs);
    }
  }

  /* 单一镜像源请求：首次失败后 400ms 重试一次（单源模式下比双源竞速稳定；
   * 播放地址另有红云/落七七竞速，不依赖此函数）。默认 12s 超时，
   * 镜像挂起/缓慢时不阻塞页面与其它操作。 */
  async function requestNetease(path, params, timeoutMs) {
    const tmo = timeoutMs || 12000;
    const ok = (j) => !!(j && (j.code === undefined || j.code === 200 || j.code === 0 ||
      (j.result || j.playlist || j.banners || j.list)));
    const attempt = async () => {
      const j = await request(PRIMARY, path, params, tmo);
      if (ok(j)) return j;
      throw new Error('bad response');
    };
    try {
      return await attempt();
    } catch (e1) {
      await new Promise((r) => setTimeout(r, 400));
      return await attempt(); // 重试仍失败则抛出，交由调用方处理
    }
  }

  /* ---------- 数据归一化 ---------- */
  /** 是否试听片段：响应带 freeTrialInfo（被截取歌曲的开始/结束时间）即为试听。
   *  兼容解锁源返回的字符串形式 'null'/'{}'（代表无截取，不是试听）。 */
  function isTrial(d) {
    if (!d || !d.freeTrialInfo) return false;
    const t = d.freeTrialInfo;
    if (typeof t === 'string') {
      return t !== 'null' && t !== 'undefined' && t !== '{}' && t.length > 0;
    }
    return true;
  }

  function artistsOf(o) {
    const ar = o.ar || o.artists || [];
    return ar.map(a => ({ id: a.id, name: a.name })).filter(a => a.name);
  }
  function albumOf(o) {
    const al = o.al || o.album;
    if (!al) return null;
    return { id: al.id, name: al.name, cover: al.picUrl || al.coverImgUrl || '' };
  }
  function normalizeSong(o) {
    if (!o || !o.id) return null;
    const al = albumOf(o);
    const fee = o.fee != null ? o.fee : (o.privilege ? o.privilege.fee : 0);
    return {
      id: o.id,
      name: o.name,
      artists: artistsOf(o),
      album: al,
      cover: (al && al.cover) || '',
      duration: o.duration || o.dt || 0,
      fee: fee,
      vip: fee > 0,
    };
  }

  /* 网易云接口 realIP 参数：api-enhanced 文档默认值（116.25.146.177）。
   * 服务端若部署在海外，不带 realIP 时网易云按海外 IP 返回「无权限/无URL」；
   * 指定国内 IP 后灰色/地区限制歌曲可正常返回（VIP 会员歌仍是试听，与 IP 无关）。 */
  const REAL_IP = '116.25.146.177';

  /* ---------- 歌曲信息 ---------- */
  const API = {

    /** 搜索  type: 1歌曲 10专辑 100歌手 1000歌单 */
    async search(keyword, type, limit, offset) {
      const j = await requestNetease('/cloudsearch', { keywords: keyword, type: type, limit: limit || 20, offset: offset || 0 });
      const r = j.result || {};
      if (type === 1) return { songs: (r.songs || []).map(normalizeSong).filter(Boolean), total: r.songCount || r.songs?.length || 0 };
      if (type === 1000) return { playlists: (r.playlists || []).map(p => ({
        id: p.id, name: p.name, cover: p.coverImgUrl, creator: p.creator ? p.creator.nickname : '',
        trackCount: p.trackCount, playCount: p.playCount, desc: p.description || '',
      })), total: r.playlistCount || 0 };
      if (type === 10) return { albums: (r.albums || []).map(a => ({
        id: a.id, name: a.name, cover: a.picUrl, artist: a.artist ? a.artist.name : '',
        publishTime: a.publishTime, size: a.size,
      })), total: r.albumCount || 0 };
      if (type === 100) return { artists: (r.artists || []).map(a => ({
        id: a.id, name: a.name, cover: a.picUrl || a.img1v1Url, albumCount: a.albumSize, songCount: a.musicSize,
      })), total: r.artistCount || 0 };
      return { songs: (r.songs || []).map(normalizeSong).filter(Boolean) };
    },

    /** 热门搜索词 */
    async searchHot() {
      const j = await requestNetease('/search/hot/detail');
      return (j.data || []).map(d => d.searchWord).filter(Boolean);
    },

    /** 歌曲详情（banner 跳转等） */
    async songDetail(id) {
      const j = await requestNetease('/song/detail', { ids: id });
      const s = (j.songs || [])[0];
      return s ? normalizeSong(s) : null;
    },

    /** 歌词（带缓存）：/lyric/new 含 lrc/yrc(逐字)；tlyric 缺失时回补 /lyric */
    _lyricCache: new Map(),
    async lyric(id) {
      const hit = API._lyricCache.get(id);
      if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.v;
      const j = await requestNetease('/lyric/new', { id: id });
      const v = {
        base: (j.lrc && j.lrc.lyric) || '',
        trans: (j.tlyric && j.tlyric.lyric) || '',
        yrc: (j.yrc && j.yrc.lyric) || '',
        uncollected: !!j.uncollected,
      };
      if (!v.trans || !v.base) {
        try {
          const j2 = await requestNetease('/lyric', { id: id });
          if (!v.base && j2.lrc) v.base = j2.lrc.lyric || '';
          if (!v.trans && j2.tlyric) v.trans = j2.tlyric.lyric || '';
        } catch (e) { /* 保持已有内容 */ }
      }
      API._lyricCache.set(id, { t: Date.now(), v });
      return v;
    },

    /** 推荐歌单 */
    async personalized(limit) {
      const j = await requestNetease('/personalized', { limit: limit || 10 });
      return (j.result || []).map(p => ({
        id: p.id, name: p.name, cover: p.picUrl, playCount: p.playCount, trackCount: p.trackCount,
        desc: p.copywriter || '',
      }));
    },

    /** 新歌速递 */
    async newsong(limit) {
      const j = await requestNetease('/personalized/newsong', { limit: limit || 10 });
      return (j.result || []).map(r => normalizeSong(r.song)).filter(Boolean);
    },

    /** Banner */
    async banner() {
      const j = await requestNetease('/banner', { type: 2 });
      return (j.banners || []).map(b => ({
        pic: b.pic, targetType: b.targetType, targetId: b.targetId,
        title: b.typeTitle || b.titleColor || '', url: b.url || '',
      }));
    },

    /** 所有榜单 */
    async toplist() {
      const j = await requestNetease('/toplist');
      return (j.list || []).map(l => ({
        id: l.id, name: l.name, cover: l.coverImgUrl, updateFrequency: l.updateFrequency, trackCount: l.trackCount,
      }));
    },

    /** 歌单分类（缓存 1 小时） */
    _catlistCache: null,
    async playlistCatlist() {
      if (API._catlistCache) return API._catlistCache;
      const j = await requestNetease('/playlist/catlist');
      const v = { all: j.all ? j.all.name : '全部', sub: (j.sub || []).map(c => c.name) };
      API._catlistCache = v;
      setTimeout(() => { API._catlistCache = null; }, 3600 * 1000);
      return v;
    },

    /** 歌单广场 */
    async topPlaylists(cat, order, limit, offset) {
      const j = await requestNetease('/top/playlist', { cat: cat || '全部', order: order || 'hot', limit: limit || 30, offset: offset || 0 });
      return {
        playlists: (j.playlists || []).map(p => ({
          id: p.id, name: p.name, cover: p.coverImgUrl, creator: p.creator ? p.creator.nickname : '',
          trackCount: p.trackCount, playCount: p.playCount, desc: p.description || '',
        })),
        total: j.total || 0,
      };
    },

    /** 歌单详情 */
    async playlistDetail(id) {
      const j = await requestNetease('/playlist/detail', { id: id });
      const p = j.playlist;
      return {
        id: p.id, name: p.name, cover: p.coverImgUrl,
        creator: p.creator ? p.creator.nickname : '',
        trackCount: p.trackCount, playCount: p.playCount,
        description: p.description || '', tags: p.tags || [],
        updateFrequency: p.updateFrequency || '',
      };
    },

    /** 歌单全部歌曲（分页） */
    async playlistTracks(id, limit, offset) {
      const j = await requestNetease('/playlist/track/all', { id: id, limit: limit || 100, offset: offset || 0 });
      return {
        songs: (j.songs || []).map(normalizeSong).filter(Boolean),
        more: !!(j.more || j.songs && j.songs.length >= (limit || 100)),
      };
    },

    /** 专辑详情 */
    async albumDetail(id) {
      const j = await requestNetease('/album', { id: id });
      const a = j.album || {};
      return {
        album: {
          id: a.id, name: a.name, cover: a.picUrl || a.coverImgUrl,
          artist: (a.artist && a.artist.name) || '',
          artistId: (a.artist && a.artist.id) || 0,
          publishTime: a.publishTime,
          description: a.description || '', size: a.size,
        },
        songs: (j.songs || []).map(normalizeSong).filter(Boolean),
      };
    },

    /** 歌手详情 */
    async artistDetail(id) {
      const j = await requestNetease('/artist/detail', { id: id });
      const a = j.data && (j.data.artist || j.data);
      return {
        id: a.id, name: a.name, cover: (a.picUrl || a.img1v1Url || '').replace(/^http:/, 'https:'),
        songCount: a.musicSize, albumCount: a.albumSize,
        briefDesc: (a.briefDesc || (j.data && j.data.artist && j.data.artist.briefDesc)) || '',
      };
    },

    /** 歌手热门歌曲 */
    async artistSongs(id) {
      const j = await requestNetease('/artist/top/song', { id: id });
      return { songs: (j.songs || []).map(normalizeSong).filter(Boolean), more: !!j.more };
    },

    /* ================= 播放地址解析（完整音频，拒绝试听） ================= */

    /**
     * 从网易云接口拿【完整】直链：
     *   1) /song/download/url/v1 —— 客户端下载直链（完整音频，免费歌可达 Hi-Res）
     *   2) /song/url/v1 —— 播放直链，但非会员返回的是试听片段（freeTrialInfo），一律拒绝
     * 抛出的错误带 .trial 标记，供降级链判断是否直接走第三方完整源。
     */
    async neteaseUrl(base, id, level) {
      // 1) 下载直链（完整音频）
      try {
        const j = await request(base, '/song/download/url/v1', { id: id, level: level, realIP: REAL_IP }, 15000);
        const d = (j.data || [])[0];
        if (d && d.url && !isTrial(d)) {
          return { url: d.url, br: d.br || 0, type: d.type || '', level: d.level || level };
        }
      } catch (e) { /* 继续尝试播放直链 */ }
      // 2) 播放直链：仅接受完整音频
      const q = { id: id, level: level, realIP: REAL_IP };
      const j = await request(base, '/song/url/v1', q, 20000);
      const d = (j.data || [])[0];
      if (d && d.url && !isTrial(d)) {
        return { url: d.url, br: d.br || 0, type: d.type || '', level: d.level || level };
      }
      const err = new Error(isTrial(d) ? '仅返回试听片段' : 'unavailable');
      err.trial = isTrial(d);
      throw err;
    },

    /** 红云点歌v4 获取直链（兜底）。密钥不进入 URL：代理注入 / file:// 本机服务器代理。
     *  v4 官方档位（2026-09 文档）：standard(128) / high(320) / lossless(flac)；
     *  应用内更高档位（hires/jymaster 等）一律映射到 lossless —— v4 已不识别
     *  旧档位名，直接传反而会多一轮 20s 降级等待。兼容新旧两种响应结构：
     *    新版：{ code:200, music_url, cover, quality, lyric, fee }（扁平）
     *    旧版：{ code:0, data:{ data:{ url, type, level, lrc, cover } } }（嵌套） */
    async hongyunUrl(id, level) {
      // 应用档位 → 红云 v4 档位（standard/high/lossless）
      const HY_MAP = {
        standard: 'standard', higher: 'high', exhigh: 'high', lossless: 'lossless',
        hires: 'lossless', jyeffect: 'lossless', sky: 'lossless', dolby: 'lossless', jymaster: 'lossless',
      };
      const want = HY_MAP[level] || 'lossless';
      const fetchLevel = async (lv) => {
        const j = await request(CFG.HONGYUN_ENDPOINT, '', { action: 'song', id: id, level: lv }, 20000);
        const oldD = j && j.data && j.data.data && j.data.data.data; // 旧结构内层
        const url = (j && j.music_url) || (oldD && oldD.url);
        if (url) {
          const type = (oldD && oldD.type) ||
            (/\.flac/i.test(url) ? 'flac' : (/\.mp3/i.test(url) ? 'mp3' : (/\.m4a/i.test(url) ? 'm4a' : '')));
          return {
            url, br: 0,
            type,
            level: (oldD && oldD.level) || j.quality || lv,
            lrc: (oldD && oldD.lrc) || j.lyric || '',
            cover: (oldD && oldD.cover) || j.cover || '',
            size: (oldD && oldD.size) || '',
          };
        }
        const errMsg = (j && j.msg) || (j && j.data && j.data.msg) || (j && j.data && j.data.data && j.data.data.msg) || '红云点歌失败';
        const err = new Error(errMsg);
        err.hyCode = (j && j.code !== undefined && j.code !== 0) ? j.code : (j && j.data && j.data.code);
        throw err;
      };
      return await fetchLevel(want);
    },

    /** 落七七（18years）网易云整合源获取直链（辅助源）。密钥不进入 URL：代理注入（nt=1）。
     *  档位映射：higher→exhigh、jyeffect/sky/dolby→lossless，其余档位直传；
     *  服务端不识别时快速降级而非报错等待（hires/jymaster 实测降到可用最高无损档）。
     *  响应结构：{ code:200, message, data:{ urls:[{ id,url,br,level,size,md5,time }], count } }
     *  —— 取 urls[0].url；code!=200 或 url 为空串视为失败（版权/VIP 限制返回空 url）。 */
    async nt18Url(id, level) {
      const NT_MAP = {
        standard: 'standard', higher: 'exhigh', exhigh: 'exhigh', lossless: 'lossless',
        hires: 'hires', jyeffect: 'lossless', sky: 'lossless', dolby: 'lossless', jymaster: 'jymaster',
      };
      const want = NT_MAP[level] || 'lossless';
      const j = await request(CFG.NT18_ENDPOINT, '', { action: 'url', id: id, quality: want }, 20000);
      const d = j && j.data && Array.isArray(j.data.urls) ? j.data.urls[0] : null;
      if (j && j.code === 200 && d && d.url) {
        return {
          url: d.url,
          br: d.br || 0,
          type: (/\.flac/i.test(d.url) ? 'flac' : (/\.mp3/i.test(d.url) ? 'mp3' : (/\.m4a/i.test(d.url) ? 'm4a' : ''))),
          level: d.level || want,
          size: d.size || '',
        };
      }
      const err = new Error((j && j.message) || '落七七接口失败');
      err.nt18Code = j ? j.code : undefined;
      throw err;
    },

    /** 红云点歌搜索（兼容新旧结构）。
     *  新版: { code:200, msg, count, data:[{ index, name, singer, id }] }（参数为 name）
     *  旧版: { code:0, data:{ data:{ songs:[{ id,name,artists,album,... }] } } } */
    async hongyunSearch(keyword, limit) {
      const j = await request(CFG.HONGYUN_ENDPOINT, '', { action: 'search', name: keyword, limit: limit || 20 }, 20000);
      let list = null;
      if (j && j.code === 200 && Array.isArray(j.data)) {
        list = j.data; // 新版扁平列表
      }
      let oldSongs = null;
      if (list === null && j && j.data && j.data.data) {
        oldSongs = (j.data.data.songs || (j.data.data.data && j.data.data.data.songs)) || null;
      }
      const norm = (s) => ({
        id: Number(s.id),
        name: s.name,
        artists: String(s.singer || s.artists || '').split('/').map(n => ({ id: 0, name: n.trim() })).filter(a => a.name),
        album: { id: s.albumId || 0, name: s.album || '', cover: s.coverImgUrl || '' },
        cover: s.coverImgUrl || '',
        duration: 0, fee: 0, vip: false,
        fromHongyun: true,
      });
      return (list || oldSongs || []).map(norm).filter(s => s.id && s.name);
    },

    /**
     * 解析【完整】播放地址 —— 三个数据源【同时并发请求】，先成功者胜出：
     *   镜像接口(silence) / 红云点歌v4 / 落七七(18years) 并行竞速，谁快用谁，加载流畅不卡顿；
     *   镜像接口先到直接胜出；第三方源（红云/落七七）先返回时，
     *   给镜像源 300ms 优先窗口，窗口内镜像成功则改选镜像。
     * 结果按 (id, level) 缓存 10 分钟。
     */
    _urlCache: new Map(),
    async resolveUrl(song, level) {
      const lv = level || Store.Settings.quality;
      const key = song.id + '|' + lv;
      const hit = API._urlCache.get(key);
      if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
      let result = null;
      const errors = [];
      await new Promise((done) => {
        const tasks = [
          API.neteaseUrl(PRIMARY, song.id, lv).then(r => { r.source = '镜像接口'; return r; }),
          API.hongyunUrl(song.id, lv).then(r => { r.source = '红云点歌'; return r; }),
          API.nt18Url(song.id, lv).then(r => { r.source = '落七七'; return r; }),
        ];
        let settled = 0;
        tasks.forEach((p) => {
          p.then((r) => {
            if (result) return;
            if (r.source === '镜像接口') { result = r; done(); return; }
            // 第三方源先到：给镜像源 300ms 优先窗口
            setTimeout(() => { if (!result) { result = r; done(); } }, 300);
          }).catch((e) => {
            errors.push(e.message);
            if (++settled === tasks.length && !result) done();
          });
        });
      });
      if (result) {
        if (location.protocol === 'https:' && result.url.startsWith('http://')) {
          result.url = 'https://' + result.url.slice(7);
        }
        API._urlCache.set(key, { t: Date.now(), v: result });
        return result;
      }
      // 三源全挂：VIP/版权歌多由落七七/红云解锁，全挂则报错并列出各源原因
      throw new Error('无法获取播放地址（' + errors.join('；') + '）');
    },

    /** 红云点歌 lrc 兜底（已缓存于 hongyunUrl 结果） */
    _hyLrcCache: new Map(),
    async hongyunLrc(id) {
      if (API._hyLrcCache.has(id)) return API._hyLrcCache.get(id);
      try {
        const r = await API.hongyunUrl(id, Store.Settings.quality);
        API._hyLrcCache.set(id, r.lrc || '');
        return r.lrc || '';
      } catch (e) { return ''; }
    },
  };

  window.API = API;
})();
