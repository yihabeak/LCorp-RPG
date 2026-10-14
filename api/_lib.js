// 공용 도구: Redis(REST) 호출, 비밀번호 해시, 세션 토큰, 요청 제한
// Vercel 대시보드에서 Upstash Redis를 프로젝트에 연결하면 아래 환경 변수가 자동으로 들어온다.
import crypto from 'node:crypto';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const hasDb = !!(URL_ && TOKEN);

export async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('redis: ' + (j.error || r.status));
  return j.result;
}

export const ID_RE = /^[a-z0-9_]{4,16}$/;
export const SESSION_DAYS = 30;

export function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((ok, no) =>
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok({ salt, hash: k.toString('hex') }))));
}
export async function checkPw(pw, rec) {
  const { hash } = await hashPw(pw, rec.salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const tkey = t => 't:' + crypto.createHash('sha256').update(t).digest('hex');   // 토큰 원문은 저장하지 않는다
export async function newSession(id) {
  const t = crypto.randomBytes(32).toString('base64url');
  await redis('SET', tkey(t), id, 'EX', SESSION_DAYS * 86400);
  return t;
}
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
export async function sessionUser(req, refresh = false) {
  const t = bearer(req);
  if (!t || t.length > 100) return null;
  const k = tkey(t);
  const id = await redis('GET', k);
  if (id && refresh) await redis('EXPIRE', k, SESSION_DAYS * 86400);
  return id || null;
}
export async function endSession(req) {
  const t = bearer(req);
  if (t && t.length <= 100) await redis('DEL', tkey(t));
}

// 같은 주소에서 15분에 limit번까지
export async function limited(req, what, limit) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
  const k = `rl:${what}:${ip}`;
  const n = await redis('INCR', k);
  if (n === 1) await redis('EXPIRE', k, 900);
  return n > limit;
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
