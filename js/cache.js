/* ============================================================
 * 音频本地缓存（IndexedDB）
 *  播放过的歌曲整曲存入本机：重播免等待、源链接过期（vuutv 令牌）
 *  后仍可播放、弱网下更流畅。
 *  容量按设置上限（默认 300MB）自动淘汰最旧条目（LRU）。
 *  与设置联动：Store.Settings.cacheOn / cacheCapMB
 * ============================================================ */
(function () {
  'use strict';

  const DB_NAME = 'bmusic-cache';
  const STORE = 'audio';
  const VERSION = 1;

  let _dbp = null;
  let _urlMap = new Map(); // key -> objectURL

  const capBytes = () => {
    try {
      const mb = (Store && Store.Settings && Store.Settings.cacheCapMB) || 300;
      return mb * 1024 * 1024;
    } catch (e) { return 300 * 1024 * 1024; }
  };
  const enabled = () => {
    try { return !!(Store && Store.Settings && Store.Settings.cacheOn !== false); }
    catch (e) { return true; }
  };
  const cacheKey = (id, level) => String(id) + '@' + (level || '');

  function open() {
    if (!('indexedDB' in window)) return null;
    if (_dbp) return _dbp;
    _dbp = new Promise((resolve, reject) => {
      let rq;
      try { rq = indexedDB.open(DB_NAME, VERSION); } catch (e) { _dbp = null; reject(e); return; }
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: 'k' });
          s.createIndex('t', 't'); // 存入时间 → 淘汰最旧
        }
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => { _dbp = null; reject(rq.error || new Error('idb open fail')); };
    });
    return _dbp;
  }

  function tx(mode, fn) {
    return new Promise((resolve, reject) => {
      open().then((d) => {
        if (!d) { reject(new Error('indexedDB 不可用')); return; }
        const t = d.transaction(STORE, mode);
        const s = t.objectStore(STORE);
        let out;
        try { out = fn(s, t); } catch (e) { reject(e); return; }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
        t.onerror = () => reject(t.error || new Error('tx error'));
        t.onabort = () => reject(t.error || new Error('tx abort'));
      }).catch(reject);
    });
  }

  const AudioCache = {
    key: cacheKey,

    /** 当前是否启用（设置开关） */
    enabled: enabled,

    async has(k) {
      try { return !!(await tx('readonly', (s) => s.get(k))); } catch (e) { return false; }
    },

    async sizeOf(k) {
      try {
        const r = await tx('readonly', (s) => s.get(k));
        return r ? (r.size || 0) : 0;
      } catch (e) { return 0; }
    },

    /** 已用字节数 */
    async used() {
      try {
        const rows = await tx('readonly', (s) => s.getAll());
        return (rows || []).reduce((sum, r) => sum + (r.size || 0), 0);
      } catch (e) { return 0; }
    },

    /** 取已缓存 blob 的 objectURL（无缓存返回 null） */
    async url(k) {
      try {
        if (_urlMap.has(k)) return _urlMap.get(k);
        const r = await tx('readonly', (s) => s.get(k));
        if (!r || !r.b) return null;
        const u = URL.createObjectURL(r.b);
        _urlMap.set(k, u);
        return u;
      } catch (e) { return null; }
    },

    /** 存入整曲（超出单曲/上限直接拒绝或触发淘汰） */
    async put(k, blob) {
      if (!blob || !blob.size) return false;
      if (!enabled()) return false;
      if (blob.size > capBytes()) return false; // 单曲大于整个上限，不缓存
      try {
        const rec = { k, b: blob, t: Date.now(), size: blob.size };
        await tx('readwrite', (s) => s.put(rec));
        await this.evict();
        return true;
      } catch (e) { return false; }
    },

    /** 按上限淘汰最旧条目 */
    async evict() {
      if (!('indexedDB' in window)) return;
      try {
        const rows = (await tx('readonly', (s) => s.getAll())) || [];
        let total = rows.reduce((sum, r) => sum + (r.size || 0), 0);
        const limit = capBytes();
        if (total <= limit) return;
        rows.sort((a, b) => (a.t || 0) - (b.t || 0)); // 最旧在前
        for (const r of rows) {
          if (total <= limit) break;
          await tx('readwrite', (s) => s.delete(r.k));
          total -= r.size || 0;
          const u = _urlMap.get(r.k);
          if (u) { try { URL.revokeObjectURL(u); } catch (e) {} _urlMap.delete(r.k); }
        }
      } catch (e) { /* 淘汰失败不影响主流程 */ }
    },

    async remove(k) {
      try {
        await tx('readwrite', (s) => s.delete(k));
        const u = _urlMap.get(k);
        if (u) { try { URL.revokeObjectURL(u); } catch (e) {} _urlMap.delete(k); }
      } catch (e) {}
    },

    /** 清空全部缓存 */
    async clear() {
      try {
        await tx('readwrite', (s) => s.clear());
      } catch (e) {}
      for (const u of _urlMap.values()) { try { URL.revokeObjectURL(u); } catch (e) {} }
      _urlMap.clear();
    },
  };

  window.AudioCache = AudioCache;
})();
