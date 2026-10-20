// 실시간 친선전 (베타) — 서버는 방 상태와 각 턴의 선택만 보관한다. 전투 계산은 두 브라우저가 같은 시드로 똑같이 한다.
// 흐름: 방 만들기 → 참가 → 코인 토스(앞면이 선/후공 선택) → 턴마다 [선공 선택 50초 → 후공 선택 50초] → 다음 턴은 선후공이 바뀐다.
// 선공이 고른 스킬 중 절반(반올림)은 후공에게 ?로 숨겨진다. 선택이 끝난 턴은 양쪽에 모두 공개된다.
//
// POST /api/pvp { op:'new', slot, name, deck, v }          → { code }
// POST /api/pvp { op:'join', slot, code, name, deck, v }   → { ok }
// GET  /api/pvp?op=get&code=XXXXXX&slot=n                  → { st }   (보는 사람에 맞춰 숨긴 상태)
// POST /api/pvp { op:'choose', slot, code, first }         → 토스 승자가 선공(true)/후공(false)을 고른다
// POST /api/pvp { op:'pick', slot, code, turn, picks }      → 지금 차례인 사람의 선택
// POST /api/pvp { op:'timeout', slot, code }                → 제한 시간이 지났으면 빈 선택으로 넘긴다
// POST /api/pvp { op:'end', slot, code, w }                 → 끝남 ('h' | 'g' | 'draw')
// POST /api/pvp { op:'leave', slot, code }                  → 기권
import crypto from 'node:crypto';
import { hasDb, redis, sessionUser, send, body, limited } from './_lib.js';

const TTL = 7200, PICK_MS = 50000, GRACE = 3000;
const ID = /^[A-Za-z0-9_]{1,32}$/;
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const txt = (v, n) => String(v || '').replace(/[<>&"']/g, '').slice(0, n);
const q = (req, k) => req.query?.[k] ?? new URL(req.url, 'http://x').searchParams.get(k);
const other = s => (s === 'h' ? 'g' : 'h');
const code6 = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const x of crypto.randomBytes(6)) s += A[x % A.length]; return s; };
const firstOf = r => (r.turn % 2 === 1 ? r.f1 : other(r.f1));

function cleanDeck(d) {
  if (!Array.isArray(d) || d.length < 1 || d.length > 3) return null;
  const out = [];
  for (const m of d) {
    if (!m || typeof m !== 'object') return null;
    const w = String(m.w || 'baton'), s = String(m.s || 'basic');
    if (!ID.test(w) || !ID.test(s)) return null;
    const st = m.st || {};
    out.push({ pl: m.pl ? 1 : 0, n: txt(m.n, 20) || '?', rk: num(m.rk, 1, 5), hp: num(m.hp, 1, 999),
      st: { F: num(st.F, 0, 999), P: num(st.P, 0, 999), T: num(st.T, 0, 999), J: num(st.J, 0, 999) }, w, s });
  }
  return out;
}
function cleanPicks(p) {
  if (!Array.isArray(p) || p.length > 12) return [];
  return p.map(x => {
    x = x || {};
    const o = x.o === 0 || x.o === 1 ? x.o : x.o === 'd' ? 'd' : null;
    return { o, u: x.u == null ? null : num(x.u, 0, 2), sl: x.sl == null ? null : num(x.sl, 0, 11) };
  });
}
function hideIdx(p) {
  const used = p.map((x, i) => (x.o !== null ? i : -1)).filter(i => i >= 0);
  const n = Math.round(used.length / 2);
  for (let i = used.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [used[i], used[j]] = [used[j], used[i]]; }
  return used.slice(0, n).sort((a, b) => a - b);
}
function advance(r) {
  const t = r.turn, P = r.P[t] = r.P[t] || {};
  if (r.ph === 'p1') { if (!P.f) P.f = []; P.hid = hideIdx(P.f); r.ph = 'p2'; r.dl = Date.now() + PICK_MS; }
  else if (r.ph === 'p2') { if (!P.s) P.s = []; r.turn = t + 1; r.ph = 'p1'; r.dl = Date.now() + PICK_MS + 6000; }
}
function view(r, side) {
  const P = {};
  for (const k of Object.keys(r.P)) {
    const t = +k, x = r.P[k];
    if (t < r.turn || r.ph === 'end') { P[k] = x; continue; }
    const first = firstOf(r);
    if (side === first) P[k] = { f: x.f || null };
    else if (r.ph === 'p2' && x.f) P[k] = { f: x.f.map((p, i) => (x.hid.includes(i) ? { o: p.o === null ? null : '?', u: p.u, sl: null } : p)), hid: x.hid };
  }
  return { side, hn: r.hn, gn: r.gn, hd: r.hd, gd: r.gd, seed: r.seed, tw: r.tw, f1: r.f1, turn: r.turn, ph: r.ph, dl: r.dl, now: Date.now(), end: r.end || null, v: r.v, P };
}

export default async function handler(req, res) {
  try {
    if (!hasDb) return send(res, 503, { code: 'nodb' });
    const uid = await sessionUser(req);
    if (!uid) return send(res, 401, { code: 'auth' });
    const b = req.method === 'GET' ? {} : body(req);
    const op = req.method === 'GET' ? q(req, 'op') : b.op;
    const slot = num(req.method === 'GET' ? q(req, 'slot') : b.slot, 0, 3);
    const id = slot ? `${uid}~${slot}` : uid;

    if (op === 'new' && req.method === 'POST') {
      if (await limited(req, 'rtnew', 20)) return send(res, 429, { code: 'slow' });
      const deck = cleanDeck(b.deck); if (!deck) return send(res, 400, { code: 'bad' });
      let code = code6();
      for (let i = 0; i < 4 && await redis('EXISTS', `rt:${code}`); i++) code = code6();
      const r = { h: id, hn: txt(b.name, 20) || uid, hd: deck, g: null, gn: null, gd: null, v: txt(b.v, 20), seed: crypto.randomInt(1, 2 ** 31 - 1),
        tw: null, f1: null, turn: 0, ph: 'wait', dl: 0, P: {}, at: Date.now() };
      await redis('SET', `rt:${code}`, JSON.stringify(r), 'EX', TTL);
      return send(res, 200, { code });
    }
    const code = String((req.method === 'GET' ? q(req, 'code') : b.code) || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return send(res, 400, { code: 'bad' });
    const key = `rt:${code}`;
    const raw = await redis('GET', key); if (!raw) return send(res, 404, { code: 'noroom' });
    const r = JSON.parse(raw);
    const save = () => redis('SET', key, JSON.stringify(r), 'EX', TTL);

    if (op === 'join' && req.method === 'POST') {
      if (r.h === id) return send(res, 400, { code: 'self' });
      if (r.g && r.g !== id) return send(res, 409, { code: 'full' });
      if (r.v && txt(b.v, 20) !== r.v) return send(res, 409, { code: 'ver', v: r.v });
      const deck = cleanDeck(b.deck); if (!deck) return send(res, 400, { code: 'bad' });
      if (!r.g) { Object.assign(r, { g: id, gn: txt(b.name, 20) || uid, gd: deck, tw: crypto.randomInt(2) ? 'h' : 'g', ph: 'toss' }); await save(); }
      return send(res, 200, { ok: true });
    }
    const side = r.h === id ? 'h' : r.g === id ? 'g' : null;
    if (!side) return send(res, 403, { code: 'notin' });

    if (op === 'get') return send(res, 200, { st: view(r, side) });
    if (op === 'choose' && req.method === 'POST') {
      if (r.ph !== 'toss' || r.tw !== side) return send(res, 409, { code: 'turn' });
      r.f1 = b.first ? side : other(side); r.turn = 1; r.ph = 'p1'; r.dl = Date.now() + PICK_MS + 4000;
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'pick' && req.method === 'POST') {
      if (num(b.turn, 0, 999) !== r.turn) return send(res, 409, { code: 'turn' });
      const first = firstOf(r);
      const mine = (r.ph === 'p1' && side === first) || (r.ph === 'p2' && side !== first);
      if (!mine) return send(res, 409, { code: 'turn' });
      const P = r.P[r.turn] = r.P[r.turn] || {};
      P[r.ph === 'p1' ? 'f' : 's'] = cleanPicks(b.picks);
      advance(r); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'timeout' && req.method === 'POST') {
      if ((r.ph === 'p1' || r.ph === 'p2') && Date.now() > r.dl + GRACE) { advance(r); await save(); }
      return send(res, 200, { ok: true });
    }
    if (op === 'end' && req.method === 'POST') {
      if (r.ph !== 'end') { r.ph = 'end'; r.end = { w: ['h', 'g', 'draw'].includes(b.w) ? b.w : 'draw', by: 'sim' }; await save(); }
      return send(res, 200, { ok: true });
    }
    if (op === 'leave' && req.method === 'POST') {
      if (r.ph !== 'end') { r.ph = 'end'; r.end = { w: r.g ? other(side) : 'draw', by: 'leave', who: side }; await save(); }
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
