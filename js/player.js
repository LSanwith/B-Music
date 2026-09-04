/* ============================================================
 * 播放器核心
 *  队列 / 播放模式（列表循环·单曲循环·随机）/ 音质切换 /
 *  播放地址解析（降级链）/ 进度 / 音量 / 收藏 / 最近播放
 * ============================================================ */
(function () {
  'use strict';

  const QUALITY_DOWNGRADE = ['jymaster', 'hires', 'lossless', 'exhigh', 'higher', 'standard'];

  const Player = {
    audio: null,
    queue: [],
    index: -1,
    mode: 'list',          // list | loop | shuffle
    order: [],             // 实际播放顺序（随机时为洗牌序）
    orderPos: 0,
    state: 'idle',         // idle | loading | playing | paused | error
    curTime: 0,
    duration: 0,
    quality: Store.Settings.quality,
    _retried: false,
    _pendingSeek: 0,

    /* ---------------- 初始化 ---------------- */
    init() {
      this.mode = Store.Settings.playMode || 'list';
      const a = new Audio();
      a.preload = 'auto';
      a.crossOrigin = 'anonymous'; // 允许 Web Audio 分析（CDN 已带 CORS）
      this.audio = a;
      a.volume = Store.Settings.muted ? 0 : Store.Settings.volume / 100;

      a.addEventListener('loadedmetadata', () => {
        this.duration = a.duration || 0;
        if (this._pendingSeek > 0) {
          a.currentTime = Math.min(this._pendingSeek, this.duration);
          this._pendingSeek = 0;
        }
        this._emit('time');
      });
      a.addEventListener('timeupdate', () => {
        this.curTime = a.currentTime || 0;
        this._emit('time');
      });
      a.addEventListener('play', () => {
        this.state = 'playing';
        this._emit('state');
        const s = this.current();
        if (s) Store.Recent.add(this.snapshot(s));
      });
      a.addEventListener('pause', () => {
        if (this.state !== 'error') this.state = 'paused';
        this._emit('state');
      });
      a.addEventListener('waiting', () => {
        if (this.state !== 'error') { this.state = 'loading'; this._emit('state'); }
      });
      a.addEventListener('canplay', () => {
        if (this.state === 'loading' && !a.paused) { this.state = 'playing'; this._emit('state'); }
      });
      a.addEventListener('ended', () => this.next(true));
      a.addEventListener('error', () => this._onAudioError());
    },

    /* ---------------- 队列 ---------------- */
    current() {
      return this.queue[this.index] || null;
    },

    snapshot(song) {
      return {
        id: song.id, name: song.name,
        artists: (song.artists || []).map(x => x.name).join(' / '),
        album: song.album ? song.album.name : '',
        cover: song.cover || '',
        duration: song.duration || 0,
      };
    },

    playQueue(songs, index) {
      if (!songs || !songs.length) return;
      this.queue = songs.slice();
      this.index = Math.max(0, Math.min(index || 0, songs.length - 1));
      this._buildOrder();
      this._loadCurrent();
    },

    playSong(song) {
      if (!song) return;
      this.playQueue([song], 0);
    },

    _buildOrder() {
      const n = this.queue.length;
      if (this.mode === 'shuffle') {
        const idx = Array.from({ length: n }, (_, i) => i);
        // 当前歌曲放最前
        const cur = this.index >= 0 ? this.index : 0;
        idx.splice(idx.indexOf(cur), 1);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        this.order = [cur, ...idx];
        this.orderPos = 0;
      } else {
        this.order = Array.from({ length: n }, (_, i) => i);
        this.orderPos = this.index >= 0 ? this.index : 0;
      }
    },

    /* ---------------- 播放控制 ---------------- */
    toggle() {
      const a = this.audio;
      if (this.state === 'loading') return;
      if (this.state === 'playing') { a.pause(); return; }
      if (!this.current()) return;
      a.play().catch(() => {
        this.state = 'paused';
        this._emit('state');
      });
    },

    next(auto) {
      if (!this.queue.length) return;
      if (this.mode === 'loop') {
        this._loadCurrent();
        return;
      }
      let advanced = false;
      if (this.mode === 'shuffle') {
        if (this.orderPos < this.order.length - 1) {
          this.orderPos++;
          advanced = true;
        } else if (this.queue.length > 1) {
          // 全部播完，重新洗牌（避免与上一首相同）
          const last = this.order[this.order.length - 1];
          this._buildOrder();
          if (this.order[0] === last && this.order.length > 1) {
            [this.order[0], this.order[1]] = [this.order[1], this.order[0]];
          }
          advanced = true;
        }
      } else {
        if (this.orderPos < this.order.length - 1) {
          this.orderPos++;
          advanced = true;
        } else if (!auto) {
          this.orderPos = 0;
          advanced = true;
        }
        // auto 且已是最后一首：停止
      }
      if (advanced) {
        this.index = this.order[this.orderPos];
        this._loadCurrent();
      } else if (auto) {
        this.state = 'paused';
        this._emit('state');
      }
    },

    prev() {
      if (!this.queue.length) return;
      if (this.curTime > 3) {
        this.seek(0);
        return;
      }
      if (this.mode === 'shuffle') {
        if (this.orderPos > 0) this.orderPos--;
        else this.orderPos = this.order.length - 1;
      } else {
        this.orderPos = this.orderPos > 0 ? this.orderPos - 1 : this.order.length - 1;
      }
      this.index = this.order[this.orderPos];
      this._loadCurrent();
    },

    seek(sec) {
      const a = this.audio;
      if (!isFinite(sec) || !this.current()) return;
      if (a.readyState >= 1) {
        a.currentTime = Math.max(0, Math.min(sec, a.duration || sec));
        this.curTime = a.currentTime;
      } else {
        this._pendingSeek = sec;
      }
      this._emit('time');
    },

    setMode(m) {
      this.mode = m;
      Store.Settings.set({ playMode: m });
      this._buildOrder();
      this._emit('mode');
    },
    cycleMode() {
      const next = this.mode === 'list' ? 'loop' : this.mode === 'loop' ? 'shuffle' : 'list';
      this.setMode(next);
      UI.toast(UI.modeText(next));
      return next;
    },

    /* ---------------- 音质 ---------------- */
    setQuality(q) {
      if (q === this.quality && this.state !== 'error') return;
      this.quality = q;
      Store.Settings.set({ quality: q });
      this._emit('quality');
      if (this.current()) {
        const keep = this.audio.currentTime || 0;
        this._loadCurrent(keep);
        UI.toast('已切换音质：' + this.qualityLabel(q));
      }
    },
    qualityLabel(q) {
      const it = window.APP_CONFIG.QUALITY_LEVELS.find(x => x.key === q);
      return it ? it.label : q;
    },

    /* ---------------- 内部加载 ---------------- */
    async _loadCurrent(keepTime) {
      const song = this.current();
      if (!song) return;
      const a = this.audio;
      if (keepTime === undefined) {
        // 新歌：立即暂停上一首并归零（避免旧歌继续出声/漏音）
        try { if (!a.paused) a.pause(); } catch (e) {}
        try { a.currentTime = 0; } catch (e) {}
        this.curTime = 0;
        this.duration = 0;
        this._pendingSeek = 0;
      }
      this.state = 'loading';
      this._retried = false;
      this._curKey = null;      // 当前歌曲的缓存键（id@音质）
      this._cacheUsed = false;  // 当前是否正用本地缓存播放
      this._cacheRetryDone = false;
      this._emit('change');
      this._emit('state');
      const resume = (keepTime !== undefined ? keepTime : (this.curTime || 0));
      try {
        let info = await API.resolveUrl(song, this.quality);
        // 音频本地缓存：有缓存直接用（免等待、不怕源链接过期）；无缓存则远程直播并后台整曲入缓存
        // 键 = 歌曲 id @ 用户所选音质（不能用 info.level —— 各源返回的 level 标签不稳定）
        const ck = (window.AudioCache && song.id) ? AudioCache.key(song.id, this.quality) : null;
        this._curKey = ck;
        if (ck && AudioCache.enabled()) {
          const cu = await AudioCache.url(ck);
          if (cu) {
            this._cacheUsed = true;
            a.src = cu;
          } else {
            a.src = info.url;
            this._fetchToCache(ck, info.url);
          }
        } else {
          a.src = info.url;
        }
        if (resume > 0 && song.id === this.current().id) this._pendingSeek = resume;
        this._retried = false;
        try { await a.play(); } catch (e) { /* 自动播放被拦截 */ }
      } catch (e) {
        this._fail(song, e);
      }
    },

    /** 后台整曲下载入缓存（并发限 2 路；失败静默，不影响播放） */
    _cacheActive: 0,
    _fetchToCache(k, url) {
      if (!k || !url || /^blob:/.test(url)) return;
      if (this._cacheActive >= 2) return; // 已经在缓存 2 首，跳过本次
      this._cacheActive++;
      fetch(url, { mode: 'cors' }).then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.blob();
      }).then((blob) => AudioCache.put(k, blob)).catch(() => { /* 缓存失败无碍 */ })
        .then(() => { this._cacheActive--; });
    },

    _fail(song, err) {
      this.state = 'error';
      this.audio.src = '';
      this.curTime = 0; this.duration = 0;
      this._emit('state');
      this._emit('time');
      console.warn('[player] 播放失败', song && song.name, err && err.message);
      let msg = '《' + (song ? song.name : '') + '》暂时无法播放（可能为 VIP/版权受限）';
      if (location.protocol === 'file:' && !window.APP_LOCAL_SERVER) {
        msg += '。本地直连模式无法播放 VIP/版权歌曲，请双击 start.bat 启动服务器或访问网页版';
      }
      UI.toast(msg, 'warn');
    },

    _onAudioError() {
      if (!this.current() || this.state === 'error') return;
      const a = this.audio;
      // 1) 本地缓存兜底：远程链接失败/过期且本曲有缓存时直接切缓存（仅一次）
      if (!this._cacheUsed && !this._cacheRetryDone && this._curKey && window.AudioCache) {
        this._cacheRetryDone = true;
        AudioCache.url(this._curKey).then((u) => {
          if (!u || !this.current()) { this._retryDowngrade(); return; }
          this._cacheUsed = true;
          UI.toast('源链接失效，已切换本地缓存播放');
          a.src = u;
          a.play().catch(() => {});
        }).catch(() => this._retryDowngrade());
        return;
      }
      this._retryDowngrade();
    },
    _retryDowngrade() {
      if (!this.current() || this.state === 'error') return;
      const a = this.audio;
      // 降级：尝试更低音质一次
      if (!this._retried) {
        const cur = this.quality;
        const idx = QUALITY_DOWNGRADE.indexOf(cur);
        if (idx < QUALITY_DOWNGRADE.length - 1) {
          const lower = QUALITY_DOWNGRADE[idx + 1];
          this._retried = true;
          UI.toast('当前音质播放失败，尝试降级为 ' + this.qualityLabel(lower));
          const keep = this.audio.currentTime || 0;
          this.quality = lower;
          Store.Settings.set({ quality: lower });
          this._emit('quality');
          API.resolveUrl(this.current(), lower).then(info => {
            this.audio.src = info.url;
            if (keep > 0) this._pendingSeek = keep;
            this.audio.play().catch(() => {});
          }).catch(e => this._fail(this.current(), e));
          return;
        }
      }
      this._fail(this.current(), new Error('audio error'));
    },

    /* ---------------- 音量 / 分析 ---------------- */
    _analyser: null,
    /** iOS 上 createMediaElementSource 会把音频路由进 WebAudio：
     *  锁屏/切后台时系统挂起 AudioContext → 音乐被掐断。因此 iOS 一律不用
     *  WebAudio 分析（背景高光退化为静态渐变），保证后台/锁屏继续播放。 */
    _isIOS() {
      const ua = navigator.userAgent || '';
      if (/iP(hone|od|ad)/.test(ua)) return true;
      // iPadOS 13+ UA 伪装成 Mac，但支持多点触控
      return ua.indexOf('Macintosh') >= 0 && navigator.maxTouchPoints > 1;
    },
    /** 懒创建 Web Audio 分析器（背景高光随音乐起伏）；iOS 返回 null */
    ensureAnalyser() {
      if (this._analyser) return this._analyser;
      if (this._isIOS()) return null;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        const ctx = new AC();
        const src = ctx.createMediaElementSource(this.audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        this._analyser = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
        this.audio.addEventListener('play', () => {
          if (this._analyser && this._analyser.ctx.state === 'suspended') {
            this._analyser.ctx.resume().catch(() => {});
          }
        });
        return this._analyser;
      } catch (e) {
        return null;
      }
    },

    /** 当前音频能量 0..1（低频加权平均），供动态高光使用 */
    level() {
      const a = this.ensureAnalyser();
      if (!a) return 0;
      try {
        a.analyser.getByteFrequencyData(a.data);
      } catch (e) { return 0; }
      let sum = 0;
      const n = Math.min(a.data.length, 96);
      for (let i = 0; i < n; i++) sum += a.data[i];
      return sum / n / 255;
    },

    /* ---------------- 收藏 / 队列管理 ---------------- */
    fav() {
      const s = this.current();
      if (!s) return false;
      const snap = this.snapshot(s);
      snap.artistsArr = (s.artists || []).map(x => ({ id: x.id, name: x.name }));
      snap.albumObj = s.album;
      return Store.FavSongs.toggle(snap);
    },

    removeFromQueue(i) {
      if (i < 0 || i >= this.queue.length) return;
      const wasCurrent = i === this.index;
      this.queue.splice(i, 1);
      if (!this.queue.length) {
        this.index = -1;
        this.order = [];
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.state = 'idle';
        this._emit('change');
        this._emit('state');
        return;
      }
      // 修正 index / order
      if (i < this.index) {
        this.index--;
        this._buildOrder();
      } else if (i === this.index) {
        // 当前歌曲被移除：接续播放
        this.index = Math.min(this.index, this.queue.length - 1);
        this._buildOrder();
        this._loadCurrent();
      } else {
        this._buildOrder();
      }
      this._emit('change');
    },

    clearQueue() {
      this.queue = [];
      this.index = -1;
      this.order = [];
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.state = 'idle';
      this._emit('change');
      this._emit('state');
    },

    /* ---------------- 事件 ---------------- */
    _emit(type) {
      document.dispatchEvent(new CustomEvent('ym:play-' + type, {
        detail: {
          song: this.current(),
          snapshot: this.current() ? this.snapshot(this.current()) : null,
          queue: this.queue, index: this.index,
          cur: this.curTime, dur: this.duration,
          state: this.state, mode: this.mode, quality: this.quality,
        },
      }));
    },

    on(type, fn) {
      document.addEventListener('ym:play-' + type, fn);
    },
  };

  window.Player = Player;
})();
