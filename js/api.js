/* ============================================================
 * API 层
 *  主接口: www.sanwith.cc.cd      (网易云音乐API增强版)
 *  备用接口: silence-music-api.cc.cd
 *  兜底源: 红云点歌v4 (仅用于播放地址 / 歌词，密钥仅发往
 *          api.xunjinlu.fun)
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const PRIMARY = CFG.API_PRIMARY;
  const SECONDARY = CFG.API_SECONDARY;

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
   * 上游接口（sanwith / silence / 红云）的 CORS 响应头不可靠：
   *  - sanwith/silence：CDN 共享缓存导致 Access-Control-Allow-Origin 偶尔是别的 origin；
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

  async function request(base, path, params, timeoutMs) {
    const isHongyun = base === CFG.HONGYUN_ENDPOINT;
    // 红云请求不携带 key：代理注入（hk=1），URL 中不暴露密钥
    const target = buildApiUrl(base, path, params);
    const proxyPath = window.APP_CONFIG.PROXY_PATH;
    const viaHttp = proxyPath && location.protocol !== 'file:';
    const viaLocal = location.protocol === 'file:' && !!_localServer; // file:// + 本机服务器在跑

    // 1) 走代理（http 同源代理，或 file:// 下的本机服务器代理）
    if ((viaHttp || viaLocal) && _proxyState !== 'off') {
      try {
        const base0 = viaLocal ? _localServer : '';
        const u = base0 + proxyPath + '?u=' + encodeURIComponent(target) + (isHongyun ? '&hk=1' : '');
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
        if (isHongyun) throw e; // 红云不回退直连（避免密钥暴露在 URL）
        _proxyState = 'off';     // 其它请求：关闭代理后走直连
      }
    }
    if (isHongyun) {
      // 无代理可用（file:// 且本机服务器未运行）：红云上游 CORS 头非法，直连必然被浏览器拦截，
      // 且会暴露密钥——直接给出明确提示，不发起注定失败的带 key 请求
      const err = new Error(location.protocol === 'file:'
        ? '红云接口需经本机服务器代理（请双击 start.bat 启动，或访问网页版）'
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

  /* 双接口并行竞速：主/备同时请求，第一个有效响应即胜出（不等待慢的那一个，保证流畅）
   * 默认 12s 超时：任一镜像挂起/缓慢时不阻塞页面与其它操作（更快切到可用镜像） */
  async function requestNetease(path, params, timeoutMs) {
    const tmo = timeoutMs || 12000;
    const ok = (j) => !!(j && (j.code === undefined || j.code === 200 || j.code === 0 ||
      (j.result || j.playlist || j.banners || j.list)));
    return await new Promise((resolve, reject) => {
      let pending = 2, done = false;
      const fail = (e) => {
        if (!done && --pending === 0) { done = true; reject(e); }
      };
      const tryResolve = (j) => {
        if (!done && ok(j)) { done = true; resolve(j); return true; }
        return false;
      };
      request(PRIMARY, path, params, tmo).then((j) => {
        if (!tryResolve(j)) fail(new Error('bad response'));
      }).catch(fail);
      request(SECONDARY, path, params, tmo).then((j) => {
        if (!tryResolve(j)) fail(new Error('bad response'));
      }).catch(fail);
    });
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
     * 抛出的错误带 .trial 标记，供降级链判断是否直接走红云完整源。
     */
    async neteaseUrl(base, id, level, opts) {
      opts = opts || {};
      // 1) 下载直链（完整音频）；解锁模式跳过此步（解锁只走播放直链）
      if (!opts.unblock) {
        try {
          const j = await request(base, '/song/download/url/v1', { id: id, level: level, realIP: REAL_IP }, 15000);
          const d = (j.data || [])[0];
          if (d && d.url && !isTrial(d)) {
            return { url: d.url, br: d.br || 0, type: d.type || '', level: d.level || level };
          }
        } catch (e) { /* 继续尝试播放直链 */ }
      }
      // 2) 播放直链：仅接受完整音频（unblock=true 时走 sanwith 的解锁通道）
      const q = opts.unblock ? { id: id, level: level, realIP: REAL_IP, unblock: 'true' } : { id: id, level: level, realIP: REAL_IP };
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
     *   主接口 / 备用接口 / 红云点歌v4 并行竞速，谁快用谁，加载流畅不卡顿；
     *   若红云先返回，给网易云 300ms 优先窗口（优先官方源），窗口内官方源成功则改选官方源。
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
          API.neteaseUrl(PRIMARY, song.id, lv).then(r => { r.source = '主接口'; return r; }),
          API.neteaseUrl(SECONDARY, song.id, lv).then(r => { r.source = '备用接口'; return r; }),
          API.hongyunUrl(song.id, lv).then(r => { r.source = '红云点歌'; return r; }),
        ];
        let settled = 0;
        tasks.forEach((p) => {
          p.then((r) => {
            if (result) return;
            if (r.source !== '红云点歌') { result = r; done(); return; }
            // 红云先到：给官方源 300ms 优先窗口
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
      // 兜底：普通三源全挂（VIP/版权歌常见）时，走主接口(sanwith)的 unblock 解锁通道。
      // sanwith 别名迁移期会在多个实例间随机分发（旧实例 SKey 快照不同 → 偶发 403），
      // 因此最多重试 3 次。
      for (let a = 0; a < 3; a++) {
        try {
          const r = await API.neteaseUrl(PRIMARY, song.id, lv, { unblock: true });
          r.source = '解锁源';
          if (location.protocol === 'https:' && r.url.startsWith('http://')) r.url = 'https://' + r.url.slice(7);
          API._urlCache.set(key, { t: Date.now(), v: r });
          return r;
        } catch (e) {
          errors.push(e.message);
          if (a < 2) await new Promise((res) => setTimeout(res, 400 + a * 300));
        }
      }
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
