// 패치노트 댓글
// GET    /api/comments?note=ID                 → { list:[{id,nick,text,at,up,del,mine}] }  누구나 읽기 (로그인했으면 내 댓글 표시)
// POST   /api/comments { note, text }          → 새 댓글 (로그인 필수 · 200자)
// PUT    /api/comments { note, id, text }      → 내 댓글 고치기
// DELETE /api/comments { note, id }            → 내 댓글 지우기 (관리자 키가 있으면 아무 댓글이나)
// GET    /api/comments?op=log&n=500            → 기록 (관리자 키 필요) — 쓰기 · 고치기 · 지우기를 모두 남긴다. 지워도 기록은 남는다.
// 표시 이름은 아이디 일부를 가린 것 (예: alice01 → al****1). 전체 아이디는 기록에만 남는다.
import crypto from 'node:crypto';
import { hasDb, redis, pipe, sessionUser, send, body, limited, kday } from './_lib.js';

const MAXLEN = 200;
const DAY_MAX = 40;
const NOTE = /^[a-f0-9]{6,24}$/;
const CID = /^[a-f0-9]{8,24}$/;
const q = (req, k) => req.query?.[k] ?? new URL(req.url, 'http://x').searchParams.get(k);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const mask = id => { id = String(id || ''); if (id.length <= 3) return id.slice(0, 1) + '**'; return id.slice(0, 2) + '*'.repeat(Math.max(1, id.length - 3)) + id.slice(-1); };
const clean = t => String(t ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const ipHash = req => crypto.createHash('sha256').update(String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim() + ':lcorp').digest('hex').slice(0, 12);

async function log(entry) {
  const at = Date.now();
  const e = JSON.stringify({ ...entry, at, k: crypto.randomBytes(4).toString('hex') });
  await redis('ZADD', 'c:log', at, e);
}

export default async function handler(req, res) {
  try {
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    const KEY = process.env.ADMIN_KEY || process.env.STATS_KEY;
    const admin = !!(KEY && KEY.length >= 8 && req.headers['x-admin-key'] && same(req.headers['x-admin-key'], KEY));
    const uid = await sessionUser(req);

    if (req.method === 'GET') {
      if (q(req, 'op') === 'log') {
        if (!admin) { if (await limited(req, 'clog', 20)) return send(res, 429, { code: 'too-many' }); return send(res, 401, { code: 'auth' }); }
        const n = Math.max(1, Math.min(5000, Number(q(req, 'n')) || 500));
        const raw = (await redis('ZREVRANGE', 'c:log', 0, n - 1)) || [];
        return send(res, 200, { log: raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) });
      }
      const note = String(q(req, 'note') || '');
      if (!NOTE.test(note)) return send(res, 400, { code: 'bad' });
      const h = (await redis('HGETALL', `c:n:${note}`)) || [];
      const list = [];
      for (let i = 0; i < h.length; i += 2) { try { const c = JSON.parse(h[i + 1]); list.push({ id: c.id, nick: mask(c.uid), text: c.del ? '' : c.text, at: c.at, up: c.up || null, del: !!c.del, mine: !!uid && c.uid === uid }); } catch { } }
      list.sort((a, b) => a.at - b.at);
      return send(res, 200, { list, me: uid ? mask(uid) : null });
    }

    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, { code: 'bad' });
    const b = body(req);
    const note = String(b.note || '');
    if (!NOTE.test(note)) return send(res, 400, { code: 'bad' });
    const nk = `c:n:${note}`;
    const ip = ipHash(req);

    if (req.method === 'DELETE' && admin) {
      const id = String(b.id || ''); if (!CID.test(id)) return send(res, 400, { code: 'bad' });
      const raw = await redis('HGET', nk, id); if (!raw) return send(res, 404, { code: 'none' });
      const c = JSON.parse(raw); if (c.del) return send(res, 200, { ok: true });
      c.del = Date.now(); c.delBy = 'admin';
      await redis('HSET', nk, id, JSON.stringify(c));
      await log({ act: 'delete', by: 'admin', note, id, uid: c.uid, nick: mask(c.uid), text: c.text });
      return send(res, 200, { ok: true });
    }

    if (!uid) return send(res, 401, { code: 'auth' });
    if (await limited(req, 'cmt', 30)) return send(res, 429, { code: 'too-many' });

    if (req.method === 'POST') {
      const text = clean(b.text);
      if (!text) return send(res, 400, { code: 'empty' });
      if (text.length > MAXLEN) return send(res, 400, { code: 'long', max: MAXLEN });
      const ex = await redis('GET', 'pn:list');
      if (!ex || !JSON.parse(ex).some(n => n.id === note)) return send(res, 404, { code: 'nonote' });
      const dk = `c:day:${uid}:${kday()}`;
      const [n] = await pipe([['INCR', dk], ['EXPIRE', dk, 172800]]);
      if (n > DAY_MAX) return send(res, 429, { code: 'daily' });
      const id = crypto.randomBytes(6).toString('hex');
      const c = { id, uid, text, at: Date.now() };
      await redis('HSET', nk, id, JSON.stringify(c));
      await log({ act: 'create', note, id, uid, nick: mask(uid), text, ip });
      return send(res, 200, { ok: true, id });
    }

    const id = String(b.id || ''); if (!CID.test(id)) return send(res, 400, { code: 'bad' });
    const raw = await redis('HGET', nk, id); if (!raw) return send(res, 404, { code: 'none' });
    const c = JSON.parse(raw);
    if (c.uid !== uid) return send(res, 403, { code: 'notmine' });
    if (c.del) return send(res, 409, { code: 'deleted' });

    if (req.method === 'PUT') {
      const text = clean(b.text);
      if (!text) return send(res, 400, { code: 'empty' });
      if (text.length > MAXLEN) return send(res, 400, { code: 'long', max: MAXLEN });
      if (text === c.text) return send(res, 200, { ok: true });
      const prev = c.text; c.text = text; c.up = Date.now(); c.edits = (c.edits || 0) + 1;
      await redis('HSET', nk, id, JSON.stringify(c));
      await log({ act: 'edit', note, id, uid, nick: mask(uid), text, prev, ip });
      return send(res, 200, { ok: true });
    }
    // DELETE (내 댓글): 화면에서는 「삭제된 댓글」로 남고, 원문은 기록에 남는다
    c.del = Date.now(); c.delBy = 'self';
    await redis('HSET', nk, id, JSON.stringify(c));
    await log({ act: 'delete', by: 'self', note, id, uid, nick: mask(uid), text: c.text, ip });
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
