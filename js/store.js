/* ============================================================
 * 本地存储：收藏歌曲 / 收藏歌单 / 最近播放 / 自建歌单 / 搜索历史 / 设置
 * 全部保存在浏览器 localStorage（前缀 ym.）
 * ============================================================ */
(function () {
  'use strict';

  const PREFIX = 'ym.';
  const MAX_RECENT = 100;

  function read(key, def) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  function write(key, val) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); }
    catch (e) { /* 存储满等情况忽略 */ }
  }

  /* ---------- 设置 ---------- */
  const SETTINGS = Object.assign({
    quality: window.APP_CONFIG.DEFAULT_QUALITY,
    volume: 80,
    muted: false,
    lyricSize: 22,         // 歌词字号 px
    lyricWeight: 600,      // 歌词粗细
    lyricLineHeight: 1.75, // 歌词行距
    cacheOn: true,         // 音频本地缓存开关
    cacheCapMB: 300,       // 音频缓存容量上限（MB）
  }, read('settings', {}));

  const Settings = {
    get all() { return SETTINGS; },
    get quality() { return SETTINGS.quality; },
    get volume() { return SETTINGS.volume; },
    get muted() { return SETTINGS.muted; },
    get lyricSize() { return SETTINGS.lyricSize; },
    get lyricWeight() { return SETTINGS.lyricWeight; },
    get lyricLineHeight() { return SETTINGS.lyricLineHeight; },
    get playMode() { return SETTINGS.playMode; },
    get cacheOn() { return SETTINGS.cacheOn !== false; },
    get cacheCapMB() { return SETTINGS.cacheCapMB || 300; },
    set(patch) {
      Object.assign(SETTINGS, patch);
      write('settings', SETTINGS);
      document.dispatchEvent(new CustomEvent('ym:settings', { detail: patch }));
      Session.sync();
    },
  };

  /* ---------- 收藏歌曲 ---------- */
  let favSongs = read('favSongs', []);
  // id 统一按字符串比较（路由/接口可能返回 number 或 string，避免收藏态失灵）
  const idEq = (a, b) => String(a) === String(b);
  const FavSongs = {
    get all() { return favSongs; },
    has(id) { return favSongs.some(s => idEq(s.id, id)); },
    add(song) {
      if (!FavSongs.has(song.id)) {
        favSongs.unshift(song);
        write('favSongs', favSongs);
        document.dispatchEvent(new CustomEvent('ym:favsongs', { detail: song.id }));
        Session.sync();
      }
    },
    remove(id) {
      favSongs = favSongs.filter(s => !idEq(s.id, id));
      write('favSongs', favSongs);
      document.dispatchEvent(new CustomEvent('ym:favsongs', { detail: id }));
      Session.sync();
    },
    toggle(song) {
      FavSongs.has(song.id) ? FavSongs.remove(song.id) : FavSongs.add(song);
      return FavSongs.has(song.id);
    },
    clear() {
      favSongs = [];
      write('favSongs', favSongs);
      document.dispatchEvent(new CustomEvent('ym:favsongs', {}));
      Session.sync();
    },
  };

  /* ---------- 收藏歌单 ---------- */
  let favPlaylists = read('favPlaylists', []);
  const FavPlaylists = {
    get all() { return favPlaylists; },
    has(id) { return favPlaylists.some(p => idEq(p.id, id)); },
    add(pl) {
      if (!FavPlaylists.has(pl.id)) {
        favPlaylists.unshift(pl);
        write('favPlaylists', favPlaylists);
        document.dispatchEvent(new CustomEvent('ym:favpls'));
        Session.sync();
      }
    },
    remove(id) {
      favPlaylists = favPlaylists.filter(p => !idEq(p.id, id));
      write('favPlaylists', favPlaylists);
      document.dispatchEvent(new CustomEvent('ym:favpls'));
      Session.sync();
    },
    toggle(pl) {
      FavPlaylists.has(pl.id) ? FavPlaylists.remove(pl.id) : FavPlaylists.add(pl);
      return FavPlaylists.has(pl.id);
    },
    clear() {
      favPlaylists = [];
      write('favPlaylists', favPlaylists);
      document.dispatchEvent(new CustomEvent('ym:favpls'));
      Session.sync();
    },
  };

  /* ---------- 最近播放 ---------- */
  let recent = read('recent', []);
  const Recent = {
    get all() { return recent; },
    add(song) {
      recent = recent.filter(s => s.id !== song.id);
      recent.unshift(song);
      if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
      write('recent', recent);
      document.dispatchEvent(new CustomEvent('ym:recent'));
    },
    clear() {
      recent = [];
      write('recent', recent);
      document.dispatchEvent(new CustomEvent('ym:recent'));
    },
  };

  /* ---------- 自建歌单 ---------- */
  let myPlaylists = read('myPlaylists', []);
  const MyPlaylists = {
    get all() { return myPlaylists; },
    get(id) { return myPlaylists.find(p => idEq(p.id, id)) || null; },
    create(name) {
      const pl = {
        id: 'mp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: String(name || '新建歌单').trim().slice(0, 30) || '新建歌单',
        cover: '', // 自定义封面 dataURL（压缩后），空 = 用首曲封面/默认占位
        songs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      myPlaylists.unshift(pl);
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
      return pl;
    },
    /** 设置自定义封面（dataURL；本地压缩后存储，云端随 myPlaylists 同步） */
    setCover(id, dataURL) {
      const p = MyPlaylists.get(id);
      if (!p) return;
      p.cover = String(dataURL || '') || '';
      p.updatedAt = Date.now();
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
    },
    /** 恢复默认封面（清除自定义） */
    clearCover(id) {
      const p = MyPlaylists.get(id);
      if (!p || !p.cover) return;
      p.cover = '';
      p.updatedAt = Date.now();
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
    },
    rename(id, name) {
      const p = MyPlaylists.get(id);
      if (!p) return;
      p.name = String(name || '').trim().slice(0, 30) || p.name;
      p.updatedAt = Date.now();
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
    },
    remove(id) {
      myPlaylists = myPlaylists.filter(p => !idEq(p.id, id));
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
    },
    /** 批量加入（按 id 去重），返回实际新增数 */
    addSongs(id, songs) {
      const p = MyPlaylists.get(id);
      if (!p || !Array.isArray(songs)) return 0;
      let added = 0;
      songs.forEach(s => {
        if (!s || !s.id) return;
        if (p.songs.some(x => idEq(x.id, s.id))) return;
        p.songs.push({
          id: s.id,
          name: s.name,
          artists: s.artists,
          album: s.album,
          cover: s.cover || (s.album && s.album.cover) || '',
          duration: s.duration || 0,
          vip: !!s.vip,
        });
        added++;
      });
      if (added) {
        p.updatedAt = Date.now();
        write('myPlaylists', myPlaylists);
        document.dispatchEvent(new CustomEvent('ym:mypls'));
        Session.sync();
      }
      return added;
    },
    removeSong(id, songId) {
      const p = MyPlaylists.get(id);
      if (!p) return;
      const before = p.songs.length;
      p.songs = p.songs.filter(s => !idEq(s.id, songId));
      if (p.songs.length !== before) {
        p.updatedAt = Date.now();
        write('myPlaylists', myPlaylists);
        document.dispatchEvent(new CustomEvent('ym:mypls'));
        Session.sync();
      }
    },
    clearSongs(id) {
      const p = MyPlaylists.get(id);
      if (!p || !p.songs.length) return;
      p.songs = [];
      p.updatedAt = Date.now();
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
    },
  };

  /* ---------- 搜索历史（仅本机，不同步） ---------- */
  const MAX_SEARCH_HISTORY = 12;
  let searchHistory = read('searchHistory', []);
  const SearchHistory = {
    get all() { return searchHistory; },
    add(kw) {
      kw = String(kw || '').trim();
      if (!kw) return;
      searchHistory = searchHistory.filter(k => k !== kw);
      searchHistory.unshift(kw);
      if (searchHistory.length > MAX_SEARCH_HISTORY) searchHistory.length = MAX_SEARCH_HISTORY;
      write('searchHistory', searchHistory);
      document.dispatchEvent(new CustomEvent('ym:searchhist'));
    },
    clear() {
      searchHistory = [];
      write('searchHistory', searchHistory);
      document.dispatchEvent(new CustomEvent('ym:searchhist'));
    },
  };

  /* ---------- 清空 ---------- */
  /** 登录后：把「登录前本地数据」与「云端数据」按 id 合并（本地保留，去重） */
  function mergeLocal(local) {
    const mergeArr = (cur, extra) => {
      const out = cur.slice();
      extra.forEach((it) => {
        if (it == null || it.id == null) return;
        if (!out.some(x => x && idEq(x.id, it.id))) out.push(it);
      });
      return out;
    };
    favSongs = mergeArr(favSongs, local.favSongs || []);
    favPlaylists = mergeArr(favPlaylists, local.favPlaylists || []);
    myPlaylists = mergeArr(myPlaylists, local.myPlaylists || []);
    write('favSongs', favSongs);
    write('favPlaylists', favPlaylists);
    write('myPlaylists', myPlaylists);
    document.dispatchEvent(new CustomEvent('ym:favsongs', {}));
    document.dispatchEvent(new CustomEvent('ym:favpls'));
    document.dispatchEvent(new CustomEvent('ym:mypls'));
  }

  function clearAll() {
    favSongs = []; favPlaylists = []; recent = []; myPlaylists = []; searchHistory = [];
    write('favSongs', favSongs); write('favPlaylists', favPlaylists); write('recent', recent);
    write('myPlaylists', myPlaylists); write('searchHistory', searchHistory);
    document.dispatchEvent(new CustomEvent('ym:favsongs', {}));
    document.dispatchEvent(new CustomEvent('ym:favpls'));
    document.dispatchEvent(new CustomEvent('ym:recent'));
    document.dispatchEvent(new CustomEvent('ym:mypls'));
    document.dispatchEvent(new CustomEvent('ym:searchhist'));
    Session.sync();
  }

  /* ============================================================
   * 云账号（数据库同步）：设置 + 收藏歌曲 + 收藏歌单 + 自建歌单
   * 上传/下载；最近播放与搜索历史仅保存在本机，不同步。
   * 未登录时一切照旧（localStorage）；登录后数据自动云端同步。
   * ============================================================ */
  let session = read('session', null); // { token, email, avatar }
  const Session = {
    get token() { return session ? session.token : null; },
    get email() { return session ? session.email : null; },
    // 旧数据兼容：无 avatar 字段一律按 '' 处理
    get avatar() { return session && session.avatar ? session.avatar : ''; },
    get loggedIn() { return !!session; },

    _setSession(data) {
      session = data ? { token: data.token, email: data.email, avatar: data.avatar || '' } : null;
      write('session', session);
    },

    _api(path, opts) {
      let base = '';
      if (location.protocol === 'file:') {
        // file:// 模式：账号 API 需经本机服务器（api.js 已探测 127.0.0.1:8899）
        const local = window.APP_LOCAL_SERVER;
        if (!local) {
          return Promise.reject(new Error('账号功能需要本机服务器：请双击 start.bat 启动，或访问部署的网页版'));
        }
        base = local;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (session) headers['Authorization'] = 'Bearer ' + session.token;
      return fetch(base + '/api' + path, Object.assign({ headers }, opts)).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.msg || ('HTTP ' + r.status));
        return j;
      });
    },

    async login(email, password) {
      const j = await Session._api('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      Session._setSession({ token: j.token, email: j.email, avatar: j.avatar || '' });
      document.dispatchEvent(new CustomEvent('ym:session'));
      // 未登录期间本机产生的收藏/自建歌单：先备份，登录拉取云端后再合并上传，
      // 避免「云端覆盖本地 → 本地数据丢失且云端也没有」的漏同步问题
      const local = {
        favSongs: favSongs.slice(),
        favPlaylists: favPlaylists.slice(),
        myPlaylists: myPlaylists.slice(),
      };
      await Session.pull(); // 登录成功：以云端数据为准
      mergeLocal(local);
      await Session.push().catch(() => {}); // 合并结果上传云端，其它设备可见
      return j;
    },

    async register(email, password, captchaId, pos, duration) {
      const j = await Session._api('/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, captchaId, pos, duration }),
      });
      Session._setSession({ token: j.token, email: j.email, avatar: j.avatar || '' });
      document.dispatchEvent(new CustomEvent('ym:session'));
      // 新账号云端从空开始，不导入本机残留数据（避免多人共用电脑时数据混淆）
      return j;
    },

    /** 获取滑块验证题（服务端下发缺口位置） */
    async captcha() {
      const j = await Session._api('/captcha');
      return { id: j.id, target: j.target };
    },

    async logout() {
      try { await Session._api('/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
      session = null;
      write('session', null);
      document.dispatchEvent(new CustomEvent('ym:session'));
    },

    /** 修改密码（POST /api/account/password {old,next}）；失败时 _api 会 reject 并带服务端 msg */
    async changePassword(oldPassword, nextPassword) {
      return Session._api('/account/password', {
        method: 'POST',
        body: JSON.stringify({ old: oldPassword, next: nextPassword }),
      });
    },

    /** 上传头像（POST /api/account/avatar {avatar: dataURL}）；成功后更新本地并派发事件刷新 UI */
    async setAvatar(dataURL) {
      await Session._api('/account/avatar', {
        method: 'POST',
        body: JSON.stringify({ avatar: dataURL || '' }),
      });
      if (session) {
        session.avatar = dataURL || '';
        write('session', session);
      }
      document.dispatchEvent(new CustomEvent('ym:session'));
    },

    /**
     * 拉取云端最新资料（GET /api/account/profile，返回 { email, avatar }）：
     * 供启动 / 登录成功 / 窗口重新聚焦时调用，跨设备头像同步（A 机换头像 → B 机刷新生效）。
     * 成功时仅更新本地 session 的 avatar（token/email 不变，也绝不涉及密码字段）并
     * 派发 'ym:session'（→ app 侧 _syncAuthUI 重绘侧栏与设置头像）；
     * 头像未变化则不派发。失败（未登录 / 401 / 网络等）静默返回 false，不影响本地。
     * @returns {Promise<boolean>} 是否成功拉取并应用
     */
    async refreshProfile() {
      if (!session) return false;
      const token = session.token; // 请求期间可能退出/切换账号：用发起时的 token 校验响应归属
      try {
        const j = await Session._api('/account/profile');
        if (!session || session.token !== token) return false; // 已退出/换号：丢弃过期结果
        const avatar = j && typeof j.avatar === 'string' ? j.avatar : '';
        if (session.avatar !== avatar) {
          session.avatar = avatar;
          write('session', session);
          document.dispatchEvent(new CustomEvent('ym:session'));
        }
        return true;
      } catch (e) {
        return false; // 网络失败 / 401（登录过期）静默忽略
      }
    },

    /** 拉取云端数据并应用到本地（登录时云端为准） */
    async pull() {
      const j = await Session._api('/data');
      if (j.settings && typeof j.settings === 'object') {
        Object.keys(SETTINGS).forEach(k => delete SETTINGS[k]);
        Object.assign(SETTINGS, j.settings);
        write('settings', SETTINGS);
        document.dispatchEvent(new CustomEvent('ym:settings', { detail: j.settings }));
      }
      if (Array.isArray(j.favSongs)) {
        favSongs = j.favSongs;
        write('favSongs', favSongs);
        document.dispatchEvent(new CustomEvent('ym:favsongs', {}));
      }
      if (Array.isArray(j.favPlaylists)) {
        favPlaylists = j.favPlaylists;
        write('favPlaylists', favPlaylists);
        document.dispatchEvent(new CustomEvent('ym:favpls'));
      }
      if (Array.isArray(j.myPlaylists)) {
        myPlaylists = j.myPlaylists;
        write('myPlaylists', myPlaylists);
        document.dispatchEvent(new CustomEvent('ym:mypls'));
      }
    },

    /** 上传当前本机数据（设置 + 收藏 + 自建歌单，不含最近播放/搜索历史） */
    async push() {
      await Session._api('/data', {
        method: 'POST',
        body: JSON.stringify({
          settings: SETTINGS,
          favSongs: favSongs,
          favPlaylists: favPlaylists,
          myPlaylists: myPlaylists,
        }),
      });
    },

    _syncT: 0,
    /** 数据变化后防抖同步到云端 */
    sync() {
      if (!Session.loggedIn) return;
      clearTimeout(Session._syncT);
      Session._syncT = setTimeout(() => {
        Session.push().catch((e) => { console.warn('[bmusic-sync] push failed:', e && e.message); });
      }, 800);
    },

    /* ---------- 自动双向同步（跨设备实时） ----------
     * 此前只有"改动→上传"；另一台设备的改动要退出重登才可见。
     * 现在：每 2 分钟（后台标签页 5 分钟）自动【拉取】云端并应用，
     * 窗口重新聚焦/回到前台也立即拉取一次；上传仍由每次改动的
     * 800ms 防抖负责（轮询不做上传，避免全量旧快照覆盖别的设备）。 */
    _pollTimer: null,
    _polling: false,
    _lastPollAt: 0,
    _startPollOnce() {
      if (Session._pollTimer) return;
      Session._pollTimer = setInterval(Session._pollSafe, 2 * 60 * 1000);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) Session._pollSafe();
        });
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', () => Session._pollSafe());
      }
    },
    _pollSafe() {
      if (!Session.loggedIn || Session._polling) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' &&
          Date.now() - Session._lastPollAt < 5 * 60 * 1000) return;
      Session._lastPollAt = Date.now();
      Session._polling = true;
      Session.pull()
        .catch(() => {}) // 拉取失败下轮重试
        .finally(() => { Session._polling = false; });
    },
  };

  Session._startPollOnce();
  window.Store = { Settings, FavSongs, FavPlaylists, Recent, MyPlaylists, SearchHistory, Session, clearAll };
})();
