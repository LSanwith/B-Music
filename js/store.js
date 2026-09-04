/* ============================================================
 * 本地存储：收藏歌曲 / 收藏歌单 / 最近播放 / 设置
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

  /* ---------- 清空 ---------- */
  function clearAll() {
    favSongs = []; favPlaylists = []; recent = [];
    write('favSongs', favSongs); write('favPlaylists', favPlaylists); write('recent', recent);
    document.dispatchEvent(new CustomEvent('ym:favsongs', {}));
    document.dispatchEvent(new CustomEvent('ym:favpls'));
    document.dispatchEvent(new CustomEvent('ym:recent'));
    Session.sync();
  }

  /* ============================================================
   * 云账号（数据库同步）：设置 + 收藏歌曲 + 收藏歌单 上传/下载；
   * 最近播放仅保存在本机，不同步。
   * 未登录时一切照旧（localStorage）；登录后数据自动云端同步。
   * ============================================================ */
  let session = read('session', null); // { token, email }
  const Session = {
    get token() { return session ? session.token : null; },
    get email() { return session ? session.email : null; },
    get loggedIn() { return !!session; },

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
      session = { token: j.token, email: j.email };
      write('session', session);
      document.dispatchEvent(new CustomEvent('ym:session'));
      await Session.pull(); // 登录成功：以云端数据为准
      return j;
    },

    async register(email, password, captchaId, pos, duration) {
      const j = await Session._api('/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, captchaId, pos, duration }),
      });
      session = { token: j.token, email: j.email };
      write('session', session);
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
    },

    /** 上传当前本机数据（设置 + 收藏，不含最近播放） */
    async push() {
      await Session._api('/data', {
        method: 'POST',
        body: JSON.stringify({
          settings: SETTINGS,
          favSongs: favSongs,
          favPlaylists: favPlaylists,
        }),
      });
    },

    _syncT: 0,
    /** 数据变化后防抖同步到云端 */
    sync() {
      if (!Session.loggedIn) return;
      clearTimeout(Session._syncT);
      Session._syncT = setTimeout(() => { Session.push().catch(() => {}); }, 800);
    },
  };

  window.Store = { Settings, FavSongs, FavPlaylists, Recent, Session, clearAll };
})();
