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
    theme: 'black-red',    // 主题色（黑红/黑蓝/黑金/黑紫/白蓝/白金）
    karaokeMode: 'fade',   // 逐字歌词效果：fade 渐显 / scroll 滚动扫光
    aiProfiles: [],        // AI 助手自定义模型配置（随账号云端同步）
    aiActiveId: '',        // 当前启用的模型配置 id（空 = 用内置默认）
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
    get theme() { return SETTINGS.theme || 'black-red'; },
    get karaokeMode() { return SETTINGS.karaokeMode || 'fade'; },
    get aiProfiles() { return Array.isArray(SETTINGS.aiProfiles) ? SETTINGS.aiProfiles : []; },
    get aiActiveId() { return SETTINGS.aiActiveId || ''; },
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
      // 自建歌单删除 → 一并取消其在"收藏歌单"中的收藏
      if (FavPlaylists.has(id)) FavPlaylists.remove(id);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
    },
    /** 批量加入（按 id 去重），返回实际新增数。
     *  新歌【置顶】并保持传入顺序：其他歌单的歌曲 1~a → 原有歌曲 a+1~b。 */
    addSongs(id, songs) {
      const p = MyPlaylists.get(id);
      if (!p || !Array.isArray(songs)) return 0;
      const fresh = []; // 本批新增（按传入顺序，去重：已有 + 批次内重复）
      songs.forEach(s => {
        if (!s || !s.id) return;
        if (p.songs.some(x => idEq(x.id, s.id))) return;
        if (fresh.some(x => idEq(x.id, s.id))) return;
        fresh.push({
          id: s.id,
          name: s.name,
          artists: s.artists,
          album: s.album,
          cover: s.cover || (s.album && s.album.cover) || '',
          duration: s.duration || 0,
          vip: !!s.vip,
        });
      });
      if (!fresh.length) return 0;
      p.songs = fresh.concat(p.songs); // 置顶：本批 1..a 在前，原有歌曲跟后
      p.updatedAt = Date.now();
      write('myPlaylists', myPlaylists);
      document.dispatchEvent(new CustomEvent('ym:mypls'));
      Session.sync();
      return fresh.length;
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
  let session = read('session', null); // { token, email, avatar, name, uid }
  const Session = {
    get token() { return session ? session.token : null; },
    get email() { return session ? session.email : null; },
    // 旧数据兼容：无 avatar 字段一律按 '' 处理
    get avatar() { return session && session.avatar ? session.avatar : ''; },
    get name() { return session && session.name ? session.name : ''; },
    get uid() { return session && session.uid ? session.uid : ''; },
    /** 内部（开发者）账号标记：由服务端在登录/注册响应里给出 */
    get internal() { return !!(session && session.internal); },
    /** 本地默认账号（local1…）：功能齐全，但不提供无损及以上音源 */
    get localAccount() { return !!(session && session.local); },
    /** 本地账号：数据只保存在本机（localStorage），不推送云端、不轮询云端 */
    get noCloud() { return !!(session && session.local); },
    get noLossless() { return !!(session && session.noLossless); },
    get loggedIn() { return !!session; },

    _setSession(data) {
      session = data ? {
        token: data.token, email: data.email, avatar: data.avatar || '',
        name: data.name || '', uid: data.uid || '', internal: !!data.internal,
        local: !!data.local, noLossless: !!data.noLossless,
      } : null;
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
        if (r.status === 401) {
          // 会话失效（本地与线上库不同 / token 过期）：自动登出，停止轮询刷屏
          if (Session.loggedIn) {
            Session._setSession(null);
            document.dispatchEvent(new CustomEvent('ym:session'));
            try { UI.toast('登录已失效，请重新登录', 'warn'); } catch (e) {}
          }
          const e401 = new Error(j.msg || '未登录');
          e401.status = 401;
          throw e401;
        }
        if (!r.ok) {
          const err = new Error(j.msg || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    },

    async login(email, password) {
      const j = await Session._api('/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      Session._setSession({ token: j.token, email: j.email, avatar: j.avatar || '', name: j.name || '', uid: j.uid || '', internal: !!j.internal, local: !!j.local, noLossless: !!j.noLossless });
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

    /** 发送注册邮箱验证码（服务端要求先过人机验证；60 秒内不可重发） */
    async sendCode(email, altcha) {
      return await Session._api('/sendcode', {
        method: 'POST',
        body: JSON.stringify({ email, altcha: altcha || '' }),
      });
    },

    async register(email, password, altcha, code) {
      const j = await Session._api('/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, altcha: altcha || '', code: code || '' }),
      });
      Session._setSession({ token: j.token, email: j.email, avatar: j.avatar || '', name: j.name || '', uid: j.uid || '', internal: !!j.internal, local: !!j.local, noLossless: !!j.noLossless });
      document.dispatchEvent(new CustomEvent('ym:session'));
      // 新账号云端从空开始，不导入本机残留数据（避免多人共用电脑时数据混淆）
      return j;
    },

    /** 获取滑块验证题（服务端下发缺口位置） */
    async captcha() {
      const j = await Session._api('/captcha');
      return { id: j.id, target: j.target };
    },

    /** 注销账号：服务端删除账号与云端数据，本地清空全部数据并登出 */
    async deleteAccount(password) {
      await Session._api('/account/delete', { method: 'POST', body: JSON.stringify({ password: String(password || '') }) });
      try { Session.clearAll(); } catch (e) {}
      session = null;
      write('session', null);
      document.dispatchEvent(new CustomEvent('ym:session'));
    },

    /** 校验 QQ 号（注册前验证，返回昵称等资料） */
    async checkQQ(qq) {
      return await Session._api('/qq/check?qq=' + encodeURIComponent(qq), { method: 'GET' });
    },
    async logout() {
      try { if (Session.markNoAutoLocal) Session.markNoAutoLocal(); } catch (e) {}
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
        const name = j && typeof j.name === 'string' ? j.name : '';
        const uid = j && typeof j.uid === 'string' ? j.uid : '';
        let changed = false;
        if (session.avatar !== avatar) { session.avatar = avatar; changed = true; }
        if (session.name !== name) { session.name = name; changed = true; }
        if (session.uid !== uid) { session.uid = uid; changed = true; }
        if (changed) {
          write('session', session);
          document.dispatchEvent(new CustomEvent('ym:session'));
        }
        return true;
      } catch (e) {
        return false; // 网络失败 / 401（登录过期）静默忽略
      }
    },

    /** 设置昵称（POST /api/account/nickname）；成功后本地缓存并派发 ym:session */
    async setNickname(nick) {
      const j = await Session._api('/account/nickname', {
        method: 'POST',
        body: JSON.stringify({ nick: String(nick || '').trim().slice(0, 20) }),
      });
      if (session) {
        session.name = j.name || session.name;
        write('session', session);
        document.dispatchEvent(new CustomEvent('ym:session'));
      }
      return j;
    },

    /** 分享自建歌单（登录）：返回 { token, url } */
    async shareMp(mpId) {
      const j = await Session._api('/share', { method: 'POST', body: JSON.stringify({ mpId }) });
      return j;
    },

    /** 读取他人分享的自建歌单（无需登录）：返回 { ok, name, cover, songs, owner, at } */
    async fetchMpShare(token) {
      const base = (location.protocol === 'file:' && window.APP_LOCAL_SERVER) ? window.APP_LOCAL_SERVER : '';
      const r = await fetch(base + '/api/share?t=' + encodeURIComponent(token));
      return r.json();
    },

    /** 拉取云端数据并应用到本地。
     *  mergeCloud=false（登录时）：云端为准，settings 全量覆盖；
     *  mergeCloud=true（1s 轮询）：本地为准（保护用户刚做的修改不被上传失败
     *  的云端旧值回滚），只补充本地缺失的新键。 */
    async pull(mergeCloud) {
      if (Session.noCloud) return; // 本地账号：不拉取云端
      const j = await Session._api('/data');
      const arr = (local, key) => {
        if (!Array.isArray(j[key]) || JSON.stringify(j[key]) === JSON.stringify(local)) return local;
        return j[key];
      };
      if (j.settings && typeof j.settings === 'object') {
        if (mergeCloud) {
          // 轮询：仅补充缺失字段，冲突以本地为权威（不再回滚用户刚改的设置）
          let ch = false;
          Object.keys(j.settings).forEach(k => {
            if (!(k in SETTINGS)) { SETTINGS[k] = j.settings[k]; ch = true; }
          });
          if (ch) {
            write('settings', SETTINGS);
            document.dispatchEvent(new CustomEvent('ym:settings', { detail: {} }));
          }
        } else if (JSON.stringify(j.settings) !== JSON.stringify(SETTINGS)) {
          Object.keys(SETTINGS).forEach(k => delete SETTINGS[k]);
          Object.assign(SETTINGS, j.settings);
          write('settings', SETTINGS);
          document.dispatchEvent(new CustomEvent('ym:settings', { detail: j.settings }));
        }
      }
      const nf = arr(favSongs, 'favSongs');
      if (nf !== favSongs) {
        favSongs = nf;
        write('favSongs', favSongs);
        document.dispatchEvent(new CustomEvent('ym:favsongs', {}));
      }
      const np = arr(favPlaylists, 'favPlaylists');
      if (np !== favPlaylists) {
        favPlaylists = np;
        write('favPlaylists', favPlaylists);
        document.dispatchEvent(new CustomEvent('ym:favpls'));
      }
      const nm = arr(myPlaylists, 'myPlaylists');
      if (nm !== myPlaylists) {
        myPlaylists = nm;
        write('myPlaylists', myPlaylists);
        document.dispatchEvent(new CustomEvent('ym:mypls'));
      }
    },

    /** 上传当前本机数据（设置 + 收藏 + 自建歌单，不含最近播放/搜索历史） */
    async push() {
      if (Session.noCloud) return; // 本地账号：不上传
      Session._pushT = Date.now(); // 标记上传进行中（轮询据此暂停拉取，防旧数据回滚） 
      try {
        await Session._api('/data', {
          method: 'POST',
          body: JSON.stringify({
            settings: SETTINGS,
            favSongs: favSongs,
            favPlaylists: favPlaylists,
            myPlaylists: myPlaylists,
          }),
        });
        console.log('[bmusic-sync] 已上传云端：设置 ' + Object.keys(SETTINGS).length + ' 项，收藏歌曲 ' +
          favSongs.length + ' 首，收藏歌单 ' + favPlaylists.length + ' 个，自建歌单 ' + myPlaylists.length + ' 个');
        // 上传成功后立即把云端结果读回并保存到本地（不再每秒轮询检查）
        Session.pull(true).then(() => {
          console.log('[bmusic-sync] 已从云端下载并保存到本地');
        }).catch((e) => {
          console.warn('[bmusic-sync] 下载云端数据失败：', (e && e.message) || e);
        });
      } finally {
        Session._pushT = Date.now(); // 上传完成时间（完成后短暂保护窗口）
      }
    },

    _syncT: 0,
    /** 数据变化后防抖同步到云端（交互驱动的即时上传见 _onActivity） */
    sync() {
      if (!Session.loggedIn || Session.noCloud) return;
      Session._dirty = true; // 有未上传的本地改动
      clearTimeout(Session._syncT);
      Session._syncT = setTimeout(() => {
        Session._syncT = 0;
        Session._flush('debounce');
      }, 800);
    },

    /* ---------- 交互驱动的即时上传 + 频繁活动保护 ----------
     * 规则：
     *  1) 只统计「真实用户交互」：event.isTrusted !== false（脚本/程序触发不计入）
     *     计入 pointerdown / keydown / input / change / click / wheel / scroll
     *     （滚动与滚轮每 250ms 合并计一次，避免连续滚动被误判为刷屏）
     *  2) 每次交互若本地有未上传改动（_dirty），立即上传一次（跳过 800ms 防抖）
     *  3) 1 秒滑动窗口内交互超过 MAX_PER_SEC(15) 次 → 判定频繁活动：
     *     提示一次 → 暂停上传 PAUSE_MS(5s) → 期间只累积改动 → 到点自动补传并恢复
     *  4) 服务端返回 429（写入过快）时同样进入暂停，避免持续冲击服务器
     */
    _dirty: false,
    _interactAt: [],
    _pauseUntil: 0,
    _pauseNotified: false,
    _resumeT: 0,
    _lastScrollAt: 0,
    MAX_PER_SEC: 15,
    PAUSE_MS: 5000,

    /** 上传一次（若有脏数据且不在暂停期） */
    _flush(reason) {
      if (!Session.loggedIn || !Session._dirty) return;
      if (Date.now() < Session._pauseUntil) return; // 暂停期只攒着，到点由 _resume 补传
      Session._dirty = false;
      Session.push().catch((e) => {
        Session._dirty = true; // 失败恢复脏标记，下次交互或防抖再传
        if (e && e.status === 429) Session._pause();
        console.warn('[bmusic-sync] push failed:', (e && e.message) || e);
      });
    },

    /** 暂停上传（默认 5 秒），到点自动补传一次 */
    _pause(ms) {
      const wait = ms || Session.PAUSE_MS;
      const until = Date.now() + wait;
      if (until <= Session._pauseUntil) return; // 已在更长的暂停里
      Session._pauseUntil = until;
      Session._interactAt.length = 0;
      if (!Session._pauseNotified) {
        Session._pauseNotified = true;
        try { UI.toast('操作过于频繁，已暂停云端同步 ' + Math.round(wait / 1000) + ' 秒', 'warn'); } catch (e) {}
      }
      clearTimeout(Session._resumeT);
      Session._resumeT = setTimeout(() => {
        Session._pauseNotified = false;
        Session._flush('resume');
      }, wait + 80);
    },

    /** 记录一次真实用户交互：判定频繁活动 + 有改动就立即上传 */
    _onActivity(kind) {
      if (!Session.loggedIn) return;
      const now = Date.now();
      const a = Session._interactAt;
      a.push(now);
      while (a.length && now - a[0] > 1000) a.shift(); // 只保留最近 1 秒
      if (a.length > Session.MAX_PER_SEC) { Session._pause(); return; }
      if (now < Session._pauseUntil) return;
      if (!Session._dirty) return;
      clearTimeout(Session._syncT);
      Session._syncT = 0;
      Session._flush('interact');
    },

    /** 绑定用户活动监听（只绑一次；untrusted 事件被忽略） */
    _bindActivityOnce() {
      if (Session._actBound) return;
      Session._actBound = true;
      const bind = (type, target, capture) => {
        target.addEventListener(type, (e) => {
          if (!e || e.isTrusted === false) return; // 只统计真实用户活动
          if (type === 'scroll' || type === 'wheel') {
            const now = Date.now();
            if (now - Session._lastScrollAt < 250) return; // 连续滚动合并计数
            Session._lastScrollAt = now;
          }
          Session._onActivity(type);
        }, { passive: true, capture: !!capture });
      };
      ['pointerdown', 'keydown', 'input', 'change', 'click'].forEach((t) => bind(t, document, true));
      bind('wheel', window, true);
      bind('scroll', window, true);
    },

    /* ---------- 自动双向同步（跨设备实时） ----------
     * 页面内每 1 秒自动【拉取】云端并应用（仅页面可见时；后台标签页降频
     * 5 分钟），窗口重新聚焦/回到前台也立即拉取一次；上传仍由每次改动
     * 的 800ms 防抖负责（轮询不做上传，避免全量旧快照覆盖别的设备）。
     * 本地有改动待上传时会推迟拉取，避免旧数据覆盖刚改的内容。 */
    _pollTimer: null,
    _polling: false,
    _lastPollAt: 0,
    _pushT: 0, // 最近一次上传开始/完成时间：保护窗口内不拉取（本地为权威）
    _startPollOnce() {
      if (Session._pollTimer) return;
      // 不再每秒轮询云端（上传成功后已实时回读保存）；只保留回到前台/窗口聚焦时的一次拉取
      Session._pollTimer = null;
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
      if (!Session.loggedIn || Session._polling || Session.noCloud) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' &&
          Date.now() - Session._lastPollAt < 5 * 60 * 1000) return;
      if (Session._syncT) { // 本地改动尚未上传完成：推迟 1.5s 再拉取，避免覆盖
        clearTimeout(Session._pollRetryT);
        Session._pollRetryT = setTimeout(Session._pollSafe, 1500);
        return;
      }
      // 上传进行中 / 刚完成 3s 内：本地是最新权威，这时拉云端旧数据会回滚本地改动
      if (Session._pushT && Date.now() - Session._pushT < 3000) return;
      Session._lastPollAt = Date.now();
      Session._polling = true;
      Session.pull(true)
        .catch(() => {}) // 拉取失败下轮重试
        .finally(() => { Session._polling = false; });
    },
  };

  /* ---------- 本地部署：自动登录本地账号（无需点登录/注册） ----------
   * 判定：页面来自 127.0.0.1 / localhost / file://
   * 账号：local1（可用 ?local=2 指定第 2 个本地账号）
   * 退出登录后不再自动登录（写入 bmusic:no-auto-local），避免退不掉 */
  /* 是否本地部署：只看访问域名是否为本机回环地址（http://127.0.0.1/ 等）。
   * 线上域名（如 www.bmusic.de5.net）一律为 false —— 本地账号只在本地部署可用。
   * 同时兼容 file:// 直接打开（APP_LOCAL_SERVER 指向本机服务）。 */
  let LOCAL_HOST = (function () {
    try {
      if (location.protocol === 'file:') return true;
      const h = String(location.hostname || '').toLowerCase();
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
    } catch (e) { return false; }
  })();
  const NO_AUTO_KEY = 'bmusic:no-auto-local';
  Session.isLocalHost = function () { return LOCAL_HOST; };
  /* 判定入口：与主机名规则一致（保留异步签名，调用方无需改动） */
  Session.detectLocal = async function () {
    // 只按域名判断：127.0.0.1 / localhost / [::1] / 0.0.0.0 / file:// 视为本地部署
    try { sessionStorage.setItem('bmusic:is-local', LOCAL_HOST ? '1' : '0'); } catch (e) {}
    return LOCAL_HOST;
  };

  Session.autoLocalLogin = async function (force) {
    if (!LOCAL_HOST) return null;
    if (session) {
      // 已有会话：本地账号但缺少 uid/name（旧版本写入的会话）→ 重新登录补全，
      // 否则一起听里判定不出「自己是房主」，邀请区不会出现
      const broken = !session.uid || !session.name; // 旧版本写入的会话缺 uid/name → 补全，否则房主判定会失败
      if (!broken) return null;
    } else if (!force) {
      try { if (localStorage.getItem(NO_AUTO_KEY) === '1') return null; } catch (e) {}
    }
    let n = 1;
    try {
      const q = new URLSearchParams(location.search).get('local');
      if (q && /^\d+$/.test(q)) n = Math.max(1, Math.min(50, Number(q)));
    } catch (e) {}
    try {
      const j = await Session._api('/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'local' + n + '@qq.com', password: 'local' + n }),
      });
      Session._setSession({
        token: j.token, email: j.email, avatar: j.avatar || '', name: j.name || '',
        uid: j.uid || '', internal: !!j.internal, local: !!j.local, noLossless: !!j.noLossless,
      });
      document.dispatchEvent(new CustomEvent('ym:session'));
      try { UI.toast('已自动登录' + (j.name || '本地账号') + '：数据仅保存在本机'); } catch (e) {}
      return j;
    } catch (e) {
      console.warn('[bmusic] 本地账号自动登录失败：', (e && e.message) || e);
      return null;
    }
  };
  Session.markNoAutoLocal = function () {
    try { localStorage.setItem(NO_AUTO_KEY, '1'); } catch (e) {}
  };

  Session._bindActivityOnce();
  Session._startPollOnce();
  window.Store = { Settings, FavSongs, FavPlaylists, Recent, MyPlaylists, SearchHistory, Session, clearAll };
})();
