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

  /* 自建歌单默认封面：透明底白色音符（与歌单卡片深色底适配，内联 SVG） */
  const DEFAULT_PL_COVER = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 200 200\'%3E%3Cpath transform=\'translate(100,100) scale(6.6) translate(-12,-12)\' fill=\'%23f0f1f4\' d=\'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z\'/%3E%3C/svg%3E';

  /** 艺术家列表归一化：兼容 对象数组 / "A / B" 字符串 / 旧 artistsArr（收藏等快照来源多样） */
  function artistList(a) {
    if (Array.isArray(a)) {
      return a.filter(x => x && x.name)
        .map(x => ({ id: x.id || 0, name: String(x.name).trim() }))
        .filter(x => x.name);
    }
    if (typeof a === 'string') {
      return a.split(' / ').map(n => n.trim()).filter(Boolean).map(n => ({ id: 0, name: n }));
    }
    return [];
  }

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
      // 云端同步变化 → 当前正在看的页面自动更新（不再需要手动刷新）
      document.addEventListener('ym:favsongs', () => this._onCloudDataChanged());
      document.addEventListener('ym:favpls', () => this._onCloudDataChanged());
      document.addEventListener('ym:mypls', () => this._onCloudDataChanged());
      this._renderSidePlaylists();
      this.applyTheme(Store.Settings.theme);
      this._renderThemeMenu();
      this._renderQualityMenu();
      this.render();
      this._applySettingsToUI();
      this._syncAuthUI();
      this._syncHibetterNav();
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
      return artistList(song.artists).map(a => a.name).join(' / ') || '未知歌手';
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
      const logged = !!(Store.Session && Store.Session.loggedIn);
      const root = seg[0] || (logged ? 'hibetter' : 'discover'); // 默认首页：登录后 HiBetter，未登录发现音乐
      this._highlightNav(root);
      // 顶栏返回按钮：仅在 歌单/专辑/歌手/单曲/自建歌单 等详情页显示（位于顶部标题文本左侧）
      const topBack = $('#btn-topback');
      if (topBack) topBack.classList.toggle('hidden', !(root === 'playlist' || root === 'album' || root === 'artist' || root === 'song' || root === 'myplaylist' || root === 'share'));
      // 分享深度链接的 ?song= 参数：页面就绪后在原列表定位并自动播放该曲
      this._autoSong = params.get('song') ? String(params.get('song')) : null;
      this._autoSongTries = 0;

      if (root === 'discover') return this.vDiscover();
      if (root === 'leaderboard') return this.vLeaderboard();
      if (root === 'playlists') return this.vPlaylists(params.get('cat'), params.get('order'));
      if (root === 'search') return this.vSearch(params.get('q') || '');
      if (root === 'favorites') return this.vFavorites();
      if (root === 'recognize') return this.vRecognize();
      if (root === 'hibetter') {
        if (!(Store.Session && Store.Session.loggedIn)) {
          toast('HiBetter 需要登录后使用，请先登录', 'warn');
          return this.nav('discover');
        }
        return this.vHibetter();
      }
      if (root === 'myplaylist' && seg[1]) return this.vMyPlaylist(seg[1]);
      if (root === 'share' && seg[1] === 'mp' && seg[2]) return this.vShareMp(seg[2]);
      if (root === 'song' && seg[1]) return this.vSong(seg[1]);
      if (root === 'playlist' && (seg[1] || params.get('id'))) return this.vPlaylist(seg[1] || params.get('id'));
      if (root === 'album' && (seg[1] || params.get('id'))) return this.vAlbum(seg[1] || params.get('id'));
      if (root === 'artist' && (seg[1] || params.get('id'))) return this.vArtist(seg[1] || params.get('id'));
      this.nav('discover');
    },

    _highlightNav(root) {
      $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.nav === root));
      const titles = { hibetter: 'HiBetter', discover: '发现', leaderboard: '排行榜', playlists: '歌单', search: '搜索', favorites: '我的收藏', recognize: '听歌识曲', hibetter: 'HiBetter', myplaylist: '自建歌单', playlist: '歌单', album: '专辑', artist: '歌手', song: '歌曲', share: '分享的歌单' };
      const t = $('#page-title');
      if (t) {
        if (root === 'hibetter') {
          t.innerHTML = 'HiBetter <em class="beta-tag">Beta·AI</em>'; // 顶栏固定展示产品名与阶段
        } else {
          t.textContent = titles[root] || 'HiBetter';
        }
      }
      const cur = Player.current();
      document.title = cur ? cur.name + ' - B·Music' : 'B·Music · 网页版';
    },

    _setView(html) {
      const v = $('#view');
      v.innerHTML = html;
      $('#main').scrollTop = 0;
      window.scrollTo(0, 0);
      // 页面切换动画：内容高斯模糊淡入 + 子块自上而下缓动就位
      v.classList.remove('view-anim');
      void v.offsetWidth; // 强制重排以重启动画
      v.classList.add('view-anim');
      const kids = Array.prototype.slice.call(v.children).slice(0, 8);
      kids.forEach((el, i) => { el.style.animationDelay = (i * 55) + 'ms'; });
      // 动画结束后移除 view-anim：其 filter 会创建 containing block，
      // 使页面内 position:fixed 元素（如 HiBetter 输入栏）退化为相对 #view 定位而随页滚动
      clearTimeout(this._viewAnimT);
      const clearAnim = () => {
        v.classList.remove('view-anim');
        kids.forEach((el) => { el.style.animationDelay = ''; });
      };
      v.addEventListener('animationend', clearAnim, { once: true });
      this._viewAnimT = setTimeout(clearAnim, 480); // 兜底（动画被跳过/打断时）
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
     * HiBetter —— AI 音乐助手（DeepSeek flash / 推理关闭 / 工具调用控制播放）
     *  · 对话式点歌、推荐（交互卡片）、切歌、音量、进度、音质、模式、收藏、跳页
     *  · 密钥只在服务端（/api/ai 代理注入），前端不持有
     * ============================================================ */
    _hbHistory: null,
    _hbBusy: false,
    _hbCards: null,
    HB_TOOLS() {
      const fn = (name, desc, props, required) => ({
        type: 'function',
        function: { name, description: desc, parameters: { type: 'object', properties: props, required: required || Object.keys(props) } },
      });
      return [
        fn('search_music', '按关键词搜索歌曲，返回可点击播放的卡片；最多 4 首（limit 传 4）', { keyword: { type: 'string', description: '歌名/歌手/关键词' }, limit: { type: 'number', description: '返回条数，最多 4' } }, ['keyword']),
        fn('play_music', '按关键词搜索并立即播放最匹配的一首', { keyword: { type: 'string', description: '歌名 + 歌手更准' } }, ['keyword']),
        fn('play_index', '播放当前播放列表中的第 N 首（1 开始）', { index: { type: 'number' } }, ['index']),
        fn('control', '播放控制', { action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'prev'] } }, ['action']),
        fn('set_volume', '设置音量百分比 0-100', { percent: { type: 'number' } }, ['percent']),
        fn('seek_ratio', '跳转到当前歌曲的百分比位置 0-100', { percent: { type: 'number' } }, ['percent']),
        fn('set_quality', '切换播放音质（无损及以上需登录）', { level: { type: 'string', enum: ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster'] } }, ['level']),
        fn('set_mode', '切换播放模式', { mode: { type: 'string', enum: ['list', 'loop', 'shuffle'], description: 'list 顺序 / loop 单曲循环 / shuffle 随机' } }, ['mode']),
        fn('favorite_current', '收藏或取消收藏当前播放的歌曲', { on: { type: 'boolean', description: 'true 收藏，false 取消' } }, ['on']),
        fn('now_playing', '获取当前播放状态（歌名/歌手/进度/音量/音质/模式）', {}, []),
        fn('search_playlists', '按关键词搜索歌单（返回可点击打开的歌单卡片），用户想找歌单/歌单推荐时用它', { keyword: { type: 'string' }, limit: { type: 'number', description: '最多 4' } }, ['keyword']),
        fn('get_my_library', '读取当前用户的音乐库：收藏的歌曲、收藏的歌单、自建歌单及其曲目（推荐前先调用它了解口味）', { limit: { type: 'number', description: '每类返回条数，默认 30' } }, []),
        fn('get_playlist_songs', '读取指定歌单（自建或收藏的歌单）里的歌曲列表', { name: { type: 'string', description: '歌单名称（模糊匹配）' } }, ['name']),
        fn('search_my_library', '在用户自己的音乐库里搜索歌曲（收藏 + 自建歌单）', { keyword: { type: 'string' } }, ['keyword']),
        fn('share_current', '生成当前播放歌曲的分享链接（会自动复制到剪贴板，并把链接告诉你）', {}, []),
        fn('share_song', '搜索并生成某首歌曲的分享链接', { keyword: { type: 'string' } }, ['keyword']),
        fn('share_playlist', '生成歌单的分享链接（自建歌单生成可播放短链，收藏歌单生成页面链接）', { name: { type: 'string' } }, ['name']),
        fn('favorite_playlist', '收藏或取消收藏一个歌单（按名称，来自搜索或收藏列表）', { name: { type: 'string' }, on: { type: 'boolean' } }, ['name']),
        fn('playlist_create', '新建一个自建歌单', { name: { type: 'string' } }, ['name']),
        fn('playlist_add', '搜索歌曲并加入指定自建歌单（歌单不存在时会自动创建）', { playlist: { type: 'string' }, keyword: { type: 'string' } }, ['playlist', 'keyword']),
        fn('get_recent', '读取最近播放与搜索历史', {}, []),
        fn('set_theme', '切换界面主题', { name: { type: 'string', enum: ['黑红', '黑蓝', '黑金', '黑紫', '白红', '白蓝', '白金', '白紫'] } }, ['name']),
        fn('download_current', '下载当前播放的歌曲到本机', {}, []),
        fn('open_song', '按关键词搜索并打开某首歌曲的详情页', { keyword: { type: 'string' } }, ['keyword']),
        fn('open_page', '跳转到应用内的页面', { page: { type: 'string', enum: ['discover', 'leaderboard', 'playlists', 'search', 'favorites', 'recognize', 'hibetter'] } }, ['page']),
      ];
    },
    HB_SYS() {
      return '你是「HiBetter」，B·Music 网页版内置的 AI 音乐助手。' +
        '你可以调用工具来搜索音乐、播放/暂停/切歌、调音量、跳进度、切音质、切播放模式、收藏、查看播放状态、跳转页面。' +
        '规则：1) 用户想听某首歌/某类音乐 → 先用 search_music 看看，再决定是否 play_music；推荐多首时用 search_music 返回卡片。' +
        '2) 用户说“放/播放” → 直接 play_music；说“下一首/暂停/继续” → 用 control。' +
        '2b) 【推荐策略】任何“推荐/来点/适合…”类请求：先调用 get_my_library 了解用户口味（收藏歌曲、收藏歌单、自建歌单），必要时用 get_playlist_songs 看具体曲目。' +
        '2b2) 【口味匹配·重要】推荐的歌曲必须与用户库的口味一致：注意【语言（中文/欧美/日韩）】、【曲风】、【年代】。例如用户收藏以欧美流行/女声为主，就优先推荐欧美同类歌曲（搜索时用英文关键词），不要推中文歌；跨口味拓展最多 1 首。' +
        '2c) 用户问“我收藏里有没有/我的歌单里…”→ 用 search_my_library 或 get_playlist_songs 回答。' +
        '2d) 若音乐库为空（未登录或没有收藏），不要追问，直接按大众口味（华语经典/流行热歌/轻音乐等）推荐 4 首。' +
        '2e) 如果一次搜索返回的歌曲不足 4 首（或结果不理想），换一个更宽的关键词再搜一次补足（最多搜 3 次）；最终正文务必凑够 4 首不同歌曲。' +
        '2f) 【语言】始终用简体中文回复，不要输出英文句子。' +
        '2i) 【歌单】用户想找歌单/歌单推荐时，用 search_playlists 搜索真实歌单（最多 4 个），正文逐字使用返回的歌单名；歌单卡片用户可直接点击打开。绝不要说“我无法推荐歌单/无法访问歌单库”。' +
        '2h) 【能力对齐】用户能在界面上做的操作你都能做：播放/暂停/切歌/音量/进度/音质/模式、搜索与推荐、读取音乐库、分享链接（share_current / share_song / share_playlist）、收藏歌单（favorite_playlist）、新建歌单并把歌加进去（playlist_create / playlist_add）、查看最近播放（get_recent）、切换主题（set_theme）、下载歌曲（download_current）、打开歌曲详情（open_song）、跳转页面（open_page）。用户提出这类需求时直接调用对应工具，绝不要说“没有这个功能”。' +
        '2z) 【最高优先级】任何一次回复都必须先调用至少一个工具，禁止只回一句说明文字就结束（例如只说“我先看看你的音乐库”）。' +
        '2g) 【必须调用工具】每次回复都必须先调用至少一个工具（如 get_my_library、search_music、get_playlist_songs），不要只回一句说明文字；工具结果拿到后再用中文总结并给出 4 首推荐（含卡片）。' +
        '3) 工具执行后，用简洁自然的中文汇报结果（不要输出 JSON、不要罗列参数）。' +
        '4) 极度精简：每首一行「歌名 —— 歌手 —— 一句不超过 20 字的理由」，行与行之间不要空行，不要开场白/总结/客套（禁止“需要的话我可以…”这类话）。' +
        '5) 【重要·严格遵守】推荐歌曲时【最多 4 首】：search_music 的 limit 传 4，回复正文里也只列这 4 首（不要列第 5 首，不要补充“还有…”）。任何歌名都必须来自工具返回的真实结果，绝不能凭记忆编造歌名/歌手；推荐多首时用 search_music（可换更短的关键词多试几次），系统会把它渲染成可点击播放的卡片。' +
        '5b) 【硬规则】一次回复最多调用一次 search_music；正文只列这 4 首，逐行对应。' +
        '5d) 【严禁幻觉】正文里出现的歌名/歌手必须与 search_music 结果的 songs 字段【逐字一致】（直接复制），不得替换成你记忆里的其它歌、不得翻译或改写；正文只允许出现这些歌，一首都不许多写。' +
        '5c) 【去重】4 首必须互不相同：不要同一首歌的不同版本（Live/Remix/翻唱/伴奏/纯音乐/片段），也不要同一首歌重复出现；尽量来自不同歌手。' +
        '6) 若多次搜索都无结果，就直接告诉用户“搜索服务暂时不可用，请稍后重试或换个关键词”，不要给出记不准的列表。' +
        '7) 工具返回错误（如未登录、无播放列表）时如实说明并给替代建议。';
    },
    async vHibetter() {
      // 不持久化对话：仅在【本次页面加载的首次进入】清空（刷新即清空）；
      // 页内切换路由（离开 HiBetter 再回来）保留当前会话的对话
      if (!this._hbLoaded) {
        this._hbHistory = [];
        this._hbCardSongs = [];
        this._hbBusy = false;
        try { localStorage.removeItem('ym.hibetter'); } catch (e) {}
        this._hbLoaded = true;
      }
      this._setView(
        '<div class="hb-wrap">' +
        '<div class="hb-head">' +
        '<h2 class="hb-title">' + (this._hbLoggedIn() ? esc(this._hbUserName()) : '未登录用户') + '</h2>' +
        '<div class="hb-sub" id="hb-greet">' + this._hbGreeting() + '</div>' +
        '</div>' +
        '<div class="hb-chat" id="hb-msgs"></div>' +
        '<div class="hb-bar">' +
        '<button type="button" class="hb-ai" id="hb-ai"><svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 640c70.6 0 128-57.4 128-128V256c0-70.6-57.4-128-128-128s-128 57.4-128 128v256c0 70.6 57.4 128 128 128z m192-128c0 106-86 192-192 192s-192-86-192-192H256c0 121.6 86.6 222.4 200 241.2V832h-96v64h304v-64h-96v-78.8C585.4 734.4 672 633.6 672 512h-64z"/></svg>听歌识曲</button>' +
        '<input class="hb-input" id="hb-input" placeholder="例如：放一首适合下雨天的歌 / 音量 30% / 下一首 / 换成无损">' +
        '<button type="button" class="btn primary" id="hb-send">发送</button>' +
        '</div>' +

        '</div>');
      const input = $('#hb-input');
      const send = () => { const v = (input.value || '').trim(); if (!v) return; input.value = ''; this._hbSend(v); };
      const btn = $('#hb-send');
      if (btn) btn.addEventListener('click', send);
      if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      const aiBtn = $('#hb-ai');
      if (aiBtn) aiBtn.addEventListener('click', async () => {
        if (this._hbRecognizing) { if (this._recStopFn) this._recStopFn(); return; } // 再次点击 = 结束录音
        this._hbRecognizing = true;
        aiBtn.innerHTML = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 640c70.6 0 128-57.4 128-128V256c0-70.6-57.4-128-128-128s-128 57.4-128 128v256c0 70.6 57.4 128 128 128z m192-128c0 106-86 192-192 192s-192-86-192-192H256c0 121.6 86.6 222.4 200 241.2V832h-96v64h304v-64h-96v-78.8C585.4 734.4 672 633.6 672 512h-64z"/></svg>正在聆听…（点击结束）';
        toast('正在聆听，请让音乐清晰一些（约 6 秒）');
        let song = null;
        try { song = await this._recognizeOnce(() => {}); }
        finally { this._hbRecognizing = false; aiBtn.innerHTML = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 640c70.6 0 128-57.4 128-128V256c0-70.6-57.4-128-128-128s-128 57.4-128 128v256c0 70.6 57.4 128 128 128z m192-128c0 106-86 192-192 192s-192-86-192-192H256c0 121.6 86.6 222.4 200 241.2V832h-96v64h304v-64h-96v-78.8C585.4 734.4 672 633.6 672 512h-64z"/></svg>听歌识曲'; }
        if (!song) { toast('没有识别到歌曲，请重试', 'warn'); return; }
        const label = song.name + ' - ' + artistList(song.artists).map(x => x.name).join('/');
        this._hbSend(
          '（内部指令：用户刚用听歌识曲识别出《' + label + '》。请先播放这首歌，然后用 2 句话介绍它，再推荐 4 首风格相近的歌；正文歌名必须逐字来自 search_music 结果）',
          false, [song],
          '🎤 听歌识曲识别成功：' + label
        );
      });
      this._hbRenderAll(); // 进入即渲染已有对话（页内切回来也能看到历史）
      this._hbLayoutBind();
      requestAnimationFrame(() => this._hbLayout());
      // 首次进入：AI 主动先给几个推荐（内部触发，不显示为“用户消息”）
      if (!this._hbHistory.length && !this._hbBusy && !this._hbGreeted) { this._hbGreeted = true; setTimeout(() => this._hbGreet(), 120); }
      setTimeout(() => this._hbLayout(), 60);
    },
    /** 对话区高度自适应：底边恰好停在输入栏顶部上方 5px（避免被遮挡/留白过多） */
    _hbLayout() {
      const bar = $('#hb-bar');
      const chat = $('#hb-msgs');
      if (!bar || !chat) return;
      // 用播放栏真实位置定位输入栏：底边 = 播放栏顶边 - 1px（无缝贴合）；无播放时贴视口底部 3px
      const pb = $('#playerbar');
      let bottomPx = 3;
      if (pb && !pb.classList.contains('hidden')) {
        const r = pb.getBoundingClientRect();
        if (r.height > 0) bottomPx = Math.max(3, Math.round(window.innerHeight - r.top - 1));
      }
      bar.style.bottom = bottomPx + 'px';
      const barH = bar.offsetHeight || 60;
      const top = chat.getBoundingClientRect().top;
      const h = Math.max(180, Math.round(window.innerHeight - top - barH - bottomPx - 5));
      chat.style.height = h + 'px';
      chat.style.maxHeight = h + 'px';
    },
    _hbLayoutBind() {
      if (this._hbLayoutBound) return;
      this._hbLayoutBound = true;
      const relayout = () => this._hbLayout();
      window.addEventListener('resize', relayout);
      // 输入栏/播放栏尺寸变化时重算（播放栏出现、窗口变化等）
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(relayout);
        const bar = $('#hb-bar');
        const pb = $('#playerbar');
        if (bar) ro.observe(bar);
        if (pb) ro.observe(pb);
        this._hbRO = ro;
      }
      this._hbRelayout = relayout;
      // 播放状态变化（播放栏显示/隐藏）也重算
      document.addEventListener('ym:player', relayout);
    },
    /** 工具调用轨迹摘要（展示为“思考过程”） */
    _hbTraceSummary(name, out) {
      const p = (out && out.payload) || {};
      if (p.error) return '✗ ' + String(p.error).slice(0, 40);
      if (p.count !== undefined) return '返回 ' + p.count + ' 首';
      if (p.songs) return '返回 ' + (p.songs.length || 0) + ' 首';
      if (p.收藏歌曲) return '收藏 ' + p.收藏歌曲.length + ' 首 / 自建歌单 ' + ((p.自建歌单 || []).length) + ' 个';
      if (p.link) return '已生成链接';
      if (p.now_playing) return '正在播放：' + p.now_playing;
      if (p.theme) return '已切换主题：' + p.theme;
      if (p.playlist) return '歌单：' + p.playlist;
      if (p.created) return '已创建：' + p.created;
      if (p.opened) return '已打开';
      if (p.volume !== undefined) return '音量 ' + p.volume + '%';
      if (p.quality) return '音质 ' + p.quality;
      return '完成';
    },
    /** 生成站内分享链接（与界面分享一致） */
    _hbShareUrl(route, id) {
      const origin = (location.origin && location.origin.indexOf('http') === 0) ? location.origin : 'https://www.bmusic.de5.net';
      return origin + '/#/' + route + '/' + id;
    },
    /** 一次性听歌识曲（供 HiBetter 等复用）：录 6 秒 → 指纹 → 匹配，返回歌曲对象或 null */
    async _recognizeOnce(onState) {
      const say = (s) => { try { onState && onState(s); } catch (e) {} };
      if (typeof window.GenerateFP !== 'function') { toast('指纹模块未加载，请刷新页面', 'warn'); return null; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast('当前浏览器不支持录音识别', 'warn'); return null;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) { toast('无法访问麦克风：' + ((e && e.name === 'NotAllowedError') ? '请允许麦克风权限' : (e && e.message)), 'warn'); return null; }
      let mime = '';
      for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mime = m; break; }
      }
      let rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { toast('录音初始化失败：' + e.message, 'warn'); stream.getTracks().forEach(t => t.stop()); return null; }
      const DUR = 6;
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      const done = new Promise((resolve) => {
        rec.onstop = () => {
          try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
          resolve(new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] }));
        };
      });
      try { rec.start(250); } catch (e) { toast('录音启动失败：' + e.message, 'warn'); return null; }
      say('recording');
      let secs = 0;
      const timer = setInterval(() => {
        secs++;
        if (secs >= DUR) { clearInterval(timer); try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} }
      }, 1000);
      this._recStopFn = () => { clearInterval(timer); try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} };
      const blob = await done;
      clearInterval(timer);
      this._recStopFn = null;
      if (!blob || !blob.size) { toast('没有录到声音，请重试', 'warn'); say('idle'); return null; }
      say('matching');
      try {
        const pcm = await this._decodePCM(blob, DUR);
        if (!pcm || !pcm.length) { toast('音频解码失败', 'warn'); say('idle'); return null; }
        const fp = await window.GenerateFP(pcm);
        const base = (location.protocol === 'file:' && window.APP_LOCAL_SERVER) ? window.APP_LOCAL_SERVER : '';
        const target = window.APP_CONFIG.API_PRIMARY + '/audio/match?duration=' + DUR + '&audioFP=' + encodeURIComponent(fp);
        const r = await fetch(base + '/proxy?u=' + encodeURIComponent(target), { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        const d = (j && j.data) || {};
        const list = d.result;
        const first = Array.isArray(list) ? list[0] : (list && typeof list === 'object' ? list : null);
        const song = first && (first.song || (first.songs && first.songs[0]) || first);
        if (!song || !(song.id || song.songId)) { say('idle'); return null; }
        const sid = String(song.id || song.songId);
        const out = {
          id: sid, name: this._textOf(song.name) || '未知歌曲',
          artists: (Array.isArray(song.artists || song.ar) ? (song.artists || song.ar) : []).map(x => ({ name: this._textOf(x && x.name) })).filter(x => x.name),
          album: (function (al) { al = al || {}; return { name: (al.name || ''), id: al.id || '', picUrl: al.picUrl || '' }; })(song.album || song.al),
          duration: song.duration || song.dt || 0,
        };
        out.cover = out.album.picUrl || '';
        try { await this._hbFillCovers([out]); } catch (e) {}
        say('idle');
        return out;
      } catch (e) { toast('识别失败：' + e.message, 'warn'); say('idle'); return null; }
    },
    /** 读取 Altcha 人机验证结果（widget 暴露的 value / 隐藏域） */
    _altchaPayload() {
      try {
        const w = document.querySelector('altcha-widget');
        if (w && typeof w.value === 'string' && w.value) return w.value;
        const el = document.querySelector('input[name="altcha"]');
        if (el && el.value) return el.value;
      } catch (e) {}
      return '';
    },
    /** 重置 Altcha 验证状态（切换登录/注册时） */
    _resetAltcha() {
      try {
        const w = document.querySelector('altcha-widget');
        if (w && typeof w.reset === 'function') w.reset();
      } catch (e) {}
    },
    /** 是否已登录 */
    _hbLoggedIn() {
      try { return !!(Store && Store.Session && Store.Session.loggedIn); } catch (e) { return false; }
    },
    /** 当前用户名（未登录回退为 HiBetter） */
    _hbUserName() {
      try {
        if (Store && Store.Session && Store.Session.loggedIn) {
          const nm = String(Store.Session.name || '').trim();
          if (nm) return nm;
          const em = String(Store.Session.email || '').trim();
          if (em) return em.split('@')[0];
        }
      } catch (e) {}
      return 'HiBetter';
    },
    /** 按当前时间生成问候语 */
    _hbGreeting() {
      const h = new Date().getHours();
      if (h >= 5 && h < 11) return '早上好';
      if (h >= 11 && h < 13) return '中午好';
      if (h >= 13 && h < 18) return '下午好';
      return '晚上好';
    },
    /** 首次进入的主动推荐：内部消息（hidden）触发 AI 读库并推荐 */
    _hbGreet() {
      if (this._hbBusy || (this._hbHistory && this._hbHistory.length)) return;
      this._hbSend('（系统提示：用户刚打开 HiBetter。请先用 get_my_library 了解他的收藏与自建歌单口味，然后主动推荐 4 首他可能会喜欢的歌）', true);
    },
    _hbSave() { /* 不保留对话：历史仅存在于内存（刷新即清空） */ },
    /** 轻量 Markdown → HTML（先转义，安全；支持加粗/斜体/行内码/列表/标题/链接/换行） */
    _hbMd(text) {
      let s = esc(String(text == null ? '' : text));
      // 压缩列表项之间的空行（避免每行之间出现大段留白）
      s = s.replace(/\n[ \t]*\n(?=[ \t]*(?:[-*]|\d+[.、]))/g, '\n');
      // 连续空行最多保留一个段落间距
      s = s.replace(/\n{3,}/g, '\n\n');
      // 行内码
      s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      // 加粗 / 斜体
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      // 裸链接自动可点
      s = s.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      // 链接 [text](url)
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // 引用块
      s = s.replace(/^&gt;\s?(.+)$/gm, '<div class="hb-quote">$1</div>');
      // 标题
      s = s.replace(/^#{1,4}\s*(.+)$/gm, '<div class="hb-h">$1</div>');
      // 列表（- / * / 1. ）
      s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
      s = s.replace(/^\s*\d+[.、]\s+(.+)$/gm, '<li>$1</li>');
      s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
      // 换行
      s = s.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
      return s;
    },
    _hbBubble(m, idx) {
      const tag = ' data-hbmsg="' + idx + '"';
      if (m.role === 'user') {
        return '<div class="hb-row me"' + tag + '><div class="hb-bubble">' + esc(m.display || m.content) + '</div></div>';
      }
      if (m.role !== 'assistant') return '';
      const cards = Array.isArray(m.cards) ? m.cards.slice(0, 4) : [];
      const trace = Array.isArray(m.trace) ? m.trace : [];
      let thinkBody = '';
      if (m.reasoning) thinkBody += '<div class="hb-think-line">' + esc(m.reasoning).replace(/\n/g, '<br>') + '</div>';
      trace.forEach((t) => {
        thinkBody += '<div class="hb-think-line">🔧 ' + esc(t.tool) + esc(t.args || '') + ' <em>' + esc(t.result || '') + '</em></div>';
      });
      const think = thinkBody
        ? '<details class="hb-think"><summary>💭 思考过程（' + (trace.length || (m.reasoning ? 1 : 0)) + ' 步）</summary><div class="hb-think-body">' + thinkBody + '</div></details>'
        : '';
      let html = m.content ? this._hbMd(m.content) : '';
      if (cards.length && html) html = this._hbInlineCards(html, cards);
      else if (cards.length) html = this._hbCardsHtml(cards);
      const text = html ? '<div class="hb-bubble md' + (m.error ? ' err' : '') + '">' + html + '</div>' : '';
      if (!text && !think) return '';
      const copyBtn = '<div class="hb-copy-row"><button type="button" class="hb-copy" data-hbcopy="' + idx + '" title="复制这条回复">复制</button></div>';
      return '<div class="hb-row ai"' + tag + '><div class="hb-ava">AI</div><div class="hb-col">' + think + text + copyBtn + '</div></div>';
    },
    /** 把卡片穿插进文字：文案里提到哪首，卡片就出现在那一行下面 */
    _hbInlineCards(html, cards) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-—_·・,，.。:：;；()（）\[\]【】"'“”‘’!！?？]/g, '');
      const used = cards.map(() => false);
      const lines = String(html).split('<br>');
      const out = lines.map((line) => {
        const plain = norm(line.replace(/<[^>]+>/g, ''));
        for (let i = 0; i < cards.length; i++) {
          if (used[i]) continue;
          const s = cards[i];
          const nm = norm(s.name);
          const ar = norm((artistList(s.artists)[0] || {}).name);
          const hitName = nm && nm.length >= 2 && plain.indexOf(nm) >= 0;
          const hitArtist = ar && ar.length >= 2 && plain.indexOf(ar) >= 0;
          if (hitName || hitArtist) {
            used[i] = true;
            return line + this._hbCardOne(s, i);
          }
        }
        return line; // 未匹配：不强行配卡（避免张冠李戴）
      });
      const matched = used.filter(Boolean).length;
      // 全部未匹配（AI 没逐条描述）→ 卡片统一列在末尾
      if (!matched && cards.length) {
        // AI 正文没提到任何真实结果（多为幻觉）→ 只展示真实卡片，避免图文不符
        let all = '';
        cards.forEach((s, i) => { all += this._hbCardOne(s, i); });
        const intro = out.filter(l => l.indexOf('hb-icard') < 0 && !/——|--|—/.test(l.replace(/<[^>]+>/g, ''))).join('<br>');
        return (intro ? intro + '<br>' : '') + '<div class="hb-cards-title">🎵 为你找到以下歌曲</div><div class="hb-cards">' + all + '</div>';
      }
      // 部分匹配：把“像歌名但没有真实结果”的行隐藏，避免图文不符（只保留有卡片支撑的歌曲行）
      if (matched && cards.length) {
        const linesKept = [];
        const rawLines = String(html).split('<br>');
        out.forEach((line, i) => {
          const hasCard = line.indexOf('hb-icard') >= 0;
          const plain = rawLines[i] ? rawLines[i].replace(/<[^>]+>/g, '').trim() : '';
          const songLike = /——|--|—/.test(plain) && plain.length > 4;
          if (songLike && !hasCard) return; // 该行是 AI 编的（没有真实结果）→ 丢弃
          linesKept.push(line);
        });
        return linesKept.join('<br>');
      }
      return out.join('<br>');
    },
    /** 单张内嵌卡片（点击即播；索引与所属消息的歌曲数组对齐） */
    _hbCardOne(s, i) {
      const isPl = s && s.type === 'playlist';
      const pic = isPl ? (s.cover || '') : ((s.album && (s.album.picUrl || s.album.cover)) || s.cover || s.picUrl || '');
      const sub = isPl
        ? ((s.creator ? s.creator + ' · ' : '') + (s.trackCount ? s.trackCount + ' 首' : '歌单'))
        : artistList(s.artists).map(x => x.name).join(' / ');
      return '<div class="hb-icard" data-hbcard="' + i + '" data-hbtype="' + (isPl ? 'playlist' : 'song') + '" style="animation-delay:' + (i * 70) + 'ms">' +
        '<img src="' + esc(coverUrl(pic)) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="hb-icard-tx"><div class="hb-icard-name">' + esc(s.name) + '</div>' +
        '<div class="hb-icard-sub">' + esc(sub) + '</div></div>' +
        '<span class="hb-icard-play">' + (isPl ? '打开' : '▶') + '</span></div>';
    },
    _hbCardsHtml(songs) {
      songs = (songs || []).slice(0, 4); // 最多 4 张，避免页面臃肿
      return '<div class="hb-cards">' + songs.map((s, i) =>
        '<div class="hb-card" data-hbplay="' + i + '">' +
        '<img src="' + esc(coverUrl((s.album && (s.album.picUrl || s.album.cover)) || s.cover || s.picUrl || '')) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="hb-card-tx"><div class="hb-card-name">' + esc(s.name) + '</div>' +
        '<div class="hb-card-sub">' + esc(artistList(s.artists).map(x => x.name).join(' / ')) + '</div></div>' +
        '<span class="hb-card-play">▶</span></div>').join('') + '</div>';
    },
    _hbRenderAll() {
      const box = $('#hb-msgs');
      if (!box) return;
      try { this._hbRenderAllInner(box); } catch (e) {
        console.warn('[hibetter] render failed:', e);
        box.innerHTML = '<div class="hb-empty">界面渲染出错：' + esc(e.message) + '</div>';
      }
    },
    _hbRenderAllInner(box) {
      const items = (this._hbHistory || []).filter(m => !m.hidden && (m.role === 'user' || (m.role === 'assistant' && (m.content || (m.cards && m.cards.length))))).slice(-8);
      const rendered = items.map((m, i) => this._hbBubble(m, i)).join('');
      console.log('[hibetter] 历史', (this._hbHistory || []).length, '条 → 渲染', items.length, '条 / HTML', rendered.length, '字符');
      box.innerHTML = rendered || '<div class="hb-empty">看看 ai 推荐中有没有你心仪的歌曲吧~</div>';
      // 卡片点击播放：直接用所属消息的歌曲数组，避免索引错位
      // 复制按钮：复制该条 AI 回复的纯文本（含链接）
      box.querySelectorAll('[data-hbcopy]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const row = btn.closest('[data-hbmsg]');
          const msg = row ? items[+row.dataset.hbmsg] : null;
          if (!msg) return;
          let out = String(msg.content || '');
          const cards = Array.isArray(msg.cards) ? msg.cards : [];
          if (cards.length) {
            out += (out ? '\n\n' : '') + cards.map(s => '《' + s.name + '》 - ' + artistList(s.artists).map(x => x.name).join('/')).join('\n');
          }
          try {
            await navigator.clipboard.writeText(out.trim());
            toast('已复制到剪贴板');
            btn.textContent = '已复制';
            setTimeout(() => { btn.textContent = '复制'; }, 1500);
          } catch (err) {
            toast('复制失败，请手动选择文本复制', 'warn');
          }
        });
      });
      box.querySelectorAll('[data-hbmsg]').forEach((row) => {
        const msg = items[+row.dataset.hbmsg];
        if (!msg || !msg.cards || !msg.cards.length) return;
        const songs = msg.cards;
        row.querySelectorAll('[data-hbcard]').forEach(el => el.addEventListener('click', () => {
          const i = +el.dataset.hbcard;
          const item = songs[i];
          if (!item) return;
          if (el.dataset.hbtype === 'playlist' || item.type === 'playlist') {
            App.nav('playlist/' + item.id);
            toast('打开歌单：' + item.name);
            return;
          }
          const onlySongs = songs.filter(x => x && x.type !== 'playlist');
          const idx = onlySongs.indexOf(item);
          if (idx >= 0) { Player.playQueue(onlySongs, idx); toast('开始播放《' + item.name + '》'); }
        }));
      });
      box.scrollTop = box.scrollHeight;
      if (this._hbLayout) this._hbLayout();
    },
    _hbTyping(on) {
      const box = $('#hb-msgs');
      if (!box) return;
      let t = $('#hb-typing');
      if (on && !t) {
        t = document.createElement('div');
        t.id = 'hb-typing';
        t.className = 'hb-row ai';
        t.innerHTML = '<div class="hb-ava">AI</div><div class="hb-bubble typing"><span></span><span></span><span></span></div>';
        box.appendChild(t);
        box.scrollTop = box.scrollHeight;
      } else if (!on && t) { t.remove(); }
    },
    /** 清洗历史（与后端同规则）：丢弃悬空 tool_calls 与孤立 tool 消息 */
    _hbSanitize(list) {
      const out = [];
      const src = Array.isArray(list) ? list : [];
      for (let i = 0; i < src.length; i++) {
        const m = src[i];
        if (!m || !m.role) continue;
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const need = m.tool_calls.map(tc => tc.id);
          const got = [];
          let j = i + 1;
          while (j < src.length && src[j] && src[j].role === 'tool') { got.push(src[j].tool_call_id); j++; }
          if (!need.every(id => got.indexOf(id) >= 0)) continue;
          out.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments } })) });
          for (let k = i + 1; k < j; k++) out.push({ role: 'tool', tool_call_id: src[k].tool_call_id, content: String(src[k].content == null ? '' : src[k].content) });
          i = j - 1;
        } else if (m.role === 'tool') {
          continue;
        } else {
          out.push(m);
        }
      }
      return out;
    },
    async _hbApi(messages, tools) {
      const base = (location.protocol === 'file:' && window.APP_LOCAL_SERVER) ? window.APP_LOCAL_SERVER : '';
      const clean = this._hbSanitize(messages);
      const body = {
        messages: [{ role: 'system', content: this.HB_SYS() }].concat(clean.map(m => {
          const o = { role: m.role, content: m.content || '' };
          if (m.tool_calls) o.tool_calls = m.tool_calls;
          if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
          return o;
        })),
        tools: tools,
      };
      const r = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.msg || ('HTTP ' + r.status));
      return j;
    },
    async _hbSend(text, hidden, withCards, displayText) {
      if (!text || this._hbBusy) return;
      if (!this._hbHistory) this._hbHistory = [];
      this._hbBusy = true;
      this._hbCards = withCards && withCards.length ? withCards.slice(0, 4) : null; // 可携带初始卡片（如识曲结果）
      this._hbSearchCount = 0; // 本轮搜索次数（结果不足时允许换关键词补足 4 首）
      let reasoningAcc = ''; // 累积本轮 AI 思考文本（若有）
      const traceAcc = [];   // 累积工具调用轨迹（思考过程的实际内容）
      this._hbHistory.push({ role: 'user', content: text, hidden: !!hidden, display: displayText || '' });
      this._hbSave(); // 立即落盘：刷新/中断也不丢对话
      this._hbRenderAll();
      this._hbTyping(true);
      const tools = this.HB_TOOLS();
      try {
        let rounds = 0;
        let nudged = false; // 是否已因“未调用工具”催过一次
        while (rounds++ < 5) {
          const j = await this._hbApi(this._hbHistory, tools);
          const msg = j.message || {};
          if (msg.reasoning) reasoningAcc += (reasoningAcc ? '\n' : '') + msg.reasoning;
          if (msg.tool_calls && msg.tool_calls.length) {
            this._hbHistory.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
            for (const tc of msg.tool_calls) {
              let args = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
              const out = await this._hbExecTool(tc.function.name, args);
              this._hbHistory.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out.payload) });
              // 轨迹：工具名 + 关键参数 + 结果摘要
              const argTxt = Object.keys(args).length ? '(' + Object.keys(args).map(k => k + '=' + String(args[k]).slice(0, 24)).join(', ') + ')' : '';
              traceAcc.push({ tool: tc.function.name, args: argTxt, result: this._hbTraceSummary(tc.function.name, out) });
            }
            continue;
          }
          // 兜底：AI 没有调用任何工具、也没给出卡片，且回复很短（或整句英文）→ 催它一次
          const txt = String(msg.content || '').trim();
          const looksLazy = !(this._hbCards && this._hbCards.length) && txt.length < 80 && (!/[一-龥]/.test(txt) || txt.length < 40);
          if (looksLazy && !nudged && rounds < 5) {
            nudged = true;
            this._hbHistory.push({ role: 'assistant', content: msg.content || '' });
            this._hbHistory.push({ role: 'user', content: '（系统提示：你刚才没有调用任何工具就结束了。请立即调用 get_my_library 了解我的口味，再用 search_music 搜索并推荐 4 首歌曲，然后给出中文回复。）', hidden: true });
            continue;
          }
          this._hbHistory.push({ role: 'assistant', content: msg.content || '（没有返回内容）', cards: this._hbCards || null, reasoning: reasoningAcc, trace: traceAcc.slice() });
          this._hbCards = null;
          break;
        }
      } catch (e) {
        this._hbCards = null;
        this._hbHistory.push({ role: 'assistant', content: '出错了：' + e.message, error: true });
      } finally {
        this._hbBusy = false;
        this._hbTyping(false);
        this._hbSave();
        this._hbRenderAll();
      }
    },
    /** 补全封面：镜像搜索不返回 album.picUrl，用 song/detail 批量补齐（失败静默） */
    async _hbFillCovers(songs) {
      const list = songs || [];
      const miss = list.filter(s => !(s.cover || (s.album && (s.album.picUrl || s.album.cover))));
      if (!miss.length) return list;
      try {
        const full = await API.songDetails(miss.slice(0, 10).map(s => s.id));
        const byId = {};
        full.forEach(f => { byId[String(f.id)] = f; });
        list.forEach(s => {
          const f = byId[String(s.id)];
          if (f && (f.cover || (f.album && f.album.picUrl))) {
            s.cover = f.cover || s.cover;
            s.album = Object.assign({}, s.album, { name: (s.album && s.album.name) || (f.album && f.album.name) || '', picUrl: (f.album && f.album.picUrl) || (s.album && s.album.picUrl) || '' });
          }
        });
      } catch (e) { /* 静默：无封面不影响播放 */ }
      return list;
    },
    /** 去重：同名歌曲的不同版本（Live/Remix/Cover/伴奏/纯音乐…）只保留一个 */
    _hbDedupe(list) {
      const norm = (s) => String(s || '')
        .replace(/[（(【\[].*?[)）】\]]/g, ' ')
        .replace(/(live|remix|cover|acoustic|instrumental|ver\.?|version|伴奏|纯音乐|翻自|翻唱|现场|重制|重置|片段|demo|演绎|演奏|版本|版)/gi, ' ')
        .replace(/[\s\-—_·・.]/g, '')
        .replace(/版$|片段$|版本$/, '')
        .toLowerCase()
        .trim();
      // 同名（含不同版本）只保留一个：优先“最干净的原始名”（名称最短、无版本后缀）
      const keys = [];
      const best = {};
      (list || []).forEach(s => {
        const k = norm(s && s.name);
        if (!k) return;
        const cur = best[k];
        if (!cur) { best[k] = s; keys.push(k); return; }
        const clean = (x) => String(x.name || '').length;
        if (clean(s) < clean(cur)) best[k] = s; // 更短 = 更接近原版
      });
      return keys.map(k => best[k]);
    },
    /** 多源搜索：镜像失败自动换红云，并把长句关键词逐步简化重试 */
    async _hbSearchAny(keyword, limit) {
      const want = Math.min(4, Math.max(1, limit || 4));
      const kw = String(keyword || '').trim();
      const cands = [];
      if (kw) cands.push(kw);
      const simplified = kw.replace(/[适合的歌曲音乐推荐来点一些几首想要听给我找放首播放一下那种风格]/g, ' ').replace(/\s+/g, ' ').trim();
      if (simplified && simplified !== kw) cands.push(simplified);
      const words = kw.split(/[\s，,、]+/).filter(Boolean);
      words.forEach(w => { if (w.length >= 2 && cands.indexOf(w) < 0) cands.push(w); });
      if (words.length > 1) {
        const two = words.slice(0, 2).join(' ');
        if (cands.indexOf(two) < 0) cands.push(two);
      }
      for (const t of cands) {
        try {
          const res = await API.search(t, 1, want, 0);
          const l = Array.isArray(res) ? res : ((res && res.songs) || []);
          if (l.length) { const dd = this._hbDedupe(l).slice(0, want); return { list: await this._hbFillCovers(dd), used: t }; }
        } catch (e) {}
        try { const l2 = await API.hongyunSearch(t, want); if (l2 && l2.length) { const dd2 = this._hbDedupe(l2).slice(0, want); return { list: await this._hbFillCovers(dd2), used: t }; } } catch (e) {}
      }
      return { list: [], used: kw };
    },
    async _hbExecTool(name, a) {
      const ok = (payload, cards) => {
        if (cards && cards.length) {
          const acc = this._hbCards || [];
          const room = Math.max(0, 4 - acc.length); // 硬上限 4 张
          const take = cards.slice(0, room);
          if (take.length) { this._hbCards = acc.concat(take); this._hbCardSongs = (this._hbCardSongs || []).concat(take); }
          return { payload: payload, cards: take };
        }
        return { payload: payload, cards: cards };
      };
      const names = (song) => artistList(song && song.artists).map(x => x.name).join('/');
      try {
        switch (name) {
          case 'search_music': {
            this._hbSearchCount = (this._hbSearchCount || 0) + 1;
            if (this._hbSearchCount > 3) return ok({ error: '本轮搜索次数已达上限，请直接用已有结果写正文' });
            const r = await this._hbSearchAny(a.keyword, Math.min(4, a.limit || 4));
            const songs = r.list || [];
            if (!songs.length) return ok({ error: '搜索无结果（可换个更短的关键词）', keyword: a.keyword });
            return ok({
              count: songs.length, used_keyword: r.used,
              songs: songs.map(s => ({ id: s.id, name: s.name, artists: names(s) })),
              instruction: '正文必须逐字使用上面 songs 里的歌名与歌手（不得替换、翻译、缩写或新增其它歌曲）；每首一行。',
            }, songs);
          }
          case 'play_music': {
            this._hbSearchCount = (this._hbSearchCount || 0) + 1;
            if (this._hbSearchCount > 3) return ok({ error: '本轮搜索次数已达上限，请直接用已有结果' });
            const r = await this._hbSearchAny(a.keyword, 8);
            const list = r.list || [];
            if (!list.length) return ok({ error: '没有搜索到《' + a.keyword + '》，换个关键词试试' });
            Player.playQueue(list.slice(), 0);
            return ok({ now_playing: list[0].name, artist: names(list[0]) }, [list[0]]);
          }
          case 'play_index': {
            const ctx = App._ctx && Array.isArray(App._ctx.songs) ? App._ctx.songs : null;
            if (!ctx || !ctx.length) return ok({ error: '当前没有播放列表' });
            const i = Math.max(1, Math.min(ctx.length, Math.round(a.index || 1))) - 1;
            Player.playQueue(ctx.slice(), i);
            return ok({ now_playing: ctx[i].name, artist: names(ctx[i]) }, [ctx[i]]);
          }
          case 'control': {
            const act = String(a.action || '');
            if (act === 'play') { if (Player.state !== 'playing') Player.toggle(); }
            else if (act === 'pause') { if (Player.state === 'playing') Player.toggle(); }
            else if (act === 'toggle') Player.toggle();
            else if (act === 'next') Player.next();
            else if (act === 'prev') Player.prev();
            else return ok({ error: '不支持的操作：' + act });
            const c = Player.current();
            return ok({ ok: true, action: act, now: c ? (c.name + ' - ' + names(c)) : '无播放', state: Player.state });
          }
          case 'set_volume': {
            const v = Math.max(0, Math.min(100, Math.round(a.percent)));
            Store.Settings.set({ volume: v, muted: v === 0 });
            App._syncVolume();
            return ok({ volume: v });
          }
          case 'seek_ratio': {
            const dur = Player.duration || (Player.current() && Player.current().duration ? Player.current().duration / 1000 : 0);
            if (!dur) return ok({ error: '当前没有可跳转的歌曲' });
            const t = Math.max(0, Math.min(dur, dur * (Math.max(0, Math.min(100, a.percent)) / 100)));
            Player.seek(t);
            return ok({ position: Math.round(t), duration: Math.round(dur) });
          }
          case 'set_quality': {
            const lv = String(a.level || '');
            const RANK = { standard: 0, higher: 1, exhigh: 2, lossless: 3, hires: 4, jymaster: 8 };
            if ((RANK[lv] || 0) >= 3 && !Store.Session.loggedIn) return ok({ error: '无损及以上音质需要登录后使用' });
            Player.setQuality(lv);
            return ok({ quality: lv, label: Player.qualityLabel(lv) });
          }
          case 'set_mode': {
            const m = ['list', 'loop', 'shuffle'].indexOf(a.mode) >= 0 ? a.mode : 'list';
            Player.setMode(m);
            return ok({ mode: m });
          }
          case 'favorite_current': {
            const c = Player.current();
            if (!c) return ok({ error: '当前没有播放歌曲' });
            const has = Store.FavSongs.has(c.id);
            const want = a.on !== false;
            if (want !== has) Store.FavSongs.toggle(c);
            return ok({ song: c.name, favorited: want });
          }
          case 'now_playing': {
            const c = Player.current();
            if (!c) return ok({ playing: false, hint: '当前没有播放歌曲' });
            return ok({
              playing: Player.state === 'playing',
              song: c.name, artist: names(c),
              position: Math.round(Player.curTime || 0), duration: Math.round(Player.duration || 0),
              volume: Store.Settings.volume, quality: Player.qualityLabel(Player.quality), mode: Player.mode,
            });
          }
          case 'search_playlists': {
            const want = Math.min(4, Math.max(1, a.limit || 4));
            let list = [];
            try {
              const res = await API.search(a.keyword || '', 1000, want, 0);
              list = Array.isArray(res) ? res : ((res && res.playlists) || []);
            } catch (e) {}
            const pls = (list || []).slice(0, want).map(p => ({
              type: 'playlist',
              id: p.id, name: p.name,
              cover: p.cover || p.picUrl || '',
              trackCount: p.trackCount || p.songCount || 0,
              playCount: p.playCount || 0,
              creator: (p.creator && p.creator.nickname) || '',
            }));
            if (!pls.length) return ok({ error: '没搜到相关歌单，换个关键词试试' });
            return ok({
              count: pls.length,
              playlists: pls.map(p => ({ id: p.id, name: p.name, songs: p.trackCount })),
              instruction: '这些是真实歌单结果；正文逐字使用它们的名称，用户可直接点卡片打开歌单。',
            }, pls);
          }
          case 'get_my_library': {
            const lim = Math.min(50, Math.max(5, a.limit || 30));
            const favSongs = (Store.FavSongs.all || []).slice(0, lim).map(s => ({ name: s.name, artists: names(s) }));
            const favPls = (Store.FavPlaylists.all || []).slice(0, 20).map(p => p.name);
            const myPls = (Store.MyPlaylists.all || []).slice(0, 20).map(p => ({ name: p.name, count: (p.songs || []).length, sample: (p.songs || []).slice(0, 8).map(s => s.name + ' - ' + names(s)) }));
            if (!favSongs.length && !myPls.length && !favPls.length) return ok({ empty: true, hint: '用户还没有收藏或自建歌单' });
            return ok({ 收藏歌曲: favSongs, 收藏的歌单: favPls, 自建歌单: myPls });
          }
          case 'get_playlist_songs': {
            const kw2 = String(a.name || '').trim();
            const norm2 = (s) => String(s || '').toLowerCase().replace(/\s/g, '');
            const my = (Store.MyPlaylists.all || []).find(p => norm2(p.name).indexOf(norm2(kw2)) >= 0 || norm2(kw2).indexOf(norm2(p.name)) >= 0);
            if (my) {
              const songs = (my.songs || []).slice(0, 30);
              if (!songs.length) return ok({ playlist: my.name, count: 0, hint: '该自建歌单还是空的' });
              return ok({ playlist: my.name, count: songs.length, songs: songs.map(s => ({ name: s.name, artists: names(s) })) }, songs);
            }
            const favPl = (Store.FavPlaylists.all || []).find(p => norm2(p.name).indexOf(norm2(kw2)) >= 0 || norm2(kw2).indexOf(norm2(p.name)) >= 0);
            if (favPl) {
              try {
                const list = await API.playlistTracks(favPl.id, 30, 0);
                const songs = (list || []).slice(0, 30);
                return ok({ playlist: favPl.name, count: songs.length, songs: songs.map(s => ({ name: s.name, artists: names(s) })) }, songs);
              } catch (e) { return ok({ error: '读取歌单失败：' + e.message }); }
            }
            return ok({ error: '没有找到名为「' + kw2 + '」的歌单' });
          }
          case 'search_my_library': {
            const kw3 = String(a.keyword || '').toLowerCase().trim();
            const hit = [];
            (Store.FavSongs.all || []).forEach(s => { if ((String(s.name) + names(s)).toLowerCase().indexOf(kw3) >= 0) hit.push(s); });
            (Store.MyPlaylists.all || []).forEach(p => (p.songs || []).forEach(s => { if ((String(s.name) + names(s)).toLowerCase().indexOf(kw3) >= 0) hit.push(s); }));
            const uniq = [];
            const seen = {};
            hit.forEach(s => { const k = String(s.id); if (!seen[k]) { seen[k] = 1; uniq.push(s); } });
            const take = uniq.slice(0, 8);
            if (!take.length) return ok({ found: 0, hint: '用户库里没有匹配的歌曲' });
            return ok({ found: take.length, songs: take.map(s => ({ name: s.name, artists: names(s) })) }, take);
          }
          case 'share_current': {
            const cur = Player.current();
            if (!cur) return ok({ error: '当前没有播放歌曲' });
            const cc = cur.cover || (cur.album && (cur.album.cover || cur.album.picUrl)) || '';
            return ok({ shared: cur.name + ' - ' + names(cur), link: this._hbShareUrl('song', cur.id), note: '把链接原文写在回复里给用户' }, [{ id: cur.id, name: cur.name, artists: cur.artists, album: cur.album, cover: cc }]);
          }
          case 'share_song': {
            const r = await this._hbSearchAny(a.keyword, 1);
            const s0 = (r.list || [])[0];
            if (!s0) return ok({ error: '没搜到《' + a.keyword + '》' });
            return ok({ shared: s0.name + ' - ' + names(s0), link: this._hbShareUrl('song', s0.id), note: '把链接原文写在回复里给用户' }, [s0]);
          }
          case 'share_playlist': {
            const kw = String(a.name || '');
            const nrm = (x) => String(x || '').toLowerCase().replace(/\s/g, '');
            const my = (Store.MyPlaylists.all || []).find(p => nrm(p.name).indexOf(nrm(kw)) >= 0 || nrm(kw).indexOf(nrm(p.name)) >= 0);
            if (my) {
              if (!Store.Session.loggedIn) return ok({ link: this._hbShareUrl('myplaylist', my.id), note: '本地自建歌单链接（登录后可生成好友可直接播放的短链）' });
              try {
                const j = await Store.Session.shareMp(my.id);
                const origin = (location.origin && location.origin.indexOf('http') === 0) ? location.origin : 'https://www.bmusic.de5.net';
                const url = origin + (j.url || ('/s/mp/' + j.token));
                return ok({ playlist: my.name, link: url });
              } catch (e) { return ok({ error: '生成分享链失败：' + e.message }); }
            }
            const fav = (Store.FavPlaylists.all || []).find(p => nrm(p.name).indexOf(nrm(kw)) >= 0 || nrm(kw).indexOf(nrm(p.name)) >= 0);
            if (fav) return ok({ playlist: fav.name, link: this._hbShareUrl('playlist', fav.id) });
            return ok({ error: '没有找到歌单「' + kw + '」' });
          }
          case 'favorite_playlist': {
            const kw = String(a.name || '');
            const nrm = (x) => String(x || '').toLowerCase().replace(/\s/g, '');
            let pl = (Store.FavPlaylists.all || []).find(p => nrm(p.name).indexOf(nrm(kw)) >= 0);
            if (!pl) {
              const res = await API.search(kw, 1000, 5, 0).catch(() => null);
              const arr = Array.isArray(res) ? res : ((res && res.playlists) || []);
              const cand = arr[0];
              if (cand) pl = { id: cand.id, name: cand.name, cover: cand.cover || (cand.album && cand.album.picUrl) || '' };
            }
            if (!pl) return ok({ error: '没找到歌单「' + kw + '」' });
            const has = Store.FavPlaylists.has(pl.id);
            const want = a.on !== false;
            if (want !== has) Store.FavPlaylists.toggle(pl);
            return ok({ playlist: pl.name, favorited: want });
          }
          case 'playlist_create': {
            const name = String(a.name || '').trim();
            if (!name) return ok({ error: '歌单名不能为空' });
            const exists = (Store.MyPlaylists.all || []).some(p => p.name === name);
            if (exists) return ok({ error: '已存在同名歌单' });
            Store.MyPlaylists.create(name);
            return ok({ created: name });
          }
          case 'playlist_add': {
            const pname = String(a.playlist || '').trim();
            let pl = (Store.MyPlaylists.all || []).find(p => p.name === pname);
            if (!pl) { pl = Store.MyPlaylists.create(pname); }
            const r = await this._hbSearchAny(a.keyword, 4);
            const songs = (r.list || []).slice(0, 4);
            if (!songs.length) return ok({ error: '没搜到《' + a.keyword + '》' });
            const added = Store.MyPlaylists.addSongs(pl.id, songs) || 0;
            return ok({ playlist: pname, added: added, songs: songs.map(s => s.name) }, songs);
          }
          case 'get_recent': {
            const rec = (Store.Recent.all || []).slice(0, 12).map(s => ({ name: s.name, artists: names(s) }));
            const hist = (Store.SearchHistory.all || []).slice(0, 10);
            return ok({ 最近播放: rec, 搜索历史: hist });
          }
          case 'set_theme': {
            const t = this.THEMES.find(x => x.name === String(a.name || ''));
            if (!t) return ok({ error: '没有这个主题' });
            this.setTheme(t.key);
            return ok({ theme: t.name });
          }
          case 'download_current': {
            const cur = Player.current();
            if (!cur) return ok({ error: '当前没有播放歌曲' });
            App._downloadSong(cur);
            return ok({ downloading: cur.name + ' - ' + names(cur) });
          }
          case 'open_song': {
            const r = await this._hbSearchAny(a.keyword, 1);
            const s0 = (r.list || [])[0];
            if (!s0) return ok({ error: '没搜到《' + a.keyword + '》' });
            App.nav('song/' + s0.id);
            return ok({ opened: s0.name }, [s0]);
          }
          case 'open_page': {
            const p = String(a.page || 'discover');
            App.nav(p);
            return ok({ opened: p });
          }
          default:
            return ok({ error: '未知工具：' + name });
        }
      } catch (e) {
        return ok({ error: e.message || '工具执行失败' });
      }
    },

    /* ============================================================
     * 听歌识曲（严格照官方 demo：8kHz PCM → Shazam v2 指纹 → POST /audio/match）
     *  - 录音：MediaRecorder 采 3 秒 → 解码为 8kHz 单声道 PCM（等价的 8k 重采样）
     *  - 指纹：官方 WASM（afp.js / afp.wasm.js，8kHz 输入）
     *  - 请求：POST {API_PRIMARY}/audio/match?duration=3&audioFP=<base64>（经同源代理）
     *  - 结果：data.result 为数组，每项形如 { song:{id,name,album,artists}, startTime }
     * ============================================================ */
    _recDuration: 6,
    async vRecognize() {
      this._setView(
        '<div class="rec-wrap">' +
        '<h2 class="rec-title">听歌识曲</h2>' +
        '<div class="rec-sub">让音乐响起，点击麦克风开始识别（录制约 6 秒）</div>' +
        '<div class="rec-stage" id="rec-stage">' +
        '<span class="rec-ring"></span><span class="rec-ring d2"></span><span class="rec-ring d3"></span>' +
        '<button type="button" class="rec-mic" id="rec-mic" aria-label="开始识别">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" class="rec-mic-svg">' +
        '<rect x="9" y="2.5" width="6" height="11" rx="3" fill="#fff"/>' +
        '<path d="M5.5 11.2a6.5 6.5 0 0 0 13 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M12 17.7v3.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>' +
        '</button>' +
        '</div>' +
        '<div class="rec-timer" id="rec-timer">00:00</div>' +
        '<div class="rec-wave" id="rec-wave">' + new Array(28).join('<i></i>') + '</div>' +
        '<div class="rec-tip" id="rec-tip">点击麦克风开始识别</div>' +
        '<div class="rec-result" id="rec-result"></div>' +
        '</div>');
      const mic = $('#rec-mic');
      if (mic) mic.addEventListener('click', () => this._toggleRecognize());
    },

    /** 把可能是对象/数组的字段安全转成字符串（识曲接口偶有嵌套结构） */
    _textOf(v) {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (Array.isArray(v)) return v.map(x => this._textOf(x)).filter(Boolean).join(' / ');
      if (typeof v === 'object') return this._textOf(v.name || v.nickname || v.title || '');
      return '';
    },
    _recogFail(msg) {
      clearTimeout(this._recStopT);
      this._recState = 'idle';
      const stage = $('#rec-stage');
      const tip = $('#rec-tip');
      const box = $('#rec-result');
      if (stage) stage.classList.remove('scanning', 'recording');
      this._stopWaveLoop();
      if (tip) tip.textContent = '未能识别，请重试';
      if (box) box.innerHTML = '<div class="rec-empty">' + esc(msg) + '</div>';
    },

    async _toggleRecognize() {
      if (this._recState === 'recording') { this._stopRecognize(); return; }
      if (this._recState === 'uploading' || this._recState === 'stopping') return;
      if (typeof window.GenerateFP !== 'function') {
        this._recogFail('指纹模块未加载（js/afp.js 缺失）——请强制刷新（Ctrl+F5）'); return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
        this._recogFail('当前浏览器不支持录音（请用 Chrome / Edge / Safari 新版）'); return;
      }
      const tip = $('#rec-tip');
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
        });
      } catch (e) {
        this._recogFail('无法访问麦克风：' + ((e && e.name === 'NotAllowedError') ? '请在浏览器地址栏允许麦克风权限' : ((e && e.message) || '未知错误')));
        return;
      }
      // 真实声波可视化（独立于录音实现）
      let analyser = null, waveErr = '';
      try {
        // 单例分析上下文：复用同一个 AudioContext（反复新建可能触达浏览器上限而被拒）
        if (!this._waveCtx || this._waveCtx.state === 'closed') {
          const AC = window.AudioContext || window.webkitAudioContext;
          this._waveCtx = new AC();
        }
        const wctx = this._waveCtx;
        if (wctx.state === 'suspended' && wctx.resume) { try { await wctx.resume(); } catch (e) {} }
        const srcNode = wctx.createMediaStreamSource(stream);
        analyser = wctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        srcNode.connect(analyser);
        this._waveSrc = srcNode;
      } catch (e) {
        analyser = null;
        waveErr = (e && e.message) || '未知错误';
        window.__recWaveErr = waveErr;
        console.warn('[recognize] 波形分析器初始化失败：', waveErr);
      }
      let mime = '';
      for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mime = m; break; }
      }
      let rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { this._recogFail('录音初始化失败：' + e.message); stream.getTracks().forEach(t => t.stop()); return; }
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = async () => {
        clearTimeout(this._recStopT);
        this._stopWaveLoop();
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        try { actx && actx.close(); } catch (e) {}
        const dur = Math.max(1, Math.min(this._recDuration, this._recSec || this._recDuration));
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type: type });
        if (!blob.size) { this._recogFail('没有录到声音（麦克风无输入？）请检查系统默认输入设备后重试'); return; }
        this._recState = 'uploading';
        try {
          const pcm = await this._decodePCM(blob, this._recDuration);
          if (!pcm || !pcm.length) { this._recogFail('音频解码失败（浏览器无法解析录音格式），请更换浏览器后重试'); return; }
          this._recognizeFP(pcm, this._recDuration);
        } catch (e) {
          this._recogFail('音频处理失败：' + e.message);
        }
      };
      this._recState = 'recording';
      this._recSec = 0;
      this._recRec = rec;
      this._recStopT = 0;
      const stage = $('#rec-stage');
      if (stage) stage.classList.add('recording');
      if (tip) tip.textContent = '正在聆听…（再次点击可提前结束）';
      const timer = $('#rec-timer');
      if (timer) timer.textContent = '00:00';
      this._startWaveLoop(analyser);
      try { rec.start(250); } catch (e) { this._recogFail('录音启动失败：' + e.message); return; }
      clearInterval(this._recT);
      this._recT = setInterval(() => {
        this._recSec = (this._recSec || 0) + 1;
        if (timer) timer.textContent = '00:0' + Math.min(9, this._recSec);
        if (this._recSec >= this._recDuration) this._stopRecognize();
      }, 1000);
    },

    _stopRecognize() {
      if (this._recState !== 'recording') return;
      this._recState = 'stopping';
      clearInterval(this._recT);
      try { if (this._recRec && this._recRec.state !== 'inactive') this._recRec.stop(); } catch (e) {}
      clearTimeout(this._recStopT);
      this._recStopT = setTimeout(() => {
        if (this._recState === 'stopping') { this._stopWaveLoop(); this._recogFail('录音结束超时，请重试'); }
      }, 2500);
    },

    /** 解码录音为 8kHz 单声道 Float32（与 demo 的 8k 采集等价） */
    async _decodePCM(blob, seconds) {
      const buf = await blob.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ sampleRate: 8000 });
      try {
        const audio = await ctx.decodeAudioData(buf.slice(0));
        const ch0 = audio.getChannelData(0);
        const want = Math.round((seconds || 3) * 8000);
        const n = Math.min(ch0.length, want);
        const out = new Float32Array(Math.max(0, n));
        out.set(ch0.subarray(0, n));
        return out;
      } finally {
        try { ctx.close(); } catch (e) {}
      }
    },

    /** 真实声波可视化：分析器频域能量驱动 28 条波形 */
    _startWaveLoop(analyser) {
      this._stopWaveLoop();
      const bars = $$('#rec-wave i');
      if (!bars.length) { const t = $('#rec-tip'); if (t) t.textContent = '正在聆听…（波形元素缺失）'; return; }
      if (!analyser) { bars.forEach(b => { b.style.height = '8px'; }); return; }
      const n = bars.length;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const time = new Uint8Array(analyser.fftSize);
      const tip = $('#rec-tip');
      const tick = () => {
        if (this._recState !== 'recording') return;
        // 时域峰值：用于波形自适应增益（不展示给用户）
        analyser.getByteTimeDomainData(time);
        let peak = 0;
        for (let k = 0; k < time.length; k++) { const d = Math.abs(time[k] - 128); if (d > peak) peak = d; }
        if (tip && tip.textContent.indexOf('正在聆听') !== 0) tip.textContent = '正在聆听…（再次点击可提前结束）';
        // 频域能量 → 波形条高度（按峰值做自适应增益，轻声也能看到起伏）
        analyser.getByteFrequencyData(data);
        const usable = Math.min(data.length, 96); // ≈0-9kHz：音乐能量集中区，保证每条都有响应
        const gain = peak > 6 ? Math.min(4, 90 / peak) : 1;
        for (let i = 0; i < n; i++) {
          const lo = Math.floor(Math.pow(i / n, 1.6) * usable);
          const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 1.6) * usable));
          let sum = 0, cnt = 0;
          for (let k = lo; k < hi && k < usable; k++) { sum += data[k]; cnt++; }
          const v = Math.min(1, (cnt ? (sum / cnt) / 255 : 0) * gain);
          bars[i].style.height = (4 + Math.pow(v, 0.55) * 28).toFixed(1) + 'px';
        }
        this._waveRaf = requestAnimationFrame(tick);
      };
      this._waveRaf = requestAnimationFrame(tick);
    },
    _stopWaveLoop() {
      if (this._waveRaf) { try { cancelAnimationFrame(this._waveRaf); } catch (e) {} this._waveRaf = 0; }
      $$$('#rec-wave i').forEach(b => { b.style.height = '5px'; });
    },

    /** 指纹 → POST 识曲接口 → 结果卡片（结果结构：data.result 为 [{song:{...}}]） */
    async _recognizeFP(pcm, seconds) {
      const stage = $('#rec-stage');
      const tip = $('#rec-tip');
      const box = $('#rec-result');
      if (stage) stage.classList.add('scanning');
      if (tip) tip.textContent = '识别中…';
      if (box) box.innerHTML = '<div class="rec-loading"><span></span><span></span><span></span>正在匹配歌曲</div>';
      const base = (location.protocol === 'file:' && window.APP_LOCAL_SERVER) ? window.APP_LOCAL_SERVER : '';
      try {
        const fp = await window.GenerateFP(pcm);
        const target = window.APP_CONFIG.API_PRIMARY + '/audio/match?duration=' + seconds + '&audioFP=' + encodeURIComponent(fp);
        const r = await fetch(base + '/proxy?u=' + encodeURIComponent(target), { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        const d = (j && j.data) || {};
        const list = d.result;
        // demo：data.result 为数组，元素形如 { song:{id,name,album,artists}, startTime }
        const first = Array.isArray(list) ? list[0] : (list && typeof list === 'object' ? list : null);
        const song = first && (first.song || (first.songs && first.songs[0]) || first);
        const sid = song && (song.id || song.songId);
        if (sid) {
          // 补全详情：识曲结果常缺封面/完整歌手，用歌曲详情覆盖（失败则用原数据）
          try {
            const dt = await API.songDetail ? await API.songDetail(String(sid)) : null;
            if (dt) {
              if (dt.name) song.name = dt.name;
              if (dt.artists && dt.artists.length) song.artists = dt.artists;
              if (dt.album) song.album = Object.assign({}, song.album, dt.album);
              if (dt.duration) song.duration = dt.duration;
            }
          } catch (e) { /* 用识曲原数据 */ }
          const name = this._textOf(song.name) || this._textOf(song.songName) || '未知歌曲';
          const ars = song.artists || song.ar || [];
          const artists = (Array.isArray(ars) ? ars : []).map(x => ({ name: this._textOf(x && x.name) })).filter(x => x.name);
          const album = song.album || song.al || {};
          const pic = album.picUrl || album.coverImgUrl || song.cover || '';
          const s = {
            id: String(sid), name: name, artists: artists,
            album: { name: this._textOf(album.name), id: album.id || '', picUrl: pic },
            cover: pic, // 播放栏封面读取的是 song.cover
            duration: song.duration || song.dt || 0,
          };
          if (box) {
            box.innerHTML =
              '<div class="rec-card">' +
              '<img class="rec-cover" src="' + esc(coverUrl(album.picUrl || '')) + '" alt="" loading="lazy">' +
              '<div class="rec-info"><div class="rec-name">' + esc(name) + '</div>' +
              '<div class="rec-artist">' + esc(artists.map(x => x.name).join(' / ') || '未知歌手') + '</div></div>' +
              '<button type="button" class="btn primary" id="rec-play">播放</button>' +
              '</div>';
            const btn = $('#rec-play');
            if (btn) btn.addEventListener('click', () => { Player.playQueue([s], 0); toast('开始播放《' + name + '》'); });
          }
          if (tip) tip.textContent = '识别成功！';
        } else {
          const reason = (d && d.noMatchReason !== undefined) ? ('（noMatchReason=' + d.noMatchReason + '）') : '';
          if (box) box.innerHTML = '<div class="rec-empty">没有识别到歌曲' + reason + '：请让音乐更清晰、离麦克风近一些（外放音量中等），或重试一次</div>';
          if (tip) tip.textContent = '未识别到，可重新尝试';
        }
      } catch (e) {
        if (box) box.innerHTML = '<div class="rec-empty">识别失败：' + esc(e.message) + '</div>';
        if (tip) tip.textContent = '识别失败，请重试';
      } finally {
        this._recState = 'idle';
        if (stage) stage.classList.remove('scanning', 'recording');
        const timer = $('#rec-timer');
        if (timer) timer.textContent = '00:00';
        this._recSec = 0;
      }
    },

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
          // 追加：把新内容【并入已有容器】（歌曲列表/专辑/歌手/歌单网格），
          // 而不是再插入一个独立容器——否则网格会在上一行未满时强制换行
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          const cardHtml = tmp.firstElementChild ? tmp.firstElementChild.innerHTML : html;
          const target = wrap.querySelector('.song-list') || wrap.querySelector('.album-grid') ||
            wrap.querySelector('.artist-grid') || wrap.querySelector('.pl-grid');
          if (target && cardHtml) {
            target.insertAdjacentHTML('beforeend', cardHtml);
          } else {
            const mw = $('[data-more="search"]');
            if (mw) mw.parentElement.insertAdjacentHTML('beforebegin', html);
            else wrap.insertAdjacentHTML('beforeend', html);
          }
          if (!hasMore) {
            const b = $('[data-more="search"]');
            if (b) {
              b.textContent = '已全部加载（共 ' + (data.total || offset + 20) + ' 条）';
              b.disabled = true;
              b.style.opacity = .55;
              b.style.cursor = 'default';
            }
          }
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
      // 收藏歌单：自建歌单（mp:true）实时取自建数据（名称/封面/数量），已删除的自动剔除
      const favPls = Store.FavPlaylists.all.map(p => {
        if (p.mp) {
          const mp = Store.MyPlaylists.get(p.id);
          if (!mp) return null;
          return { id: p.id, name: mp.name, cover: this._mpCoverSrc(mp), trackCount: mp.songs.length, mp: true };
        }
        return p;
      }).filter(Boolean);
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
      const fav = Store.FavPlaylists.has(p.id);
      return '<div class="pl-card mp-card" data-mp="' + p.id + '">' +
        '<div class="pl-cover"><img src="' + esc(this._mpCoverSrc(p)) + '" alt="" loading="lazy">' +
        '<span class="pl-count">' + p.songs.length + ' 首</span>' +
        '<span class="pl-hover">' + Icons.icon('playTri') + '</span>' +
        '<button class="pl-fav' + (fav ? ' on' : '') + '" data-mpfav="' + p.id + '" aria-label="收藏自建歌单">' + Icons.icon('heart') + '</button></div>' +
        '<div class="mp-name">' + esc(p.name) + '</div>' +
        '<div class="mp-acts"><button class="mini-btn" data-mp-rename="' + p.id + '">重命名</button>' +
        '<button class="mini-btn danger" data-mp-del="' + p.id + '">删除</button>' +
        '<button class="mini-btn danger" data-mp-clear="' + p.id + '">清空</button></div></div>';
    },

    /** 自建歌单封面来源优先级：自定义封面 → 首曲封面 → 默认音符占位。
     *  防御：封面字段里若混入 SVG dataURL（旧版占位图残留），一律忽略，
     *  保证清空后的歌单显示新版音符占位。 */
    _mpCoverSrc(p) {
      const custom = p.cover && p.cover.indexOf('data:image/svg+xml') !== 0 ? p.cover : '';
      return custom || (p.songs[0] && p.songs[0].cover ? coverUrl(p.songs[0].cover) : '') || DEFAULT_PL_COVER;
    },

    /* ---------- 自建歌单自定义封面（≤10MB，本地压缩后存储） ---------- */
    _changePlCover(id) {
      if (!this._plCoverFile) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.style.display = 'none';
        inp.addEventListener('change', () => this._onPlCoverFile(this._plCoverPending, inp.files && inp.files[0]));
        document.body.appendChild(inp);
        this._plCoverFile = inp;
      }
      this._plCoverPending = id;
      this._plCoverFile.value = '';
      this._plCoverFile.click();
    },
    /** 校验大小（≤10MB）→ 压缩（最长边 400 / JPEG / >100KB 降质；失败回退 256px，再失败小图直接存）→ 存歌单并刷新界面 */
    async _onPlCoverFile(id, file) {
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        toast('图片不能超过 10MB', 'warn');
        return;
      }
      const isImage = /^image\//.test(file.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '');
      if (!isImage) {
        toast('请选择图片文件', 'warn');
        return;
      }
      try {
        const dataURL = await this._compressPlCover(file);
        Store.MyPlaylists.setCover(id, dataURL);
        toast('封面已更新');
        const h = location.hash;
        if (/^#\/myplaylist\//.test(h)) this.vMyPlaylist(id);
        else this.vFavorites();
      } catch (e) {
        toast((e && e.message) || '封面更新失败', 'warn');
      }
    },
    _compressPlCover(file) {
      const compressAt = (maxSide, maxBytes) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('不支持的图片格式'));
          img.onload = () => {
            try {
              const w0 = img.naturalWidth || img.width || 1;
              const h0 = img.naturalHeight || img.height || 1;
              const scale = Math.min(1, maxSide / Math.max(w0, h0));
              const w = Math.max(1, Math.round(w0 * scale));
              const h = Math.max(1, Math.round(h0 * scale));
              const cv = document.createElement('canvas');
              cv.width = w; cv.height = h;
              const ctx = cv.getContext('2d');
              if (ctx) {
                ctx.fillStyle = '#15151a'; // JPEG 无透明通道：深色底垫底
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
              }
              const bytesOf = (s) => Math.floor((s.length - (s.indexOf(',') + 1)) * 3 / 4);
              let q = 0.82;
              let out = '';
              while (q > 0.18) {
                out = cv.toDataURL('image/jpeg', q);
                if (out && out.length > 30 && bytesOf(out) <= maxBytes) break;
                q = +(q - 0.06).toFixed(2);
              }
              if (out && out.length > 30) resolve(out);
              else reject(new Error('图片过复杂无法压缩，请换一张较小的图（建议 2MB 内）'));
            } catch (e2) { reject(e2); }
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
      // 首选 400px/100KB；失败（复杂大图/异常画布）→ 256px 再试；仍失败给小图机会直接用原始 dataURL
      return compressAt(400, 100 * 1024)
        .catch(() => compressAt(256, 100 * 1024))
        .catch(() => new Promise((resolve, reject) => {
          if (file.size <= 300 * 1024) {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('读取图片失败'));
            r.readAsDataURL(file);
          } else {
            reject(new Error('图片过复杂无法压缩，请换一张较小的图（建议 2MB 内）'));
          }
        }));
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
        '<section class="view-section"><div class="sec-head mp-head">' +
        '<img class="mp-head-cover" src="' + esc(this._mpCoverSrc(pl)) + '" alt="">' +
        '<h2>' + esc(pl.name) + '</h2>' +
        '<span class="mp-count">' + pl.songs.length + ' 首</span></div>' +
        '<div class="mp-tools">' +
        (pl.songs.length ? '<button class="mini-btn" id="mp-play-all">播放全部</button>' : '') +
        '<button class="mini-btn' + (Store.FavPlaylists.has(pl.id) ? ' mp-faved' : '') + '" id="mp-fav">' + (Store.FavPlaylists.has(pl.id) ? '已收藏' : '收藏') + '</button>' +
        '<button class="mini-btn" id="mp-share">分享</button>' +
        '<button class="mini-btn" id="mp-rename">重命名</button>' +
        '<button class="mini-btn" id="mp-cover-btn">更换封面</button>' +
        (pl.cover ? '<button class="mini-btn" id="mp-cover-reset">恢复默认</button>' : '') +
        '</div>' +
        '<div class="mp-import"><div class="search-box"><form id="mp-import-form">' +
        '<input id="mp-import-input" placeholder="粘贴网易云 歌单/专辑/歌曲 链接或 ID，导入全部歌曲" maxlength="300"></form></div>' +
        '<button class="mini-btn" id="mp-import-btn">导入</button></div>' +
        '<div id="mp-progress" class="mp-progress"></div>' +
        (pl.songs.length ? this._songListHtml(pl.songs, { album: true, remove: true })
          : UI.empty('歌单是空的', '在任意歌曲列表点「加入歌单」，或粘贴网易云歌单链接到上方输入框导入')) +
        '</section>');
      const pa = $('#mp-play-all');
      if (pa) pa.addEventListener('click', () => Player.playQueue(pl.songs, 0));
      try {
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
      $('#mp-cover-btn').addEventListener('click', () => this._changePlCover(pl.id));
      $('#mp-fav').addEventListener('click', () => {
        const wasFav = Store.FavPlaylists.has(pl.id);
        Store.FavPlaylists.toggle({ id: pl.id, name: pl.name, cover: this._mpCoverSrc(pl), trackCount: pl.songs.length, mp: true });
        toast(wasFav ? '已取消收藏自建歌单' : '已收藏自建歌单，可在「我的收藏 → 收藏歌单」与侧边栏查看');
        this.vMyPlaylist(pl.id);
      });
      $('#mp-share').addEventListener('click', async () => {
        if (!Store.Session.loggedIn) {
          toast('请先登录后再分享自建歌单', 'warn');
          this.openAuth('login');
          return;
        }
        try {
          const j = await Store.Session.shareMp(pl.id);
          const origin = (location.origin && location.origin.indexOf('http') === 0) ? location.origin : 'https://www.bmusic.de5.net';
          const url = origin + (j.url || '/s/mp/' + j.token);
          const okCopy = navigator.clipboard && await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
          toast(okCopy ? '分享链接已复制，发送给好友即可（仅登录可分享；对方可直接查看）' : '链接：' + url);
        } catch (e) {
          toast('分享失败：' + e.message, 'warn');
        }
      });
      const rcst = $('#mp-cover-reset');
      if (rcst) rcst.addEventListener('click', () => {
        Store.MyPlaylists.clearCover(pl.id);
        toast('已恢复默认封面');
        this.vMyPlaylist(pl.id);
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
      } catch (e) {
        console.error('vMyPlaylist bind error', e);
      }
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

    /** 单曲加入自建歌单：弹出目标歌单选择浮层（歌曲列表/歌曲页「加入歌单」共用） */
    _addSongToPl(song) {
      if (!song) return;
      const pls = Store.MyPlaylists.all;
      if (!pls.length) {
        toast('请先到「我的收藏 → 自建歌单」新建歌单', 'warn');
        return;
      }
      const mask = document.createElement('div');
      mask.className = 'mp-pick-mask';
      mask.innerHTML =
        '<div class="mp-pick"><div class="mp-pick-head"><span>「' + esc(song.name) + '」加入歌单</span>' +
        '<button class="icon-btn" id="mp-psong-close">✕</button></div>' +
        '<div class="mp-pick-body">' + pls.map(p =>
          '<button class="mp-pick-item" data-target="' + p.id + '">' + esc(p.name) +
          '<em>' + p.songs.length + ' 首</em></button>').join('') +
        '</div><div class="mp-pick-foot">按歌曲 ID 去重，重复加入不会产生副本</div></div>';
      document.body.appendChild(mask);
      const close = () => mask.remove();
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      $('#mp-psong-close').addEventListener('click', close);
      mask.querySelectorAll('[data-target]').forEach(b => b.addEventListener('click', () => {
        const pid = b.dataset.target;
        const p = Store.MyPlaylists.get(pid);
        if (!p) { close(); return; }
        close();
        const added = Store.MyPlaylists.addSongs(pid, [song]);
        if (added) toast('已加入「' + p.name + '」');
        else toast('这首歌已在「' + p.name + '」中', 'warn');
      }));
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
      const artists = artistList(s.artistsArr && s.artistsArr.length ? s.artistsArr : s.artists); // 兼容对象数组/字符串/旧 artistsArr
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
          '<button class="btn" id="dt-pladd">加入歌单</button>' +
          '<button class="btn" id="dt-share">分享</button></div>' +
          '</div></section>' +
          '<section class="view-section"><div class="sec-head"><h2>单曲</h2></div>' +
          this._songListHtml([s], { album: true }) + '</section>';
        this._setView(html);
        $('#dt-playall').addEventListener('click', () => Player.playQueue([s], 0));
        $('#dt-pladd').addEventListener('click', () => this._addSongToPl(s));
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

    /** 其他用户分享的自建歌单（只读视图；未登录用户仅查看） */
    async vShareMp(token) {
      const seq = this._viewSeq;
      this._viewLoading();
      try {
        const j = await Store.Session.fetchMpShare(token);
        if (seq !== this._viewSeq) return;
        if (!j || !j.ok) {
          this._viewError((j && j.msg) || '分享不存在或已失效', 'App.vShareMp(\'' + token + '\')');
          return;
        }
        const songs = (j.songs || []);
        const owner = j.owner || {};
        // 播放用歌曲对象：artists 必须为对象数组、album 为对象（播放器 snapshot 要求），
        // 列表显示则使用原始快照（字符串 artists/album）
        const playable = songs.map(s => ({
          id: s.id, name: s.name,
          artists: (s.artists || '').split(' / ').filter(Boolean).map(a => ({ name: a })),
          album: { name: s.album || '' },
          cover: s.cover || '', duration: s.duration || 0, vip: !!s.vip,
        }));
        this._ctx.songs = playable;
        const headCover = (j.cover || (songs[0] && songs[0].cover) || '');
        const html =
          '<section class="view-section"><div class="sec-head mp-head">' +
          '<img class="mp-head-cover" src="' + esc(coverUrl(headCover) || DEFAULT_PL_COVER) + '" alt="">' +
          '<h2>' + esc(j.name || '自建歌单') + '</h2>' +
          '<span class="mp-count">' + songs.length + ' 首</span></div>' +
          '<div class="mp-tools">' +
          (songs.length ? '<button class="mini-btn" id="share-playall">播放全部</button>' : '') +
          '</div>' +
          '<div class="mp-share-owner">分享者：' + esc(owner.name || '用户') +
          (owner.id ? ' · UID ' + esc(owner.id) : '') + '</div>' +
          (Store.Session.loggedIn ? '' :
            '<div class="mp-share-tip">未登录仅可查看；登录后可分享自己的歌单</div>') +
          (songs.length ? this._songListHtml(songs, { cover: true, album: true })
            : UI.empty('该歌单没有歌曲')) +
          '</section>';
        this._setView(html);
        const pa = $('#share-playall');
        if (pa) pa.addEventListener('click', () => Player.playQueue(playable, 0));
      } catch (e) {
        if (seq !== this._viewSeq) return;
        this._viewError('分享加载失败：' + e.message, 'App.vShareMp(\'' + token + '\')');
      }
    },

    /** 分享快照字段容错：artists 可能是数组/对象数组/字符串 */
    _shareArtistText(a) {
      if (!a) return '';
      if (typeof a === 'string') return a;
      if (Array.isArray(a)) return a.map(x => (x && typeof x === 'object' ? x.name : x)).filter(Boolean).join(' / ');
      return a.name || '';
    },
    /** 分享快照字段容错：album 可能是对象/字符串 */
    _shareAlbumText(a) {
      if (!a) return '';
      if (typeof a === 'string') return a;
      return a.name || '';
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
        const artists = artistList(s.artists).map(a => a.name).join(' / ');
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
          '<button class="sr-dl sr-pladd" data-pladd="' + n + '" aria-label="加入歌单">' +
          '<svg viewBox="0 0 1024 1024"><path d="M832 352H192c-17.7 0-32-14.3-32-32s14.3-32 32-32h640c17.7 0 32 14.3 32 32s-14.3 32-32 32zM832 544H192c-17.7 0-32-14.3-32-32s14.3-32 32-32h640c17.7 0 32 14.3 32 32s-14.3 32-32 32zM512 736H192c-17.7 0-32-14.3-32-32s14.3-32 32-32h320c17.7 0 32 14.3 32 32s-14.3 32-32 32z"/><path d="M896 608v64h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32h64v64c0 17.7 14.3 32 32 32s32-14.3 32-32v-64h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64v-64c0-17.7-14.3-32-32-32s-32 14.3-32 32z"/></svg></button>' +
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
        const plAddEl = e.target.closest('[data-pladd]');
        if (plAddEl) {
          const i = +plAddEl.dataset.pladd;
          const s = this._ctx.songs[i];
          if (s) this._addSongToPl(s);
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
        const mpClrEl = e.target.closest('[data-mp-clear]');
        if (mpClrEl) {
          const id = mpClrEl.dataset.mpClear;
          const p = Store.MyPlaylists.get(id);
          const card = mpClrEl.closest('.mp-card');
          if (!p || !card) return;
          card.innerHTML = '<div class="mp-del-confirm">清空歌单「' + esc(p.name) + '」的全部 ' + p.songs.length + ' 首歌曲？<br>' +
            '<button class="mini-btn danger" data-mp-clear-yes="' + id + '">确认清空</button>' +
            '<button class="mini-btn" data-mp-clear-no>取消</button></div>';
          return;
        }
        const mpClrYesEl = e.target.closest('[data-mp-clear-yes]');
        if (mpClrYesEl) {
          Store.MyPlaylists.clearSongs(mpClrYesEl.dataset.mpClearYes);
          toast('歌单已清空');
          this.vFavorites();
          return;
        }
        const mpClrNoEl = e.target.closest('[data-mp-clear-no]');
        if (mpClrNoEl) { this.vFavorites(); return; }
        const mpFavEl = e.target.closest('[data-mpfav]');
        if (mpFavEl) {
          const pid = mpFavEl.dataset.mpfav;
          const p = Store.MyPlaylists.get(pid);
          if (p) {
            const wasFav = Store.FavPlaylists.has(pid);
            Store.FavPlaylists.toggle({ id: pid, name: p.name, cover: this._mpCoverSrc(p), trackCount: p.songs.length, mp: true });
            toast(wasFav ? '已取消收藏自建歌单' : '已收藏自建歌单，可在「我的收藏 → 收藏歌单」与侧边栏查看');
            this.vFavorites();
          }
          return;
        }
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
        if (plEl) {
          const pid = plEl.dataset.pl;
          // 自建歌单（mp 前缀）跳自建详情；其余跳网易云歌单
          if (pid && pid.indexOf('mp') === 0) this.nav('myplaylist/' + pid);
          else this.nav('playlist/' + pid);
          return;
        }
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

    /* ---------------- 下载（点击即出进度浮层：取址 → 流式下载 → 完成） ---------------- */
    async _downloadSong(song) {
      const label = song.name + ' - ' + artistList(song.artists).map(x => x.name).join('/');
      // 点击立即创建进度浮层：先显示“获取地址中”流动动画，随后无缝转下载百分比
      const bar = document.createElement('div');
      bar.className = 'dl-card';
      bar.innerHTML = '<div class="dl-name">' + esc(label) + '</div>' +
        '<div class="dl-track"><i class="loading"></i></div><div class="dl-pct">获取中</div>';
      document.body.appendChild(bar);
      const setPct = (pct, bytes) => {
        const i = bar.querySelector('.dl-track i');
        const p = bar.querySelector('.dl-pct');
        if (i) { i.classList.remove('loading'); i.style.width = pct + '%'; }
        if (p) p.textContent = pct ? (pct + '%') : ((bytes / 1048576).toFixed(1) + 'MB');
      };
      const removeBar = () => { if (bar.parentNode) bar.remove(); };
      try {
        let info = null;
        // 无损及以上=登录专属：未登录下载自动降到极高(320k)
        let dlQ = Store.Settings.quality;
        if (!Store.Session.loggedIn) {
          const R = { standard: 0, higher: 1, exhigh: 2, lossless: 3, hires: 4, jyeffect: 5, sky: 6, dolby: 7, jymaster: 8 };
          if ((R[dlQ] || 0) >= 3) dlQ = 'exhigh';
        }
        // 下载音质优先级：会员/镜像(真实高清) → 红云仅兜底（其免费档固定 320k）
        try {
          info = await API.resolveUrl(song, dlQ);
        } catch (e1) {
          info = await API.hongyunUrl(song.id, dlQ);
        }
        if (!info || !info.url) throw new Error('无可用地址');
        try {
          const res = await fetch(info.url, { mode: 'cors' });
          if (res.ok) {
            const total = +(res.headers.get('content-length') || 0);
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0;
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              chunks.push(r.value);
              received += r.value.length;
              setPct(total ? Math.min(100, Math.round(received / total * 100)) : 0, received);
            }
            // 拼合分块 → 按文件头魔数识别真实格式（CDN 的 content-type 常不可靠，
            // 会把 flac 标成 audio/mpeg，导致浏览器给文件名再补一个 .mp3）
            const raw = new Uint8Array(received);
            let off = 0;
            for (const c of chunks) { raw.set(c, off); off += c.length; }
            const kind = (window.Metadata && window.Metadata.detectType(raw.buffer)) || '';
            const pctEl = bar.querySelector('.dl-pct');
            if (pctEl) pctEl.textContent = '写入元信息…';
            const meta = await this._songMeta(song);
            const outBuf = (window.Metadata && window.Metadata.write)
              ? await window.Metadata.write(raw.buffer, meta) : raw.buffer;
            const ext = kind || (info.type || 'mp3').replace('mpeg', 'mp3');
            // Blob MIME 必须与扩展名一致，否则 Chrome 保存时会追加“纠正”后缀
            const blob = new Blob([outBuf], { type: ext === 'flac' ? 'audio/flac' : 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = label + '.' + ext;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
            toast('下载完成《' + song.name + '》');
            removeBar();
            return;
          }
        } catch (e) { /* 走新标签页 */ }
        removeBar();
        const a = document.createElement('a');
        a.href = info.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.click();
        toast('已在新标签页打开下载链接（' + (info.source || '') + '）');
      } catch (e) {
        removeBar();
        toast('下载失败：' + e.message, 'warn');
      }
    },

    /* 下载写入用元信息：标题/歌手/专辑/歌词/封面（任一失败静默跳过，不阻塞下载） */
    async _songMeta(song) {
      const meta = {
        title: song.name || '',
        artist: artistList(song.artists).map(x => x.name).join(' / '),
        album: (song.album && song.album.name) || '',
        lyrics: '',
        cover: null,
        coverMime: 'image/jpeg',
      };
      try {
        const [lyr, cover] = await Promise.all([
          API.lyric(song.id).then(v => v.base || '').catch(() => ''),
          song.cover ? this._fetchCover(song.cover) : Promise.resolve(null),
        ]);
        meta.lyrics = lyr;
        if (cover) { meta.cover = cover.buf; meta.coverMime = cover.mime; }
      } catch (e) { /* 静默 */ }
      return meta;
    },

    /* 抓取封面二进制（网易云缩略参数 500y500；CORS/网络失败则放弃封面） */
    async _fetchCover(url) {
      try {
        let u = String(url || '').replace(/^http:\/\//i, 'https://');
        if (!u) return null;
        if (/music\.126\.net/i.test(u)) u = u.split('?')[0] + '?param=500y500';
        const r = await fetch(u, { mode: 'cors' });
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        if (ab.byteLength < 100) return null;
        const d = new Uint8Array(ab);
        const mime = (d[0] === 0x89 && d[1] === 0x50) ? 'image/png' : 'image/jpeg';
        return { buf: ab, mime };
      } catch (e) { return null; }
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
            '%, rgba(var(--fg-rgb),.26) ' + ratio * 100 + '%, rgba(var(--fg-rgb),.26) 100%)';
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
      bindBar('#ov-bar', (t) => Player.seek(t), 'var(--fg-strong)');

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
        $$('.ly-trans').forEach((el) => {
          if (this._lyricTrans) {
            // 出现动画：淡入 + 轻微上浮
            el.classList.remove('hide', 'out');
            el.classList.remove('in'); void el.offsetWidth; // 重新触发动画
            el.classList.add('in');
          } else {
            // 消失动画：先淡出，再移除占位
            el.classList.remove('in');
            el.classList.add('out');
            setTimeout(() => { el.classList.remove('out'); el.classList.add('hide'); }, 170);
          }
        });
        const tb = $('#ly-trans-toggle');
        tb.textContent = this._lyricTrans ? '译' : '原';
        tb.classList.toggle('on', this._lyricTrans);
        this._swingLyricLines(); // 原文行协调动画：与译文出现/消失同拍，避免闪烁
        // 行高变化后：重测度量并把轨道【平滑滑动】到活动行新位置（Apple Music 式切换）
        setTimeout(() => {
          this._measureLyrics();
          const st = this._lyricState;
          const li = st && st.li;
          if (li != null && li >= 0) {
            const target = this._lyricTargetFor(li, 0);
            this._smoothLyricTo(target);
          }
        }, this._lyricTrans ? 30 : 200);
        toast(this._lyricTrans ? '已显示译文' : '已隐藏译文');
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
      $('#pb-artist').textContent = artistList(d.song.artists).map(a => a.name).join(' / ');
      $('#pb-cover').src = d.song.cover ? coverUrl(d.song.cover) : PLACEHOLDER;
      const faved = Store.FavSongs.has(d.song.id);
      $('#pb-fav').classList.toggle('on', faved);
      $('#pb-fav').innerHTML = Icons.heartIcon(faved);
      $('#ov-title').textContent = d.song.name;
      $('#ov-artist').textContent = artistList(d.song.artists).map(a => a.name).join(' / ') +
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
      const show = (base, trans, yrows) => {
        const tb = $('#ly-trans-toggle');
        const setTrans = (has) => {
          this._lyricTrans = !!has;
          if (tb) {
            tb.textContent = has ? '译' : '原'; // 显示译文→"译"，仅原文→"原"
            tb.classList.toggle('on', has);
          }
        };
        const merged = Lrc.mergeLyrics(base || '', trans || '');
        // 逐字（YRC）接入【根治】：逐字时间轴与 LRC 常有固定偏移（如 ±0.2~1.5s），
        // 先求两轴时间差的中位数并校正，再以 0.5s 窗口匹配——杜绝"未匹配行"导致的
        // 重复插入/混排；只补词、不插入行；匹配率 <85% 才整体放弃
        if (yrows && yrows.length) {
          const diffs = [];
          for (const r of yrows) {
            let bd = Infinity, bt = 0;
            for (const o of merged) {
              const d = Math.abs(o.t - r.t);
              if (d < bd) { bd = d; bt = o.t; }
            }
            if (bd < 2) diffs.push(bt - r.t);
          }
          let off = 0;
          if (diffs.length) {
            diffs.sort((a, b) => a - b);
            off = diffs[Math.floor(diffs.length / 2)];
          }
          off = Math.max(-2, Math.min(2, off)); // 防御错配偏移
          let matched = 0;
          for (const r of yrows) {
            let best = null, bd = 0.5;
            for (const o of merged) {
              const d = Math.abs((r.t + off) - o.t);
              if (d < bd) { bd = d; best = o; }
            }
            if (best) {
              matched++;
              if (!best.words) best.words = r.words;
            }
          }
          const ok = matched / yrows.length >= 0.85;
          for (const o of merged) if (!ok || !o.words) delete o.words;
        }
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
          show(ly.base, ly.trans, ly.yrc ? Lrc.parseYrc(ly.yrc) : []);
        } else {
          const hy = await API.hongyunLrc(song.id);
          show(hy, '', []);
        }
      } catch (e) {
        this._lyricLines = [];
        this._showLyricPlaceholder('歌词加载失败');
      }
    },

    _renderLyricBox(box, lines, hasTrans) {
      const html = lines.map((l, i) => {
        const dur = Math.max(0.5, ((lines[i + 1] ? lines[i + 1].t : l.t + 5) - l.t));
        let textHtml = l.l ? esc(l.l) : '&nbsp;';
        if (l.words && l.words.length) {
          const ascii = /[\u4e00-\u9fa5]/.test(l.l) ? false : true;
          textHtml = l.words.map(w => '<span class="ly-w" data-t="' + w.t + '" data-d="' + Math.max(0.05, w.d) + '">' + esc(w.w) + '</span>').join(ascii ? ' ' : '');
        }
        return '<div class="ly-line" data-li="' + i + '" data-t="' + l.t + '" data-d="' + dur + '">' +
          '<div class="ly-text">' + textHtml + '</div>' +
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
        // 非活动行模糊度随距离渐变：越靠近主行越清晰（d=1 → 0.5px），
        // 越远越模糊（d>=7 → 4px，上限 4px / 下限 0.5px）
        for (let i = 0; i < els.length; i++) {
          if (i === li) continue;
          const d = Math.abs(i - li);
          const blur = d <= 1 ? 0.5 : Math.min(4, 0.5 + (d - 1) * (3.5 / 6));
          els[i].style.setProperty('--ly-blur', blur.toFixed(2) + 'px');
          // 模糊窗口：仅活动行附近 ±10 行保留模糊（远处行关闭滤镜，节省 GPU）
          const far = d > 10;
          if (els[i].classList.contains('ly-far') !== far) els[i].classList.toggle('ly-far', far);
        }
      }

      // 2) 逐字（YRC）：活动行内词级卡拉OK——词亮度随演唱进度线性变亮
      //    （词开始 ~30% 亮 → 唱完 100% 亮）；无词数据则整段显示（活动行纯白）
      const el = els[li];
      if (el) {
        if (this._lyricWaveLine !== li) { this._lyricWaveLine = li; this._lyricWaveIdx = null; }
        const ws = el.querySelectorAll('.ly-w');
        if (ws && ws.length) {
          let curIdx = -1;   // 正在演唱的字（羽化边界所在字）
          let lastOn = -1;   // 最后一个已唱完的字
          for (let k = 0; k < ws.length; k++) {
            const wt = parseFloat(ws[k].dataset.t);
            const wd = parseFloat(ws[k].dataset.d) || 0.2;
            const p = cur >= wt ? Math.min(1, (cur - wt) / wd) : 0; // 词演唱进度 0..1
            ws[k].style.setProperty('--wp', p.toFixed(3));
            ws[k].classList.toggle('on', p >= 1);
            if (p > 0 && p < 1) curIdx = k;
            else if (p >= 1) lastOn = k;
            // 滚动样式：仅【正在演唱的那个字】带字内扫光；未唱=整字均匀暗、已唱=整字纯白
            if (this._karaokeScroll) {
              if (p > 0 && p < 1) {
                const q = (p * 100).toFixed(1);
                const grad = 'linear-gradient(90deg, rgba(0,0,0,1) calc(' + q + '% - 2.5px), rgba(0,0,0,.5) calc(' + q + '% + 2.5px))';
                if (ws[k].dataset.mk !== grad) {
                  ws[k].dataset.mk = grad;
                  ws[k].style.webkitMaskImage = grad;
                  ws[k].style.maskImage = grad;
                }
                if (ws[k].style.opacity !== '1') ws[k].style.opacity = '1';
              } else {
                if (ws[k].style.maskImage || ws[k].style.webkitMaskImage) {
                  ws[k].style.webkitMaskImage = '';
                  ws[k].style.maskImage = '';
                }
                if (ws[k].style.opacity) ws[k].style.opacity = '';
              }
            } else {
              if (ws[k].style.maskImage || ws[k].style.webkitMaskImage) {
                ws[k].style.webkitMaskImage = '';
                ws[k].style.maskImage = '';
              }
              if (ws[k].style.opacity) ws[k].style.opacity = '';
            }
          }
          // 波浪位移：当前字【随字内播放进度】抬升（最大 1px）；
          // 左侧已唱字按距离渐次衰减（尾波）；未唱字轻微下沉。位移精度 0.001px。
          const idx = curIdx >= 0 ? curIdx : lastOn;
          if (this._karaokeScroll) {
            const CUR_UP = 1, STEP = 0.125, AHEAD_DOWN = 0.3;
            // ① 索引变化时：刷新整行的尾波与未唱下沉
            if (idx !== this._lyricWaveIdx) {
              this._lyricWaveIdx = idx;
              for (let k = 0; k < ws.length; k++) {
                if (k === idx) continue; // 当前字交给 ② 每帧按进度处理
                let y = 0;
                if (idx >= 0) {
                  const d = idx - k;
                  if (d > 0) y = -Math.max(0, CUR_UP - d * STEP); // 已唱尾波
                  else if (d < 0) y = AHEAD_DOWN;                 // 未唱微沉
                }
                ws[k].style.transform = y ? ('translateY(' + y.toFixed(3) + 'px)') : '';
              }
            }
            // ② 每帧：当前字随字内进度抬升（0 → 1px），并保证它是唯一无过渡的字
            for (let k = 0; k < ws.length; k++) {
              const isCur = (k === idx && curIdx >= 0);
              ws[k].classList.toggle('w-cur', isCur);
            }
            if (idx >= 0 && curIdx >= 0) {
              const wt = parseFloat(ws[idx].dataset.t);
              const wd = parseFloat(ws[idx].dataset.d) || 0.2;
              const pk = cur >= wt ? Math.min(1, (cur - wt) / wd) : 0;
              ws[idx].style.transform = pk > 0 ? ('translateY(' + (-CUR_UP * pk).toFixed(3) + 'px)') : '';
            }
          }
          // 行级遮罩（上一版实现）已废弃：清理残留，避免多行错乱
          if (el.style.maskImage || el.style.webkitMaskImage) {
            el.style.webkitMaskImage = '';
            el.style.maskImage = '';
          }
        }
        const d = parseFloat(el.dataset.d) || 5;
        const t0 = parseFloat(el.dataset.t) || 0;
        const p = Math.max(0, Math.min(1, (cur - t0) / d)); // 行进度 0..1（仅用于随唱上滑）
        // 3) 指数跟随 + 随唱平滑上移：行开始时下边缘在中心偏下 20px，随演唱进度
        //    连续上滑到中心偏上 10px；换行时自然衔接，避免“一跳一跳”的断续感。
        //    transform 平移（GPU 合成）；用户手动滚动预览时暂停跟随（4 秒）
        if (now - (this._userScrollAt || 0) < 4000 || now - (this._lyricAnimT || 0) < 420) {
          // 用户预览中 / 译原平滑切换过渡中：保持当前滚动位置
        } else {
          // 注意：clientHeight 已包含上下 padding，直接以其一半作为可视中心；
          // offsetTop 已相对轨道顶边（含其 padding），不再加 padTop
          const target = this._lyricTargetFor(li, p);
          const diff = target - (this._lyricScroll || 0);
          if (Math.abs(diff) > 0.5) {
            const k = 1 - Math.exp(-dt * 11); // 收敛时间约 250ms
            this._lyricScroll = Math.max(0, Math.min(target, (this._lyricScroll || 0) + diff * k));
            this._applyLyricScroll();
          }
        }
      }
    },

    /** 活动行应处的滚动目标：
     *  手机（≤800px）：以主句【上边缘】为准——第一行固定在可视区 36% 线，
     *    多行（长句+译文）向下展开，第一行永不被裁/遮；
     *  桌面：块中心对齐可视区中心；
     *  均含随唱上滑 travel */
    _lyricTargetFor(li, p) {
      const wrap = $('.ov-lyrics');
      const el = this._lyricEls && this._lyricEls[li];
      if (!wrap || !el) return this._lyricScroll || 0;
      const m = this._lyricM && this._lyricM[li];
      const wrapH = this._wrapClientH || wrap.clientHeight;
      const scrollH = this._wrapScrollH || wrap.scrollHeight;
      const lineH = m ? m.h : (el.offsetHeight || 42);
      const base = m ? m.top : el.offsetTop;
      let target;
      if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) {
        // 以上边缘为准：第一行恒在 30% 线（到位后静止，不再随唱上滑）
        target = base - wrapH * 0.30 + 8;
      } else {
        // 桌面：当前句对齐可视区约 1/3 线（偏上，与手机端一致；到位后静止，不再随唱上滑）
        target = base + lineH / 2 - wrapH * 0.44 + 10;
      }
      return Math.max(0, Math.min(Math.max(0, scrollH - wrapH), target));
    },

    /** 立即把活动行定格到居中位置（翻译/原文本切换后消除滚动追赶动画） */
    _snapActiveLyric() {
      const st = this._lyricState;
      const li = st && st.li;
      if (li == null || li < 0) return;
      this._lyricScroll = this._lyricTargetFor(li, 0);
      this._applyLyricScroll();
    },

    /** 平滑滑动歌词轨道到目标位置（切换译/原时使用，Apple Music 式过渡） */
    _smoothLyricTo(target) {
      const inner = $('#ov-lyrics-inner');
      const blurInner = $('#ov-lyric-blur-inner');
      const els = [inner, blurInner].filter(Boolean);
      els.forEach((el) => {
        el.style.transition = 'transform .32s cubic-bezier(.22,.61,.36,1)';
      });
      this._lyricAnimT = (typeof performance !== 'undefined' ? performance.now() : Date.now()); // 过渡期间暂停逐帧跟随，避免打断
      this._lyricScroll = target;
      this._applyLyricScroll(); // 从旧 transform 平滑过渡到新位置
      setTimeout(() => {
        els.forEach((el) => { el.style.transition = ''; });
      }, 380);
    },

    /** 原文行协调动画：活动行附近 ±12 行轻微上浮归位一次（与译文淡入/淡出同拍，防止闪烁） */
    _swingLyricLines() {
      const els = this._lyricEls || [];
      if (!els.length) return;
      const st = this._lyricState;
      const li = (st && st.li >= 0) ? st.li : Math.floor(els.length / 2);
      const from = Math.max(0, li - 12);
      const to = Math.min(els.length, li + 13);
      for (let j = from; j < to; j++) {
        els[j].classList.remove('ly-swap');
        void els[j].offsetWidth; // 重新触发动画
        els[j].classList.add('ly-swap');
      }
      setTimeout(() => {
        for (let j = from; j < to; j++) {
          const el = els[j];
          if (el) el.classList.remove('ly-swap');
        }
      }, 320);
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
      clearTimeout(this._ovT);
      ov.classList.remove('hidden', 'ov-closing');
      ov.classList.add('ov-opening');
      this._ovT = setTimeout(() => ov.classList.remove('ov-opening'), 420);
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
      const ov = $('#overlay');
      this.stopLyricLoop();
      if (!$('#queue-drawer').classList.contains('hidden')) this.closeQueue();
      document.body.classList.remove('no-scroll');
      if (ov.classList.contains('hidden')) return;
      // 退出动画：下滑淡出后再隐藏（期间再次打开会取消并直接显示）
      clearTimeout(this._ovT);
      ov.classList.remove('ov-opening');
      ov.classList.add('ov-closing');
      this._ovT = setTimeout(() => {
        ov.classList.add('hidden');
        ov.classList.remove('ov-closing');
      }, 260);
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
        '<div class="qd-artists">' + esc(artistList(s.artists).map(a => a.name).join(' / ')) + '</div></div>' +
        '<div class="qd-dur">' + fmtDuration(s.duration) + '</div>' +
        '<button class="qd-rm" data-qrm="' + i + '">' +
        '<svg viewBox="0 0 1024 1024"><path d="M864 256H736v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80H160c-17.7 0-32 14.3-32 32s14.3 32 32 32h32v512c0 35.3 28.7 64 64 64h512c35.3 0 64-28.7 64-64V320h32c17.7 0 32-14.3 32-32s-14.3-32-32-32zM384 192h256v64H384v-64zm384 640H256V320h512v512z"/></svg></button>' +
        '</div>').join('');
    },

    /* ============================================================
     * 更新公告（左侧版本列表 → 右侧对应版本内容）
     * ============================================================ */
    _noticeSeenKey() { return 'ym.noticeSeen'; },
    _noticeSeen() {
      try { return localStorage.getItem(this._noticeSeenKey()) || ''; } catch (e) { return ''; }
    },
    _markNoticeSeen() {
      try { localStorage.setItem(this._noticeSeenKey(), (window.APP_NOTICE || {}).version || ''); } catch (e) { /* 忽略 */ }
    },
    _noticeAll() {
      const n = window.APP_NOTICE || {};
      return (n.history && n.history.length) ? n.history.slice() : (n.version ? [n] : []);
    },
    /** 在弹窗右侧渲染某个版本的公告内容 */
    _noticeShow(entry) {
      if (!entry) return;
      const ver = $('#notice-ver');
      if (ver) ver.textContent = 'v' + entry.version + (entry.date ? ' · ' + entry.date : '');
      const list = $('#notice-list');
      if (list) list.innerHTML = (entry.items || []).map(t => '<li>' + esc(t) + '</li>').join('');
      $$('#notice-side .notice-ver-item').forEach(b => b.classList.toggle('active', b.dataset.noticeVer === entry.version));
    },
    /** 打开更新公告：左侧版本列表 + 默认显示最新版；打开即视为已读 */
    openNotice() {
      const all = this._noticeAll();
      const n = all[all.length - 1] || {};
      if (n.title) $('#notice-title').textContent = n.title;
      const side = $('#notice-side');
      if (side) {
        side.innerHTML = all.slice().reverse().map(v =>
          '<button class="notice-ver-item' + (v.version === (window.APP_NOTICE || {}).version ? ' active' : '') + '" data-notice-ver="' + esc(v.version) + '">' +
          '<b>v' + esc(v.version) + '</b><span>' + esc(v.date || '') + '</span></button>').join('');
        side.querySelectorAll('[data-notice-ver]').forEach(b => b.addEventListener('click', () => {
          const e = all.find(x => x.version === b.dataset.noticeVer);
          if (e) this._noticeShow(e);
        }));
      }
      this._noticeShow(n);
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
    /** 设置弹窗二级页导航：'' → 一级列表（默认）；account/prefs/cache → 对应二级页
     *  带过渡动画：当前页高斯模糊淡出 → 目标页高斯模糊淡入，面板高度平滑拉长/缩短 */
    _showSetPage(name) {
      const pages = ['account', 'prefs', 'cache'];
      const main = $('#set-page-main');
      if (!main) return;
      const panel = $('.modal-panel', $('#settings'));
      const switchNow = () => {
        main.classList.toggle('hidden', pages.indexOf(name) !== -1);
        pages.forEach(p => {
          const pg = $('#set-page-' + p);
          if (pg) pg.classList.toggle('hidden', p !== name);
        });
        if (panel) panel.scrollTop = 0;
        if (name === 'account') this._renderSettingsAccount();
        if (name === 'cache') this._bindCacheSettings();
        if (!name) this._refreshSettingsMenuAccount();
      };
      // 若非切换（打开时首次 / 连续点击同一页）→ 直接切换
      const cur = main.classList.contains('hidden') ? null : main;
      const curPg = (pages.find(p => { const el = $('#set-page-' + p); return el && !el.classList.contains('hidden'); }) || '');
      if ((cur && name === '') || (!cur && curPg === name)) { switchNow(); return; }
      const outEl = cur || (curPg ? $('#set-page-' + curPg) : null);
      if (outEl) {
        outEl.style.transition = 'filter .24s ease, opacity .24s ease, transform .24s ease';
        outEl.style.filter = 'blur(10px)';
        outEl.style.opacity = '0';
        outEl.style.transform = 'translateY(-14px)';
      }
      setTimeout(() => {
        switchNow();
        const nextEl = main.classList.contains('hidden') ? $('#set-page-' + name) : main;
        if (nextEl) {
          nextEl.style.transition = 'none';
          nextEl.style.filter = 'blur(10px)';
          nextEl.style.opacity = '0';
          nextEl.style.transform = 'translateY(16px)';
          requestAnimationFrame(() => {
            nextEl.style.transition = 'filter .3s ease, opacity .3s ease, transform .3s ease';
            nextEl.style.filter = 'blur(0)';
            nextEl.style.opacity = '1';
            nextEl.style.transform = 'translateY(0)';
          });
        }
      }, outEl ? 220 : 0);
    },

    /* ============================================================
     * 登录 / 注册（仅 QQ 邮箱账号；设置+收藏云端同步）
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
      if (this._authMode === 'register') this._resetAltcha();
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
          this.null /* 旧滑块已废弃 */ = { id: cap.id, pos: Math.round(pos * 100) / 100, duration: dur };
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
    /** HiBetter 入口仅登录后可见 */
    _syncHibetterNav() {
      const item = document.querySelector('.nav-item[data-nav="hibetter"]');
      if (!item) return;
      const logged = !!(Store.Session && Store.Session.loggedIn);
      item.classList.toggle('hidden', !logged);
    },
    _syncAuthUI() {
      const logged = Store.Session.loggedIn;
      const btns = $('#side-auth-btns');
      const user = $('#side-user');
      const mail = $('#side-user-mail');
      if (btns) btns.classList.toggle('hidden', logged);
      if (user) user.classList.toggle('hidden', !logged);
      // 有昵称显示昵称，否则显示邮箱
      if (mail) mail.textContent = (Store.Session.name || Store.Session.email || '');
      // 登录/登出后：音质菜单锁定状态重渲染
      const qb = $('#set-quality');
      if (qb) { delete qb.dataset.bound; this._applySettingsToUI(); }
      // 登录/登出后：缓存上限滑杆立即按最新登录态重建（免刷新）
      ['#set-cache-on', '#set-cache-cap', '#set-clear-cache'].forEach(sel => {
        const el = $(sel);
        if (el) delete el.dataset.bound;
      });
      if ($('#set-cache-cap')) this._bindCacheSettings();
      this._renderSidebarAvatar();
      this._renderSettingsAccount();
    },

    /* ============================================================
     * 头像（侧栏 + 设置弹窗账号分区）
     * ============================================================ */
    /** 头像圆形内层内容：有头像 → <img>，无头像 → 默认灰色人形占位（图1） */
    _avatarInner(email, avatar) {
      if (avatar) return '<img src="' + esc(avatar) + '" alt="">';
      return '<svg viewBox="0 0 200 200" aria-hidden="true" style="width:100%;height:100%;display:block">' +
        '<circle cx="100" cy="100" r="100" fill="#e3e4e6"/>' +
        '<circle cx="100" cy="76" r="34" fill="#fff"/>' +
        '<path d="M100 122c-40 0-64 22-69 44a100 100 0 0 0 138 0c-5-22-29-44-69-44z" fill="#fff"/>' +
        '</svg>';
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
      const nick = Store.Session.name || '';
      const uid = Store.Session.uid || '';
      box.innerHTML =
        '<div class="set-account">' +
        '<div class="set-acc-top">' +
        '<span class="usr-avatar lg chg" id="set-acc-avatar" role="button" aria-label="更换头像">' +
        this._avatarInner(email, Store.Session.avatar || '') + '<i class="cam">' + CAM_ICON + '</i>' +
        '</span>' +
        '<div class="set-acc-info">' +
        '<div class="set-acc-mail">' + esc(email) + '</div>' +
        '<div class="set-acc-sub">点击头像更换 · 云端同步</div>' +
        '<div class="set-acc-uid">UID：' + esc(uid || '读取中…') + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="set-acc-nick">' +
        '<div class="set-label">昵称</div>' +
        '<input class="auth-input" id="set-nick" maxlength="20" placeholder="设置昵称" value="' + esc(nick) + '">' +
        '<div class="set-acc-nick-row">' +
        '<button type="button" class="btn primary" id="set-nick-btn">保存昵称</button>' +
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
        '<div class="set-acc-foot"><button type="button" class="btn" id="set-logout">退出登录</button>' +
        '<button type="button" class="btn danger" id="set-delete-account">注销账号</button></div>' +
        '<div class="set-acc-note">注销后将永久删除账号与全部云端数据（设置、收藏歌曲、收藏歌单、自建歌单），且不可恢复</div>' +
        '</div>';
      const av = $('#set-acc-avatar');
      if (av) av.addEventListener('click', () => this._changeAvatar());
      const nickBtn = $('#set-nick-btn');
      if (nickBtn) nickBtn.addEventListener('click', async () => {
        const inp = $('#set-nick');
        if (!inp) return;
        try {
          await Store.Session.setNickname(inp.value);
          toast('昵称已保存');
          this._renderSettingsAccount();
        } catch (e) {
          toast('保存失败：' + e.message, 'warn');
        }
      });
      const pwBtn = $('#set-pw-submit');
      const delBtn = $('#set-delete-account');
      if (delBtn) delBtn.addEventListener('click', async () => {
        const mail = Store.Session.email || '当前账号';
        if (!confirm('注销账号：' + mail + '\n\n将永久删除：账号、云端设置、收藏歌曲、收藏歌单、自建歌单。\n此操作不可恢复，确定继续吗？')) return;
        if (!confirm('最后确认：真的要注销 ' + mail + ' 吗？\n点击“确定”后立即删除全部数据。')) return;
        delBtn.disabled = true;
        delBtn.textContent = '正在注销…';
        try {
          await Store.Session.deleteAccount();
          toast('账号已注销，所有数据已清除');
          setTimeout(() => { location.hash = '#/discover'; location.reload(); }, 600);
        } catch (e) {
          toast('注销失败：' + e.message, 'warn');
          delBtn.disabled = false;
          delBtn.textContent = '注销账号';
        }
      });
      const loBtn = $('#set-logout');
      if (loBtn) loBtn.addEventListener('click', async () => {
        try {
          await Store.Session.logout();
          toast('已退出登录');
        } catch (e) {
          toast('退出失败：' + e.message, 'warn');
        }
      });
      /* 老缓存缺 uid：异步补拉资料后重绘（成功后显示唯一ID） */
      if (!Store.Session.uid) {
        Store.Session.refreshProfile().then(() => {
          if (Store.Session.uid) this._renderSettingsAccount();
        });
      }
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
      if (!/^[A-Za-z0-9._%+-]+@(qq\.com|foxmail\.com)$/i.test(email)) { showErr('仅支持 QQ 邮箱账号（@qq.com / @foxmail.com），其它邮箱无效'); return; }
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
          const altcha = this._altchaPayload();
          if (!altcha) { showErr('请先完成人机验证（点击验证框的复选框）'); return; }
          // 先校验 QQ 号（提示用户正在验证，避免干等）
          const qq = (email.split('@')[0] || '').replace(/\D/g, '');
          if (qq) {
            if (btn) btn.textContent = '正在验证 QQ 号 ' + qq + ' …';
            showErr('正在验证 QQ 号 ' + qq + '，请稍候…', true);
            let info = null;
            try { info = await Store.Session.checkQQ(qq); } catch (e) { info = null; }
            if (info && info.ok && info.nickname) {
              showErr('✓ QQ 号验证成功：' + info.nickname + '，正在注册…', true);
            } else {
              showErr('QQ 号校验未通过（' + ((info && info.msg) || '服务暂不可用') + '），仍可继续注册…', true);
            }
          }
          if (btn) btn.textContent = '注册中…';
          const j = await Store.Session.register(email, password, altcha);
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
      /* 音质选项（无损及以上 = 登录专属：未登录显示🔒，点击提示登录） */
      const box = $('#set-quality');
      if (box && !box.dataset.bound) {
        box.dataset.bound = '1';
        const LV_RANK = { standard: 0, higher: 1, exhigh: 2, lossless: 3, hires: 4, jyeffect: 5, sky: 6, dolby: 7, jymaster: 8 };
        const locked = !Store.Session.loggedIn;
        box.innerHTML = window.APP_CONFIG.QUALITY_LEVELS.map(q => {
          const isLock = locked && (LV_RANK[q.key] || 0) >= 3;
          return '<button class="q-item' + (isLock ? ' q-locked' : '') + '" data-q="' + q.key + '">' +
            '<span class="q-name">' + q.label + (isLock ? ' <em class="q-lock">🔒 登录</em>' : '') + '</span>' +
            '<span class="q-check">✓</span></button>';
        }).join('');
        box.querySelectorAll('.q-item').forEach(el => el.addEventListener('click', () => {
          const isLock = el.classList.contains('q-locked');
          if (isLock) {
            toast('无损及以上音质仅登录后可用', 'warn');
            this.openAuth('login');
            return;
          }
          Player.setQuality(el.dataset.q);
          toast('默认音质：' + Player.qualityLabel(el.dataset.q));
        }));
      }
      this._onQuality({ quality: Player.quality });
      this._renderThemeMenu();
      this.applyTheme(Store.Settings.theme);
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
        'set-karaoke': [
          { v: 'fade', l: '渐显' }, { v: 'scroll', l: '滚动' },
        ],
      };
      for (const id of Object.keys(LYR_OPTS)) {
        const b = $('#' + id);
        if (!b || b.dataset.bound) continue;
        b.dataset.bound = '1';
        // size→lyricSize / weight→lyricWeight / lh→lyricLineHeight
        const KEY_MAP = {
          'set-lyric-size': 'lyricSize',
          'set-lyric-weight': 'lyricWeight',
          'set-lyric-lh': 'lyricLineHeight',
          'set-karaoke': 'karaokeMode',
        };
        const key = KEY_MAP[id] || ('lyric' + id.replace('set-lyric-', '').replace(/^([a-z])/, (m, c) => c.toUpperCase()));
        const cur = Store.Settings[key];
        b.innerHTML = LYR_OPTS[id].map(o =>
          '<button class="q-item' + (cur === o.v ? ' active' : '') + '" data-v="' + o.v + '"><span class="q-name">' + o.l + '</span>' +
          '<span class="q-check">✓</span></button>').join('');
        b.querySelectorAll('.q-item').forEach(el => el.addEventListener('click', () => {
          const raw = el.dataset.v;
          Store.Settings.set({ [key]: (key === 'karaokeMode') ? raw : parseFloat(raw) });
          this._applyLyricStyle();
          b.querySelectorAll('.q-item').forEach(x => x.classList.toggle('active', x === el));
          toast('歌词样式已更新');
        }));
      }
      this._applyLyricStyle();
      this._bindCacheSettings();
    },
    /** 缓存容量显示：≥1GB 换算 GB（两位小数），否则 MB */
    _fmtCap(mb) {
      if (mb >= 1024) return (mb / 1024).toFixed(2) + 'GB';
      return mb + 'MB';
    },
    /** 音频缓存设置：开关 / 上限滑杆 / 用量显示 / 清空 */
    _bindCacheSettings() {
      const refreshUsed = () => {
        AudioCache.used().then((b) => {
          const el = $('#set-cache-used');
          if (el) {
            const mb = b / 1048576;
            const fmtUsed = (m) => (m >= 1024 ? (m / 1024).toFixed(2) + 'GB' : Math.round(m) + 'MB');
            el.textContent = '已用 ' + fmtUsed(mb) + ' / 上限 ' + this._fmtCap(Store.Settings.cacheCapMB);
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
        const isLogin = Store.Session.loggedIn;
        const MAX_MB = isLogin ? 51200 : 2048;      // 登录 50GB；未登录 2GB
        const cur = Math.min(MAX_MB, Math.max(100, Store.Settings.cacheCapMB || 500));
        // 位置↔容量：登录=非线性（前 50% 100MB~2GB / 后 50% 2GB~50GB）；未登录=线性 100MB~2GB
        const mbToPos = (mb) => {
          if (!isLogin) return (mb - 100) / (2048 - 100) * 100;
          if (mb <= 2048) return (mb - 100) / (2048 - 100) * 50;
          return 50 + (mb - 2048) / (MAX_MB - 2048) * 50;
        };
        const posToMb = (pos) => {
          if (!isLogin) return Math.round(100 + (2048 - 100) * pos / 100);
          if (pos <= 50) return Math.round(100 + (2048 - 100) * pos / 50);
          return Math.round(2048 + (MAX_MB - 2048) * (pos - 50) / 50);
        };
        capBox.innerHTML =
          '<div class="set-cap-box">' +
          '<div class="set-cap-val" id="set-cap-val">' + this._fmtCap(cur) + '</div>' +
          '<input type="range" id="set-cap-slider" min="0" max="100" step="0.5" value="' + mbToPos(cur) + '">' +
          '<div class="set-cap-skala">' +
          (isLogin ? '<span>100MB</span><span>2GB</span><span>50GB</span>'
            : '<span>100MB</span><span>2GB</span>') +
          '</div>' +
          (!isLogin ? '<div class="set-cap-tip">登录后可将缓存上限提高到 50GB</div>' : '') +
          '</div>';
        const slider = $('#set-cap-slider');
        const val = $('#set-cap-val');
        if (slider && val) {
          const fmt = () => {
            const mb = posToMb(+slider.value);
            val.textContent = this._fmtCap(mb);
            slider.dataset.mb = mb;
          };
          const paint = () => {
            const p = +slider.value;
            slider.style.background = 'linear-gradient(to right, #fa2d3c 0%, #fa2d3c ' + p +
              '%, rgba(var(--fg-rgb),.26) ' + p + '%, rgba(var(--fg-rgb),.26) 100%)';
          };
          slider.addEventListener('input', () => { fmt(); paint(); });
          slider.addEventListener('change', () => {
            const mb = posToMb(+slider.value);
            Store.Settings.set({ cacheCapMB: mb });
            AudioCache.evict().then(refreshUsed);
            toast('缓存上限已更新为 ' + this._fmtCap(mb));
          });
          paint(); // 初始填充
        }
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
      const mode = Store.Settings.karaokeMode || 'fade';
      ov.dataset.karaoke = mode;
      this._karaokeScroll = (mode === 'scroll');
      if (!this._karaokeScroll) {
        // 切回渐显：清掉扫光遮罩与波浪位移残留
        $$('.ly-w').forEach(w => {
          w.style.webkitMaskImage = ''; w.style.maskImage = '';
          w.style.transform = ''; w.style.opacity = ''; w.dataset.mk = '';
          w.classList.remove('w-cur');
        });
        $$('.ly-line').forEach(l2 => { l2.style.webkitMaskImage = ''; l2.style.maskImage = ''; });
        this._lyricWaveIdx = null;
      }
    },
    _syncVolume(v) {
      if (v === undefined) v = Store.Settings.muted ? 0 : Store.Settings.volume;
      v = Math.max(0, Math.min(100, v));
      $('#pb-volume').value = v;
      $('#ov-volume').value = v;
      const fill = (el, color) => {
        el.style.background = 'linear-gradient(to right, ' + color + ' 0%, ' + color + ' ' + v +
          '%, rgba(var(--fg-rgb),.26) ' + v + '%, rgba(var(--fg-rgb),.26) 100%)';
      };
      fill($('#pb-volume'), 'var(--accent)');
      fill($('#ov-volume'), 'var(--fg-strong)');
      const muted = Store.Settings.muted || v === 0;
      $('#pb-mute').classList.toggle('muted', muted);
      $('#ov-mute').classList.toggle('muted', muted);
    },
    _onSettings(d) {
      if ('volume' in d || 'muted' in d) this._syncVolume();
      if ('quality' in d) this._onQuality({ quality: Player.quality });
      if ('theme' in d) { this.applyTheme(Store.Settings.theme); this._renderThemeMenu(); }
    },

    /* ---------------- 主题色 ---------------- */
    THEMES: [
      { key: 'black-red', name: '黑红', bg: '#0b0b0e', ac: '#fa2d3c', dark: true },
      { key: 'black-blue', name: '黑蓝', bg: '#0b0b0e', ac: '#3b82f6', dark: true },
      { key: 'black-gold', name: '黑金', bg: '#0b0b0e', ac: '#e0b64a', dark: true },
      { key: 'black-purple', name: '黑紫', bg: '#0b0b0e', ac: '#a855f7', dark: true },
      { key: 'white-red', name: '白红', bg: '#f6f4f5', ac: '#e0343f', dark: false },
      { key: 'white-blue', name: '白蓝', bg: '#f3f5f9', ac: '#2563eb', dark: false },
      { key: 'white-gold', name: '白金', bg: '#f7f5f0', ac: '#b8860b', dark: false },
      { key: 'white-purple', name: '白紫', bg: '#f6f4fa', ac: '#7c3aed', dark: false },
    ],
    /** 应用主题（设置 data-theme + 浏览器栏配色） */
    applyTheme(t) {
      const key = (this.THEMES.some(x => x.key === t) ? t : 'black-red');
      document.documentElement.setAttribute('data-theme', key);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', key.indexOf('white-') === 0 ? '#f3f5f9' : '#0b0b0e');
    },
    setTheme(t) {
      const it = this.THEMES.find(x => x.key === t);
      if (!it) return;
      Store.Settings.set({ theme: t });
      this.applyTheme(t);
      this._renderThemeMenu();
      toast('主题已切换：' + it.name);
    },
    _renderThemeMenu() {
      const box = $('#set-theme');
      if (!box) return;
      const cur = Store.Settings.theme;
      if (!box.dataset.bound) {
        box.dataset.bound = '1';
        box.addEventListener('click', (e) => {
          const el = e.target.closest('.theme-card');
          if (el) this.setTheme(el.dataset.t);
        });
      }
      box.innerHTML = this.THEMES.map(t =>
        '<button type="button" class="theme-card' + (cur === t.key ? ' active' : '') + '" data-t="' + t.key + '">' +
        '<span class="theme-prev" style="background:' + t.bg + '">' +
        '<i class="tp-side" style="background:' + (t.dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.07)') + '"></i>' +
        '<i class="tp-line" style="background:' + (t.dark ? 'rgba(255,255,255,.42)' : 'rgba(0,0,0,.34)') + '"></i>' +
        '<i class="tp-line short" style="background:' + (t.dark ? 'rgba(255,255,255,.24)' : 'rgba(0,0,0,.18)') + '"></i>' +
        '<i class="tp-btn" style="background:' + t.ac + '"></i>' +
        '</span>' +
        '<span class="theme-name">' + t.name + '</span></button>').join('');
    },

    /* ---------------- 侧边栏收藏歌单 ---------------- */
    _renderSidePlaylists() {
      const box = $('#side-playlists');
      // 自建歌单（mp:true）实时取自建数据；已删除的剔除
      const pls = Store.FavPlaylists.all.map(p => {
        if (p.mp) {
          const mp = Store.MyPlaylists.get(p.id);
          if (!mp) return null;
          return { id: p.id, name: mp.name, cover: this._mpCoverSrc(mp), mp: true };
        }
        return p;
      }).filter(Boolean).slice(0, 15);
      if (!pls.length) {
        box.innerHTML = '<div class="side-empty">收藏的歌单会显示在这里</div>';
        return;
      }
      box.innerHTML = pls.map(p =>
        '<div class="side-pl" data-spl="' + p.id + '">' +
        '<img src="' + esc(coverUrl(p.cover)) + '" alt="" loading="lazy">' +
        '<span>' + esc(p.name) + (p.mp ? ' <em class="side-pl-mp">自建</em>' : '') + '</span></div>').join('');
      box.querySelectorAll('[data-spl]').forEach(el => el.addEventListener('click', () => {
        const sid = el.dataset.spl;
        if (sid && sid.indexOf('mp') === 0) this.nav('myplaylist/' + sid);
        else this.nav('playlist/' + sid);
      }));
    },

    /* 云端数据变化后的界面刷新（自动同步可见性）：
     *  - 收藏 / 自建歌单页：数据可能新增/删除条目 → 直接重绘当前页
     *  - 其它页面：仅刷新列表行内的红心与播放器收藏按钮状态 */
    _onCloudDataChanged() {
      const h = location.hash;
      if (/^#\/favorites/.test(h) || /^#\/myplaylist\//.test(h)) {
        this.render();
        return;
      }
      $$('#view .sr-fav').forEach((b) => {
        const i = +b.dataset.fav;
        const s = this._ctx && this._ctx.songs && this._ctx.songs[i];
        if (!s) return;
        const on = Store.FavSongs.has(s.id);
        b.classList.toggle('on', on);
        b.innerHTML = Icons.heartIcon(on);
      });
      const cur = Player.current && Player.current();
      if (cur && cur.id != null) {
        const on = Store.FavSongs.has(cur.id);
        const pb = $('#pb-fav');
        if (pb) { pb.classList.toggle('on', on); pb.innerHTML = Icons.heartIcon(on); }
        const ov = $('#ov-fav');
        if (ov) { ov.classList.toggle('on', on); ov.innerHTML = Icons.heartIcon(on); }
      }
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
          artist: artistList(s.artists).map(a => a.name).join(' / '),
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
