/* ============================================================
 * 一起听（Listen Together）客户端
 *
 * 协议（轮询式，见 api/room.js）：
 *   - 房主是播放权威：每 2 秒 poll 时上报 { songId, position, playing }
 *   - 跟随者同一个 poll 拿房间状态，把播放进度对齐到
 *       position + (playing ? (now - at) / 1000 : 0)
 *   - 聊天、成员在线状态随 poll 一起返回（增量：since=seq）
 *
 * 约束：
 *   - 未登录不可用（入口处拦截，Store.Session.loggedIn 为假直接提示登录）
 *   - 房主退出 = 解散房间；跟随者退出只把自己移出
 *   - 网络异常自动重试；连续失败 3 次提示并停止跟随
 * ============================================================ */
window.ListenTogether = (function () {
  'use strict';

  const POLL_MS = 2000;          // 轮询间隔
  const SEEK_TOLERANCE = 2.5;    // 播放位置偏差超过这个秒数才纠偏（避免频繁抖动）
  const STALE_MS = 15000;        // 房主状态超过这个时间没更新视为暂停同步
  const MAX_CHAT = 200;          // 本地最多保留的聊天条数

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const api = (path, opts) => Store.Session._api(path, opts);

  const S = {
    room: null,          // 房间公开信息
    chat: [],            // 已收到的聊天（含自己发的）
    seq: 0,              // 已收到的最新消息序号
    timer: null,
    busy: false,
    tab: 'room',        // 'room' | 'invite' | 'chat'
    seeking: false,     // 正在拖动进度条（期间不被轮询覆盖）
    fails: 0,
    isHost: false,
    lastSyncAt: 0,
    _joining: false,
    _loose: false,       // 房主长时间没上报状态
  };

  /* ---------------- 基础判定 ---------------- */
  function loggedIn() {
    return !!(window.Store && Store.Session && Store.Session.loggedIn);
  }
  function uid() {
    return window.Store && Store.Session ? String(Store.Session.uid || '') : '';
  }
  function inRoom() {
    return !!(S.room && S.room.code);
  }
  function isHost() {
    if (!inRoom()) return false;
    // 服务端在 create/join/poll 里直接告诉过我们是不是房主（最可靠，不依赖本地会话字段）
    if (S.isHost) return true;
    const hu = String((S.room.host && S.room.host.uid) || '');
    return !!hu && hu === uid();
  }

  /* ---------------- 播放快照 / 跟随 ---------------- */
  function hostState() {
    const P = window.Player;
    if (!P || !P.current || !P.audio) return null;
    const cur = P.current();
    if (!cur) return null;
    const snap = (P.snapshot ? P.snapshot(cur) : null) || cur; // 规范成字符串字段（artists/album 可能是对象）
    const dur = snap.duration || P.audio.duration || 0;
    return {
      songId: String(cur.id || ''),
      name: snap.name || '',
      artists: snap.artists || '',
      cover: snap.cover || '',
      duration: dur,
      position: Number(P.audio.currentTime) || 0,
      playing: !P.audio.paused,
    };
  }

  /** 跟随者把本机播放对齐到房主（返回动作描述，便于调试/提示） */
  function followState(state) {
    const P = window.Player;
    if (!P || !P.audio || !state || !state.songId) return 'no-state';
    const target = Math.max(0, (state.position || 0) + (state.playing ? (Date.now() - (state.at || Date.now())) / 1000 : 0));
    const cur = P.current();
    const sameSong = cur && String(cur.id) === String(state.songId);
    S.lastSyncAt = Date.now();
    if (!sameSong) {
      // 换歌：用房间里的展示信息构造最小 song（播放直链由 Player 自己解析）
      P.playQueue([{
        id: state.songId,
        name: state.name || '一起听',
        artists: state.artists || '',
        album: '',
        cover: state.cover || '',
        duration: state.duration || 0,
      }], 0);
      // 等首帧可播放后再纠偏（不等也能播，但位置会从 0 开始）
      const t0 = Date.now();
      const timer = setInterval(() => {
        const a = P.audio;
        const ready = a && a.readyState >= 1;
        if (ready || Date.now() - t0 > 6000) {
          clearInterval(timer);
          try { P.seek(target); } catch (e) {}
          if (state.playing && a && a.paused) { try { P.toggle(); } catch (e) {} }
          if (!state.playing && a && !a.paused) { try { P.toggle(); } catch (e) {} }
        }
      }, 300);
      return 'switch-song';
    }
    const a = P.audio;
    let acted = 'keep';
    if (Math.abs((a.currentTime || 0) - target) > SEEK_TOLERANCE) {
      try { P.seek(target); acted = 'seek'; } catch (e) {}
    }
    if (state.playing && a.paused) { try { P.toggle(); acted = acted === 'keep' ? 'play' : acted + '+play'; } catch (e) {} }
    if (!state.playing && !a.paused) { try { P.toggle(); acted = acted === 'keep' ? 'pause' : acted + '+pause'; } catch (e) {} }
    return acted;
  }

  /* ---------------- 轮询 ---------------- */
  async function poll() {
    if (!inRoom() || S.busy) return;
    if (!loggedIn()) { stop('登录已失效，已退出一听'); return; }
    S.busy = true;
    try {
      const body = { code: S.room.code, since: S.seq };
      if (isHost()) {
        const st = hostState();
        if (st) body.state = st;
      }
      const j = await api('/room?a=poll', { method: 'POST', body: JSON.stringify(body) });
      S.fails = 0;
      S.room = j.room || S.room;
      S.isHost = !!j.isHost;
      if (Array.isArray(j.chat) && j.chat.length) {
        j.chat.forEach((m) => {
          S.chat.push(m);
          S.seq = Math.max(S.seq, m.seq || 0);
        });
        if (S.chat.length > MAX_CHAT) S.chat = S.chat.slice(-MAX_CHAT);
        renderChat();
      }
      renderRoom();
      // 房间内所有人（含房主）都对齐房间状态：成员拖动进度后大家都会跟上
      if (S.room.state) {
        S._loose = Date.now() - (S.room.state.at || 0) > STALE_MS;
        if (!S._loose && !S.seeking) followState(S.room.state);
      }
    } catch (e) {
      S.fails++;
      const msg = (e && e.message) || '';
      if (e && e.status === 409) { stop(msg || '你已不在房间中'); return; }
      if (e && e.status === 404) { stop(msg || '房间不存在或已结束'); return; }
      if (S.fails >= 3) { stop('网络不稳定，已暂停一起听'); return; }
    } finally {
      S.busy = false;
    }
  }

  function startTimer() {
    if (S.timer) return;
    S.timer = setInterval(poll, POLL_MS);
  }
  function stopTimer() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
  }

  /* ---------------- 对外动作 ---------------- */
  async function create() {
    if (!loggedIn()) return gate();
    if (S._joining) return;
    S._joining = true;
    try {
      const j = await api('/room?a=create', {
        method: 'POST',
        body: JSON.stringify({ mine: inRoom() ? S.room.code : '' }),
      });
      S.room = j.room;
      S.isHost = true;
      S.chat = [];
      S.seq = 0;
      S.fails = 0;
      renderAll();
      openModal();
      startTimer();
      poll();
      return j.room;
    } catch (e) {
      toast((e && e.message) || '创建房间失败', 'error');
    } finally {
      S._joining = false;
    }
  }

  async function join(code) {
    if (!loggedIn()) return gate(code);
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) { toast('口令应为 6 位字母或数字', 'warn'); return; }
    if (S._joining) return;
    S._joining = true;
    try {
      const j = await api('/room?a=join', { method: 'POST', body: JSON.stringify({ code: c }) });
      S.room = j.room;
      S.isHost = !!j.isHost;
      S.chat = Array.isArray(j.chat) ? j.chat.slice(-MAX_CHAT) : [];
      S.seq = S.chat.reduce((m, x) => Math.max(m, x.seq || 0), 0);
      S.fails = 0;
      renderAll();
      openModal();
      startTimer();
      poll();
      toast(isHost() ? '已回到你的一起听房间' : '已加入一起听');
      return j.room;
    } catch (e) {
      toast((e && e.message) || '加入失败', 'error');
    } finally {
      S._joining = false;
    }
  }

  async function leave(silent) {
    const wasHost = isHost();
    const code = inRoom() ? S.room.code : '';
    stopTimer();
    S.room = null; S.chat = []; S.seq = 0; S.isHost = false; S._loose = false;
    renderAll();
    closeModal();
    if (!code) return;
    try {
      await api('/room?a=' + (wasHost ? 'close' : 'leave'), { method: 'POST', body: JSON.stringify({ code }) });
      if (!silent) toast(wasHost ? '已结束一起听' : '已退出一听');
    } catch (e) { /* 忽略：房间会自然过期 */ }
  }

  function stop(reason) {
    stopTimer();
    S.room = null; S.chat = []; S.seq = 0; S.isHost = false;
    renderAll();
    closeModal();
    if (reason) toast(reason, 'warn');
  }

  /** 任何人拖动进度条：上报给房间，所有人（含房主）都会对齐 */
  async function seekTo(sec) {
    if (!inRoom()) return;
    const t = Math.max(0, Number(sec) || 0);
    try { Player.seek(t); } catch (e) {}
    S.room.state = Object.assign({}, S.room.state || {}, { position: t, at: Date.now() });
    try {
      await api('/room?a=poll', { method: 'POST', body: JSON.stringify({ code: S.room.code, seek: t, since: S.seq }) });
      toast('已同步进度给房间所有人');
    } catch (e) { toast((e && e.message) || '同步进度失败', 'error'); }
  }

  /** 播放页进度条开始拖动：暂停跟随，避免和拖动打架 */
  function dragStart() {
    S.seeking = true;
  }

  /** 播放页进度条松手：把进度同步给房间所有人（房主与成员都可以） */
  function syncSeek(sec) {
    S.seeking = false;
    if (!inRoom()) return;
    return seekTo(sec);
  }

  async function send() {
    const input = $('#lt-text');
    if (!input || !inRoom()) return;
    const text = String(input.value || '').trim();
    if (!text) return;
    if (text.length > 300) { toast('消息最多 300 字', 'warn'); return; }
    input.value = '';
    try {
      const j = await api('/room?a=chat', { method: 'POST', body: JSON.stringify({ code: S.room.code, text }) });
      if (j && j.msg) {
        S.chat.push(j.msg);
        S.seq = Math.max(S.seq, j.msg.seq || 0);
        renderChat();
      }
    } catch (e) {
      input.value = text; // 失败回填，便于重发
      toast((e && e.message) || '发送失败', 'error');
    }
  }

  function inviteLink() {
    if (!inRoom()) return '';
    const base = location.href.split('#')[0];
    return base + '#/listen/' + S.room.code;
  }

  function copy(text, okMsg) {
    const done = () => toast(okMsg || '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallback());
    } else fallback();
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        toast(ok ? (okMsg || '已复制') : '复制失败，请手动选择复制', ok ? 'success' : 'warn');
      } catch (e) { toast('复制失败，请手动选择复制', 'warn'); }
    }
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal() {
    const m = $('#listen');
    if (!m) return;
    if (window.App && App._openModal) App._openModal('#listen');
    else m.classList.remove('hidden');
  }
  function closeModal() {
    const m = $('#listen');
    if (!m) return;
    if (window.App && App._closeModal) App._closeModal('#listen');
    else m.classList.add('hidden');
  }

  function gate(code) {
    if (code) sessionStorage.setItem('bmusic:lt-pending', String(code).toUpperCase());
    toast('一起听需要登录后使用', 'warn');
    if (window.App && App.openAuth) App.openAuth('login');
    return null;
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    renderRoom();
    renderChat();
    renderBadge();
    notify();
  }

  /** 通知外部（app.js）刷新播放页顶栏：房主显示 ✕、成员显示「退出一起听房间」 */
  function notify() {
    try { document.dispatchEvent(new CustomEvent('ym:listen')); } catch (e) {}
  }

  /** 播放页顶栏的一起听角标：在房间里显示人数 */
  function renderBadge() {
    const b = $('#ov-listen-badge');
    if (!b) return;
    const on = inRoom();
    b.classList.toggle('hidden', !on);
    if (on) b.textContent = String((S.room.members || []).length || 1);
    notify();
  }

  function renderRoom() {
    const invite = $('#lt-invite');
    const idle = $('#lt-idle');
    const status = $('#lt-status');
    const members = $('#lt-members');
    if (!invite) return;
    const on = inRoom();
    if (idle) idle.classList.toggle('hidden', on);
    const room = $('#lt-room');
    if (room) room.classList.toggle('hidden', !on);
    const panelEl2 = document.querySelector('#listen .lt-panel');
    if (panelEl2) panelEl2.classList.toggle('in-room', on); // 房间内固定尺寸，未进房间用内容高度
    if (!on) return;
    // 邀请页签：房主与成员都能看到口令（成员也可以再拉人进来）
    if (invite) invite.classList.remove('hidden');
    const tipEl = $('#lt-invite-tip');
    if (tipEl) tipEl.textContent = isHost()
      ? '把口令或链接发给好友，他打开后就会跟上你的进度（最多 4 人）'
      : '把口令发给好友，他也能加入这个房间（最多 4 人）';
    const TABS = ['room', 'invite', 'chat'];
    if (TABS.indexOf(S.tab) < 0) S.tab = 'room';
    const tabs = $$('#lt-tabs .lt-tab');
    tabs.forEach((el) => el.classList.toggle('active', el.dataset.ltTab === S.tab));
    ['room', 'invite', 'chat'].forEach((k) => {
      const el = $('#lt-pane-' + k);
      if (el) el.classList.toggle('hidden', S.tab !== k);
    });
    const panelEl = document.querySelector('#listen .lt-panel');
    if (panelEl) panelEl.classList.add('in-room'); // 房间内固定面板尺寸

    const codeEl = $('#lt-code');
    if (codeEl) codeEl.textContent = S.room.code;
    const linkEl = $('#lt-link');
    if (linkEl) linkEl.textContent = inviteLink();

    const st = S.room.state;
    const songEl = $('#lt-song');
    const metaEl = $('#lt-meta');
    if (songEl) {
      if (!st) songEl.textContent = isHost() ? '播放任意歌曲，好友会自动跟上' : '等待房主开始播放…';
      else songEl.textContent = (st.name || '未知歌曲') + (st.artists ? ' - ' + st.artists : '');
    }
    if (metaEl) {
      const role = isHost() ? '你是房主（播放由你控制）' : '跟随中：' + ((S.room.host && S.room.host.name) || '房主');
      const extra = S._loose && !isHost() ? ' · 房主暂时没在播放' : '';
      metaEl.textContent = role + extra +
        (st && st.playing ? ' · 播放中' : st ? ' · 已暂停' : '');
    }
    // 成员数 + 人数上限
    const countEl = $('#lt-count');
    if (countEl) countEl.textContent = ((S.room.members || []).length) + '/' + (S.roomMax || 4) + ' 人';
    if (members) {
      const list = S.room.members || [];
      members.innerHTML = list.map((m) => {
        const isMe = String(m.uid) === uid();
        return '<span class="lt-member' + (m.role === 'host' ? ' host' : '') + '">' +
          avatarHtml(m, 'lt-m-av') +
          '<span class="lt-m-name">' + (m.role === 'host' ? '房主 · ' : '') + esc(m.name) + (isMe ? '（我）' : '') + '</span>' +
          '</span>';
      }).join('');
    }
    const endBtn = $('#lt-leave');
    if (endBtn) endBtn.textContent = isHost() ? '结束一起听' : '退出房间';
  }

  function renderChat() {
    const box = $('#lt-chat');
    if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = S.chat.length
      ? S.chat.map((m) => {
        const mine = String(m.uid) === uid();
        const t = new Date(m.at || Date.now());
        const hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
        const av = mine ? { avatar: (window.Store && Store.Session ? Store.Session.avatar : '') || '', name: '我' } : m;
        return '<div class="lt-msg' + (mine ? ' mine' : ' other') + '">' +
          avatarHtml(av, 'lt-av') +
          '<div class="lt-msg-body">' +
          '<div class="lt-msg-head"><span class="lt-msg-name">' + esc(mine ? '我' : (m.name || '好友')) + '</span>' +
          '<span class="lt-msg-time">' + hh + '</span></div>' +
          '<div class="lt-msg-text">' + esc(m.text) + '</div></div></div>';
      }).join('')
      : '<div class="lt-chat-empty">还没有消息，说点什么吧</div>';
    if (near) box.scrollTop = box.scrollHeight;
  }

  /** 头像：有图用图，无图用名字首字（与站内一致） */
  function avatarHtml(u, cls) {
    const url = (u && u.avatar) || '';
    const name = (u && u.name) || '?';
    const ch = esc(String(name).trim().slice(0, 1) || '?');
    const style = url ? ' style="background-image:url(' + esc(url) + ')"' : '';
    return '<i class="' + (cls || 'lt-av') + (url ? ' has-img' : '') + '"' + style + '>' + (url ? '' : ch) + '</i>';
  }

  function toast(msg, type) {
    try { UI.toast(msg, type || 'info'); } catch (e) {}
  }

  /* ---------------- 绑定 ---------------- */
  function bindOnce() {
    if (S._bound) return;
    S._bound = true;
    const m = $('#listen');
    if (m) {
      m.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => {
        // 只是收起面板，不退出房间（房间状态由轮询维持）
        closeModal();
      }));
    }
    const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
    on('#lt-create', () => create());
    on('#lt-join', () => {
      const v = $('#lt-code-input') ? $('#lt-code-input').value : '';
      join(v);
    });
    const codeInput = $('#lt-code-input');
    if (codeInput) {
      codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(codeInput.value); });
      codeInput.addEventListener('input', () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      });
    }
    // 两个切换页：邀请 / 聊天
    $$('#lt-tabs .lt-tab').forEach((el) => el.addEventListener('click', () => {
      const k = el.dataset.ltTab;
      S.tab = (k === 'chat' || k === 'invite') ? k : 'room';
      renderRoom();
      if (S.tab === 'chat') { const c = $('#lt-chat'); if (c) c.scrollTop = c.scrollHeight; }
    }));
    on('#lt-copy-code', () => copy(inRoom() ? S.room.code : '', '口令已复制'));
    on('#lt-copy-link', () => copy(inviteLink(), '邀请链接已复制'));
    on('#lt-send', () => send());
    on('#lt-leave', () => leave());
    const text = $('#lt-text');
    if (text) text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    // 页面隐藏时降频（回到前台立刻同步一次）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopTimer();
      else if (inRoom()) { startTimer(); poll(); }
    });
    // 关掉页面时尽量通知服务端（房主离开即解散）
    window.addEventListener('beforeunload', () => {
      if (!inRoom()) return;
      try {
        const base = location.protocol === 'file:' ? (window.APP_LOCAL_SERVER || '') : '';
        fetch(base + '/api/room?a=' + (isHost() ? 'close' : 'leave'), {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (Store.Session.token || '') },
          body: JSON.stringify({ code: S.room.code }),
        });
      } catch (e) {}
    });
  }

  /** 顶栏/侧栏入口：打开面板（已在房间则直接显示） */
  function open() {
    if (!loggedIn()) return gate();
    bindOnce();
    if (inRoom()) { renderAll(); openModal(); startTimer(); return; }
    renderAll();
    openModal();
  }

  return {
    open, create, join, leave, send, poll, bindOnce, renderBadge, seekTo, syncSeek, dragStart,
    isHost, inRoom, inviteLink,
    get room() { return S.room; },
    get chat() { return S.chat; },
    POLL_MS, SEEK_TOLERANCE,
    _state: S,
  };
})();
