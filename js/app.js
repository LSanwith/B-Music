/* ============================================================
 * B·Music 网页版 · 主应用
 * 视图路由 / 渲染 / 播放栏 / 全屏播放页(滚动歌词) / 队列 / 设置
 * ============================================================ */
(function () {
  'use strict';
  const { $, $$, esc, fmtTime, fmtCount, fmtDuration, toast, coverUrl } = UI;

  const PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 80 80\'%3E%3Crect width=\'80\' height=\'80\' fill=\'%23222\'/%3E%3Ctext x=\'40\' y=\'48\' font-size=\'30\' text-anchor=\'middle\' fill=\'%23555\'%3E♪%3C/text%3E%3C/svg%3E';

  /* 相机小图标（头像悬停时提示“可更换”，viewBox 1024，内联 SVG，无 title/tooltip） */
  const CAM_ICON = '<svg viewBox="0 0 1024 1024"><path d="M928 288H768l-56-64H312l-56 64H96c-17.7 0-32 14.3-32 32v480c0 17.7 14.3 32 32 32h832c17.7 0 32-14.3 32-32V320c0-17.7-14.3-32-32-32zM512 768c-97.2 0-176-78.8-176-176s78.8-176 176-176 176 78.8 176 176-78.8 176-176 176z m0-288c-61.9 0-112 50.1-112 112s50.1 112 112 112 112-50.1 112-112-50.1-112-112-112z"/></svg>';

  const App = {
    _ctx: { songs: [], banners: [] },
    _lyricLines: [],
    _lyricTrans: false,
    _barDragging: false,
    _ovDragging: false,
    _queueOpen: false,

    /* ============================================================
     * 初始化
     * ============================================================ */
    init() {
      Player.init();
      this._bindStatic();
      this._bindPlayerEvents();
      window.addEventListener('hashchange', () => this.render());
      // 歌词轨道度量缓存：窗口尺寸变化后重测（仅在歌词页打开时）
      window.addEventListener('resize', () => {
        clearTimeout(this._lyricRszT);
        this._lyricRszT = setTimeout(() => {
          const ov = $('#overlay');
          if (ov && !ov.classList.contains('hidden')) this._measureLyrics();
        }, 250);
      });
      document.addEventListener('ym:favpls', () => this._renderSidePlaylists());
      document.addEventListener('ym:settings', (e) => this._onSettings(e.detail));
      this._renderSidePlaylists();
      this._renderQualityMenu();
      this.render();
      this._applySettingsToUI();
      this._syncAuthUI();
      // 启动即拉取云端最新资料（头像）：此前已登录的旧会话（localStorage 里存着旧 avatar）
      // 打开应用也能立即同步为其他设备设置的头像（失败静默，无碍本地）
      this._refreshProfile();
      // 从其他标签/应用切回本页时也刷新（_refreshProfile 内部有 ≥60s 节流）
      window.addEventListener('focus', () => this._refreshProfile());
      this._maybeShowNotice();
      this._initMediaSession();
      this._lyricsVisible = true;
      document.addEventListener('contextmenu', (e) => e.preventDefault());
      document.addEventListener('keydown', (e) => this._onKey(e));
      // 歌词手动滚动预览：暂停自动跟随（transform 平移滚动，GPU 合成不重绘）；
      // 预览期间歌词不模糊，便于浏览
      const lw = $('.ov-lyrics');
      if (lw) {
        let touchY = 0;
        const enterPreview = () => {
          lw.classList.add('lyrics-previewing');
          clearTimeout(this._lyricPreviewT);
          this._lyricPreviewT = setTimeout(() => lw.classList.remove('lyrics-previewing'), 4000);
        };
        const scrollBy = (dy) => {
          const max = Math.max(0, lw.scrollHeight - lw.clientHeight);
          this._lyricScroll = Math.max(0, Math.min(max, (this._lyricScroll || 0) + dy));
          this._applyLyricScroll();
        };
        lw.addEventListener('wheel', (e) => {
          e.preventDefault();
          this._userScrollAt = performance.now();
          enterPreview();
          scrollBy(e.deltaY);
        }, { passive: false });
        lw.addEventListener('touchstart', (e) => {
          touchY = e.touches[0].clientY;
          this._userScrollAt = performance.now();
          enterPreview();
        }, { passive: true });
        lw.addEventListener('touchmove', (e) => {
          const dy = touchY - e.touches[0].clientY;
          touchY = e.touches[0].clientY;
          this._userScrollAt = performance.now();
          enterPreview();
          scrollBy(dy);
          e.preventDefault();
        }, { passive: false });
      }
    },

    nav(route, params) {
      let h = '#/' + route;
      if (params) {
        const qs = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '')
          .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
        if (qs) h += '?' + qs;
      }
      const cur = location.hash;
      if (cur && cur !== h) {
        // 记录浏览历史（供详情页「返回」按钮回到上一页）
        this._stack = this._stack || [];
        this._stack.push(cur);
        if (this._stack.length > 50) this._stack.shift();
      }
      if (location.hash === h) this.render();
      else location.hash = h;
    },

    /** 返回上一页（顶栏返回按钮 / 空历史则回发现页） */
    _goBack() {
      const s = this._stack || [];
      const prev = s.pop();
      if (prev) location.hash = prev;
      else location.hash = '#/discover';
    },

    /* ============ 分享 ============ */
    /** 生成可分享链接
     *  - #/song|playlist|album|artist/<id> 深链（无查询串）：http(s) 部署下返回短链
     *    /s/<type>/<id>——微信/QQ 等外部 App 的爬虫不带 hash，短链由服务端
     *    （vercel.json rewrite / server.js）渲染 og 卡片并跳回本 hash 落地页；
     *  - 其它 hash 或 file:// 打开（无短链服务）时退回原逻辑：当前 URL(去 hash) + hash */
    shareUrl(hash) {
      hash = hash || location.hash || '#/discover';
      const m = /^#\/(song|playlist|album|artist)\/([^\/?#]+)(?:[?#].*)?$/.exec(hash);
      if (m && (location.protocol === 'http:' || location.protocol === 'https:')) {
        return location.origin + '/s/' + m[1] + '/' + m[2];
      }
      const base = location.href.split('#')[0];
      return base + hash;
    },
    /** 分享：系统面板立即弹出（不等待图片，杜绝“点了没反应”）；支持 files 时后台补图后二次唤起文件分享 */
    async _doShare(title, hash, imageUrl) {
      const url = this.shareUrl(hash);
      try { window.__lastShareUrl = url; } catch (e) {}
      // ① 有系统分享：立刻弹纯文本/链接面板（首击必有响应）
      if (navigator.share) {
        try {
          await navigator.share({ title: title || '', text: title || '', url: url });
          // ② 成功后在后台拉封面，若有 files 支持再补一次“带图分享”（用户取消则忽略）
          if (imageUrl && navigator.canShare && typeof navigator.canShare === 'function') {
            try {
              const res = await fetch(imageUrl, { mode: 'cors', signal: AbortSignal.timeout(3000) });
              if (res.ok) {
                const blob = await res.blob();
                const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
                const file = new File([blob], 'cover.' + ext, { type: blob.type || 'image/jpeg' });
                const withFile = { title: title || '', url: url, files: [file] };
                if (navigator.canShare(withFile)) await navigator.share(withFile);
              }
            } catch (e) { /* 忽略：无图/取消均可 */ }
          }
          return;
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return; // 用户取消
          // 其它失败继续走复制兜底
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('分享链接已复制，发送给好友打开即可');
        return;
      } catch (e) { /* 继续 execCommand 兜底 */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) {
          toast('分享链接已复制，发送给好友打开即可');
          return;
        }
      } catch (e) { /* 继续 */ }
      toast('请手动复制链接：' + url, 'warn');
    },
    _artistText(song) {
      return (song.artists || []).map(a => a.name).join(' / ') || '未知歌手';
    },
    /** 分享单曲：链接为独立歌曲页（打开自动播放），携带歌曲封面 */
    _shareSong(song) {
      if (!song || !song.id) return;
      const cover = song.cover || (song.album && song.album.cover) || '';
      this._doShare(song.name + ' - ' + this._artistText(song), '#/song/' + song.id, coverUrl(cover));
    },
    /** 分享歌单/专辑/歌手等页面：链接即原页面，携带自身封面 */
    _sharePage(route, id, label, name, cover) {
      if (!id) return;
      this._doShare((name || '') + ' · ' + label, '#/' + route + '/' + id, cover ? coverUrl(cover) : '');
    },

    /* ============================================================
     * 路由
     * ============================================================ */
    render() {
      this._viewSeq = (this._viewSeq || 0) + 1;
      const h = location.hash.replace(/^#\/?/, '');
      const [path, query] = h.split('?');
      const params = new URLSearchParams(query || '');
      const seg = path.split('/').filter(Boolean);
      const root = seg[0] || 'discover';
      this._highlightNav(root);
      // 顶栏返回按钮：仅在 歌单/专辑/歌手/单曲/自建歌单 等详情页显示（位于顶部标题文本左侧）
      const topBack = $('#btn-topback');
      if (topBack) topBack.classList.toggle('hidden', !(root === 'playlist' || root === 'album' || root === 'artist' || root === 'song' || root === 'myplaylist'));
      // 分享深度链接的 ?song= 参数：页面就绪后在原列表定位并自动播放该曲
      this._autoSong = params.get('song') ? String(params.get('song')) : null;
      this._autoSongTries = 0;

      if (root === 'discover') return this.vDiscover();
      if (root === 'leaderboard') return this.vLeaderboard();
      if (root === 'playlists') return this.vPlaylists(params.get('cat'), params.get('order'));
      if (root === 'search') return this.vSearch(params.get('q') || '');
      if (root === 'favorites') return this.vFavorites();
      if (root === 'myplaylist' && seg[1]) return this.vMyPlaylist(seg[1]);
      if (root === 'song' && seg[1]) return this.vSong(seg[1]);
      if (root === 'playlist' && (seg[1] || params.get('id'))) return this.vPlaylist(seg[1] || params.get('id'));
      if (root === 'album' && (seg[1] || params.get('id'))) return this.vAlbum(seg[1] || params.get('id'));
      if (root === 'artist' && (seg[1] || params.get('id'))) return this.vArtist(seg[1] || params.get('id'));
      this.nav('discover');
    },

    _highlightNav(root) {
      $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.nav === root));
      const titles = { discover: '发现', leaderboard: '排行榜', playlists: '歌单', search: '搜索', favorites: '我的收藏', myplaylist: '自建歌单', playlist: '歌单', album: '专辑', artist: '歌手', song: '歌曲' };
      const t = $('#page-title');
      if (t) t.textContent = titles[root] || '发现';
      const cur = Player.current();
      document.title = cur ? cur.name + ' - B·Music' : 'B·Music · 网页版';
    },

    _setView(html) {
      const v = $('#view');
      v.innerHTML = html;
      $('#main').scrollTop = 0;
      window.scrollTo(0, 0);
      // 分享深度链接：列表就绪后自动定位并播放 ?song= 指定的歌曲
      if (html.indexOf('view-loading') < 0) this._tryAutoPlayShared();
    },

    /** 尝试在已渲染列表里定位 ?song= 分享目标并自动播放 */
    _tryAutoPlayShared() {
      if (this._autoSong == null) return;
      const songs = this._ctx && Array.isArray(this._ctx.songs) ? this._ctx.songs : null;
      if (songs && songs.length) {
        const i = songs.findIndex(s => s && String(s.id) === this._autoSong);
        if (i >= 0) {
          const sid = this._autoSong;
          this._autoSong = null;
          Player.playQueue(songs.slice(), i);
          toast('已打开分享的歌曲并开始播放');
          return;
        }
      }
      if ((this._autoSongTries = (this._autoSongTries || 0) + 1) <= 14) {
        clearTimeout(this._autoSongT);
        this._autoSongT = setTimeout(() => this._tryAutoPlayShared(), 650);
      } else {
        const id = this._autoSong;
        this._autoSong = null;
        if (location.hash.indexOf('#/song/') !== 0) location.hash = '#/song/' + id;
      }
    },

    _viewLoading() {
      this._setView('<div class="view-loading"><div class="spinner"></div><div class="view-loading-text">加载中…</div></div>');
    },

    _viewError(msg, retry) {
      this._setView('<div class="empty"><div class="empty-icon">⚠</div><div class="empty-text">' + esc(msg) +
        '</div><button class="mini-btn" onclick="' + retry + '">重试</button></div>');
    },

    /* ============================================================
     * 视图：发现
     * ============================================================ */
    async vDiscover() {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const [banners, pls, news, hot] = await Promise.all([
          API.banner().catch(() => []),
          API.personalized(12).catch(() => []),
          API.newsong(12).catch(() => []),
          API.searchHot().catch(() => []),
        ]);
        if (seq !== this._viewSeq) return;
        this._ctx = { songs: news, banners };
        let html = '';
        if (banners.length) html += this._bannerHtml(banners);
        html += '<section class="view-section"><div class="sec-head"><h2>推荐歌单</h2></div><div class="grid pl-grid">'
          + pls.map(p => this._plCard(p)).join('') + '</div></section>';
        if (news.length) html += '<section class="view-section"><div class="sec-head"><h2>新歌速递</h2></div>'
          + this._songListHtml(news, { album: false, cover: true }) + '</section>';
        if (hot.length) html += '<section class="view-section"><div class="sec-head"><h2>热门搜索</h2></div>'
          + '<div class="hot-chips">' + hot.slice(0, 20).map(w =>
            '<button class="chip" data-search="' + esc(w) + '">' + esc(w) + '</button>').join('') + '</div></section>';
        this._setView(html);
        this._initBanner();
      } catch (e) {
        this._viewError('发现页加载失败：' + e.message, 'App.vDiscover()');
      }
    },

    _bannerHtml(banners) {
      const slides = banners.map((b, i) =>
        '<div class="banner-slide' + (i === 0 ? ' active' : '') + '" data-banner="' + i + '">' +
        '<img src="' + esc(coverUrl(b.pic)) + '" alt="" loading="lazy">' +
        (b.title ? '<span class="banner-tag">' + esc(b.title) + '</span>' : '') + '</div>').join('');
      return '<section class="banner-wrap"><div class="banner">' + slides +
        '</div><div class="banner-dots">' + banners.map((_, i) =>
        '<span class="dot' + (i === 0 ? ' active' : '') + '" data-dot="' + i + '"></span>').join('') + '</div></section>';
    },

    _initBanner() {
      const wrap = $('.banner');
      if (!wrap) return;
      clearInterval(wrap._timer);
      const slides = $$('.banner-slide', wrap);
      const dots = $$('.dot', wrap);
      let cur = 0, timer = null;
      const go = (i) => {
        cur = (i + slides.length) % slides.length;
        slides.forEach((s, j) => s.classList.toggle('active', j === cur));
        dots.forEach((d, j) => d.classList.toggle('active', j === cur));
      };
      const start = () => { timer = setInterval(() => go(cur + 1), 5000); };
      const stop = () => { clearInterval(timer); };
      dots.forEach(d => d.addEventListener('click', () => { go(+d.dataset.dot); stop(); start(); }));
      wrap.addEventListener('mouseenter', stop);
      wrap.addEventListener('mouseleave', start);
      start();
    },

    /* ============================================================
     * 视图：排行榜
     * ============================================================ */
    async vLeaderboard() {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const list = await API.toplist();
        if (seq !== this._viewSeq) return;
        const featured = [19723756, 3779629, 3778678, 2884035] // 飙升/新歌/热歌/原创
          .map(id => list.find(l => l.id === id)).filter(Boolean);
        const rest = list.filter(l => !featured.includes(l)).slice(0, 12);
        const card = (l) => this._plCard({
          id: l.id, name: l.name, cover: l.cover, trackCount: l.trackCount,
          playCount: l.playCount, sub: l.updateFrequency,
        });
        const html =
          '<section class="view-section"><div class="sec-head"><h2>官方榜</h2></div>' +
          '<div class="grid pl-grid featured">' + featured.map(card).join('') + '</div></section>' +
          '<section class="view-section"><div class="sec-head"><h2>更多榜单</h2></div>' +
          '<div class="grid pl-grid">' + rest.map(card).join('') + '</div></section>';
        this._setView(html);
      } catch (e) {
        this._viewError('排行榜加载失败：' + e.message, 'App.vLeaderboard()');
      }
    },

    /* ============================================================
     * 视图：歌单广场
     * ============================================================ */
    async vPlaylists(cat, order) {
      const seq = this._viewSeq;
      this._viewLoading();
      const curCat = cat || '全部';
      const curOrder = order || 'hot';
      try {
        const [cats, data] = await Promise.all([
          API.playlistCatlist().catch(() => ({ all: '全部', sub: [] })),
          API.topPlaylists(curCat, curOrder, 30, 0),
        ]);
        if (seq !== this._viewSeq) return;
        this._ctx = { playlists: data.playlists, cat: curCat, order: curOrder, offset: 30, more: data.playlists.length >= 30 };
        const catChips = ['全部', ...cats.sub.slice(0, 24)].map(c =>
          '<button class="chip' + (c === curCat ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');
        const orderBtns = [['hot', '热门'], ['new', '最新']].map(o =>
          '<button class="chip' + (o[0] === curOrder ? ' active' : '') + '" data-order="' + o[0] + '">' + o[1] + '</button>').join('');
        const html =
          '<section class="view-section"><div class="sec-head"><h2>歌单广场</h2></div>' +
          '<div class="filter-bar"><div class="chips" id="cat-chips">' + catChips + '</div>' +
          '<div class="chips" id="order-chips">' + orderBtns + '</div></div>' +
          '<div class="grid pl-grid">' + data.playlists.map(p => this._plCard(p)).join('') + '</div>' +
          (this._ctx.more ? '<div class="more-wrap"><button class="mini-btn" data-more="playlists">加载更多</button></div>' : '') +
          '</section>';
        this._setView(html);
      } catch (e) {
        this._viewError('歌单加载失败：' + e.message, 'App.vPlaylists()');
      }
    },

    async _morePlaylists() {
      const seq = this._viewSeq;
      const c = this._ctx;
      try {
        const data = await API.topPlaylists(c.cat, c.order, 30, c.offset);
        if (seq !== this._viewSeq) return;
        c.playlists.push(...data.playlists);
        c.offset += 30;
        c.more = data.playlists.length >= 30;
        const grid = $('.pl-grid');
        grid.insertAdjacentHTML('beforeend', data.playlists.map(p => this._plCard(p)).join(''));
        const btn = $('[data-more="playlists"]');
        if (btn) {
          if (c.more) btn.textContent = '加载更多';
          else btn.parentElement.remove();
        }
      } catch (e) { toast('加载失败：' + e.message, 'warn'); }
    },

    /* ============================================================
     * 视图：搜索
     * ============================================================ */
    async vSearch(kw) {
      this._viewLoading();
      const tabs = [['song', '单曲'], ['playlist', '歌单'], ['album', '专辑'], ['artist', '歌手']];
      if (!kw) {
        const seq = this._viewSeq;
        const hot = await API.searchHot().catch(() => []);
        if (seq !== this._viewSeq) return;
        const hist = Store.SearchHistory.all.slice(0, 12);
        this._setView(
          '<section class="view-section search-page"><div class="search-box"><form id="search-form">' +
          '<input id="search-input" type="text" placeholder="关键词 / 歌曲ID / 网易云链接，回车搜索" maxlength="120" autofocus></form></div>' +
          (hist.length ? '<div class="sec-head"><h2>历史搜索</h2><button class="mini-btn danger" id="search-clear-hist">清空</button></div>' +
            '<div class="hot-chips">' + hist.map(w => '<button class="chip" data-search="' + esc(w) + '">' + esc(w) + '</button>').join('') +
            '</div>' : '') +
          (hot.length ? '<div class="sec-head" style="margin-top:26px"><h2>热门搜索</h2></div><div class="hot-chips">' +
            hot.slice(0, 20).map(w => '<button class="chip" data-search="' + esc(w) + '">' + esc(w) + '</button>').join('') +
            '</div>' : '') + '</section>');
        $('#search-form').addEventListener('submit', (e) => {
          e.preventDefault();
          const v = $('#search-input').value.trim();
          if (v) {
            Store.SearchHistory.add(v);
            this.nav('search', { q: v });
          }
        });
        const ch = $('#search-clear-hist');
        if (ch) ch.addEventListener('click', () => { Store.SearchHistory.clear(); toast('搜索历史已清空'); this.vSearch(''); });
        return;
      }
      // 支持 网易云链接 / ID 直达：识别成功则直接打开对应页面
      if (await this._maybeIdSearch(kw)) return;
      this._searchType = 'song';
      this._searchKw = kw;
      this._searchOffset = 0;
      this._searchSeq = 0;
      this._searchAll = [];
      this._setView(
        '<section class="view-section search-page"><div class="search-box"><form id="search-form">' +
        '<input id="search-input" type="text" value="' + esc(kw) + '" maxlength="120"></form></div>' +
        '<div class="fav-tabs" id="search-tabs"></div>' +
        '<div id="search-result"></div></section>');
      $('#search-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('#search-input').value.trim();
        if (v && v !== this._searchKw) {
          Store.SearchHistory.add(v);
          this.nav('search', { q: v });
        }
      });
      this._searchTabHtml(tabs);
      await this._doSearch();
    },

    /** 搜索词可能是网易云链接或纯 ID：识别并直达对应页面。返回 true 表示已处理 */
    async _maybeIdSearch(kw) {
      const t = App._parseNeteaseLink(kw);
      if (t) {
        if (t.type === 'song' || t.type === 'playlist' || t.type === 'album' || t.type === 'artist') {
          toast('已识别网易云' + { song: '歌曲', playlist: '歌单', album: '专辑', artist: '歌手' }[t.type] + '链接，正在打开');
          this.nav(t.type + '/' + t.id);
          return true;
        }
        return false; // mv / djradio 等暂不支持：退回关键词搜索
      }
      if (/^\d{5,}$/.test(kw)) {
        const hit = await App._resolveNeteaseId(kw);
        if (hit) {
          toast(hit.label);
          this.nav(hit.route);
          return true;
        }
        toast('未找到该 ID，已按关键词搜索', 'warn');
      }
      return false;
    },

    /** 解析网易云链接（含分享文本中夹带链接），返回 { type, id }；识别不到返回 null */
    _parseNeteaseLink(text) {
      const m = /((?:playlist|album|artist|song|mv|djradio|program|user|radio))[\s\S]{0,120}?(?:id|sid)=(\d+)/i.exec(text || '');
      if (!m) return null;
      return { type: m[1].toLowerCase(), id: m[2] };
    },

    /** 纯数字 ID 依次探测 歌曲→歌单→专辑→歌手 */
    async _resolveNeteaseId(id) {
      try {
        const s = await API.songDetail(id);
        if (s && s.id) return { route: 'song/' + id, label: '歌曲 ID 直达：' + s.name };
      } catch (e) { /* 继续探测 */ }
      try {
        const p = await API.playlistDetail(id);
        const t = await API.playlistTracks(id, 1, 0);
        if (p && p.id && t && t.songs) return { route: 'playlist/' + id, label: '歌单 ID 直达：' + p.name };
      } catch (e) { /* 继续探测 */ }
      try {
        const a = await API.albumDetail(id);
        if (a && a.album && a.album.id) return { route: 'album/' + id, label: '专辑 ID 直达：' + a.album.name };
      } catch (e) { /* 继续探测 */ }
      try {
        const ar = await API.artistDetail(id);
        if (ar && ar.id) return { route: 'artist/' + id, label: '歌手 ID 直达：' + ar.name };
      } catch (e) { /* 未命中 */ }
      return null;
    },

    _searchTabHtml(tabs) {
      const wrap = $('#search-tabs');
      if (!wrap) return;
      wrap.innerHTML = tabs.map(t =>
        '<button class="chip' + (t[0] === this._searchType ? ' active' : '') + '" data-stype="' + t[0] + '">' + t[1] + '</button>').join('');
      wrap.querySelectorAll('[data-stype]').forEach(b => b.addEventListener('click', async () => {
        this._searchType = b.dataset.stype;
        this._searchOffset = 0;
        this._searchTabHtml(tabs);
        await this._doSearch();
      }));
    },

    async _doSearch() {
      const seq = ++this._searchSeq;
      const typeMap = { song: 1, album: 10, artist: 100, playlist: 1000 };
      const type = typeMap[this._searchType];
      const kw = this._searchKw;
      const offset = this._searchOffset;
      const wrap = $('#search-result');
      if (!wrap) return;
      if (offset === 0) {
        wrap.innerHTML = '<div class="view-loading small"><div class="spinner"></div></div>';
      }
      try {
        const data = await API.search(kw, type, 20, offset);
        if (seq !== this._searchSeq) return; // 已切换 tab/关键词，丢弃过期结果
        if (offset === 0) this._searchAll = data.songs || [];
        else this._searchAll = this._searchAll.concat(data.songs || []);
        this._ctx = { songs: this._searchAll };
        let html = '';
        if (type === 1) {
          html = (data.songs && data.songs.length)
            ? this._songListHtml(data.songs, { album: true, start: offset })
            : UI.empty('未找到相关歌曲');
        } else if (type === 1000) {
          html = (data.playlists && data.playlists.length)
            ? '<div class="grid pl-grid">' + data.playlists.map(p => this._plCard(p)).join('') + '</div>'
            : UI.empty('未找到相关歌单');
        } else if (type === 10) {
          html = (data.albums && data.albums.length)
            ? '<div class="album-grid">' + data.albums.map(a =>
              '<div class="album-card" data-album="' + a.id + '"><div class="pl-cover"><img src="' + esc(coverUrl(a.cover)) + '" loading="lazy"></div>' +
              '<div class="pl-name">' + esc(a.name) + '</div><div class="pl-sub">' + esc(a.artist) + ' · ' + (a.size || 0) + '首</div></div>').join('') + '</div>'
            : UI.empty('未找到相关专辑');
        } else {
          html = (data.artists && data.artists.length)
            ? '<div class="artist-grid">' + data.artists.map(ar =>
              '<div class="artist-card" data-artist="' + ar.id + '"><div class="artist-avatar"><img src="' + esc(coverUrl(ar.cover)) + '" loading="lazy"></div>' +
              '<div class="pl-name">' + esc(ar.name) + '</div><div class="pl-sub">歌曲 ' + (ar.songCount || 0) + ' 首</div></div>').join('') + '</div>'
            : UI.empty('未找到相关歌手');
        }
        const total = data.total || 0;
        const hasMore = offset + 20 < total || (type === 1 && data.songs && data.songs.length >= 20);
        if (offset === 0) {
          wrap.innerHTML = html + (hasMore ? '<div class="more-wrap"><button class="mini-btn" data-more="search">加载更多</button></div>' : '');
        } else {
          // 追加内容插到“加载更多”按钮之前，按钮保持置底
          const mw = $('[data-more="search"]');
          if (mw) mw.parentElement.insertAdjacentHTML('beforebegin', html);
          else wrap.insertAdjacentHTML('beforeend', html);
          if (!hasMore) { const b = $('[data-more="search"]'); if (b) b.parentElement.remove(); }
        }
      } catch (e) {
        if (seq !== this._searchSeq) return;
        wrap.innerHTML = UI.empty('搜索失败：' + e.message);
      }
    },

    async _moreSearch() {
      this._searchOffset += 20;
      await this._doSearch();
    },

    /* ============================================================
     * 视图：我的收藏
     * ============================================================ */
    vFavorites() {
      const favSongs = Store.FavSongs.all;
      const favPls = Store.FavPlaylists.all;
      const recents = Store.Recent.all;
      const myPls = Store.MyPlaylists.all;
      const tab = this._favTab || 'songs'; // 记住上次所在分页（自建歌单操作后刷新不跳走）
      this._ctx = {
        favSongs: favSongs.map(s => this._snapToSong(s)),
        recent: recents.map(s => this._snapToSong(s)),
        songs: favSongs.map(s => this._snapToSong(s)),
      };
      const html =
        '<section class="view-section"><div class="sec-head"><h2>我的收藏</h2></div>' +
        '<div class="fav-tabs"><button class="chip' + (tab === 'songs' ? ' active' : '') + '" data-favtab="songs">收藏歌曲 (' + favSongs.length + ')</button>' +
        '<button class="chip' + (tab === 'playlists' ? ' active' : '') + '" data-favtab="playlists">收藏歌单 (' + favPls.length + ')</button>' +
        '<button class="chip' + (tab === 'recent' ? ' active' : '') + '" data-favtab="recent">最近播放 (' + recents.length + ')</button>' +
        '<button class="chip' + (tab === 'mypls' ? ' active' : '') + '" data-favtab="mypls">自建歌单 (' + myPls.length + ')</button></div>' +
        '<div id="fav-body">' +
        (tab === 'mypls' ? this._myPlsTabHtml(myPls) :
          (tab === 'playlists'
            ? (favPls.length ? '<div class="grid pl-grid">' + favPls.map(p => this._plCard(p)).join('') + '</div>' : UI.empty('还没有收藏歌单', '在歌单页点击「收藏歌单」'))
            : (tab === 'recent'
              ? (recents.length ? this._songListHtml(this._ctx.songs, { album: false, cover: false }) : UI.empty('暂无播放记录'))
              : (favSongs.length ? this._songListHtml(this._ctx.songs, { album: false, cover: false }) : UI.empty('还没有收藏歌曲', '在歌曲列表或播放页点击 ♥ 收藏'))))) +
        '</div></section>';
      this._setView(html);
      this._bindFavTabEvents();
    },

    /* 自建歌单 Tab 内容（含新建歌单输入行） */
    _myPlsTabHtml(myPls) {
      return '<div class="mp-tools"><input id="mp-new-name" class="mp-input" placeholder="新歌单名称，如：开车循环" maxlength="30">' +
        '<button class="mini-btn" id="mp-new-btn">新建歌单</button></div>' +
        (myPls.length
          ? '<div class="grid pl-grid">' + myPls.map(p => this._mpCard(p)).join('') + '</div>'
          : UI.empty('还没有自建歌单', '输入名称点「新建歌单」，再从网易云链接导入全部歌曲'));
    },

    _bindFavTabEvents() {
      $$('.fav-tabs .chip').forEach(b => b.addEventListener('click', () => {
        $$('.fav-tabs .chip').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const t = b.dataset.favtab;
        this._favTab = t;
        const body = $('#fav-body');
        if (t === 'songs') {
          this._ctx.songs = this._ctx.favSongs; // 点击委托读取 _ctx.songs
          body.innerHTML = this._ctx.songs.length
            ? this._songListHtml(this._ctx.songs, { album: false, cover: false })
            : UI.empty('还没有收藏歌曲', '在歌曲列表或播放页点击 ♥ 收藏');
        } else if (t === 'playlists') {
          const favPls = Store.FavPlaylists.all;
          body.innerHTML = favPls.length
            ? '<div class="grid pl-grid">' + favPls.map(p => this._plCard(p)).join('') + '</div>'
            : UI.empty('还没有收藏歌单', '在歌单页点击「收藏歌单」');
        } else if (t === 'recent') {
          this._ctx.songs = this._ctx.recent; // 最近播放：点击委托同样生效
          body.innerHTML = this._ctx.songs.length
            ? this._songListHtml(this._ctx.songs, { album: false, cover: false })
            : UI.empty('暂无播放记录');
        } else {
          body.innerHTML = this._myPlsTabHtml(Store.MyPlaylists.all);
          this._bindMyPlsTabEvents();
        }
      }));
      this._bindMyPlsTabEvents(); // 初始渲染（含 mypls 分页）也绑定
    },

    /* 自建歌单 Tab 内：新建 + 卡片交互（重命名/删除/打开） */
    _bindMyPlsTabEvents() {
      const fresh = $('#mp-new-btn');
      if (fresh) {
        const create = () => {
          const inp = $('#mp-new-name');
          const v = inp ? inp.value.trim() : '';
          if (!v) { toast('请输入歌单名称', 'warn'); return; }
          const pl = Store.MyPlaylists.create(v);
          toast('已创建歌单「' + pl.name + '」');
          this._favTab = 'mypls';
          this.vFavorites();
        };
        fresh.addEventListener('click', create);
        const inp = $('#mp-new-name');
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
      }
    },

    _mpCard(p) {
      return '<div class="pl-card mp-card" data-mp="' + p.id + '">' +
        '<div class="pl-cover"><img src="' + esc(coverUrl(p.songs[0] ? p.songs[0].cover : '')) + '" alt="" loading="lazy">' +
        '<span class="pl-count">' + p.songs.length + ' 首</span>' +
        '<span class="pl-hover">' + Icons.icon('playTri') + '</span></div>' +
        '<div class="mp-name">' + esc(p.name) + '</div>' +
        '<div class="mp-acts"><button class="mini-btn" data-mp-rename="' + p.id + '">重命名</button>' +
        '<button class="mini-btn danger" data-mp-del="' + p.id + '">删除</button></div></div>';
    },

    /* 卡片内联重命名：点击后名称变输入框，回车/失焦保存 */
    _editMpName(id, card) {
      const p = Store.MyPlaylists.get(id);
      const nameEl = card.querySelector('.mp-name');
      if (!p || !nameEl) return;
      const input = document.createElement('input');
      input.className = 'mp-edit-input';
      input.value = p.name;
      input.maxLength = 30;
      nameEl.innerHTML = '';
      nameEl.appendChild(input);
      let doneFlag = false;
      const done = () => {
        if (doneFlag) return;
        doneFlag = true;
        Store.MyPlaylists.rename(id, input.value);
        this.vFavorites();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done();
        else if (e.key === 'Escape') this.vFavorites();
      });
      input.addEventListener('blur', done);
      input.focus();
      input.select();
    },

    /* ============================================================
     * 视图：自建歌单详情
     * ============================================================ */
    async vMyPlaylist(id) {
      const pl = Store.MyPlaylists.get(id);
      if (!pl) { this._viewError('歌单不存在或已删除', 'App.vMyPlaylist()'); return; }
      this._ctx.songs = pl.songs;
      this._mpId = pl.id; // 供「移出歌单」按钮知道目标歌单
      this._setView(
        '<section class="view-section"><div class="sec-head"><h2>' + esc(pl.name) + '</h2>' +
        '<span class="mp-count">' + pl.songs.length + ' 首</span></div>' +
        '<div class="mp-tools">' +
        (pl.songs.length ? '<button class="mini-btn" id="mp-play-all">播放全部</button>' : '') +
        '<button class="mini-btn" id="mp-rename">重命名</button>' +
        '<button class="mini-btn danger" id="mp-clear">清空列表</button>' +
        '<button class="mini-btn danger" id="mp-del">删除歌单</button></div>' +
        '<div class="mp-import"><div class="search-box"><form id="mp-import-form">' +
        '<input id="mp-import-input" placeholder="粘贴网易云 歌单/专辑/歌曲 链接或 ID，导入全部歌曲" maxlength="300"></form></div>' +
        '<button class="mini-btn" id="mp-import-btn">导入</button></div>' +
        '<div id="mp-progress" class="mp-progress"></div>' +
        (pl.songs.length ? this._songListHtml(pl.songs, { album: true, remove: true })
          : UI.empty('歌单是空的', '复制网易云歌单链接粘贴到上方输入框，点「导入」即可拉取全部歌曲')) +
        '</section>');
      const pa = $('#mp-play-all');
      if (pa) pa.addEventListener('click', () => Player.playQueue(pl.songs, 0));
      $('#mp-rename').addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'mp-edit-input';
        input.value = pl.name;
        input.maxLength = 30;
        const h2 = $('#view .sec-head h2');
        h2.innerHTML = ''; h2.appendChild(input);
        let doneFlag = false;
        const done = () => {
          if (doneFlag) return; doneFlag = true;
          Store.MyPlaylists.rename(pl.id, input.value);
          this.vMyPlaylist(pl.id);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); else if (e.key === 'Escape') this.vMyPlaylist(pl.id); });
        input.addEventListener('blur', done);
        input.focus(); input.select();
      });
      this._twoStep($('#mp-clear'), '清空列表', () => {
        Store.MyPlaylists.clearSongs(pl.id);
        toast('歌单已清空');
        this.vMyPlaylist(pl.id);
      });
      this._twoStep($('#mp-del'), '删除歌单', () => {
        Store.MyPlaylists.remove(pl.id);
        toast('歌单已删除');
        this.nav('favorites');
      });
      const btn = $('#mp-import-btn');
      const inp = $('#mp-import-input');
      const doImport = async () => {
        const v = inp.value.trim();
        if (!v) { toast('请先粘贴网易云链接或 ID', 'warn'); return; }
        const prog = $('#mp-progress');
        prog.textContent = '解析中…';
        let t = App._parseNeteaseLink(v);
        if (!t && /^\d{5,}$/.test(v)) t = { type: 'playlist', id: v }; // 导入框里纯 ID 默认按歌单处理
        if (!t) { prog.textContent = '无法识别该链接/ID'; return; }
        if (t.type === 'mv' || t.type === 'djradio' || t.type === 'program' || t.type === 'user' || t.type === 'radio') {
          prog.textContent = '暂不支持导入该类型：' + t.type;
          return;
        }
        const songs = await App._fetchImportSongs(t, (msg) => { const p = $('#mp-progress'); if (p) p.textContent = msg; });
        if (!songs || !songs.length) {
          prog.textContent = '未导入任何歌曲（链接无效 / 权限不足 / 已全部存在）';
          return;
        }
        const added = Store.MyPlaylists.addSongs(pl.id, songs);
        this.vMyPlaylist(pl.id);
        toast('导入完成：新增 ' + added + ' 首');
      };
      btn.addEventListener('click', doImport);
      $('#mp-import-form').addEventListener('submit', (e) => { e.preventDefault(); doImport(); });
      toast('MP HOOKS OK'); // DEBUG PROBE - remove
    },

    /** 两段式确认按钮（再点一次才执行），5 秒内未确认自动复位 */
    _twoStep(btn, label, fn) {
      if (!btn) return;
      if (btn.dataset.armed) { delete btn.dataset.armed; fn(); return; }
      btn.dataset.armed = '1';
      const old = btn.textContent;
      btn.textContent = label + '（再点确认）';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 5000);
      toast('ARMED ' + label); // DEBUG PROBE - remove
    },

    /** 按类型拉取歌单/专辑/歌曲全部歌曲（供自建歌单导入），分页上限 1500 首 */
    async _fetchImportSongs(t, onProg) {
      onProg = onProg || (() => {});
      try {
        if (t.type === 'song') {
          const s = await API.songDetail(t.id);
          return s && s.id ? [s] : [];
        }
        if (t.type === 'album') {
          const a = await API.albumDetail(t.id);
          return (a && a.songs) || [];
        }
        if (t.type === 'playlist') {
          const out = [];
          let offset = 0;
          while (out.length < 1500) {
            onProg('获取歌单歌曲… 已 ' + out.length + ' 首');
            const j = await API.playlistTracks(t.id, 100, offset);
            out.push(...(j.songs || []));
            if (!j.more || out.length >= 1500) break;
            offset += 100;
          }
          return out;
        }
      } catch (e) { /* 返回已获取部分 */ }
      return [];
    },

    /** 在网易云歌单页选择目标自建歌单并导入 */
    _openImportPicker(targetId) {
      const pls = Store.MyPlaylists.all;
      if (!pls.length) { toast('请先在「我的收藏 → 自建歌单」新建歌单', 'warn'); return; }
      const mask = document.createElement('div');
      mask.className = 'mp-pick-mask';
      mask.innerHTML =
        '<div class="mp-pick"><div class="mp-pick-head"><span>导入到自建歌单</span>' +
        '<button class="icon-btn" id="mp-pick-close">✕</button></div>' +
        '<div class="mp-pick-body">' + pls.map(p =>
          '<button class="mp-pick-item" data-target="' + p.id + '">' + esc(p.name) +
          '<em>' + p.songs.length + ' 首</em></button>').join('') +
        '</div><div class="mp-pick-foot">按歌曲 ID 去重导入，不影响收藏与最近播放</div></div>';
      document.body.appendChild(mask);
      const close = () => mask.remove();
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      $('#mp-pick-close').addEventListener('click', close);
      mask.querySelectorAll('[data-target]').forEach(b => b.addEventListener('click', async () => {
        const pid = b.dataset.target;
        const p = Store.MyPlaylists.get(pid);
        if (!p) { close(); return; }
        close();
        toast('正在导入到「' + p.name + '」…');
        try {
          const pl = await App._fetchImportSongs({ type: 'playlist', id: targetId }, () => {});
          const added = Store.MyPlaylists.addSongs(pid, pl);
          if (added) toast('导入完成：' + p.name + ' 新增 ' + added + ' 首');
          else toast('没有新歌曲（可能已存在或链接失效）', 'warn');
        } catch (e) {
          toast('导入失败：' + e.message, 'warn');
        }
      }));
    },

    _snapToSong(s) {
      const artists = (s.artistsArr && s.artistsArr.length)
        ? s.artistsArr
        : (s.artists ? String(s.artists).split(' / ').filter(Boolean).map(n => ({ id: 0, name: n })) : []);
      return {
        id: s.id, name: s.name, artists: artists,
        album: s.albumObj || (s.album ? { id: 0, name: s.album, cover: '' } : null),
        cover: s.cover || '', duration: s.duration || 0,
        fee: s.fee || 0, vip: !!s.vip,
      };
    },

    /* ============================================================
     * 视图：单曲落地页（分享链接 #/song/id 打开，自动播放）
     * ============================================================ */
    async vSong(id) {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const s = await API.songDetail(id);
        if (seq !== this._viewSeq) return;
        if (!s) throw new Error('未找到该歌曲');
        this._ctx = { songs: [s] };
        const html =
          '<section class="detail-head">' +
          '<div class="dt-cover"><img src="' + esc(coverUrl(s.cover || (s.album && s.album.cover))) + '" alt=""></div>' +
          '<div class="dt-info"><div class="dt-type">歌曲</div>' +
          '<h1 class="dt-name">' + esc(s.name) + '</h1>' +
          '<div class="dt-meta">' + esc(this._artistText(s)) + (s.album && s.album.name ? ' · ' + esc(s.album.name) : '') +
          (s.duration ? ' · ' + fmtDuration(s.duration) : '') + '</div>' +
          '<div class="dt-actions">' +
          '<button class="btn primary" id="dt-playall">' + Icons.icon('playTri') + '播放</button>' +
          '<button class="btn" id="dt-share">分享</button></div>' +
          '</div></section>' +
          '<section class="view-section"><div class="sec-head"><h2>单曲</h2></div>' +
          this._songListHtml([s], { album: true }) + '</section>';
        this._setView(html);
        $('#dt-playall').addEventListener('click', () => Player.playQueue([s], 0));
        $('#dt-share').addEventListener('click', () => this._shareSong(s));
        // 打开分享链接后自动播放（浏览器自动播放策略允许时；被拦截则用户点播放）
        setTimeout(() => { if (this._viewSeq === seq) Player.playQueue([s], 0); }, 600);
      } catch (e) {
        this._viewError('歌曲加载失败：' + e.message, 'App.vSong(\'' + id + '\')');
      }
    },

    /* ============================================================
     * 视图：歌单详情
     * ============================================================ */
    async vPlaylist(id) {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const [info, tracks] = await Promise.all([
          API.playlistDetail(id),
          API.playlistTracks(id, 100, 0).catch(() => ({ songs: [], more: false })),
        ]);
        if (seq !== this._viewSeq) return;
        const fav = Store.FavPlaylists.has(id);
        this._ctx = { songs: tracks.songs };
        const pl = { id: info.id, name: info.name, cover: info.cover, trackCount: info.trackCount };
        const html =
          '<section class="detail-head">' +
          '<div class="dt-cover"><img src="' + esc(coverUrl(info.cover)) + '" alt=""></div>' +
          '<div class="dt-info">' +
          '<div class="dt-type">歌单</div>' +
          '<h1 class="dt-name">' + esc(info.name) + '</h1>' +
          '<div class="dt-meta">' + esc(info.creator || '') + ' 创建 · 播放 ' + fmtCount(info.playCount) + ' · ' +
            (info.trackCount || 0) + ' 首' + (info.updateFrequency ? ' · ' + esc(info.updateFrequency) : '') + '</div>' +
          (info.tags && info.tags.length ? '<div class="dt-tags">' + info.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
          '<div class="dt-actions">' +
          '<button class="btn primary" id="dt-playall">' + Icons.icon('playTri') + '播放全部</button>' +
          '<button class="btn" id="dt-share">分享</button>' +
          '<button class="btn" id="dt-import">导入自建歌单</button>' +
          '<button class="btn' + (fav ? ' on' : '') + '" id="dt-fav">' + Icons.heartIcon(fav) +
          (fav ? '已收藏' : '收藏歌单') + '</button></div>' +
          (info.description ? '<div class="dt-desc">' + esc(info.description).slice(0, 120) + '</div>' : '') +
          '</div></section>' +
          '<section class="view-section"><div class="sec-head"><h2>歌曲列表</h2></div>' +
          '<div id="pl-tracks">' + this._songListHtml(tracks.songs, { album: true }) + '</div>' +
          (tracks.more ? '<div class="more-wrap"><button class="mini-btn" data-more="playlist-tracks" data-plid="' + id + '">加载更多</button></div>' : '') +
          '</section>';
        this._setView(html);
        $('#dt-playall').addEventListener('click', () => {
          if (this._ctx.songs.length) Player.playQueue(this._ctx.songs, 0);
          else toast('歌单暂无歌曲', 'warn');
        });
        $('#dt-fav').addEventListener('click', (e) => {
          const on = Store.FavPlaylists.toggle(pl);
          const b = e.currentTarget;
          b.classList.toggle('on', on);
          b.lastChild.textContent = on ? '已收藏' : '收藏歌单';
          toast(on ? '已收藏歌单' : '已取消收藏');
        });
        $('#dt-share').addEventListener('click', () => this._sharePage('playlist', id, '歌单', info.name, info.cover));
        $('#dt-import').addEventListener('click', () => this._openImportPicker(id));
      } catch (e) {
        this._viewError('歌单加载失败：' + e.message, 'App.vPlaylist(\'' + id + '\')');
      }
    },

    async _morePlaylistTracks(id) {
      const seq = this._viewSeq;
      const offset = this._ctx.songs.length;
      try {
        const data = await API.playlistTracks(id, 100, offset);
        if (seq !== this._viewSeq) return;
        this._ctx.songs.push(...data.songs);
        const box = $('#pl-tracks');
        box.insertAdjacentHTML('beforeend', this._songListHtml(data.songs, { album: true, start: offset }));
        if (!data.more) { const b = $('[data-more="playlist-tracks"]'); if (b) b.parentElement.remove(); }
        const btn = $('[data-more="playlist-tracks"]');
        if (btn) btn.textContent = '加载更多 (' + this._ctx.songs.length + ' 首)';
      } catch (e) { toast('加载失败：' + e.message, 'warn'); }
    },

    /* ============================================================
     * 视图：专辑
     * ============================================================ */
    async vAlbum(id) {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const { album, songs } = await API.albumDetail(id);
        if (seq !== this._viewSeq) return;
        this._ctx = { songs };
        const html =
          '<section class="detail-head">' +
          '<div class="dt-cover"><img src="' + esc(coverUrl(album.cover)) + '" alt=""></div>' +
          '<div class="dt-info"><div class="dt-type">专辑</div>' +
          '<h1 class="dt-name">' + esc(album.name) + '</h1>' +
          '<div class="dt-meta"><a class="link" data-artist="' + (album.artistId || '') + '">' + esc(album.artist || '') + '</a>' +
          (album.publishTime ? ' · ' + new Date(album.publishTime).toLocaleDateString('zh-CN') : '') + ' · ' + (album.size || songs.length) + ' 首</div>' +
          (album.description ? '<div class="dt-desc">' + esc(album.description).slice(0, 120) + '</div>' : '') +
          '<div class="dt-actions"><button class="btn primary" id="dt-playall">' + Icons.icon('playTri') + '播放全部</button>' +
          '<button class="btn" id="dt-share">分享</button></div>' +
          '</div></section>' +
          '<section class="view-section"><div class="sec-head"><h2>歌曲列表</h2></div>' +
          this._songListHtml(songs, { album: false }) + '</section>';
        this._setView(html);
        $('#dt-playall').addEventListener('click', () => Player.playQueue(this._ctx.songs, 0));
        $('#dt-share').addEventListener('click', () => this._sharePage('album', id, '专辑', album.name, album.cover));
      } catch (e) {
        this._viewError('专辑加载失败：' + e.message, 'App.vAlbum(\'' + id + '\')');
      }
    },

    /* ============================================================
     * 视图：歌手
     * ============================================================ */
    async vArtist(id) {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const [info, data] = await Promise.all([API.artistDetail(id), API.artistSongs(id)]);
        if (seq !== this._viewSeq) return;
        this._ctx = { songs: data.songs };
        const html =
          '<section class="detail-head artist-head">' +
          '<div class="dt-cover round"><img src="' + esc(coverUrl(info.cover)) + '" alt=""></div>' +
          '<div class="dt-info"><div class="dt-type">歌手</div>' +
          '<h1 class="dt-name">' + esc(info.name) + '</h1>' +
          '<div class="dt-meta">歌曲 ' + (info.songCount || 0) + ' 首 · 专辑 ' + (info.albumCount || 0) + ' 张</div>' +
          (info.briefDesc ? '<div class="dt-desc">' + esc(info.briefDesc).slice(0, 150) + '</div>' : '') +
          '<div class="dt-actions"><button class="btn primary" id="dt-playall">' + Icons.icon('playTri') + '播放热门50首</button>' +
          '<button class="btn" id="dt-share">分享</button></div>' +
          '</div></section>' +
          '<section class="view-section"><div class="sec-head"><h2>热门歌曲</h2></div>' +
          this._songListHtml(data.songs, { album: true }) + '</section>';
        this._setView(html);
        $('#dt-playall').addEventListener('click', () => Player.playQueue(this._ctx.songs, 0));
        $('#dt-share').addEventListener('click', () => this._sharePage('artist', id, '歌手', info.name, info.cover));
      } catch (e) {
        this._viewError('歌手加载失败：' + e.message, 'App.vArtist(\'' + id + '\')');
      }
    },

    /* ============================================================
     * 通用渲染：卡片 / 歌曲列表
     * ============================================================ */
    _plCard(p) {
      this._plCache = this._plCache || {};
      this._plCache[p.id] = p;
      const fav = Store.FavPlaylists.has(p.id);
      return '<div class="pl-card" data-pl="' + p.id + '">' +
        '<div class="pl-cover"><img src="' + esc(coverUrl(p.cover)) + '" alt="" loading="lazy">' +
        '<span class="pl-count">' + (p.playCount ? '▶ ' + fmtCount(p.playCount) : '') + '</span>' +
        '<button class="pl-fav' + (fav ? ' on' : '') + '" data-plfav="' + p.id + '" aria-label="收藏歌单">' +
        Icons.heartIcon(fav) + '</button>' +
        '<span class="pl-hover">' + Icons.icon('playTri') + '</span></div>' +
        '<div class="pl-name">' + esc(p.name) + '</div>' +
        '<div class="pl-sub">' + esc(p.sub || (p.trackCount ? p.trackCount + ' 首' : p.creator || '')) + '</div></div>';
    },

    _songListHtml(songs, opts) {
      if (!songs.length) return UI.empty('暂无歌曲');
      const showAlbum = opts.album !== false;
      const start = opts.start || 0; // 分页追加时传累计起始索引，保证编号/点击索引全局连续
      return '<div class="song-list">' + songs.map((s, i) => {
        const n = start + i;
        const artists = (s.artists || []).map(a => a.name).join(' / ');
        return '<div class="song-row" data-play="' + n + '" data-id="' + s.id + '">' +
          '<div class="sr-idx"><span class="sr-num">' + (n + 1) + '</span>' +
          '<svg class="sr-play" viewBox="0 0 1024 1024"><path d="M256 208.6v606.8c0 12.8 13 20.8 23.4 14.4l481-303.4c10.2-6.4 10.2-22.2 0-28.6L279.4 194.4c-10.4-6.6-23.4 1.4-23.4 14.2z"/></svg></div>' +
          '<div class="sr-cover"><img src="' + esc(coverUrl(s.cover)) + '" loading="lazy" alt=""></div>' +
          '<div class="sr-main"><div class="sr-name">' + esc(s.name) +
          (s.vip ? '<em class="vip-tag">VIP</em>' : '') + '</div>' +
          '<div class="sr-artists">' + esc(artists) + '</div></div>' +
          (showAlbum ? '<div class="sr-album">' + esc(s.album ? s.album.name : '') + '</div>' : '') +
          '<div class="sr-dur">' + fmtDuration(s.duration) + '</div>' +
          '<button class="sr-fav' + (Store.FavSongs.has(s.id) ? ' on' : '') + '" data-fav="' + n + '">' +
          Icons.heartIcon(Store.FavSongs.has(s.id)) + '</button>' +
          (opts.remove ? '<button class="sr-dl sr-del" data-mprem="' + n + '" aria-label="移出歌单">' +
            '<svg viewBox="0 0 1024 1024"><path d="M800 288H640.3V224c0-35.4-28.7-64-64-64h-128.5c-35.4 0-64 28.6-64 64v64H224c-35.4 0-64 28.7-64 64s28.7 64 64 64h26.4l30.6 428.4c1.7 24.2 21.9 43.2 46.1 43.2h369.8c24.2 0 44.4-19 46.1-43.2L773.6 416H800c35.4 0 64-28.7 64-64s-28.6-64-64-64z m-224-64v64H448v-64h128z M512 512c14.1 0 25.6 11.5 25.6 25.6l-12.8 214.4c0 14.1-11.5 25.6-25.6 25.6s-25.6-11.5-25.6-25.6l12.8-214.4c0-14.1 11.5-25.6 25.6-25.6z"/></svg></button>' : '') +
          '<button class="sr-dl sr-share" data-share="' + n + '" aria-label="分享">' +
          '<svg viewBox="0 0 1024 1024"><path d="M807 588c-36 0-68 14-93 36L416 486c1-7 1-13 0-20l298-138c25 22 57 36 93 36 75 0 136-61 136-136S882 92 807 92 671 153 671 228c0 7 0 13 1 20L374 386c-25-22-57-36-93-36-75 0-136 61-136 136s61 136 136 136c36 0 68-14 93-36l298 138c-1 7-1 13 0 20-1 75 60 136 135 136s136-61 136-136-61-136-136-136z"/></svg></button>' +
          '<button class="sr-dl" data-dl="' + n + '">' +
          '<svg viewBox="0 0 1024 1024"><path d="M752 288H538v359.8l95.8-94.4c10.2-10 26.6-10 36.8 0.2 10 10.2 10 26.6-0.2 36.8l-140 138c-5 4.8-11.6 7.4-18.2 7.4-3.4 0-6.8-0.6-10-2-3-1.2-5.8-3.2-8.2-5.4l-140-138c-10.2-10-10.4-26.6-0.2-36.8 10-10.2 26.6-10.4 36.8-0.2l95.8 94.4V288H272c-44 0-80 36-80 80v480c0 44 36 80 80 80h480c44 0 80-36 80-80V368c0-44-36-80-80-80zM538 122c0-14.4-11.6-26-26-26s-26 11.6-26 26v166h52V122z"/></svg></button>' +
          '</div>';
      }).join('') + '</div>';
    },

    /* ============================================================
     * 视图事件委托（#view 上常驻监听）
     * ============================================================ */
    _bindViewEvents() {
      $('#view').addEventListener('click', (e) => {
        /* 注意顺序：歌单收藏/歌曲收藏/下载按钮必须先于导航/播放判断 */
        const backEl = e.target.closest('[data-back]');
        if (backEl) { this._goBack(); return; }
        const plFavEl = e.target.closest('[data-plfav]');
        if (plFavEl) {
          const id = plFavEl.dataset.plfav;
          const pl = (this._plCache && this._plCache[id]) || { id: id, name: '', cover: '' };
          const on = Store.FavPlaylists.toggle(pl);
          plFavEl.classList.toggle('on', on);
          plFavEl.innerHTML = Icons.heartIcon(on);
          toast(on ? '已收藏歌单' : '已取消收藏');
          return;
        }
        const favEl = e.target.closest('[data-fav]');
        if (favEl) {
          const i = +favEl.dataset.fav;
          const s = this._ctx.songs[i];
          if (!s) return;
          const on = Store.FavSongs.toggle(s);
          favEl.classList.toggle('on', on);
          favEl.innerHTML = Icons.heartIcon(on);
          toast(on ? '已收藏 ♥' : '已取消收藏');
          return;
        }
        const shareEl = e.target.closest('[data-share]');
        if (shareEl) {
          const i = +shareEl.dataset.share;
          const s = this._ctx.songs && this._ctx.songs[i];
          if (s) this._shareSong(s);
          return;
        }
        const dlEl = e.target.closest('[data-dl]');
        if (dlEl) {
          const i = +dlEl.dataset.dl;
          const s = this._ctx.songs[i];
          if (s) this._downloadSong(s);
          return;
        }
        const mpremEl = e.target.closest('[data-mprem]');
        if (mpremEl) {
          const i = +mpremEl.dataset.mprem;
          const s = this._ctx.songs[i];
          const pid = this._mpId; // vMyPlaylist 渲染时记录
          if (s && pid) {
            Store.MyPlaylists.removeSong(pid, s.id);
            toast('已移出歌单');
            this.vMyPlaylist(pid);
          }
          return;
        }
        const mpRenEl = e.target.closest('[data-mp-rename]');
        if (mpRenEl) {
          this._editMpName(mpRenEl.dataset.mpRename, mpRenEl.closest('.mp-card'));
          return;
        }
        const mpDelEl = e.target.closest('[data-mp-del]');
        if (mpDelEl) {
          const id = mpDelEl.dataset.mpDel;
          const p = Store.MyPlaylists.get(id);
          const card = mpDelEl.closest('.mp-card');
          if (!p || !card) return;
          card.innerHTML = '<div class="mp-del-confirm">删除歌单「' + esc(p.name) + '」？<br>' +
            '<button class="mini-btn danger" data-mp-del-yes="' + id + '">确认删除</button>' +
            '<button class="mini-btn" data-mp-del-no>取消</button></div>';
          return;
        }
        const mpDelYesEl = e.target.closest('[data-mp-del-yes]');
        if (mpDelYesEl) {
          Store.MyPlaylists.remove(mpDelYesEl.dataset.mpDelYes);
          toast('歌单已删除');
          this.vFavorites();
          return;
        }
        const mpDelNoEl = e.target.closest('[data-mp-del-no]');
        if (mpDelNoEl) { this.vFavorites(); return; }
        const mpEl = e.target.closest('[data-mp]');
        if (mpEl) { this.nav('myplaylist/' + mpEl.dataset.mp); return; }
        const playEl = e.target.closest('[data-play]');
        if (playEl) {
          const i = +playEl.dataset.play;
          const songs = this._ctx.songs;
          if (songs && songs[i]) Player.playQueue(songs, i);
          return;
        }
        const plEl = e.target.closest('[data-pl]');
        if (plEl) { this.nav('playlist/' + plEl.dataset.pl); return; }
        const alEl = e.target.closest('[data-album]');
        if (alEl) { this.nav('album/' + alEl.dataset.album); return; }
        const arEl = e.target.closest('[data-artist]');
        if (arEl && arEl.dataset.artist) { this.nav('artist/' + arEl.dataset.artist); return; }
        const scEl = e.target.closest('[data-search]');
        if (scEl) {
          const tsi = $('#top-search-input');
          if (tsi) tsi.value = scEl.dataset.search;
          Store.SearchHistory.add(scEl.dataset.search);
          this.nav('search', { q: scEl.dataset.search });
          return;
        }
        const catEl = e.target.closest('[data-cat]');
        if (catEl) { this.nav('playlists', { cat: catEl.dataset.cat, order: this._ctx.order }); return; }
        const ordEl = e.target.closest('[data-order]');
        if (ordEl) { this.nav('playlists', { cat: this._ctx.cat, order: ordEl.dataset.order }); return; }
        const moreEl = e.target.closest('[data-more]');
        if (moreEl) {
          if (moreEl.dataset.more === 'playlists') this._morePlaylists();
          else if (moreEl.dataset.more === 'search') this._moreSearch();
          else if (moreEl.dataset.more === 'playlist-tracks') this._morePlaylistTracks(moreEl.dataset.plid);
          return;
        }
        const banEl = e.target.closest('[data-banner]');
        if (banEl) this._bannerClick(+banEl.dataset.banner);
      });
    },

    async _bannerClick(i) {
      const b = this._ctx.banners[i];
      if (!b) return;
      if (b.targetType === 1 && b.targetId) {
        try {
          const song = await API.songDetail(b.targetId);
          if (song) Player.playQueue([song], 0);
        } catch (e) { toast('播放失败：' + e.message, 'warn'); }
      } else if (b.targetType === 10 && b.targetId) this.nav('album/' + b.targetId);
      else if (b.targetType === 1000 && b.targetId) this.nav('playlist/' + b.targetId);
      else if (b.url) window.open(b.url, '_blank');
    },

    /* ---------------- 下载 ---------------- */
    async _downloadSong(song) {
      toast('正在获取下载地址…');
      try {
        let info = null;
        // 下载优先走红云点歌（下载专用接口），失败再走网易云
        try {
          info = await API.hongyunUrl(song.id, Store.Settings.quality);
          info.source = '红云点歌';
        } catch (e1) {
          info = await API.resolveUrl(song, Store.Settings.quality);
        }
        if (!info || !info.url) throw new Error('无可用地址');
        const a = document.createElement('a');
        a.href = info.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.download = song.name + '.' + (info.type || 'mp3');
        // 尝试 blob 方式下载（跨域 CORS 已放开），失败则新标签页打开
        try {
          const res = await fetch(info.url, { mode: 'cors' });
          if (res.ok) {
            const blob = await res.blob();
            const ext = (info.type || blob.type.split('/')[1] || 'mp3').replace('mpeg', 'mp3');
            const url = URL.createObjectURL(blob);
            a.href = url;
            a.download = song.name + ' - ' + (song.artists || []).map(x => x.name).join('/') + '.' + ext;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
            toast('开始下载《' + song.name + '》');
            return;
          }
        } catch (e) { /* 走新标签页 */ }
        a.click();
        toast('已在新标签页打开下载链接（' + (info.source || '') + '）');
      } catch (e) {
        toast('下载失败：' + e.message, 'warn');
      }
    },

    /* ============================================================
     * 静态绑定（播放栏 / 遮罩 / 弹窗）
     * ============================================================ */
    _bindStatic() {
      /* 侧边栏 */
      $('#btn-settings').addEventListener('click', () => this.openSettings());
      $('#btn-topback').addEventListener('click', () => this._goBack());
      $('#btn-login').addEventListener('click', () => this.openAuth('login'));
      $('#btn-register').addEventListener('click', () => this.openAuth('register'));
      $('#btn-logout').addEventListener('click', async () => {
        await Store.Session.logout();
        toast('已退出登录');
      });
      /* 侧栏头像：点击更换（未登录时随 #side-user 隐藏） */
      const sideAvatar = $('#side-user-avatar');
      if (sideAvatar) sideAvatar.addEventListener('click', () => this._changeAvatar());
      document.addEventListener('ym:session', () => this._syncAuthUI());
      /* 侧栏抽屉开合：手机端伴随灰色遮罩，点遮罩/点导航/点收藏歌单均可收起 */
      const setSide = (open) => {
        const sb = $('#sidebar');
        const mk = $('#side-mask');
        sb.classList.toggle('open', open);
        if (!mk) return;
        clearTimeout(mk._t);
        if (open) {
          mk.classList.remove('hidden');
          requestAnimationFrame(() => mk.classList.add('show'));
        } else {
          mk.classList.remove('show');
          mk._t = setTimeout(() => mk.classList.add('hidden'), 260);
        }
      };
      $('#btn-menu').addEventListener('click', () => {
        const sb = $('#sidebar');
        setSide(!sb.classList.contains('open'));
      });
      $('#side-mask').addEventListener('click', () => setSide(false));
      $('#sidebar').addEventListener('click', (e) => {
        if (e.target.closest('a') || e.target.closest('[data-spl]')) setSide(false);
      });

      /* 播放栏 */
      $('#pb-play').addEventListener('click', () => Player.toggle());
      $('#pb-prev').addEventListener('click', () => Player.prev());
      $('#pb-next').addEventListener('click', () => Player.next(false));
      $('#pb-mode').addEventListener('click', () => Player.cycleMode());
      $('#pb-queue').addEventListener('click', () => this.toggleQueue());
      $('#pb-left').addEventListener('click', () => this.openOverlay());
      $('#pb-fav').addEventListener('click', (e) => {
        e.stopPropagation();
        const on = Player.fav();
        if (on === false && !Player.current()) { toast('当前没有播放歌曲', 'warn'); return; }
        $('#pb-fav').classList.toggle('on', on);
        $('#pb-fav').innerHTML = Icons.heartIcon(on);
        toast(on ? '已收藏 ♥' : '已取消收藏');
      });
      /* 播放栏音质为纯展示（切换在设置弹窗内） */

      /* 进度条：拖动时暂停播放（静音拖动，避免漏音/卡顿），松开后恢复 */
      const bindBar = (barId, seekFn, color) => {
        const bar = $(barId);
        let dragResume = false;
        const sync = () => {
          const ratio = bar.value / 1000;
          bar.style.background = 'linear-gradient(to right, ' + color + ' 0%, ' + color + ' ' + ratio * 100 +
            '%, rgba(255,255,255,.22) ' + ratio * 100 + '%, rgba(255,255,255,.22) 100%)';
        };
        bar.addEventListener('pointerdown', () => {
          const a = Player.audio;
          dragResume = !!a && !a.paused && !!Player.current();
          if (dragResume) a.pause();
        });
        bar.addEventListener('input', () => {
          if (barId === '#pb-bar') this._barDragging = true; else this._ovDragging = true;
          const dur = Player.duration || 0;
          if (dur > 0) seekFn(bar.value / 1000 * dur);
          sync();
        });
        bar.addEventListener('change', () => {
          if (barId === '#pb-bar') this._barDragging = false; else this._ovDragging = false;
          if (dragResume) {
            dragResume = false;
            Player.audio.play().catch(() => {});
          }
        });
        bar.sync = sync;
      };
      bindBar('#pb-bar', (t) => Player.seek(t), 'var(--accent)');
      bindBar('#ov-bar', (t) => Player.seek(t), '#ffffff');

      /* 音量：拖动时实时生效，松开才写入存储（避免每 tick 同步写 localStorage） */
      const bindVol = (barId, muteId) => {
        // iOS Safari 忽略 HTMLMediaElement.volume（音量只能系统侧键调）：
        // 滑块退化为“静音开关”，拖动>0 取消静音并提示；muted 在 iOS 上始终有效。
        const iosHinted = {};
        const applyVol = (v) => {
          if (Player._isIOS && Player._isIOS()) {
            Player.audio.muted = v <= 0;
            if (v > 0 && !iosHinted[barId]) {
              iosHinted[barId] = true;
              toast('iPhone 音量请用机身侧键调节（滑块用于静音/取消静音）');
              setTimeout(() => { iosHinted[barId] = false; }, 4000);
            }
          } else {
            Player.audio.volume = v / 100;
            Player.audio.muted = v <= 0;
          }
        };
        $(barId).addEventListener('input', () => {
          applyVol(+$(barId).value);
          this._syncVolume(+$(barId).value);
        });
        $(barId).addEventListener('change', () => {
          const v = +$(barId).value;
          Store.Settings.set({ volume: v, muted: v === 0 });
          this._syncVolume();
        });
        $(muteId).addEventListener('click', () => {
          const m = !Store.Settings.muted;
          applyVol(m ? 0 : Store.Settings.volume);
          Store.Settings.set({ muted: m });
          this._syncVolume();
        });
      };
      bindVol('#pb-volume', '#pb-mute');
      bindVol('#ov-volume', '#ov-mute');

      /* 全屏播放页 */
      $('#ov-close').addEventListener('click', () => this.closeOverlay());
      $('#ov-play').addEventListener('click', () => Player.toggle());
      $('#ov-prev').addEventListener('click', () => Player.prev());
      $('#ov-next').addEventListener('click', () => Player.next(false));
      $('#ov-mode').addEventListener('click', () => Player.cycleMode());
      $('#ov-fav').addEventListener('click', () => {
        const on = Player.fav();
        $('#ov-fav').classList.toggle('on', on);
        $('#ov-fav').innerHTML = Icons.heartIcon(on);
        toast(on ? '已收藏 ♥' : '已取消收藏');
      });
      /* 歌词面板固定工具栏（右下角）：翻译(译/原) / 歌单列表 / 歌词显示 */
      $('#ly-trans-toggle').addEventListener('click', () => {
        if (!$$('.ly-trans').length) { toast('该歌曲暂无译文', 'warn'); return; }
        this._lyricTrans = !this._lyricTrans;
        $$('.ly-trans').forEach(el => el.classList.toggle('hide', !this._lyricTrans));
        const tb = $('#ly-trans-toggle');
        tb.textContent = this._lyricTrans ? '译' : '原';
        tb.classList.toggle('on', this._lyricTrans);
      });
      $('#ly-queue').addEventListener('click', () => this.toggleQueue());
      $('#ly-toggle').addEventListener('click', () => {
        this._lyricsVisible = !this._lyricsVisible;
        const ob = $('#ov-body');
        if (ob) ob.classList.toggle('lyrics-hidden', !this._lyricsVisible);
        $('#ly-toggle').classList.toggle('on', this._lyricsVisible);
      });
      $('#ly-share').addEventListener('click', () => {
        const s = Player.current();
        if (s) this._shareSong(s);
        else toast('当前没有播放歌曲', 'warn');
      });

      /* 队列抽屉 */
      $('#qd-close').addEventListener('click', () => this.closeQueue());
      $('#queue-mask').addEventListener('click', () => this.closeQueue());
      $('#qd-list').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-qrm]');
        if (rm) {
          Player.removeFromQueue(+rm.dataset.qrm);
          this.renderQueue();
          return;
        }
        const it = e.target.closest('[data-qidx]');
        if (it) {
          Player.playQueue(Player.queue, +it.dataset.qidx);
          this.renderQueue();
        }
      });

      /* 设置弹窗 */
      $('#settings').querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => this.closeSettings()));
      /* 设置弹窗二级页导航：一级行 → 二级页；二级返回 → 回一级列表 */
      $('#settings').addEventListener('click', (e) => {
        const row = e.target.closest('[data-setpage]');
        if (row) { this._showSetPage(row.dataset.setpage); return; }
        const back = e.target.closest('[data-setback]');
        if (back) this._showSetPage('');
      });

      /* 登录/注册弹窗 */
      $('#auth').querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => this.closeAuth()));
      $('#auth-toggle').addEventListener('click', () =>
        this.openAuth(this._authMode === 'register' ? 'login' : 'register'));
      $('#auth-submit').addEventListener('click', () => this._submitAuth());
      $('#auth-pass').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._submitAuth();
      });
      this._bindSliderCaptcha();
      /* 更新公告 */
      $('#set-notice').addEventListener('click', () => this.openNotice());
      $('#notice').querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => this.closeNotice()));
      $('#set-clear-fav').addEventListener('click', () => { Store.FavSongs.clear(); Store.FavPlaylists.clear(); toast('收藏已清空'); });
      $('#set-clear-recent').addEventListener('click', () => { Store.Recent.clear(); toast('最近播放已清空'); });
      $('#set-clear-all').addEventListener('click', () => {
        Store.clearAll();
        if (window.AudioCache) AudioCache.clear().then(() => {});
        toast('全部数据已清空');
      });

      this._bindViewEvents();
    },

    /* ============================================================
     * 播放器事件 → UI
     * ============================================================ */
    _bindPlayerEvents() {
      Player.on('change', (e) => this._onChange(e.detail));
      Player.on('state', (e) => this._onState(e.detail));
      Player.on('time', (e) => this._onTime(e.detail));
      Player.on('mode', (e) => this._onMode(e.detail));
      Player.on('quality', (e) => this._onQuality(e.detail));
    },

    _onChange(d) {
      const bar = $('#playerbar');
      const has = !!d.song;
      bar.classList.toggle('hidden', !has);
      if (!has) {
        $('#pb-title').textContent = '未在播放';
        $('#pb-artist').textContent = '';
        return;
      }
      $('#pb-title').textContent = d.song.name;
      $('#pb-artist').textContent = (d.song.artists || []).map(a => a.name).join(' / ');
      $('#pb-cover').src = d.song.cover ? coverUrl(d.song.cover) : PLACEHOLDER;
      const faved = Store.FavSongs.has(d.song.id);
      $('#pb-fav').classList.toggle('on', faved);
      $('#pb-fav').innerHTML = Icons.heartIcon(faved);
      $('#ov-title').textContent = d.song.name;
      $('#ov-artist').textContent = (d.song.artists || []).map(a => a.name).join(' / ') +
        (d.song.album && d.song.album.name ? ' — ' + d.song.album.name : '');
      $('#ov-cover').src = d.song.cover ? coverUrl(d.song.cover) : PLACEHOLDER;
      $('#ov-bg').style.backgroundImage = d.song.cover ? 'url("' + coverUrl(d.song.cover) + '")' : '';
      this._analyzeCover(d.song.cover);
      $('#ov-fav').classList.toggle('on', faved);
      $('#ov-fav').innerHTML = Icons.heartIcon(faved);
      document.title = d.song.name + ' - B·Music';
      this._onState({ state: d.state });
      this._loadLyric(d.song);
      this._markActiveRow();
      if (this._queueOpen) this.renderQueue();
    },

    _onState(d) {
      const playing = d.state === 'playing';
      $('#pb-play').classList.toggle('playing', playing);
      $('#ov-play').classList.toggle('playing', playing);
      $('#pb-dot').classList.toggle('on', playing);
      $('#ov-disc').classList.toggle('spinning', playing);
      if (d.state === 'loading') {
        $('#pb-play').classList.add('loading');
        $('#ov-play').classList.add('loading');
      } else {
        $('#pb-play').classList.remove('loading');
        $('#ov-play').classList.remove('loading');
      }
    },

    _onTime(d) {
      if (!this._barDragging) {
        $('#pb-bar').value = d.dur > 0 ? Math.round(d.cur / d.dur * 1000) : 0;
      }
      if (!this._ovDragging) {
        $('#ov-bar').value = d.dur > 0 ? Math.round(d.cur / d.dur * 1000) : 0;
      }
      const pb = $('#pb-bar');
      const ov = $('#ov-bar');
      if (pb && pb.sync) pb.sync();
      if (ov && ov.sync) ov.sync();
      $('#pb-cur').textContent = fmtTime(d.cur);
      $('#pb-dur').textContent = fmtTime(d.dur);
      $('#ov-cur').textContent = fmtTime(d.cur);
      $('#ov-dur').textContent = fmtTime(d.dur);
      // 歌词同步由 rAF 渲染循环负责（60fps 平滑）
    },

    _onMode(d) {
      const html = UI.modeIcon(d.mode);
      $('#pb-mode').innerHTML = html;
      $('#ov-mode').innerHTML = html;
    },

    _onQuality(d) {
      const label = Player.qualityLabel(d.quality);
      $('#pb-quality').textContent = label;
      const oq = $('#ov-quality');
      if (oq) oq.textContent = label + '音质';
      $$('#set-quality .q-item').forEach(el =>
        el.classList.toggle('active', el.dataset.q === d.quality));
    },

    /* 播放中的行高亮 */
    _markActiveRow() {
      const cur = Player.current();
      $$('.song-row').forEach(r => {
        const is = cur && r.dataset.id === String(cur.id);
        r.classList.toggle('active', is);
        if (is) {
          const fav = r.querySelector('.sr-fav');
          if (fav) fav.classList.toggle('on', Store.FavSongs.has(cur.id));
        }
      });
    },

    /* ============================================================
     * 歌词
     * ============================================================ */
    /** 占位文案（纯音乐/加载中/加载失败）：居中于封面中心，不可滚动、不可选择 */
    _showLyricPlaceholder(text) {
      const ph = $('#ly-placeholder');
      const inner = $('#ov-lyrics-inner');
      if (inner) inner.innerHTML = '';
      if (ph) { ph.textContent = text; ph.hidden = false; }
    },
    _hideLyricPlaceholder() {
      const ph = $('#ly-placeholder');
      if (ph) ph.hidden = true;
    },

    async _loadLyric(song) {
      const box = $('#ov-lyrics-inner');
      if (this._lyricSongId === song.id && this._lyricLines.length) return;
      this._lyricSongId = song.id;
      this._lyricLines = [];
      this._lyricState = { li: -1 };
      this._showLyricPlaceholder('加载歌词…');
      const show = (base, trans) => {
        const tb = $('#ly-trans-toggle');
        const setTrans = (has) => {
          this._lyricTrans = !!has;
          if (tb) {
            tb.textContent = has ? '译' : '原'; // 显示译文→"译"，仅原文→"原"
            tb.classList.toggle('on', has);
          }
        };
        const merged = Lrc.mergeLyrics(base || '', trans || '');
        this._lyricLines = merged;
        if (!box) return;
        if (!merged.length) {
          this._showLyricPlaceholder('纯音乐，请欣赏');
          setTrans(false);
          return;
        }
        const hasTrans = merged.some(l => l.tl);
        setTrans(hasTrans);
        this._hideLyricPlaceholder();
        this._renderLyricBox(box, merged, hasTrans);
      };
      try {
        const ly = await API.lyric(song.id);
        if (ly.base) {
          show(ly.base, ly.trans);
        } else {
          const hy = await API.hongyunLrc(song.id);
          show(hy, '');
        }
      } catch (e) {
        this._lyricLines = [];
        this._showLyricPlaceholder('歌词加载失败');
      }
    },

    _renderLyricBox(box, lines, hasTrans) {
      const html = lines.map((l, i) => {
        const dur = Math.max(0.5, ((lines[i + 1] ? lines[i + 1].t : l.t + 5) - l.t));
        return '<div class="ly-line" data-li="' + i + '" data-t="' + l.t + '" data-d="' + dur + '">' +
          '<div class="ly-text">' + (l.l ? esc(l.l) : '&nbsp;') + '</div>' +
          (l.tl ? '<div class="ly-trans' + (hasTrans ? '' : ' hide') + '">' + esc(l.tl) + '</div>' : '') +
          '</div>';
      }).join('');
      box.innerHTML = html;
      // 模糊层同步同一份歌词（只渲染一次，纹理随自身 transform 平移，GPU 合成）
      const blurBox = $('#ov-lyric-blur-inner');
      if (blurBox) blurBox.innerHTML = html;
      // 点击歌词跳转（同时退出预览模式，恢复模糊）
      $$('.ly-line', box).forEach(el => {
        el.addEventListener('click', () => {
          this._userScrollAt = 0; // 点击跳转后恢复自动跟随
          const w = $('.ov-lyrics');
          if (w) w.classList.remove('lyrics-previewing');
          clearTimeout(this._lyricPreviewT);
          Player.seek(parseFloat(el.dataset.t));
        });
      });
      this._cacheLyricEls(box);
    },

    /** 缓存歌词 DOM，避免每帧查询（性能优化） */
    _cacheLyricEls(box) {
      this._lyricEls = $$('.ly-line', box);
      this._lyricState = { li: -1 };
      this._lyricPadTop = 0;
      this._lyricPadBottom = 0;
      this._lastPad = 0;
      this._lastGlowBg = 0;
      this._lyricScroll = 0;
      this._measureLyrics();
      this._applyLyricScroll();
    },

    /**
     * 度量歌词轨道与每行位置并缓存 —— 滚动动画循环里不再逐帧读 offsetTop/
     * offsetHeight/clientHeight（那些读取会强制同步布局，是动画掉帧主因）。
     * 行高/位置只在渲染后、字体加载、窗口变化时重测。
     */
    _measureLyrics() {
      const els = this._lyricEls || [];
      const wrap = $('.ov-lyrics');
      const m = [];
      for (let i = 0; i < els.length; i++) {
        m.push({ top: els[i].offsetTop, h: els[i].offsetHeight || 42 });
      }
      this._lyricM = m;
      this._lyricMeasuredAt = performance.now();
      if (wrap) {
        this._wrapClientH = wrap.clientHeight;
        this._wrapScrollH = wrap.scrollHeight;
      }
    },
    /** 懒重测：行数变化 / 字体加载 / 缩放断点改变后调用 */
    _ensureLyricMeasured(force) {
      if (force || !this._lyricM || !this._lyricM.length ||
        performance.now() - (this._lyricMeasuredAt || 0) > 1500) {
        this._measureLyrics();
      }
    },

    /** 分析封面亮部区域（8x8 亮度网格），供背景多点高光 */
    _analyzeCover(src) {
      this._coverCells = null;
      if (!src) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 32; c.height = 32;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);
          const d = ctx.getImageData(0, 0, 32, 32).data;
          const cells = [];
          for (let cy = 0; cy < 8; cy++) {
            for (let cx = 0; cx < 8; cx++) {
              let s = 0, n = 0;
              for (let y = cy * 4; y < (cy + 1) * 4; y++) {
                for (let x = cx * 4; x < (cx + 1) * 4; x++) {
                  const i = (y * 32 + x) * 4;
                  s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                  n++;
                }
              }
              cells.push({ x: (cx + 0.5) / 8 * 100, y: (cy + 0.5) / 8 * 100, v: s / n / 255 });
            }
          }
          this._coverCells = cells;
        } catch (e) { this._coverCells = null; }
      };
      img.onerror = () => { this._coverCells = null; };
      img.src = coverUrl(src);
    },

    /**
     * 歌词渲染循环（requestAnimationFrame 驱动，60fps 平滑）
     * - 基础歌词：行级连续填充（当前行从左往右，边界羽化）
     * - 滚动采用指数跟随：当前行定位在封面正中，其余行随之移动
     * - 背景高光随音乐起伏（AnalyserNode）动态增减
     */
    startLyricLoop() {
      if (this._lyricRafId) return;
      this._lastTick = 0;
      const tick = (now) => {
        this._lyricRafId = requestAnimationFrame(tick);
        this._lyricUpdate(now);
      };
      this._lyricRafId = requestAnimationFrame(tick);
    },
    stopLyricLoop() {
      if (this._lyricRafId) {
        cancelAnimationFrame(this._lyricRafId);
        this._lyricRafId = 0;
      }
    },

    /** 熄灭一行（高亮复位，回到灰色） */
    _resetLyricLine(i) {
      const els = this._lyricEls;
      const e = els[i];
      if (!e) return;
      e.classList.remove('active');
    },

    _lyricUpdate(now) {
      if ($('#overlay').classList.contains('hidden')) return;
      const dt = Math.min(0.1, Math.max(0.001, (now - (this._lastTick || now)) / 1000));
      this._lastTick = now;
      // 0) 背景高光随音乐起伏：根据封面亮部区域多点增亮（150ms 节流）
      const lvl = Player.level ? Player.level() : 0;
      this._glowLvl = (this._glowLvl || 0) * 0.88 + lvl * 0.12;
      const gl = $('#ov-glow');
      if (gl) {
        if (now - this._lastGlowBg > 150) {
          this._lastGlowBg = now;
          if (this._coverCells && this._coverCells.length) {
            const bright = this._coverCells.filter(c => c.v > 0.48).sort((a, b) => b.v - a.v).slice(0, 5);
            if (bright.length) {
              const total = bright.reduce((s, c) => s + c.v, 0) || 1;
              const bg = bright.map((c) => {
                const a = Math.min(0.30, (0.20 + this._glowLvl * 0.45) * (c.v / total) * 2.2);
                return 'radial-gradient(circle at ' + c.x.toFixed(1) + '% ' + c.y.toFixed(1) +
                  '%, rgba(255,255,255,' + a.toFixed(3) + '), transparent 55%)';
              }).join(', ');
              gl.style.backgroundImage = bg;
              gl.style.opacity = (0.55 + this._glowLvl * 0.45).toFixed(3);
            } else {
              gl.style.backgroundImage = '';
              gl.style.opacity = (0.12 + this._glowLvl * 0.4).toFixed(3);
            }
          } else {
            gl.style.backgroundImage = '';
            gl.style.opacity = (0.16 + this._glowLvl * 0.5).toFixed(3);
          }
        }
      }
      if (this._lyricsVisible === false) return;
      const wrap = $('.ov-lyrics');
      const lines = this._lyricLines;
      const els = this._lyricEls;
      if (!wrap || !lines || !lines.length || !els || !els.length) return;
      // 少量开销：定时重算 padding（移动端断点变化；padding 在轨道 #ov-lyrics-inner 上）
      if (now - this._lastPad > 500) {
        const src = $('#ov-lyrics-inner') || wrap;
        const ws = getComputedStyle(src);
        this._lyricPadTop = parseFloat(ws.paddingTop) || 0;
        this._lyricPadBottom = parseFloat(ws.paddingBottom) || 0;
        this._lastPad = now;
      }
      const cur = Player.audio.currentTime || Player.curTime || 0;
      let li = Lrc.findIndex(lines, cur);
      const st = this._lyricState || (this._lyricState = { li: -1 });

      // 第一句之前：不点亮任何行（全部保持暗色）
      if (li < 0) {
        if (st.li >= 0) {
          this._resetLyricLine(st.li);
          st.li = -1;
        }
        return;
      }

      // 1) 活动行切换（仅变化时操作 DOM；离开的行必须熄灭）
      if (li !== st.li) {
        if (st.li >= 0) this._resetLyricLine(st.li);
        if (els[li]) els[li].classList.add('active');
        st.li = li;
        // 模糊窗口：仅活动行附近 ±10 行保留模糊（远处行关闭滤镜，节省 GPU）
        for (let i = 0; i < els.length; i++) {
          const far = Math.abs(i - li) > 10;
          if (els[i].classList.contains('ly-far') !== far) els[i].classList.toggle('ly-far', far);
        }
      }

      // 2) 无 YRC 逐字数据：整段显示（活动行纯白，其余行灰色+模糊），不做卡拉OK填充
      const el = els[li];
      if (el) {
        const d = parseFloat(el.dataset.d) || 5;
        const t0 = parseFloat(el.dataset.t) || 0;
        const p = Math.max(0, Math.min(1, (cur - t0) / d)); // 行进度 0..1（仅用于随唱上滑）
        // 3) 指数跟随 + 随唱平滑上移：行开始时下边缘在中心偏下 20px，随演唱进度
        //    连续上滑到中心偏上 10px；换行时自然衔接，避免“一跳一跳”的断续感。
        //    transform 平移（GPU 合成）；用户手动滚动预览时暂停跟随（4 秒）
        if (now - (this._userScrollAt || 0) < 4000) {
          // 用户预览中，保持当前滚动位置
        } else {
          // 注意：clientHeight 已包含上下 padding，直接以其一半作为可视中心；
          // offsetTop 已相对轨道顶边（含其 padding），不再加 padTop
          this._ensureLyricMeasured();
          const m = this._lyricM && this._lyricM[li];
          const travel = 20; // 随唱上滑行程 px
          const wrapH = this._wrapClientH || wrap.clientHeight;
          const scrollH = this._wrapScrollH || wrap.scrollHeight;
          const lineH = m ? m.h : (el.offsetHeight || 42);
          const maxScroll = Math.max(0, scrollH - wrapH);
          const base = m ? m.top : el.offsetTop;
          const target = Math.max(0, Math.min(maxScroll,
            base + lineH - wrapH / 2 + 10 + p * travel));
          const diff = target - (this._lyricScroll || 0);
          if (Math.abs(diff) > 0.5) {
            const k = 1 - Math.exp(-dt * 11); // 收敛时间约 250ms
            this._lyricScroll = Math.max(0, Math.min(maxScroll, (this._lyricScroll || 0) + diff * k));
            this._applyLyricScroll();
          }
        }
      }
    },

    /** 应用歌词轨道平移（GPU 合成滚动；同时清零容器原生 scrollTop 防双重偏移） */
    _applyLyricScroll() {
      const wrap = $('.ov-lyrics');
      if (wrap && wrap.scrollTop !== 0) wrap.scrollTop = 0;
      const inner = $('#ov-lyrics-inner') || wrap;
      if (inner) {
        const t = 'translate3d(0, ' + (-(this._lyricScroll || 0)).toFixed(2) + 'px, 0)';
        inner.style.transform = t;
        // 模糊层与清晰层同步平移（各层自带 transform → 合成器纹理平移，无逐行重光栅化）
        const blurInner = $('#ov-lyric-blur-inner');
        if (blurInner) blurInner.style.transform = t;
      }
    },

    /** 立即同步一次（打开播放页时调用） */
    _syncLyric(cur) {
      this._lyricUpdate(performance.now());
    },

    /* ============================================================
     * 全屏播放页
     * ============================================================ */
    openOverlay() {
      if (!Player.current()) { toast('当前没有播放歌曲', 'warn'); return; }
      const ov = $('#overlay');
      ov.classList.remove('hidden');
      document.body.classList.add('no-scroll');
      this.startLyricLoop();
      this._syncLyric(Player.curTime);
      // 等自定义字体就绪后重测行高（字体加载会改变行高，缓存的 offsetTop 会失效）
      this._measureLyrics();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (!document.getElementById('overlay').classList.contains('hidden')) this._measureLyrics();
        }).catch(() => {});
      }
    },
    closeOverlay() {
      $('#overlay').classList.add('hidden');
      this.stopLyricLoop();
      if (!$('#queue-drawer').classList.contains('hidden')) this.closeQueue();
      document.body.classList.remove('no-scroll');
    },

    /* ---------------- 音质（仅设置弹窗内切换） ---------------- */
    _renderQualityMenu() { /* 由设置弹窗提供音质选择，此处无需渲染 */ },

    /* ---------------- 播放队列 ---------------- */
    toggleQueue() {
      this._queueOpen ? this.closeQueue() : this.openQueue();
    },
    openQueue() {
      this._queueOpen = true;
      $('#queue-drawer').classList.remove('hidden');
      $('#queue-mask').classList.remove('hidden');
      this.renderQueue();
    },
    closeQueue() {
      this._queueOpen = false;
      $('#queue-drawer').classList.add('hidden');
      $('#queue-mask').classList.add('hidden');
    },
    renderQueue() {
      const list = $('#qd-list');
      const q = Player.queue;
      const cur = Player.current();
      $('#qd-count').textContent = q.length
        ? (cur ? '共 ' + q.length + ' 首 · 正在播放第 ' + (Player.index + 1) + ' 首' : '共 ' + q.length + ' 首')
        : '';
      if (!q.length) {
        list.innerHTML = '<div class="qd-empty">队列为空，去发现音乐吧</div>';
        return;
      }
      list.innerHTML = q.map((s, i) =>
        '<div class="qd-item' + (i === Player.index ? ' active' : '') + '" data-qidx="' + i + '">' +
        '<div class="qd-idx">' + (i === Player.index ? '<span class="qd-eq"><i></i><i></i><i></i></span>' : (i + 1)) + '</div>' +
        '<div class="qd-cover"><img src="' + esc(coverUrl(s.cover)) + '" alt=""></div>' +
        '<div class="qd-main"><div class="qd-name">' + esc(s.name) + '</div>' +
        '<div class="qd-artists">' + esc((s.artists || []).map(a => a.name).join(' / ')) + '</div></div>' +
        '<div class="qd-dur">' + fmtDuration(s.duration) + '</div>' +
        '<button class="qd-rm" data-qrm="' + i + '">' +
        '<svg viewBox="0 0 1024 1024"><path d="M864 256H736v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80H160c-17.7 0-32 14.3-32 32s14.3 32 32 32h32v512c0 35.3 28.7 64 64 64h512c35.3 0 64-28.7 64-64V320h32c17.7 0 32-14.3 32-32s-14.3-32-32-32zM384 192h256v64H384v-64zm384 640H256V320h512v512z"/></svg></button>' +
        '</div>').join('');
    },

    /* ============================================================
     * 更新公告
     * ============================================================ */
    _noticeSeenKey() { return 'ym.noticeSeen'; },
    _noticeSeen() {
      try { return localStorage.getItem(this._noticeSeenKey()) || ''; } catch (e) { return ''; }
    },
    _markNoticeSeen() {
      try { localStorage.setItem(this._noticeSeenKey(), (window.APP_NOTICE || {}).version || ''); } catch (e) { /* 忽略 */ }
    },
    /** 打开更新公告；打开即视为已读 */
    openNotice() {
      const n = window.APP_NOTICE;
      if (n && n.title) $('#notice-title').textContent = n.title;
      const ver = $('#notice-ver');
      if (ver && n) ver.textContent = 'v' + n.version + (n.date ? ' · ' + n.date : '');
      const list = $('#notice-list');
      if (list && n) {
        list.innerHTML = (n.items || []).map(t => '<li>' + esc(t) + '</li>').join('');
      }
      $('#notice').classList.remove('hidden');
      document.body.classList.add('no-scroll');
      this._markNoticeSeen();
    },
    closeNotice() {
      $('#notice').classList.add('hidden');
      document.body.classList.remove('no-scroll');
    },
    /** 版本未读过时自动弹出一次 */
    _maybeShowNotice() {
      const n = window.APP_NOTICE;
      if (!n || !n.version) return;
      if (this._noticeSeen() !== n.version) this.openNotice();
    },

    /* ============================================================
     * 设置
     * ============================================================ */
    openSettings() {
      $('#settings').classList.remove('hidden');
      document.body.classList.add('no-scroll');
      this._applySettingsToUI();
      this._showSetPage(''); // 打开设置总是复位到一级列表
      this._renderSettingsAccount();
    },
    closeSettings() {
      $('#settings').classList.add('hidden');
      document.body.classList.remove('no-scroll');
    },
    /** 设置弹窗二级页导航：'' → 一级列表（默认）；account/prefs/cache → 对应二级页 */
    _showSetPage(name) {
      const pages = ['account', 'prefs', 'cache'];
      const main = $('#set-page-main');
      if (main) main.classList.toggle('hidden', pages.indexOf(name) !== -1);
      pages.forEach(p => {
        const pg = $('#set-page-' + p);
        if (pg) pg.classList.toggle('hidden', p !== name);
      });
      const panel = $('.modal-panel', $('#settings'));
      if (panel) panel.scrollTop = 0;
      if (name === 'account') this._renderSettingsAccount(); // 进账号页按最新登录态重绘
      if (name === 'cache') this._bindCacheSettings();       // 进缓存页刷新用量
      if (!name) this._refreshSettingsMenuAccount();         // 回一级列表刷新账号行副标题
    },

    /* ============================================================
     * 登录 / 注册（QQ 邮箱等任意邮箱账号；设置+收藏云端同步）
     * ============================================================ */
    openAuth(mode) {
      this._authMode = mode === 'register' ? 'register' : 'login';
      const title = $('#auth-title');
      const sub = $('#auth-submit');
      const sw = $('#auth-toggle');
      const err = $('#auth-err');
      const capRow = $('#auth-slider');
      const pass2 = $('#auth-pass2');
      if (title) title.textContent = this._authMode === 'register' ? '注册' : '登录';
      if (sub) sub.textContent = this._authMode === 'register' ? '注册并登录' : '登 录';
      if (sw) sw.textContent = this._authMode === 'register' ? '已有账号？' : '没有账号？';
      if (err) { err.textContent = ''; err.classList.add('hidden'); }
      if (capRow) capRow.classList.toggle('hidden', this._authMode !== 'register');
      if (pass2) pass2.classList.toggle('hidden', this._authMode !== 'register');
      if (this._authMode === 'register') this._loadCaptcha();
      $('#auth').classList.remove('hidden');
      document.body.classList.add('no-scroll');
      setTimeout(() => { const e = $('#auth-email'); if (e) e.focus(); }, 60);
    },
    closeAuth() {
      $('#auth').classList.add('hidden');
      document.body.classList.remove('no-scroll');
    },
    /** 加载滑动验证（缺口位置来自服务端） */
    async _loadCaptcha() {
      this._captchaSolved = null;
      const slider = $('#auth-slider');
      const notch = $('#auth-slider-notch');
      const fill = $('#auth-slider-fill');
      const thumb = $('#auth-slider-thumb');
      const hint = $('#auth-slider-hint');
      if (slider) { slider.classList.remove('ok', 'fail'); slider.dataset.solved = '0'; }
      if (thumb) thumb.style.left = '2px';
      if (fill) fill.style.width = '0';
      if (hint) hint.textContent = '按住滑块拖动到缺口位置完成验证';
      try {
        const c = await Store.Session.captcha();
        this._captcha = c;
        // 缺口中心与滑块中心对齐：行程 = 轨道宽 - 44px，thumb 起点 2px + 半宽 20 - 缺口半宽 15
        // 用「长度 × 数字」的合法 calc（百分比×长度在 CSS calc 中非法，会导致缺口位置失效）
        if (notch) notch.style.left = 'calc((100% - 44px) * ' + (c.target / 100) + ' + 7px)';
      } catch (e) {
        if (hint) {
          hint.textContent = (location.protocol === 'file:' && !window.APP_LOCAL_SERVER)
            ? '账号功能需本机服务器：请双击 start.bat 启动后重试'
            : ((e && e.message) || '验证加载失败，请刷新');
        }
      }
    },
    /** 滑块拖拽（拖动到缺口±6% 且时长 300ms~15s 通过） */
    _bindSliderCaptcha() {
      const track = $('#auth-slider-track');
      const thumb = $('#auth-slider-thumb');
      if (!track || !thumb) return;
      const slider = $('#auth-slider');
      const fill = $('#auth-slider-fill');
      const hint = $('#auth-slider-hint');
      let dragging = false, moved = 0, startT = 0;
      const moveThumb = (clientX) => {
        const tr = track.getBoundingClientRect();
        const x = Math.max(0, Math.min(tr.width - 44, clientX - tr.left - 2));
        moved = x;
        thumb.style.left = (2 + x) + 'px';
        if (fill) fill.style.width = (x + 22) + 'px';
      };
      const reset = () => {
        thumb.style.left = '2px';
        if (fill) fill.style.width = '0';
        if (hint) hint.textContent = '按住滑块拖动到缺口位置完成验证';
      };
      thumb.addEventListener('pointerdown', (e) => {
        dragging = true;
        startT = Date.now();
        slider.classList.remove('ok', 'fail');
        thumb.classList.add('dragging');
        if (hint) hint.textContent = '按住滑块拖动到缺口位置完成验证';
        try { thumb.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        e.preventDefault();
      });
      const onMove = (e) => { if (dragging) moveThumb(e.clientX); };
      thumb.addEventListener('pointermove', onMove);
      track.addEventListener('pointermove', onMove);
      const finish = () => {
        if (!dragging) return;
        dragging = false;
        thumb.classList.remove('dragging');
        const dur = Date.now() - startT;
        const tr = track.getBoundingClientRect();
        const pos = Math.max(0, Math.min(100, moved / (tr.width - 44) * 100));
        const cap = this._captcha;
        const ok = cap && Math.abs(pos - cap.target) <= 6 && dur >= 300 && dur <= 15000;
        if (ok) {
          this._captchaSolved = { id: cap.id, pos: Math.round(pos * 100) / 100, duration: dur };
          slider.classList.add('ok');
          if (hint) hint.textContent = '✓ 验证通过';
        } else {
          slider.classList.add('fail');
          if (hint) hint.textContent = dur < 300 ? '拖动太快，请慢一点再试' : '未对准缺口，请重试';
          setTimeout(() => { slider.classList.remove('fail'); reset(); }, 600);
        }
      };
      thumb.addEventListener('pointerup', finish);
      thumb.addEventListener('pointercancel', finish);
    },
    /**
     * 拉取云端最新资料（头像，跨设备同步）：启动 / 登录成功后各调用一次；
     * window 'focus' 触发时做节流刷新——距上次成功刷新 <60s 则跳过。
     * 未登录或拉取失败（网络/401）静默忽略，不影响本地会话。
     * 成功后 Store.Session.refreshProfile 内部派发 ym:session → _syncAuthUI 自动重绘
     * 侧栏头像与设置「账号设置」区，无需在此手动刷新 UI。
     */
    async _refreshProfile() {
      if (!Store.Session.loggedIn || this._profileRefreshing) return;
      const now = Date.now();
      if (now - (this._profileRefreshT || 0) < 60000) return; // 节流：距上次成功刷新 ≥60s 才请求
      this._profileRefreshing = true;
      try {
        const ok = await Store.Session.refreshProfile();
        if (ok) this._profileRefreshT = Date.now();
      } finally {
        this._profileRefreshing = false;
      }
    },
    /** 侧栏账号区：未登录显示 登录/注册，已登录显示头像 + 邮箱 + 退出 */
    _syncAuthUI() {
      const logged = Store.Session.loggedIn;
      const btns = $('#side-auth-btns');
      const user = $('#side-user');
      const mail = $('#side-user-mail');
      if (btns) btns.classList.toggle('hidden', logged);
      if (user) user.classList.toggle('hidden', !logged);
      if (mail) mail.textContent = Store.Session.email || '';
      this._renderSidebarAvatar();
      this._renderSettingsAccount();
    },

    /* ============================================================
     * 头像（侧栏 + 设置弹窗账号分区）
     * ============================================================ */
    /** 头像圆形内层内容：有头像 → <img>，无头像 → 邮箱首字母 */
    _avatarInner(email, avatar) {
      if (avatar) return '<img src="' + esc(avatar) + '" alt="">';
      const ch = String(email || '?').trim().charAt(0) || '?';
      return '<b>' + esc(ch.toUpperCase()) + '</b>';
    },
    /** 刷新主页侧栏的头像（邮箱右侧） */
    _renderSidebarAvatar() {
      const el = $('#side-user-avatar');
      if (!el) return;
      if (!Store.Session.loggedIn) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      el.innerHTML = this._avatarInner(Store.Session.email || '', Store.Session.avatar || '');
    },
    /** 刷新设置一级列表「账号」行的头像缩略 + 副标题（登录态/头像变化后调用） */
    _refreshSettingsMenuAccount() {
      const av = $('#set-menu-acc-av');
      const sub = $('#set-menu-acc-sub');
      if (av) {
        av.innerHTML = this._avatarInner(Store.Session.email || '', Store.Session.avatar || '');
        av.classList.toggle('off', !Store.Session.loggedIn);
      }
      if (sub) sub.textContent = Store.Session.loggedIn ? (Store.Session.email || '已登录') : '未登录';
    },
    /** 刷新设置弹窗「账号设置」分区内容；登录/退出/换头像（ym:session）后都会调用 */
    _renderSettingsAccount() {
      const box = $('#set-account');
      if (!box) return;
      this._refreshSettingsMenuAccount();
      if (!Store.Session.loggedIn) {
        box.innerHTML =
          '<div class="set-account">' +
          '<div class="set-acc-tip">登录后可用：头像云端同步、修改密码等账号功能</div>' +
          '<div class="set-acc-btns">' +
          '<button type="button" class="btn" id="set-acc-login">登录</button>' +
          '<button type="button" class="btn primary" id="set-acc-register">注册</button>' +
          '</div>' +
          '</div>';
        const lb = $('#set-acc-login');
        const rb = $('#set-acc-register');
        if (lb) lb.addEventListener('click', () => this.openAuth('login'));
        if (rb) rb.addEventListener('click', () => this.openAuth('register'));
        return;
      }
      const email = Store.Session.email || '';
      box.innerHTML =
        '<div class="set-account">' +
        '<div class="set-acc-top">' +
        '<span class="usr-avatar lg chg" id="set-acc-avatar" role="button" aria-label="更换头像">' +
        this._avatarInner(email, Store.Session.avatar || '') + '<i class="cam">' + CAM_ICON + '</i>' +
        '</span>' +
        '<div class="set-acc-info">' +
        '<div class="set-acc-mail">' + esc(email) + '</div>' +
        '<div class="set-acc-sub">点击头像更换 · 云端同步</div>' +
        '</div>' +
        '</div>' +
        '<div class="set-acc-pw">' +
        '<div class="set-label">修改密码</div>' +
        '<div class="auth-err hidden" id="set-pw-err"></div>' +
        '<input class="auth-input" id="set-pw-old" type="password" placeholder="原密码" autocomplete="current-password">' +
        '<input class="auth-input" id="set-pw-new" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password">' +
        '<input class="auth-input" id="set-pw-new2" type="password" placeholder="再次输入新密码" autocomplete="new-password">' +
        '<div class="set-acc-pw-btns"><button type="button" class="btn primary" id="set-pw-submit">确认修改</button></div>' +
        '</div>' +
        '</div>';
      const av = $('#set-acc-avatar');
      if (av) av.addEventListener('click', () => this._changeAvatar());
      const pwBtn = $('#set-pw-submit');
      if (pwBtn) pwBtn.addEventListener('click', () => this._submitChangePassword());
      /* 回车快捷提交改密 */
      ['#set-pw-old', '#set-pw-new', '#set-pw-new2'].forEach(sel => {
        const inp = $(sel);
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitChangePassword(); });
      });
    },
    /** 修改密码：原密码/新密码/确认 校验（一致且 ≥6 位）后提交 */
    async _submitChangePassword() {
      const err = $('#set-pw-err');
      const showErr = (msg) => {
        if (!err) return;
        err.textContent = msg;
        err.classList.remove('hidden');
      };
      const oldPw = $('#set-pw-old').value;
      const next = $('#set-pw-new').value;
      const next2 = $('#set-pw-new2').value;
      if (!oldPw) { showErr('请输入原密码'); return; }
      if (!next) { showErr('请输入新密码'); return; }
      if (next.length < 6) { showErr('新密码至少 6 位'); return; }
      if (next !== next2) { showErr('两次输入的新密码不一致'); return; }
      const btn = $('#set-pw-submit');
      if (btn) { btn.disabled = true; btn.style.opacity = .6; }
      try {
        await Store.Session.changePassword(oldPw, next);
        if (err) err.classList.add('hidden');
        $('#set-pw-old').value = '';
        $('#set-pw-new').value = '';
        $('#set-pw-new2').value = '';
        toast('密码修改成功');
      } catch (e) {
        showErr((e && e.message) || '修改失败，请重试');
      } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
      }
    },
    /** 弹起文件选择框（侧栏/设置内头像点击共用） */
    _changeAvatar() {
      if (!Store.Session.loggedIn) return;
      if (!this._avatarFile) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.style.display = 'none';
        inp.addEventListener('change', () => this._onAvatarFile(inp.files && inp.files[0]));
        document.body.appendChild(inp);
        this._avatarFile = inp;
      }
      this._avatarFile.value = '';
      this._avatarFile.click();
    },
    /** 读取文件 → canvas 压缩（最长边 256 / JPEG 0.82 / >200KB 再降质）→ 上传并刷新 UI */
    async _onAvatarFile(file) {
      if (!file) return;
      try {
        const dataURL = await this._compressAvatar(file);
        await Store.Session.setAvatar(dataURL); // 成功会派发 ym:session → 刷新侧栏与设置头像
        toast('头像已更新');
      } catch (e) {
        toast((e && e.message) || '头像更新失败', 'warn');
      }
    },
    _compressAvatar(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('不支持的图片格式'));
          img.onload = () => {
            try {
              const MAX = 256;
              const w0 = img.naturalWidth || img.width || 1;
              const h0 = img.naturalHeight || img.height || 1;
              const scale = Math.min(1, MAX / Math.max(w0, h0));
              const w = Math.max(1, Math.round(w0 * scale));
              const h = Math.max(1, Math.round(h0 * scale));
              const cv = document.createElement('canvas');
              cv.width = w; cv.height = h;
              const ctx = cv.getContext('2d');
              if (ctx) {
                ctx.fillStyle = '#15151a'; // JPEG 无透明通道：深色底垫底（与界面一致）
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
              }
              const bytesOf = (s) => Math.floor((s.length - (s.indexOf(',') + 1)) * 3 / 4);
              let q = 0.82;
              let out = cv.toDataURL('image/jpeg', q);
              while (bytesOf(out) > 200 * 1024 && q > 0.18) {
                q = +(q - 0.06).toFixed(2);
                out = cv.toDataURL('image/jpeg', q);
              }
              if (!out || out.length < 30) reject(new Error('图片压缩失败'));
              else resolve(out);
            } catch (e) { reject(e); }
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    },
    /** 提交登录/注册表单（注册：滑动验证通过后直接注册并登录，无需邮箱验证码） */
    async _submitAuth() {
      const email = $('#auth-email').value.trim();
      const password = $('#auth-pass').value;
      const err = $('#auth-err');
      const showErr = (msg) => {
        if (!err) return;
        err.textContent = msg;
        err.classList.remove('hidden');
      };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('请输入正确的邮箱地址（支持 QQ 邮箱等）'); return; }
      if (password.length < 6) { showErr('密码至少 6 位'); return; }
      if (this._authMode === 'register') {
        const pass2 = $('#auth-pass2').value;
        if (!pass2) { showErr('请再次输入密码确认'); return; }
        if (pass2 !== password) { showErr('两次输入的密码不一致'); return; }
      }
      const btn = $('#auth-submit');
      if (btn) { btn.disabled = true; btn.style.opacity = .6; }
      try {
        if (this._authMode === 'register') {
          const cap = this._captchaSolved;
          if (!cap) { showErr('请先完成滑动验证'); return; }
          const j = await Store.Session.register(email, password, cap.id, cap.pos, cap.duration);
          toast(j && j.existing ? '该邮箱已注册，密码正确，已直接登录' : '注册成功，已登录');
        } else {
          await Store.Session.login(email, password);
          toast('登录成功，云端数据已同步到本机');
        }
        $('#auth-pass').value = '';
        $('#auth-pass2').value = '';
        this.closeAuth();
        this._refreshProfile(); // 登录成功后再拉一次云端资料（头像），与启动拉取互补
      } catch (e) {
        showErr(e.message || '操作失败');
        if (this._authMode === 'register') this._loadCaptcha(); // 验证题一次一题
      } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
      }
    },
    _applySettingsToUI() {
      /* 音质选项 */
      const box = $('#set-quality');
      if (box && !box.dataset.bound) {
        box.dataset.bound = '1';
        box.innerHTML = window.APP_CONFIG.QUALITY_LEVELS.map(q =>
          '<button class="q-item" data-q="' + q.key + '"><span class="q-name">' + q.label + '</span>' +
          '<span class="q-check">✓</span></button>').join('');
        box.querySelectorAll('.q-item').forEach(el => el.addEventListener('click', () => {
          Player.setQuality(el.dataset.q);
          toast('默认音质：' + Player.qualityLabel(el.dataset.q));
        }));
      }
      this._onQuality({ quality: Player.quality });
      this._syncVolume();
      /* 歌词样式：字号 / 粗细 / 行距 */
      const LYR_OPTS = {
        'set-lyric-size': [
          { v: 18, l: '小' }, { v: 22, l: '中' }, { v: 26, l: '大' }, { v: 30, l: '特大' },
        ],
        'set-lyric-weight': [
          { v: 400, l: '常规' }, { v: 600, l: '中等' }, { v: 700, l: '加粗' },
        ],
        'set-lyric-lh': [
          { v: 1.5, l: '紧凑' }, { v: 1.75, l: '标准' }, { v: 2.1, l: '宽松' },
        ],
      };
      for (const id of Object.keys(LYR_OPTS)) {
        const b = $('#' + id);
        if (!b || b.dataset.bound) continue;
        b.dataset.bound = '1';
        // size→lyricSize / weight→lyricWeight / lh→lyricLineHeight
        const KEY_MAP = { size: 'lyricSize', weight: 'lyricWeight', lh: 'lyricLineHeight' };
        const key = KEY_MAP[id.slice('set-lyric-'.length)] ||
          ('lyric' + id.slice('set-lyric-'.length).replace(/^([a-z])/, (m, c) => c.toUpperCase()));
        const cur = Store.Settings[key];
        b.innerHTML = LYR_OPTS[id].map(o =>
          '<button class="q-item' + (cur === o.v ? ' active' : '') + '" data-v="' + o.v + '"><span class="q-name">' + o.l + '</span>' +
          '<span class="q-check">✓</span></button>').join('');
        b.querySelectorAll('.q-item').forEach(el => el.addEventListener('click', () => {
          Store.Settings.set({ [key]: parseFloat(el.dataset.v) });
          this._applyLyricStyle();
          b.querySelectorAll('.q-item').forEach(x => x.classList.toggle('active', x === el));
          toast('歌词样式已更新');
        }));
      }
      this._applyLyricStyle();
      this._bindCacheSettings();
    },
    /** 音频缓存设置：开关 / 上限 / 用量显示 / 清空 */
    _bindCacheSettings() {
      const refreshUsed = () => {
        AudioCache.used().then((b) => {
          const el = $('#set-cache-used');
          if (el) {
            const mb = b / 1048576;
            el.textContent = '已用 ' + (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB / 上限 ' + Store.Settings.cacheCapMB + ' MB';
          }
        });
      };
      const onBox = $('#set-cache-on');
      if (onBox && !onBox.dataset.bound) {
        onBox.dataset.bound = '1';
        const draw = () => {
          const on = Store.Settings.cacheOn;
          onBox.innerHTML = [true, false].map(v =>
            '<button class="q-item' + (on === v ? ' active' : '') + '" data-v="' + v + '"><span class="q-name">' +
            (v ? '开' : '关') + '</span><span class="q-check">✓</span></button>').join('');
        };
        draw();
        onBox.addEventListener('click', (e) => {
          const it = e.target.closest('.q-item');
          if (!it) return;
          const v = it.dataset.v === 'true';
          Store.Settings.set({ cacheOn: v });
          draw();
          toast(v ? '音频缓存已开启（播放过的歌会自动缓存）' : '音频缓存已关闭（已缓存内容保留）');
        });
      }
      const capBox = $('#set-cache-cap');
      if (capBox && !capBox.dataset.bound) {
        capBox.dataset.bound = '1';
        const opts = [[100, '100MB'], [300, '300MB'], [500, '500MB'], [1000, '1GB']];
        const draw = () => {
          const cur = Store.Settings.cacheCapMB;
          capBox.innerHTML = opts.map(o =>
            '<button class="q-item' + (cur === o[0] ? ' active' : '') + '" data-v="' + o[0] + '"><span class="q-name">' +
            o[1] + '</span><span class="q-check">✓</span></button>').join('');
        };
        draw();
        capBox.addEventListener('click', (e) => {
          const it = e.target.closest('.q-item');
          if (!it) return;
          Store.Settings.set({ cacheCapMB: +it.dataset.v });
          draw();
          AudioCache.evict().then(refreshUsed);
          toast('缓存上限已更新为 ' + it.textContent.trim().replace('✓', ''));
        });
      }
      const clearBtn = $('#set-clear-cache');
      if (clearBtn && !clearBtn.dataset.bound) {
        clearBtn.dataset.bound = '1';
        clearBtn.addEventListener('click', () => {
          AudioCache.clear().then(() => { toast('音频缓存已清空'); refreshUsed(); });
        });
      }
      refreshUsed();
    },
    /** 应用歌词样式（字号/粗细/行距）到播放页 */
    _applyLyricStyle() {
      const ov = $('#overlay');
      if (!ov) return;
      ov.style.setProperty('--lyric-size', Store.Settings.lyricSize + 'px');
      ov.style.setProperty('--lyric-weight', Store.Settings.lyricWeight);
      ov.style.setProperty('--lyric-lh', Store.Settings.lyricLineHeight);
    },
    _syncVolume(v) {
      if (v === undefined) v = Store.Settings.muted ? 0 : Store.Settings.volume;
      v = Math.max(0, Math.min(100, v));
      $('#pb-volume').value = v;
      $('#ov-volume').value = v;
      const fill = (el, color) => {
        el.style.background = 'linear-gradient(to right, ' + color + ' 0%, ' + color + ' ' + v +
          '%, rgba(255,255,255,.22) ' + v + '%, rgba(255,255,255,.22) 100%)';
      };
      fill($('#pb-volume'), 'var(--accent)');
      fill($('#ov-volume'), '#ffffff');
      const muted = Store.Settings.muted || v === 0;
      $('#pb-mute').classList.toggle('muted', muted);
      $('#ov-mute').classList.toggle('muted', muted);
    },
    _onSettings(d) {
      if ('volume' in d || 'muted' in d) this._syncVolume();
      if ('quality' in d) this._onQuality({ quality: Player.quality });
    },

    /* ---------------- 侧边栏收藏歌单 ---------------- */
    _renderSidePlaylists() {
      const box = $('#side-playlists');
      const pls = Store.FavPlaylists.all.slice(0, 15);
      if (!pls.length) {
        box.innerHTML = '<div class="side-empty">收藏的歌单会显示在这里</div>';
        return;
      }
      box.innerHTML = pls.map(p =>
        '<div class="side-pl" data-spl="' + p.id + '">' +
        '<img src="' + esc(coverUrl(p.cover)) + '" alt="" loading="lazy">' +
        '<span>' + esc(p.name) + '</span></div>').join('');
      box.querySelectorAll('[data-spl]').forEach(el => el.addEventListener('click', () =>
        this.nav('playlist/' + el.dataset.spl)));
    },

    /* ============================================================
     * 媒体会话（系统媒体键）
     * ============================================================ */
    _initMediaSession() {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      try {
        ms.setActionHandler('play', () => Player.toggle());
        ms.setActionHandler('pause', () => Player.toggle());
        ms.setActionHandler('previoustrack', () => Player.prev());
        ms.setActionHandler('nexttrack', () => Player.next(false));
        ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) Player.seek(d.seekTime); });
      } catch (e) { /* 忽略 */ }
      Player.on('change', (e) => {
        const s = e.detail.song;
        if (!s) return;
        ms.metadata = new MediaMetadata({
          title: s.name,
          artist: (s.artists || []).map(a => a.name).join(' / '),
          album: s.album ? s.album.name : '',
          artwork: s.cover ? [{ src: coverUrl(s.cover), sizes: '512x512', type: 'image/jpeg' }] : [],
        });
      });
    },

    /* ---------------- 快捷键 ---------------- */
    _onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        Player.toggle();
      } else if (e.code === 'ArrowLeft' && $('#overlay').classList.contains('hidden') === false) {
        Player.seek(Player.curTime - 5);
      } else if (e.code === 'ArrowRight' && $('#overlay').classList.contains('hidden') === false) {
        Player.seek(Player.curTime + 5);
      }
    },
  };

  window.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})();
