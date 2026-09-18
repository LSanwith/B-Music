/* Vercel Serverless Function：一起听（Listen Together）房间
 *
 * 设计（轮询式，适配 Serverless + Upstash，无需常驻 WebSocket）：
 *   - 房间数据存独立 KV 键 room:<CODE>，不占用主 db（避免心跳放大写入）
 *   - 发起者（房主）是播放权威：客户端每次心跳上报 { songId, position, playing }
 *   - 跟随者轮询同一接口拿房间状态，自行把播放进度对齐到
 *       position + (playing ? now - at : 0)
 *   - 聊天与成员状态同一条通道返回，减少请求数
 *
 * 接口：GET/POST /api/room?a=<action>
 *   create  : 建房间（已登录；返回 code 与房间）
 *   join    : body { code } 加入
 *   poll    : body { code, since?, state? } 心跳 + 拉新消息（房主可带 state）
 *   chat    : body { code, text } 发消息（600ms 限频、单条 300 字、保留最近 60 条）
 *   leave   : 退出（房主退出 = 解散房间）
 * 安全：全部需要登录（Authorization: Bearer <token>）；口令 6 位、不含易混字符；
 *      房间 2 小时无心跳自动失效；成员 45 秒无心跳视为离线。
 */

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;   // 房间闲置 2 小时失效
const MEMBER_TTL_MS = 45 * 1000;          // 成员 45 秒无心跳视为离线
const CHAT_KEEP = 60;                     // 保留最近 60 条
const CHAT_MAX_LEN = 300;
const CHAT_MIN_GAP_MS = 600;              // 同一个人发消息最小间隔
const ROOM_MAX = 4;                        // 一个房间最多 4 人
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1

let MEM = null;
let MEM_EXT = {};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 256 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

async function loadDb() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const r = await fetch(process.env.KV_REST_API_URL + '/get/db', {
        headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
      });
      const j = await r.json();
      if (j && j.result) return JSON.parse(j.result);
    } catch (e) { /* 降级内存 */ }
  }
  return MEM || { users: {}, sessions: {}, data: {} };
}

function authUser(db, req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const uid = db.sessions[m[1]];
  const u = uid ? db.users[uid] || null : null;
  if (u && u.banned) return null;
  return u;
}

function kvGet(key) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return fetch(process.env.KV_REST_API_URL + '/get/' + key, {
      headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
    }).then(r => r.json()).then(j => (j && j.result ? JSON.parse(j.result) : null))
      .catch(() => MEM_EXT[key] || null);
  }
  return Promise.resolve(MEM_EXT[key] || null);
}

function kvSet(key, val, ttlSec) {
  MEM_EXT[key] = val;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const url = process.env.KV_REST_API_URL + '/set/' + key + (ttlSec ? '?EX=' + ttlSec : '');
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(val),
      headers: {
        Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN,
        'Content-Type': 'application/json',
      },
    }).catch(() => {});
  }
  return Promise.resolve();
}

function kvDel(key) {
  delete MEM_EXT[key];
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return fetch(process.env.KV_REST_API_URL + '/del/' + key, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN },
    }).catch(() => {});
  }
  return Promise.resolve();
}

function newCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function me(u) {
  return { uid: String(u.id), name: u.nickname || ('用户' + u.id), avatar: u.avatar || '' };
}

/** 只保留在线成员（45 秒内有心跳） */
function liveMembers(room, now) {
  const out = [];
  Object.keys(room.members || {}).forEach((uid) => {
    const m = room.members[uid];
    if (m && now - (m.at || 0) <= MEMBER_TTL_MS) out.push(m);
  });
  return out.sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : (a.at || 0) - (b.at || 0)));
}

function roomPublic(room, now) {
  return {
    code: room.code,
    host: room.host,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    state: room.state || null,
    members: liveMembers(room, now),
    seq: room.seq || 0,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ msg: 'method not allowed' });
  const db = await loadDb();
  const user = authUser(db, req);
  if (!user) return res.status(401).json({ msg: '未登录或登录已过期' });
  const q = req.query || {};
  const action = String(q.a || '');
  const now = Date.now();
  const keyOf = (code) => 'room:' + String(code || '').toUpperCase();

  try {
    if (action === 'create') {
      // 已在房间里且自己是房主：直接返回原房间，避免产生孤儿房间
      const b = req.method === 'POST' ? await readBody(req) : {};
      const mine = String(b.mine || '');
      if (/^[A-Z0-9]{6}$/.test(mine)) {
        const old = await kvGet(keyOf(mine));
        if (old && old.host && String(old.host.uid) === String(user.id) && now - (old.updatedAt || 0) < ROOM_TTL_MS) {
          old.updatedAt = now;
          old.members[String(user.id)] = Object.assign(me(user), { at: now, role: 'host' });
          await kvSet(keyOf(mine), old, Math.ceil(ROOM_TTL_MS / 1000));
          return res.status(200).json({ ok: true, room: roomPublic(old, now) });
        }
      }
      let code = '';
      for (let i = 0; i < 6 && !code; i++) {
        const c = newCode();
        const exist = await kvGet(keyOf(c));
        if (!exist || now - (exist.updatedAt || 0) >= ROOM_TTL_MS) code = c;
      }
      const room = {
        code,
        host: me(user),
        createdAt: now,
        updatedAt: now,
        state: null,
        members: { [String(user.id)]: Object.assign(me(user), { at: now, role: 'host' }) },
        chat: [],
        seq: 0,
      };
      await kvSet(keyOf(code), room, Math.ceil(ROOM_TTL_MS / 1000));
      return res.status(200).json({ ok: true, room: roomPublic(room, now) });
    }

    const b = req.method === 'POST' ? await readBody(req) : {};
    const code = String(b.code || q.code || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ msg: '口令格式不正确（6 位字母数字）' });
    const room = await kvGet(keyOf(code));
    if (!room) return res.status(404).json({ msg: '房间不存在或已结束' });
    if (now - (room.updatedAt || 0) > ROOM_TTL_MS) {
      await kvDel(keyOf(code));
      return res.status(404).json({ msg: '房间已过期' });
    }
    const uid = String(user.id);

    if (action === 'join') {
      const isHost = String(room.host.uid) === uid;
      const already = isHost || !!room.members[uid];
      if (!already && liveMembers(room, now).length >= ROOM_MAX) {
        return res.status(409).json({ msg: '\u623f\u95f4\u4eba\u6570\u5df2\u6ee1\uff08\u6700\u591a 4 \u4eba\uff09' });
      }
      room.members[uid] = Object.assign(me(user), { at: now, role: isHost ? 'host' : 'guest' });
      room.updatedAt = now;
      await kvSet(keyOf(code), room, Math.ceil(ROOM_TTL_MS / 1000));
      return res.status(200).json({ ok: true, room: roomPublic(room, now), chat: room.chat || [] });
    }

    if (action === 'poll') {
      const isHost = String(room.host.uid) === uid;
      if (!room.members[uid] && !isHost) return res.status(409).json({ msg: '你已不在房间中' });
      room.members[uid] = Object.assign(me(user), { at: now, role: isHost ? 'host' : 'guest' });
      // 房主上报播放状态（权威）
      if (isHost && b.state && typeof b.state === 'object') {
        const s = b.state;
        room.state = {
          songId: String(s.songId || ''),
          name: String(s.name || '').slice(0, 80),
          artists: String(s.artists || '').slice(0, 80),
          cover: String(s.cover || '').slice(0, 300),
          duration: Number(s.duration) || 0,
          position: Math.max(0, Number(s.position) || 0),
          playing: !!s.playing,
          at: now,
        };
      }
      room.updatedAt = now;
      await kvSet(keyOf(code), room, Math.ceil(ROOM_TTL_MS / 1000));
      const since = Number(b.since) || 0;
      const chat = (room.chat || []).filter((m) => (m.seq || 0) > since);
      return res.status(200).json({ ok: true, room: roomPublic(room, now), chat, isHost });
    }

    if (action === 'chat') {
      if (!room.members[uid] && String(room.host.uid) !== uid) return res.status(409).json({ msg: '你已不在房间中' });
      const text = String(b.text || '').replace(/\s+$/g, '').slice(0, CHAT_MAX_LEN);
      if (!text.trim()) return res.status(400).json({ msg: '消息不能为空' });
      const last = (room.chat || []).filter((m) => String(m.uid) === uid).pop();
      if (last && now - (last.at || 0) < CHAT_MIN_GAP_MS) return res.status(429).json({ msg: '发得太快啦，稍等一下' });
      const m = Object.assign(me(user), { text, at: now, seq: (room.seq || 0) + 1 });
      room.seq = m.seq;
      room.chat = (room.chat || []).concat([m]).slice(-CHAT_KEEP);
      room.members[uid] = Object.assign(me(user), { at: now, role: String(room.host.uid) === uid ? 'host' : 'guest' });
      room.updatedAt = now;
      await kvSet(keyOf(code), room, Math.ceil(ROOM_TTL_MS / 1000));
      return res.status(200).json({ ok: true, msg: m });
    }

    if (action === 'leave' || action === 'close') {
      const isHost = String(room.host.uid) === uid;
      if (isHost || action === 'close') {
        await kvDel(keyOf(code)); // 房主离开 = 解散房间
        return res.status(200).json({ ok: true, closed: true });
      }
      delete room.members[uid];
      room.updatedAt = now;
      await kvSet(keyOf(code), room, Math.ceil(ROOM_TTL_MS / 1000));
      return res.status(200).json({ ok: true, closed: false });
    }

    return res.status(400).json({ msg: '未知操作' });
  } catch (e) {
    return res.status(400).json({ msg: (e && e.message) || 'bad request' });
  }
}
