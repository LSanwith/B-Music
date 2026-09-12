/* ============================================================
 * UI 工具：DOM 助手 / 时间格式化 / Toast / 图标 / 封面处理
 * ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 秒 -> mm:ss */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  /** 播放量 -> 万/亿 */
  function fmtCount(n) {
    if (n == null || isNaN(n)) return '';
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(n);
  }

  /** 毫秒 -> 时长 */
  function fmtDuration(ms) {
    if (!ms) return '';
    return fmtTime(ms / 1000);
  }

  /** 转义 HTML */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 封面占位图（透明底白色音符，内联 SVG） */
  const COVER_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
    '<rect width="80" height="80" fill="rgba(127,127,127,.16)"/>' +
    '<path fill="rgba(127,127,127,.55)" d="M52 16.5c-1.2.2-15.4 3.1-16 3.3-.6.2-1 .5-1 1v26.6c0 .2 0 .9-.3 1.5-.4.8-1.1 1.3-2.1 1.7-.4.1-1 .3-1.7.4-3.2.7-8.5 1.9-8.5 6.8 0 3.9 2.8 5.8 4.6 6.2.7.1 1.4.1 1.8.1 1.1 0 4.7-.4 6.7-1.7 1.4-.9 3.2-2.8 3.2-6.3V30.6c0-.5.4-.9.8-1l12.2-2.5c1-.2 1.7-1.1 1.7-2V17c0-.6-.5-1.2-1.4-1z"/>' +
    '</svg>'
  );

  /** 已知取不到的封面地址：图片加载失败后记下来，后续直接给占位图，不再反复请求 */
  const BAD_COVERS = new Set();

  /** 封面地址统一转 https（页面为 https 时）；坏图直接返回占位图 */
  function coverUrl(u) {
    if (!u) return '';
    const s = (location.protocol === 'https:' && u.startsWith('http://')) ? 'https://' + u.slice(7) : u;
    return BAD_COVERS.has(s) ? COVER_PLACEHOLDER : s;
  }

  /* 图片加载兜底（全局捕获，error 事件不冒泡所以要 capture）：
   *  1) 网易云 CDN 有多台（p1~p4），先换一台再试一次；
   *  2) 仍失败 → 换占位图，并记入 BAD_COVERS，避免同一张坏图被反复请求。
   *  典型场景：上游返回的封面本身在 CDN 上是坏图（返回 NotAnImage）。 */
  function altCoverHost(src) {
    const m = /^https?:\/\/p([1-4])\.music\.126\.net\/(.+)$/.exec(src);
    if (!m) return '';
    const cur = Number(m[1]);
    const next = cur >= 4 ? 1 : cur + 1;
    return 'https://p' + next + '.music.126.net/' + m[2];
  }
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.getAttribute) return;
    const src = el.getAttribute('src') || '';
    if (src.slice(0, 5) === 'data:') return; // 占位图自己也失败就不再处理
    if (src && el.dataset.coverRetried !== '1') {
      const alt = altCoverHost(src);
      if (alt) {
        el.dataset.coverRetried = '1';
        el.src = alt;
        return;
      }
    }
    if (el.dataset.coverDead === '1') return;
    el.dataset.coverDead = '1';
    if (src) BAD_COVERS.add(src);
    el.src = COVER_PLACEHOLDER;
  }, true);

  /** Toast 提示 */
  let toastTimer = null;
  function toast(msg, type) {
    const box = $('#toast');
    box.innerHTML = '<div class="toast ' + (type || '') + '">' + esc(msg) + '</div>';
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
  }

  /** 播放模式图标/文案（使用图标库自身 viewBox，避免 1024 坐标被 24 视口裁剪） */
  function modeIcon(mode) {
    const n = mode === 'loop' ? 'modeLoop' : mode === 'shuffle' ? 'modeShuffle' : 'modeList';
    const it = window.Icons && window.Icons.paths[n];
    if (!it) return '';
    return '<svg viewBox="' + it.vb + '"><path d="' + it.d + '"/></svg>';
  }
  function modeText(mode) {
    return mode === 'loop' ? '单曲循环' : mode === 'shuffle' ? '随机播放' : '列表循环';
  }

  /** 空状态 */
  function empty(text, sub) {
    return '<div class="empty"><div class="empty-icon">♪</div><div class="empty-text">' + esc(text) +
      (sub ? '</div><div class="empty-sub">' + esc(sub) : '') + '</div></div>';
  }

  /** 骨架屏 */
  function skeleton(lines) {
    let h = '';
    for (let i = 0; i < (lines || 6); i++) {
      h += '<div class="sk-row"><span class="sk sk-c"></span><span class="sk sk-t"></span><span class="sk sk-a"></span><span class="sk sk-d"></span></div>';
    }
    return h;
  }

  window.UI = { $, $$, fmtTime, fmtCount, fmtDuration, esc, coverUrl, toast, modeIcon, modeText, empty, skeleton, COVER_PLACEHOLDER, BAD_COVERS };
})();
