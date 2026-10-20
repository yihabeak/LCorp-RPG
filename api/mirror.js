// 아인·소프·오르 — 거울 세계의 비동기 PvP · 친선전(베타)
// 모든 요청은 로그인(사원증) 필요. 계산은 각자의 브라우저에서 하고, 서버는 덱·전적·방만 보관한다.
//
// 모든 요청에 slot(0~3, 계정 저장소 번호)을 붙인다. 덱 · 전적 · 순위는 계정+저장소마다 따로다.
// GET  /api/mirror?op=me                    → { def, st:{pts,w,l,dw,dl}, rank }
// PUT  /api/mirror { op:'def', name, deck } → 수비 덱 등록
// GET  /api/mirror?op=find                  → { list:[{k,n,pw,deck,pts}] }   도전 상대 최대 3
// POST /api/mirror { op:'fight', k, win }   → { pts, gain, left }            도전 결과 (하루 10회 · 같은 상대는 하루 1회만 점수)
// GET  /api/mirror?op=rank                  → { list:[{n,pts}] }             상위 20
// POST /api/mirror { op:'room_new', name, deck }          → { code }
// POST /api/mirror { op:'room_join', code, name, deck }   → { ok }
// GET  /api/mirror?op=room&code=XXXXXX                    → { room }
// POST /api/mirror { op:'room_score', code, score }       → { ok }
import crypto from 'node:crypto';
import { hasDb, redis, pipe, sessionUser, send, body, kday, limited } from './_lib.js';

const DAY_MAX = 10;
const ROOM_TTL = 1800;
// 장비 id: 기본 영문·숫자·_ 에 변조 장비 표시(~)까지 — 예: baton~pierce
const ID = /^[A-Za-z0-9_][A-Za-z0-9_~.-]{0,63}$/;
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const txt = (v, n) => String(v || '').replace(/[<>&"']/g, '').slice(0, n);

function cleanDeck(d) {
  if (!Array.isArray(d) || d.length < 1 || d.length > 3) return null;
  const out = [];
  for (const m of d) {
    if (!m || typeof m !== 'object') return null;
    const w = String(m.w || 'baton'), s = String(m.s || 'basic');
    if (!ID.test(w) || !ID.test(s)) return null;
    const st = m.st || {};
    out.push({
      pl: m.pl ? 1 : 0, n: txt(m.n, 20) || '?', rk: num(m.rk, 1, 5), hp: num(m.hp, 1, 999),
      st: { F: num(st.F, 0, 999), P: num(st.P, 0, 999), T: num(st.T, 0, 999), J: num(st.J, 0, 999) }, w, s,
      g: (Array.isArray(m.g) ? m.g : []).map(String).filter(x => ID.test(x)).slice(0, 3), gp: num(m.gp, 0, 5), gs: num(m.gs, 0, 5)
    });
  }
  return out;
}
function cleanMem(x, run) {
  if (!x || typeof x !== 'object') return null;
  const st = x.st || {}; const w = String(x.w || 'baton'), s = String(x.s || 'basic');
  return { n: txt(x.n, 20) || '?', rk: num(x.rk, 1, 5), hp: num(x.hp, 1, 999),
    st: { F: num(st.F, 0, 999), P: num(st.P, 0, 999), T: num(st.T, 0, 999), J: num(st.J, 0, 999) },
    dept: ID.test(String(x.dept || '')) ? String(x.dept) : '', w: ID.test(w) ? w : 'baton', s: ID.test(s) ? s : 'basic',
    day: num(x.day, 0, 999), alive: x.alive ? 1 : 0, run: txt(run || x.run, 12), at: num(x.at, 0, 9e15), mg: txt(x.mg, 20) };
}
function cleanArch(a) {
  if (!a || typeof a !== 'object') return null;
  const out = { v: 1, ag: {}, pl: {}, w: [], s: [], g: [] };
  const KEY = /^[A-Za-z0-9_@~.-]{1,64}$/;
  for (const t of ['ag', 'pl']) {
    const E = Object.entries(a[t] || {}).slice(0, t === 'ag' ? 300 : 60);
    for (const [k, v] of E) { if (!KEY.test(k)) continue; const m = cleanMem(v); if (m) out[t][k] = m; }
  }
  for (const t of ['w', 's', 'g']) out[t] = [...new Set((Array.isArray(a[t]) ? a[t] : []).map(String).filter(x => ID.test(x)))].slice(0, 400);
  return out;
}
const power = d => d.reduce((a, m) => a + m.rk * 10 + Math.round(m.hp / 10), 0);
const code6 = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(6); let s = ''; for (const x of b) s += A[x % A.length]; return s; };
const q = (req, k) => req.query?.[k] ?? new URL(req.url, 'http://x').searchParams.get(k);
const stOf = h => { const o = { pts: 0, w: 0, l: 0, dw: 0, dl: 0 }; if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) o[h[i]] = Number(h[i + 1]) || 0; return o; };

const base = x => String(x).split('~')[0];
function named(deck, uid) { for (const m of deck) if (m.pl) m.n = String(uid).slice(0, 20); return deck; }
// 예전 방식(저장소마다 따로) 기록을 계정 하나로 합친다: 지워진 저장소는 버리고, 점수는 가장 높은 것 하나, 수비 덱은 가장 최근 것
async function migrate(uid) {
  if (await redis('GET', `m:mig2:${uid}`)) return;
  const L = [1, 2, 3].map(s => `${uid}~${s}`);
  const r = await pipe([...L.map(x => ['GET', `m:def:${x}`]), ...L.map(x => ['ZSCORE', 'm:rank', x]), ...[1, 2, 3].map(s => ['EXISTS', `s:${uid}:${s}`]), ['GET', `m:def:${uid}`], ['ZSCORE', 'm:rank', uid], ['HGETALL', `m:st:${uid}`]]);
  const defs = r.slice(0, 3), sc = r.slice(3, 6), ex = r.slice(6, 9);
  let best = r[9] ? JSON.parse(r[9]) : null, pts = Number(r[10]) || 0, stK = null, stP = r[10] == null ? -1 : pts;
  const cmds = [];
  for (let i = 0; i < 3; i++) {
    const x = L[i]; cmds.push(['SREM', 'm:pool', x], ['ZREM', 'm:rank', x], ['DEL', `m:def:${x}`]);
    if (!defs[i] || !ex[i]) continue; // 지워진 저장소는 버린다
    const d = JSON.parse(defs[i]); d.slot = i + 1; d.n = uid; named(d.deck || [], uid);
    if (!best || (d.at || 0) > (best.at || 0)) best = d;
    const p = Number(sc[i]) || 0; if (p > stP) { stP = p; stK = x; }
  }
  if (stK) { const h = await redis('HGETALL', `m:st:${stK}`); const o = stOf(h); o.pts = stP; cmds.push(['HSET', `m:st:${uid}`, 'pts', o.pts, 'w', o.w, 'l', o.l, 'dw', o.dw, 'dl', o.dl]); pts = stP; }
  if (best) { best.n = uid; cmds.push(['SET', `m:def:${uid}`, JSON.stringify(best)], ['SADD', 'm:pool', uid], ['ZADD', 'm:rank', Math.max(0, pts), uid]); }
  cmds.push(['SET', `m:mig2:${uid}`, '1']);
  await pipe(cmds);
}
// 목록에 남은 예전 기록(저장소별 id) 정리: 지워진 저장소이거나 이미 합쳐진 계정이면 내린다
async function clean(ids) {
  const old = ids.filter(x => String(x).includes('~')); if (!old.length) return ids;
  const r = await pipe(old.flatMap(x => { const [u, s] = String(x).split('~'); return [['EXISTS', `s:${u}:${s}`], ['GET', `m:mig2:${u}`]]; }));
  const drop = new Set(); old.forEach((x, i) => { if (!r[2 * i] || r[2 * i + 1]) drop.add(x); });
  if (drop.size) await pipe([...drop].flatMap(x => [['SREM', 'm:pool', x], ['ZREM', 'm:rank', x]]));
  return ids.filter(x => !drop.has(x));
}

export default async function handler(req, res) {
  try {
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    const uid = await sessionUser(req);
    if (!uid) return send(res, 401, { code: 'auth' });
    const b = req.method === 'GET' ? {} : body(req);
    const op = req.method === 'GET' ? q(req, 'op') : b.op;
    // 계정 하나 = 거울 세계의 관리직 하나. 이름은 계정 아이디. 저장소 번호는 수비 덱이 어디서 왔는지만 기록한다.
    const slot = num(req.method === 'GET' ? q(req, 'slot') : b.slot, 0, 3);
    const id = uid;
    await migrate(uid);

    // 보관함: 계정 하나에 하나 (저장소와 무관) — 엔딩을 봐도 남는 직원 · 장비 · 기프트
    if (op === 'arch') {
      const k = `m:arch:${uid}`;
      if (req.method === 'GET') { const raw = await redis('GET', k); return send(res, 200, { arch: raw ? JSON.parse(raw) : null }); }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (await limited(req, 'march', 30)) return send(res, 429, { code: 'slow' });
        const a = cleanArch(b.arch); if (!a) return send(res, 400, { code: 'bad' });
        const j = JSON.stringify(a); if (j.length > 400000) return send(res, 413, { code: 'big' });
        await redis('SET', k, j); return send(res, 200, { ok: true });
      }
    }
    // 저장소를 지웠을 때: 그 저장소에서 올린 수비 덱은 도전 · 순위에서 내린다 (점수 기록은 계정에 남는다)
    if (op === 'slot_del' && req.method === 'POST') {
      const raw = await redis('GET', `m:def:${id}`); const d = raw ? JSON.parse(raw) : null;
      const cmds = [['DEL', `m:def:${uid}~${slot}`], ['SREM', 'm:pool', `${uid}~${slot}`], ['ZREM', 'm:rank', `${uid}~${slot}`]];
      if (d && Number(d.slot) === slot) cmds.push(['DEL', `m:def:${id}`], ['SREM', 'm:pool', id], ['ZREM', 'm:rank', id]);
      await pipe(cmds); return send(res, 200, { ok: true, removed: !!(d && Number(d.slot) === slot) });
    }
    if (op === 'me') {
      const [def, h, rk] = await pipe([['GET', `m:def:${id}`], ['HGETALL', `m:st:${id}`], ['ZREVRANK', 'm:rank', id]]);
      return send(res, 200, { def: def ? JSON.parse(def) : null, st: stOf(h), rank: rk == null ? null : rk + 1 });
    }
    if (op === 'def' && (req.method === 'PUT' || req.method === 'POST')) {
      if (await limited(req, 'mdef', 30)) return send(res, 429, { code: 'slow' });
      const deck = cleanDeck(b.deck); if (!deck) return send(res, 400, { code: 'bad' });
      named(deck, uid); const rec = { n: uid, deck, pw: power(deck), at: Date.now(), slot };
      // 다른 저장소에서 올린 수비 덱이 있으면 이것으로 바꾼다. 순위 점수는 계정에 남아 있던 점수로 되살린다.
      const [keepRaw, oldRaw] = await pipe([['HGET', `m:st:${id}`, 'pts'], ['GET', `m:def:${id}`]]);
      const keep = Number(keepRaw) || 0; const old = oldRaw ? JSON.parse(oldRaw) : null;
      await pipe([['SET', `m:def:${id}`, JSON.stringify(rec)], ['SADD', 'm:pool', id], ['ZADD', 'm:rank', 'NX', keep, id]]);
      return send(res, 200, { ok: true, pw: rec.pw, prev: old && old.slot && Number(old.slot) !== slot ? Number(old.slot) : null });
    }
    if (op === 'find') {
      if (await limited(req, 'mfind', 60)) return send(res, 429, { code: 'slow' });
      const ids = [...new Set((await clean(await redis('SRANDMEMBER', 'm:pool', 16) || [])).filter(x => base(x) !== uid))].slice(0, 8);
      if (!ids.length) return send(res, 200, { list: [] });
      const raw = await redis('MGET', ...ids.map(x => `m:def:${x}`));
      const sc = await pipe(ids.map(x => ['ZSCORE', 'm:rank', x]));
      const list = ids.map((k, i) => raw[i] ? Object.assign(JSON.parse(raw[i]), { k, pts: Number(sc[i]) || 0 }) : null).filter(Boolean);
      const mine = await redis('GET', `m:def:${id}`); const myPw = mine ? JSON.parse(mine).pw : 0;
      list.sort((x, y) => Math.abs(x.pw - myPw) - Math.abs(y.pw - myPw));
      return send(res, 200, { list: list.slice(0, 3).map(r => ({ k: r.k, n: base(r.k), pw: r.pw, pts: r.pts, deck: named(r.deck || [], base(r.k)) })) });
    }
    if (op === 'fight' && req.method === 'POST') {
      const k = String(b.k || ''); if (!k || k === id || k.length > 48) return send(res, 400, { code: 'bad' });
      const exists = await redis('EXISTS', `m:def:${k}`); if (!exists) return send(res, 404, { code: 'gone' });
      const dk = `m:day:${id}:${kday()}`;
      const [n, added] = await pipe([['INCR', dk + ':n'], ['SADD', dk, k], ['EXPIRE', dk + ':n', 172800], ['EXPIRE', dk, 172800]]);
      if (n > DAY_MAX) return send(res, 429, { code: 'daily', left: 0 });
      const win = !!b.win; const fresh = added === 1;
      const gain = fresh ? (win ? 20 : -8) : 0, dgain = fresh ? (win ? -5 : 5) : 0;
      const cmds = [['HINCRBY', `m:st:${id}`, win ? 'w' : 'l', 1], ['HINCRBY', `m:st:${k}`, win ? 'dl' : 'dw', 1]];
      if (gain) cmds.push(['ZINCRBY', 'm:rank', gain, id]);
      if (dgain) cmds.push(['ZINCRBY', 'm:rank', dgain, k]);
      await pipe(cmds);
      // 점수는 0 아래로 내려가지 않는다
      const [p1, p2] = await pipe([['ZSCORE', 'm:rank', id], ['ZSCORE', 'm:rank', k]]);
      const fix = []; if (Number(p1) < 0) fix.push(['ZADD', 'm:rank', 0, id]); if (Number(p2) < 0) fix.push(['ZADD', 'm:rank', 0, k]);
      if (fix.length) await pipe(fix);
      await redis('HSET', `m:st:${id}`, 'pts', Math.max(0, Number(p1) || 0));
      return send(res, 200, { pts: Math.max(0, Number(p1) || 0), gain, left: Math.max(0, DAY_MAX - n) });
    }
    if (op === 'rank') {
      const r = await redis('ZREVRANGE', 'm:rank', 0, 59, 'WITHSCORES') || [];
      const all = []; for (let i = 0; i < r.length; i += 2) all.push([r[i], Number(r[i + 1]) || 0]);
      const alive = new Set(await clean(all.map(x => x[0])));
      const seen = new Set(), ids = [];
      for (const x of all) { if (!alive.has(x[0])) continue; const k = base(x[0]); if (seen.has(k)) continue; seen.add(k); ids.push(x); if (ids.length >= 20) break; }
      if (!ids.length) return send(res, 200, { list: [] });
      const raw = await redis('MGET', ...ids.map(x => `m:def:${x[0]}`));
      return send(res, 200, { list: ids.map((x, i) => ({ n: base(x[0]), pts: x[1], me: base(x[0]) === uid })) });
    }
    // ---- 친선전 (베타) ----
    if (op === 'room_new' && req.method === 'POST') {
      if (await limited(req, 'mroom', 20)) return send(res, 429, { code: 'slow' });
      const deck = cleanDeck(b.deck); if (!deck) return send(res, 400, { code: 'bad' });
      let code = code6();
      for (let i = 0; i < 4 && await redis('EXISTS', `m:room:${code}`); i++) code = code6();
      named(deck, uid); const room = { h: id, hn: uid, hd: deck, g: null, gn: null, gd: null, hs: null, gs: null, at: Date.now() };
      await redis('SET', `m:room:${code}`, JSON.stringify(room), 'EX', ROOM_TTL);
      return send(res, 200, { code });
    }
    const code = String((req.method === 'GET' ? q(req, 'code') : b.code) || '').toUpperCase();
    if (op && op.startsWith('room') && !/^[A-Z0-9]{6}$/.test(code)) return send(res, 400, { code: 'bad' });
    const rkey = `m:room:${code}`;
    if (op === 'room_join' && req.method === 'POST') {
      const deck = cleanDeck(b.deck); if (!deck) return send(res, 400, { code: 'bad' });
      const raw = await redis('GET', rkey); if (!raw) return send(res, 404, { code: 'noroom' });
      const room = JSON.parse(raw);
      if (room.h === id) return send(res, 400, { code: 'self' });
      if (room.g && room.g !== id) return send(res, 409, { code: 'full' });
      named(deck, uid); Object.assign(room, { g: id, gn: uid, gd: deck });
      await redis('SET', rkey, JSON.stringify(room), 'EX', ROOM_TTL);
      return send(res, 200, { ok: true });
    }
    if (op === 'room') {
      const raw = await redis('GET', rkey); if (!raw) return send(res, 404, { code: 'noroom' });
      const r = JSON.parse(raw); const side = r.h === id ? 'h' : r.g === id ? 'g' : null;
      if (!side) return send(res, 403, { code: 'notin' });
      return send(res, 200, { room: { side, hn: r.hn, gn: r.gn, hd: r.hd, gd: r.gd, hs: r.hs, gs: r.gs } });
    }
    if (op === 'room_score' && req.method === 'POST') {
      const raw = await redis('GET', rkey); if (!raw) return send(res, 404, { code: 'noroom' });
      const r = JSON.parse(raw); const side = r.h === id ? 'h' : r.g === id ? 'g' : null;
      if (!side) return send(res, 403, { code: 'notin' });
      const s = b.score || {};
      r[side + 's'] = { win: s.win ? 1 : 0, hp: num(s.hp, 0, 100), t: num(s.t, 0, 999) };
      await redis('SET', rkey, JSON.stringify(r), 'EX', ROOM_TTL);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
