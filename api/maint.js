// GET  /api/maint            → { block, m, at }   (게임 첫 화면이 확인한다)
// POST /api/maint {m}        헤더 x-stats-key  → 보수 모드 바꾸기  m: auto(정해진 시각부터) · on(지금 막기) · off(열기)
import crypto from 'node:crypto';
import { hasDb, redis, send, body, limited, maintState } from './_lib.js';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!hasDb) return send(res, 200, { block: false, m: 'off', at: 0 });
      return send(res, 200, await maintState());
    }
    if (req.method !== 'POST') return send(res, 405, { code: 'bad' });
    const KEY = process.env.STATS_KEY;
    if (!KEY || KEY.length < 8 || !hasDb) return send(res, 503, { code: 'nokey' });
    if (!same(req.headers['x-stats-key'] || '', KEY)) {
      if (await limited(req, 'maint', 20)) return send(res, 429, { code: 'too-many' });
      return send(res, 401, { code: 'auth' });
    }
    const m = String(body(req).m || '');
    if (!['auto', 'on', 'off'].includes(m)) return send(res, 400, { code: 'bad' });
    await redis('SET', 'maint', m);
    return send(res, 200, await maintState());
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
