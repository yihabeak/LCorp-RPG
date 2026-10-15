// GET /api/slot?n=all         → { list:[1,2,3번 칸], pref }   (한 번에 — 서버 호출 절약)
// GET /api/slot?n=1..3        → { data }   (본인 저장소만)
// PUT /api/slot?n=1..3  {save, cdx, name, day, at, v}
import { hasDb, redis, sessionUser, send, body } from './_lib.js';

const MAX = 900_000;   // 저장 한 칸의 최대 크기(글자 수)

export default async function handler(req, res) {
  try {
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    const id = await sessionUser(req);
    if (!id) return send(res, 401, { code: 'auth' });
    const q = req.query?.n ?? new URL(req.url, 'http://x').searchParams.get('n');
    if (q === 'all' && req.method === 'GET') {
      const raw = await redis('MGET', `s:${id}:1`, `s:${id}:2`, `s:${id}:3`, `p:${id}`);
      const list = raw.slice(0, 3).map(v => (v ? JSON.parse(v) : null));
      return send(res, 200, { list, pref: raw[3] ? JSON.parse(raw[3]) : null });
    }
    const n = Number(q);
    if (![1, 2, 3].includes(n)) return send(res, 400, { code: 'bad' });
    const key = `s:${id}:${n}`;

    if (req.method === 'GET') {
      const raw = await redis('GET', key);
      return send(res, 200, { data: raw ? JSON.parse(raw) : null });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const b = body(req);
      const str = v => (typeof v === 'string' ? v : null);
      const data = {
        save: str(b.save), cdx: str(b.cdx) || '{}',
        name: String(b.name || '').slice(0, 40), day: Math.max(0, Math.min(999, Number(b.day) || 0)),
        at: Number(b.at) || Date.now(), v: 1
      };
      const json = JSON.stringify(data);
      if (json.length > MAX) return send(res, 413, { code: 'too-big' });
      await redis('SET', key, json);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
