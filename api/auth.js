// GET  /api/auth                         → { ok, db, user }   (지금 로그인한 아이디. 없으면 null)
// POST /api/auth { action:'signup'|'login', id, pw } → { id, token }
// POST /api/auth { action:'logout' }
import { hasDb, redis, ID_RE, hashPw, checkPw, newSession, sessionUser, endSession, limited, send, body } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!hasDb) return send(res, 200, { ok: true, db: false, user: null });
      return send(res, 200, { ok: true, db: true, user: await sessionUser(req, true) });
    }
    if (req.method !== 'POST') return send(res, 405, { code: 'bad' });
    if (!hasDb) return send(res, 503, { code: 'nodb' });

    const b = body(req);
    if (b.action === 'logout') { await endSession(req); return send(res, 200, { ok: true }); }

    const id = String(b.id || '').trim().toLowerCase();
    const pw = String(b.pw || '');
    if (!ID_RE.test(id) || pw.length < 8 || pw.length > 128) return send(res, 400, { code: 'id-form' });

    if (b.action === 'signup') {
      if (await limited(req, 'signup', 10)) return send(res, 429, { code: 'too-many' });
      const rec = await hashPw(pw);
      const ok = await redis('SET', 'u:' + id, JSON.stringify({ ...rec, at: Date.now() }), 'NX');
      if (ok !== 'OK') return send(res, 409, { code: 'id-taken' });
      return send(res, 200, { id, token: await newSession(id) });
    }
    if (b.action === 'login') {
      if (await limited(req, 'login', 30)) return send(res, 429, { code: 'too-many' });
      const raw = await redis('GET', 'u:' + id);
      if (!raw || !(await checkPw(pw, JSON.parse(raw)))) return send(res, 401, { code: 'id-bad' });
      return send(res, 200, { id, token: await newSession(id) });
    }
    return send(res, 400, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
