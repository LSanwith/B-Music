/* ============================================================
 * LRC 歌词解析器
 * 支持：时间标签 [mm:ss.xx]、元信息标签 [ti:][ar:][al:][by:][offset:]、
 *       双语歌词合并（tlyric 译文）
 * ============================================================ */
(function () {
  'use strict';

  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const TAG_RE = /\[(ti|ar|al|by|offset|re|ve):(.*)\]/i;

  /**
   * 解析单段 LRC 文本
   * @param {string} text
   * @returns {{lines:Array<{t:number,l:string}>, meta:Object}}
   */
  function parseLrc(text) {
    const lines = [];
    const meta = {};
    if (!text) return { lines, meta };
    const raw = String(text).replace(/\r/g, '').split('\n');
    for (const row of raw) {
      if (!row.trim()) continue;
      const tag = row.match(TAG_RE);
      if (tag) {
        meta[tag[1].toLowerCase()] = tag[2].trim();
        continue;
      }
      const times = [];
      let m;
      TIME_RE.lastIndex = 0;
      while ((m = TIME_RE.exec(row)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        let frac = m[3] ? parseFloat('0.' + m[3]) : 0;
        if (m[3] && m[3].length > 2) frac = parseInt(m[3], 10) / 1000;
        times.push(min * 60 + sec + frac);
      }
      if (!times.length) continue;
      const content = row.replace(TIME_RE, '').trim();
      if (!content) continue;
      for (const t of times) lines.push({ t, l: content });
    }
    lines.sort((a, b) => a.t - b.t);
    // offset 处理（毫秒，正数表示整体提前）
    const offset = parseFloat(meta.offset);
    if (!isNaN(offset) && offset) {
      const shift = offset / 1000;
      for (const ln of lines) ln.t = Math.max(0, ln.t - shift);
      lines.sort((a, b) => a.t - b.t);
    }
    return { lines, meta };
  }

  /**
   * 合并原文 + 译文
   * @param {string} baseText
   * @param {string} transText
   * @returns {Array<{t:number,l:string,tl:string}>}
   */
  function mergeLyrics(baseText, transText) {
    const base = parseLrc(baseText);
    const trans = parseLrc(transText || '');
    const out = [];
    for (const b of base.lines) {
      out.push({ t: b.t, l: b.l, tl: '' });
    }
    if (trans.lines.length) {
      // 译文按时间就近匹配
      for (const tr of trans.lines) {
        let best = null;
        let bestDiff = Infinity;
        for (const o of out) {
          const d = Math.abs(o.t - tr.t);
          if (d < bestDiff) { bestDiff = d; best = o; }
          if (d > 1.2 && o.t > tr.t) break;
        }
        if (best && bestDiff <= 1.5 && !best.tl) best.tl = tr.l;
        else if (best && bestDiff <= 1.5 && best.tl) {
          // 同一时间已有译文，追加为独立行
          out.push({ t: tr.t + 0.001, l: '', tl: tr.l });
        } else if (bestDiff <= 1.5) {
          out.push({ t: tr.t, l: '', tl: tr.l });
        }
      }
      out.sort((a, b) => a.t - b.t);
    }
    return out;
  }

  /** 当前时间对应的歌词行索引 */
  function findIndex(lines, time) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= time) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /**
   * 解析 YRC 逐字歌词（网易云 /lyric/new 的 yrc.lyric 字段）
   * 行格式：[行开始ms,行总时长ms](字开始ms,字时长ms,0)字(下一字开始ms,...)字...
   * 返回: [{ t: 行开始秒, d: 行时长秒, words: [{ t: 字开始秒, d: 字时长秒, w: 文字 }] }]
   */
  function parseYrc(text) {
    const lines = [];
    if (!text) return lines;
    for (const row of String(text).replace(/\r/g, '').split('\n')) {
      const m = row.match(/^\[(\d+),(\d+)\]([\s\S]*)$/);
      if (!m) continue; // 跳过 JSON 元数据等行
      const t0 = parseInt(m[1], 10) / 1000;
      const d0 = parseInt(m[2], 10) / 1000;
      const content = m[3];
      const words = [];
      const re = /\((\d+),(\d+)(?:,\d*)?\)([^\(]*)/g;
      let wm;
      while ((wm = re.exec(content)) !== null) {
        const w = wm[3];
        if (w) words.push({ t: parseInt(wm[1], 10) / 1000, d: parseInt(wm[2], 10) / 1000, w: w });
      }
      if (!words.length) {
        const txt = content.trim();
        if (txt) words.push({ t: t0, d: d0, w: txt });
      } else {
        // 词间残留文本（未带时间的标点等）并入前一词
        const rest = content.replace(/\(\d+,\d+(?:,\d*)?\)[^\(]*/g, '').trim();
        if (rest && words.length) words[words.length - 1].w += rest;
        // 兼容相对时间：首个字时间早于行开始时间时，按偏移处理
        if (words[0].t < t0 - 0.05) {
          for (const w of words) w.t += t0;
        }
      }
      if (words.length) lines.push({ t: t0, d: d0, words: words });
    }
    lines.sort((a, b) => a.t - b.t);
    return lines;
  }

  /** 当前时间在词序列中的索引 */
  function findWordIndex(words, time) {
    let lo = 0, hi = words.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].t <= time) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  window.Lrc = { parseLrc, mergeLyrics, findIndex, parseYrc, findWordIndex };
})();
