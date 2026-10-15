// GET /api/pref        → { pref: {lang, at} | null }   (본인 설정만)
// PUT /api/pref {lang, at}  — 마지막으로 바꾼 언어를 계정에 기억한다
import { hasDb, redis, sessionUser, send, body } from './_lib.js';

const LANGS = ['ko', 'en', 'ja'];

export default async function handler(req, res) {
  try {
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    const id = await sessionUser(req);
    if (!id) return send(res, 401, { code: 'auth' });
    const key = `p:${id}`;
    if (req.method === 'GET') {
      const raw = await redis('GET', key);
      return send(res, 200, { pref: raw ? JSON.parse(raw) : null });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const b = body(req);
      if (!LANGS.includes(b.lang)) return send(res, 400, { code: 'bad' });
      const at = Math.min(Date.now(), Number(b.at) || Date.now());
      await redis('SET', key, JSON.stringify({ lang: b.lang, at }));
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
