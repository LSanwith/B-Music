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

  /** 封面地址统一转 https（页面为 https 时） */
  function coverUrl(u) {
    if (!u) return '';
    if (location.protocol === 'https:' && u.startsWith('http://')) {
      return 'https://' + u.slice(7);
    }
    return u;
  }

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

  window.UI = { $, $$, fmtTime, fmtCount, fmtDuration, esc, coverUrl, toast, modeIcon, modeText, empty, skeleton };
})();
