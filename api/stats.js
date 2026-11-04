// GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD   (또는 ?days=30)   헤더 x-stats-key: (Vercel 환경 변수 STATS_KEY 값)
// 관리자 전용 사용량 통계. 키가 없으면 열리지 않는다. 통계는 100일까지만 남는다.
import crypto from 'node:crypto';
import { hasDb, pipe, send, limited, kday } from './_lib.js';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ms = d => Date.parse(d + 'T00:00:00Z');

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
    const sp = new URL(req.url, 'http://x').searchParams;
    const today = kday();
    let to = String(req.query?.to ?? sp.get('to') ?? ''), from = String(req.query?.from ?? sp.get('from') ?? '');
    if (!DAY.test(to) || to > today) to = today;
    if (!DAY.test(from)) { const n = Math.max(1, Math.min(100, Number(req.query?.days ?? sp.get('days')) || 31)); from = new Date(ms(to) - (n - 1) * 86400e3).toISOString().slice(0, 10); }
    if (from > to) [from, to] = [to, from];
    const oldest = new Date(ms(today) - 99 * 86400e3).toISOString().slice(0, 10);
    if (from < oldest) from = oldest;
    if (to < oldest) to = oldest;
    const days = [];
    for (let t = ms(from); t <= ms(to); t += 86400e3) days.push(new Date(t).toISOString().slice(0, 10));
    const month = today.slice(0, 7);
    const mdays = [];
    for (let t = ms(month + '-01'); t <= ms(today); t += 86400e3) mdays.push(new Date(t).toISOString().slice(0, 10));
    const cmds = [];
    days.forEach(d => { cmds.push(['HGETALL', 'st:' + d], ['PFCOUNT', 'st:u:' + d], ['PFCOUNT', 'st:pu:' + d]); });
    mdays.forEach(d => cmds.push(['HGETALL', 'st:' + d]));
    cmds.push(['PFCOUNT', ...mdays.map(d => 'st:u:' + d)]);
    cmds.push(['PFCOUNT', ...mdays.map(d => 'st:pu:' + d)]);
    cmds.push(['PFCOUNT', ...days.map(d => 'st:u:' + d)]);
    cmds.push(['PFCOUNT', ...days.map(d => 'st:pu:' + d)]);
    cmds.push(['DBSIZE']);
    const r = await pipe(cmds);
    const obj = a => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; else if (a) Object.assign(o, a); return o; };
    const out = days.map((d, i) => ({ d, h: obj(r[i * 3]), u: r[i * 3 + 1] || 0, pu: r[i * 3 + 2] || 0 }));
    let k = days.length * 3;
    const mrows = mdays.map((d, i) => ({ d, h: obj(r[k + i]) })); k += mdays.length;
    return send(res, 200, { ok: true, today, month, from, to, oldest, days: out, mdays: mrows, monthU: r[k] || 0, monthPU: r[k + 1] || 0, rangeU: r[k + 2] || 0, rangePU: r[k + 3] || 0, keys: r[k + 4] || 0 });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
