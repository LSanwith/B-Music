/* ============================================================
 * 下载元信息写入（ID3 / Vorbis Comment）
 *  - MP3  ：内嵌 browser-id3-writer 写 ID3v2.3 标签（标题/歌手/专辑/歌词/封面）
 *  - FLAC ：解析并重建 metadata blocks（保留 STREAMINFO，
 *           重建 Vorbis Comment + Picture 封面块）
 *  - 其余格式（m4a 等）原样返回
 * 实现参考：CoCo 音乐元数据编辑器扩展（m.ccw.site，by corainly）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 内嵌 browser-id3-writer（MIT） ---------- */
  (function (e, t) { "object" == typeof exports && "undefined" != typeof module ? module.exports = t() : "function" == typeof define && define.amd ? define(t) : (e = e || self).ID3Writer = t() })(this, function () {
    "use strict"; function a(e) { return String(e).split("").map(function (e) { return e.charCodeAt(0) }) } function o(e) { return new Uint8Array(a(e)) } function u(e) { var t = new Uint8Array(2 * e.length); return new Uint16Array(t.buffer).set(a(e)), t } return function () { var e = t.prototype; function t(e) { if (!(e && "object" == typeof e && "byteLength" in e)) throw new Error("First argument should be an instance of ArrayBuffer or Buffer"); this.arrayBuffer = e, this.padding = 4096, this.frames = [], this.url = "" } return e._setIntegerFrame = function (e, t) { var a = parseInt(t, 10); this.frames.push({ name: e, value: a, size: 11 + a.toString().length }) }, e._setStringFrame = function (e, t) { var a = t.toString(); this.frames.push({ name: e, value: a, size: 13 + 2 * a.length }) }, e._setPictureFrame = function (e, t, a, r) { var n, s, i, c = function (e) { if (!e || !e.length) return null; if (255 === e[0] && 216 === e[1] && 255 === e[2]) return "image/jpeg"; if (137 === e[0] && 80 === e[1] && 78 === e[2] && 71 === e[3]) return "image/png"; if (71 === e[0] && 73 === e[1] && 70 === e[2]) return "image/gif"; if (87 === e[8] && 69 === e[9] && 66 === e[10] && 80 === e[11]) return "image/webp"; var t = 73 === e[0] && 73 === e[1] && 42 === e[2] && 0 === e[3], a = 77 === e[0] && 77 === e[1] && 0 === e[2] && 42 === e[3]; return t || a ? "image/tiff" : 66 === e[0] && 77 === e[1] ? "image/bmp" : 0 === e[0] && 0 === e[1] && 1 === e[2] && 0 === e[3] ? "image/x-icon" : null }(new Uint8Array(t)), o = a.toString(); if (!c) throw new Error("Unknown picture MIME type"); a || (r = !1), this.frames.push({ name: "APIC", value: t, pictureType: e, mimeType: c, useUnicodeEncoding: r, description: o, size: (n = t.byteLength, s = c.length, i = o.length, 11 + s + 1 + 1 + (r ? 2 + 2 * (i + 1) : i + 1) + n) }) }, e._setLyricsFrame = function (e, t, a) { var r, n, s = e.split("").map(function (e) { return e.charCodeAt(0) }), i = t.toString(), c = a.toString(); this.frames.push({ name: "USLT", value: c, language: s, description: i, size: (r = i.length, n = c.length, 16 + 2 * r + 2 + 2 + 2 * n) }) }, e._setCommentFrame = function (e, t, a) { var r, n, s = e.split("").map(function (e) { return e.charCodeAt(0) }), i = t.toString(), c = a.toString(); this.frames.push({ name: "COMM", value: c, language: s, description: i, size: (r = i.length, n = c.length, 16 + 2 * r + 2 + 2 + 2 * n) }) }, e._setPrivateFrame = function (e, t) { var a, r, n = e.toString(); this.frames.push({ name: "PRIV", value: t, id: n, size: (a = n.length, r = t.byteLength, 10 + a + 1 + r) }) }, e._setUserStringFrame = function (e, t) { var a, r, n = e.toString(), s = t.toString(); this.frames.push({ name: "TXXX", description: n, value: s, size: (a = n.length, r = s.length, 13 + 2 * a + 2 + 2 + 2 * r) }) }, e._setUrlLinkFrame = function (e, t) { var a = t.toString(); this.frames.push({ name: e, value: a, size: 10 + a.length }) }, e.setFrame = function (e, t) { switch (e) { case "TPE1": case "TCOM": case "TCON": if (!Array.isArray(t)) throw new Error(e + " frame value should be an array of strings"); var a = "TCON" === e ? ";" : "/", r = t.join(a); this._setStringFrame(e, r); break; case "TLAN": case "TIT1": case "TIT2": case "TIT3": case "TALB": case "TPE2": case "TPE3": case "TPE4": case "TRCK": case "TPOS": case "TKEY": case "TMED": case "TPUB": case "TCOP": case "TEXT": case "TSRC": this._setStringFrame(e, t); break; case "TBPM": case "TLEN": case "TDAT": case "TYER": this._setIntegerFrame(e, t); break; case "USLT": if (t.language = t.language || "eng", !("object" == typeof t && "description" in t && "lyrics" in t)) throw new Error("USLT frame value should be an object with keys description and lyrics"); if (t.language && !t.language.match(/[a-z]{3}/i)) throw new Error("Language must be coded following the ISO 639-2 standards"); this._setLyricsFrame(t.language, t.description, t.lyrics); break; case "APIC": if (!("object" == typeof t && "type" in t && "data" in t && "description" in t)) throw new Error("APIC frame value should be an object with keys type, data and description"); if (t.type < 0 || 20 < t.type) throw new Error("Incorrect APIC frame picture type"); this._setPictureFrame(t.type, t.data, t.description, !!t.useUnicodeEncoding); break; case "TXXX": if (!("object" == typeof t && "description" in t && "value" in t)) throw new Error("TXXX frame value should be an object with keys description and value"); this._setUserStringFrame(t.description, t.value); break; case "WCOM": case "WCOP": case "WOAF": case "WOAR": case "WOAS": case "WORS": case "WPAY": case "WPUB": this._setUrlLinkFrame(e, t); break; case "COMM": if (t.language = t.language || "eng", !("object" == typeof t && "description" in t && "text" in t)) throw new Error("COMM frame value should be an object with keys description and text"); if (t.language && !t.language.match(/[a-z]{3}/i)) throw new Error("Language must be coded following the ISO 639-2 standards"); this._setCommentFrame(t.language, t.description, t.text); break; case "PRIV": if (!("object" == typeof t && "id" in t && "data" in t)) throw new Error("PRIV frame value should be an object with keys id and data"); this._setPrivateFrame(t.id, t.data); break; default: throw new Error("Unsupported frame " + e) } return this }, e.removeTag = function () { if (!(this.arrayBuffer.byteLength < 10)) { var e, t, a = new Uint8Array(this.arrayBuffer), r = a[3], n = ((e = [a[6], a[7], a[8], a[9]])[0] << 21) + (e[1] << 14) + (e[2] << 7) + e[3] + 10; if (!(73 !== (t = a)[0] || 68 !== t[1] || 51 !== t[2] || r < 2 || 4 < r)) this.arrayBuffer = new Uint8Array(a.subarray(n)).buffer } }, e.addTag = function () { this.removeTag(); var e, t, r = [255, 254], a = 10 + this.frames.reduce(function (e, t) { return e + t.size }, 0) + this.padding, n = new ArrayBuffer(this.arrayBuffer.byteLength + a), s = new Uint8Array(n), i = 0, c = []; return c = [73, 68, 51, 3], s.set(c, i), i += c.length, i++, i++, c = [(e = a - 10) >>> 21 & (t = 127), e >>> 14 & t, e >>> 7 & t, e & t], s.set(c, i), i += c.length, this.frames.forEach(function (e) { var t, a; switch (c = o(e.name), s.set(c, i), i += c.length, t = e.size - 10, c = [t >>> 24 & (a = 255), t >>> 16 & a, t >>> 8 & a, t & a], s.set(c, i), i += c.length, i += 2, e.name) { case "WCOM": case "WCOP": case "WOAF": case "WOAR": case "WOAS": case "WORS": case "WPAY": case "WPUB": c = o(e.value), s.set(c, i), i += c.length; break; case "TPE1": case "TCOM": case "TCON": case "TLAN": case "TIT1": case "TIT2": case "TIT3": case "TALB": case "TPE2": case "TPE3": case "TPE4": case "TRCK": case "TPOS": case "TKEY": case "TMED": case "TPUB": case "TCOP": case "TEXT": case "TSRC": c = [1].concat(r), s.set(c, i), i += c.length, c = u(e.value), s.set(c, i), i += c.length; break; case "TXXX": case "USLT": case "COMM": c = [1], "USLT" !== e.name && "COMM" !== e.name || (c = c.concat(e.language)), c = c.concat(r), s.set(c, i), i += c.length, c = u(e.description), s.set(c, i), i += c.length, c = [0, 0].concat(r), s.set(c, i), i += c.length, c = u(e.value), s.set(c, i), i += c.length; break; case "TBPM": case "TLEN": case "TDAT": case "TYER": i++, c = o(e.value), s.set(c, i), i += c.length; break; case "PRIV": c = o(e.id), s.set(c, i), i += c.length, i++, s.set(new Uint8Array(e.value), i), i += e.value.byteLength; break; case "APIC": c = [e.useUnicodeEncoding ? 1 : 0], s.set(c, i), i += c.length, c = o(e.mimeType), s.set(c, i), i += c.length, c = [0, e.pictureType], s.set(c, i), i += c.length, e.useUnicodeEncoding ? (c = [].concat(r), s.set(c, i), i += c.length, c = u(e.description), s.set(c, i), i += c.length, i += 2) : (c = o(e.description), s.set(c, i), i += c.length, i++), s.set(new Uint8Array(e.value), i), i += e.value.byteLength } }), i += this.padding, s.set(new Uint8Array(this.arrayBuffer), i), this.arrayBuffer = n }, e.getBlob = function () { return new Blob([this.arrayBuffer], { type: "audio/mpeg" }) }, e.getURL = function () { return this.url || (this.url = URL.createObjectURL(this.getBlob())), this.url }, e.revokeURL = function () { URL.revokeObjectURL(this.url) }, t }()
  });

  /* ---------- 类型探测：按文件头魔数（优先于接口返回的 type / content-type） ---------- */
  function detectType(buf) {
    const d = new Uint8Array(buf);
    if (d.length >= 4 && d[0] === 0x66 && d[1] === 0x4C && d[2] === 0x61 && d[3] === 0x43) return 'flac'; // "fLaC"
    if (d.length >= 3 && d[0] === 0x49 && d[1] === 0x44 && d[2] === 0x33) return 'mp3'; // "ID3"
    if (d.length >= 2 && d[0] === 0xFF && (d[1] & 0xE0) === 0xE0) return 'mp3'; // MPEG 帧同步
    if (d.length >= 12 && d[4] === 0x66 && d[5] === 0x74 && d[6] === 0x79 && d[7] === 0x70) return 'm4a'; // "ftyp"
    return '';
  }

  /* ---------- FLAC：Vorbis Comment 块（type 4） ---------- */
  function writeUint32LE(arr, off, v) {
    arr[off] = v & 0xFF; arr[off + 1] = (v >> 8) & 0xFF;
    arr[off + 2] = (v >> 16) & 0xFF; arr[off + 3] = (v >> 24) & 0xFF;
  }
  function writeUint32BE(arr, off, v) {
    arr[off] = (v >> 24) & 0xFF; arr[off + 1] = (v >> 16) & 0xFF;
    arr[off + 2] = (v >> 8) & 0xFF; arr[off + 3] = v & 0xFF;
  }

  function createVorbisComment(meta) {
    const enc = new TextEncoder();
    const vendor = enc.encode('B\u00b7Music');
    const comments = [];
    if (meta.title) comments.push(enc.encode('TITLE=' + meta.title));
    if (meta.artist) comments.push(enc.encode('ARTIST=' + meta.artist));
    if (meta.album) comments.push(enc.encode('ALBUM=' + meta.album));
    if (meta.lyrics) comments.push(enc.encode('LYRICS=' + meta.lyrics));
    /* 工具签名（与 CoCo 音乐元数据编辑器扩展一致，致谢原作者 corainly） */
    comments.push(enc.encode('TOOL=Music Metadata Editor'));
    comments.push(enc.encode('SOFTWARE=by corainly@ccw'));
    comments.push(enc.encode('ENCODER=Music Metadata Editor (by corainly@ccw) v2.0'));
    comments.push(enc.encode('thanks:感谢使用Music Metadata Editor喵~'));

    let dataSize = 4 + vendor.length + 4;
    for (const c of comments) dataSize += 4 + c.length;

    const block = new Uint8Array(4 + dataSize);
    let off = 0;
    block[off++] = 0x04; // VORBIS_COMMENT
    block[off++] = (dataSize >> 16) & 0xFF;
    block[off++] = (dataSize >> 8) & 0xFF;
    block[off++] = dataSize & 0xFF;

    writeUint32LE(block, off, vendor.length); off += 4;
    block.set(vendor, off); off += vendor.length;
    writeUint32LE(block, off, comments.length); off += 4;
    for (const c of comments) {
      writeUint32LE(block, off, c.length); off += 4;
      block.set(c, off); off += c.length;
    }
    return block;
  }

  /* ---------- FLAC：Picture 块（type 6） ---------- */
  function createPicture(coverAb, mime) {
    const enc = new TextEncoder();
    const mimeBytes = enc.encode(mime || 'image/jpeg');
    const descBytes = enc.encode('Cover (front)');
    const img = new Uint8Array(coverAb);

    const dataSize = 4 + 4 + mimeBytes.length + 4 + descBytes.length + 4 + 4 + 4 + 4 + 4 + img.length;
    const block = new Uint8Array(4 + dataSize);
    block[0] = 0x06; // PICTURE
    block[1] = (dataSize >> 16) & 0xFF;
    block[2] = (dataSize >> 8) & 0xFF;
    block[3] = dataSize & 0xFF;

    let off = 4;
    writeUint32BE(block, off, 3); off += 4; // picture type: front cover
    writeUint32BE(block, off, mimeBytes.length); off += 4;
    block.set(mimeBytes, off); off += mimeBytes.length;
    writeUint32BE(block, off, descBytes.length); off += 4;
    block.set(descBytes, off); off += descBytes.length;
    writeUint32BE(block, off, 0); off += 4; // width
    writeUint32BE(block, off, 0); off += 4; // height
    writeUint32BE(block, off, 24); off += 4; // depth
    writeUint32BE(block, off, 0); off += 4; // colors
    writeUint32BE(block, off, img.length); off += 4;
    block.set(img, off);
    return block;
  }

  /* ---------- FLAC：丢弃旧 metadata blocks（保留 STREAMINFO），重建后拼接音频帧 ---------- */
  function rebuildFlac(buf, meta, coverAb, coverMime) {
    const data = new Uint8Array(buf);
    if (data.length < 4 || data[0] !== 0x66 || data[1] !== 0x4C || data[2] !== 0x61 || data[3] !== 0x43) return buf;

    let pos = 4, audioStart = data.length, streamInfo = null;
    const scanEnd = Math.min(data.length, 100000);
    while (pos < scanEnd && pos + 4 <= data.length) {
      const header = data[pos];
      const isLast = (header & 0x80) !== 0;
      const blockSize = (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
      const blockEnd = pos + 4 + blockSize;
      if (blockEnd > data.length) { audioStart = pos; break; }
      if ((header & 0x7F) === 0) streamInfo = data.subarray(pos, blockEnd); // STREAMINFO
      pos = blockEnd;
      if (isLast) { audioStart = blockEnd; break; }
    }
    if (!streamInfo) { audioStart = 4; streamInfo = data.subarray(0, 4); }

    const blocks = [];
    const si = new Uint8Array(streamInfo);
    si[0] = 0x00; // STREAMINFO 置于首位且非 last
    blocks.push(si);
    blocks.push(createVorbisComment(meta));
    if (coverAb && coverAb.byteLength > 0) blocks.push(createPicture(coverAb, coverMime));
    blocks[blocks.length - 1][0] |= 0x80; // 末块标记 last

    const metaSize = blocks.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(4 + metaSize + (data.length - audioStart));
    out.set(data.subarray(0, 4), 0);
    let off = 4;
    for (const b of blocks) { out.set(b, off); off += b.length; }
    out.set(data.subarray(audioStart), off);
    return out.buffer;
  }

  /* ---------- MP3：ID3v2.3 标签 ---------- */
  function writeMp3(buf, meta, coverAb, coverMime) {
    const w = new window.ID3Writer(buf);
    if (meta.title) w.setFrame('TIT2', meta.title);
    if (meta.artist) { w.setFrame('TPE1', [meta.artist]); w.setFrame('TPE2', meta.artist); }
    if (meta.album) w.setFrame('TALB', meta.album);
    if (meta.lyrics) w.setFrame('USLT', { language: 'chi', description: 'Lyrics', lyrics: meta.lyrics });
    if (coverAb && coverAb.byteLength > 0) {
      w.setFrame('APIC', { type: 3, data: coverAb, description: 'Cover', mimeType: coverMime || 'image/jpeg' });
    }
    /* 工具签名（与 CoCo 音乐元数据编辑器扩展一致，致谢原作者 corainly） */
    w.setFrame('COMM', { language: 'eng', description: 'Tool', text: 'Music Metadata Editor (by corainly@ccw) v2.0' });
    w.setFrame('COMM', { language: 'eng', description: 'Software', text: 'by corainly@ccw' });
    w.setFrame('TXXX', { description: 'Encoder', value: 'Music Metadata Editor (by corainly@ccw) v2.0' });
    w.addTag();
    return w.arrayBuffer;
  }

  window.Metadata = {
    detectType: detectType,
    /** 写入元信息：buf(ArrayBuffer) + meta{title,artist,album,lyrics,cover,coverMime}
     *  返回处理后的 ArrayBuffer；识别失败/写入异常时原样返回，绝不阻塞下载。 */
    async write(buf, meta) {
      meta = meta || {};
      const kind = detectType(buf);
      try {
        if (kind === 'flac') return rebuildFlac(buf, meta, meta.cover, meta.coverMime);
        if (kind === 'mp3') return writeMp3(buf, meta, meta.cover, meta.coverMime);
      } catch (e) {
        console.warn('[Metadata] 元信息写入失败，保留原文件：', e);
      }
      return buf;
    },
  };
})();
