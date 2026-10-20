// 패치노트
// GET    /api/notes                          → { ok, notes:[{id,t,x,f,at,up}] }  f=1이면 서식 표시(pnfmt.js)로 그린다  누구나 읽기 (최신순)
// POST   /api/notes { t, x }                 → 새 글     ┐
// PUT    /api/notes { id, t, x }             → 고치기    ├ 헤더 x-admin-key: (Vercel 환경 변수 ADMIN_KEY, 없으면 STATS_KEY) 가 맞을 때만
// DELETE /api/notes { id }                   → 지우기    ┘
import crypto from 'node:crypto';
import { hasDb, redis, send, body, limited } from './_lib.js';

const K = 'pn:list';
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const load = async () => { try { const r = await redis('GET', K); const a = JSON.parse(r || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export default async function handler(req, res) {
  try {
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    if (req.method === 'GET') return send(res, 200, { ok: true, notes: await load() });
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, { code: 'bad' });

    const KEY = process.env.ADMIN_KEY || process.env.STATS_KEY;
    if (!KEY || KEY.length < 8) return send(res, 503, { code: 'nokey' });
    if (!same(req.headers['x-admin-key'] || '', KEY)) {
      if (await limited(req, 'notes', 20)) return send(res, 429, { code: 'too-many' });
      return send(res, 401, { code: 'auth' });
    }
    const b = body(req);
    const t = String(b.t ?? '').trim().slice(0, 120);
    const x = String(b.x ?? '').replace(/\r\n/g, '\n').slice(0, 20000);
    const f = b.f ? 1 : 0;
    const list = await load();

    if (req.method === 'POST') {
      if (!t) return send(res, 400, { code: 'empty' });
      const n = { id: crypto.randomBytes(6).toString('hex'), t, x, f, at: Date.now() };
      list.unshift(n); list.length = Math.min(list.length, 300);
      await redis('SET', K, JSON.stringify(list));
      return send(res, 200, { ok: true, note: n });
    }
    const i = list.findIndex(n => n.id === b.id);
    if (i < 0) return send(res, 404, { code: 'none' });
    if (req.method === 'PUT') {
      if (!t) return send(res, 400, { code: 'empty' });
      list[i] = { ...list[i], t, x, f, up: Date.now() };
    } else list.splice(i, 1);
    await redis('SET', K, JSON.stringify(list));
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
