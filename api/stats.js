// GET /api/stats?days=30   헤더 x-stats-key: (Vercel 환경 변수 STATS_KEY 값)
// 관리자 전용 사용량 통계. 키가 없으면 열리지 않는다.
import crypto from 'node:crypto';
import { hasDb, pipe, send, limited, kday } from './_lib.js';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return send(res, 405, { code: 'bad' });
    const KEY = process.env.STATS_KEY;
    if (!KEY || KEY.length < 8) return send(res, 503, { code: 'nokey' });
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    if (!same(req.headers['x-stats-key'] || '', KEY)) {
      if (await limited(req, 'stats', 20)) return send(res, 429, { code: 'too-many' });
      return send(res, 401, { code: 'auth' });
    }
    const q = Number(req.query?.days ?? new URL(req.url, 'http://x').searchParams.get('days')) || 31;
    const n = Math.max(1, Math.min(90, q));
    const days = [];
    for (let i = n - 1; i >= 0; i--) days.push(kday(Date.now() - i * 86400e3));
    const month = kday().slice(0, 7);
    const mdays = days.filter(d => d.startsWith(month));
    const cmds = [];
    days.forEach(d => { cmds.push(['HGETALL', 'st:' + d], ['PFCOUNT', 'st:u:' + d], ['PFCOUNT', 'st:pu:' + d]); });
    cmds.push(['PFCOUNT', ...mdays.map(d => 'st:u:' + d)]);
    cmds.push(['PFCOUNT', ...mdays.map(d => 'st:pu:' + d)]);
    cmds.push(['PFCOUNT', ...days.map(d => 'st:u:' + d)]);
    cmds.push(['DBSIZE']);
    const r = await pipe(cmds);
    const obj = a => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; else if (a) Object.assign(o, a); return o; };
    const out = days.map((d, i) => ({ d, h: obj(r[i * 3]), u: r[i * 3 + 1] || 0, pu: r[i * 3 + 2] || 0 }));
    const k = days.length * 3;
    return send(res, 200, { ok: true, today: kday(), month, days: out, monthU: r[k] || 0, monthPU: r[k + 1] || 0, rangeU: r[k + 2] || 0, keys: r[k + 3] || 0 });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
