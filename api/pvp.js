// 실시간 친선전 (베타) — 서버는 방 상태와 각 턴의 선택만 보관한다. 전투 계산은 두 브라우저가 같은 시드로 똑같이 한다.
// 방 종류: 'pub'(공개 방 · 목록에서 누구나 들어온다) / 'code'(초대 코드 방 · 코드를 아는 사람만).
// 방에는 최대 6명. 들어온 순서대로 앞의 두 사람이 대전하고, 나머지는 관전한다. 방장은 언제나 가장 먼저 들어와 남아 있는 사람이다.
// 흐름: 방 만들기 → 두 번째 사람 입장 → 코인 토스(앞면이 선/후공 선택) → 턴마다 [선공 50초 → 후공 50초] → 다음 턴 선후공 교대.
// 선공이 고른 스킬의 절반(반올림)은 후공에게 ?로 숨겨진다. 끝난 턴은 모두에게 공개된다.
//
// POST /api/pvp { op:'new', slot, type, name, deck, v }   → { code }
// GET  /api/pvp?op=list&slot=n                            → { list:[{code,host,n,ph}] }   공개 방 목록
// POST /api/pvp { op:'join', slot, code, name, deck, v }  → { ok }
// GET  /api/pvp?op=get&code=XXXXXX&slot=n                 → { st }   (보는 사람에 맞춰 숨긴 상태)
// POST /api/pvp { op:'choose', slot, code, first }        → 토스 승자가 선공(true)/후공(false)
// POST /api/pvp { op:'pick', slot, code, turn, picks }     → 지금 차례인 사람의 선택
// POST /api/pvp { op:'timeout', slot, code }               → 제한 시간이 지났으면 빈 선택으로 넘긴다
// POST /api/pvp { op:'end', slot, code, w }                → 끝남 ('h' | 'g' | 'draw')
// POST /api/pvp { op:'rematch', slot, code }               → (방장) 다음 대전
// POST /api/pvp { op:'leave', slot, code }                 → 나가기 (대전 중이면 기권)
import crypto from 'node:crypto';
import { hasDb, redis, sessionUser, send, body, limited } from './_lib.js';

const TTL = 7200, PICK_MS = 50000, GRACE = 3000, MAX_MEM = 6, IDLE = 45000;
const ID = /^[A-Za-z0-9_]{1,32}$/;
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const txt = (v, n) => String(v || '').replace(/[<>&"']/g, '').slice(0, n);
const q = (req, k) => req.query?.[k] ?? new URL(req.url, 'http://x').searchParams.get(k);
const other = s => (s === 'h' ? 'g' : 'h');
const code6 = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const x of crypto.randomBytes(6)) s += A[x % A.length]; return s; };
const firstOf = r => (r.turn % 2 === 1 ? r.f1 : other(r.f1));
const inBattle = r => ['toss', 'p1', 'p2'].includes(r.ph);

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
// 앞의 두 사람으로 새 대전을 준비한다 (두 명이 안 되면 대기)
function seat(r) {
  const [a, b] = r.mem;
  Object.assign(r, { h: a ? a.id : null, hn: a ? a.n : null, hd: a ? a.d : null, g: b ? b.id : null, gn: b ? b.n : null, gd: b ? b.d : null,
    seed: crypto.randomInt(1, 2 ** 31 - 1), f1: null, turn: 0, P: {}, end: null, dl: 0 });
  if (a && b) { r.tw = crypto.randomInt(2) ? 'h' : 'g'; r.ph = 'toss'; } else { r.tw = null; r.ph = 'wait'; }
}
// 사람이 빠질 때: 대전 중인 사람이면 기권 처리, 아니면 자리만 다시 정한다
function drop(r, id, why) {
  const i = r.mem.findIndex(m => m.id === id); if (i < 0) return;
  const side = r.h === id ? 'h' : r.g === id ? 'g' : null;
  r.mem.splice(i, 1);
  if (side && (r.ph === 'p1' || r.ph === 'p2')) { r.ph = 'end'; r.end = { w: other(side), by: why || 'leave', who: side }; }
  else if (side && (r.ph === 'toss' || r.ph === 'wait')) seat(r);
}
function prune(r) {
  const now = Date.now();
  for (const m of r.mem.slice()) if (now - (m.seen || 0) > IDLE) drop(r, m.id, 'idle');
}
function view(r, side, me) {
  const P = {};
  for (const k of Object.keys(r.P)) {
    const t = +k, x = r.P[k];
    if (t < r.turn || r.ph === 'end') { P[k] = x; continue; }
    const first = firstOf(r);
    if (side === first) P[k] = { f: x.f || null };
    else if (side === other(first) && r.ph === 'p2' && x.f) P[k] = { f: x.f.map((p, i) => (x.hid.includes(i) ? { o: p.o === null ? null : '?', u: p.u, sl: null } : p)), hid: x.hid };
  }
  return { side, type: r.type, host: r.mem[0] ? r.mem[0].id === me : false, mem: r.mem.map((m, i) => ({ n: m.n, me: m.id === me, role: i === 0 ? 'host' : i < 2 ? 'p' : 'x' })),
    hn: r.hn, gn: r.gn, hd: r.hd, gd: r.gd, seed: r.seed, tw: r.tw, f1: r.f1, turn: r.turn, ph: r.ph, dl: r.dl, now: Date.now(), end: r.end || null, v: r.v, P };
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
      const type = b.type === 'pub' ? 'pub' : 'code';
      let code = code6();
      for (let i = 0; i < 4 && await redis('EXISTS', `rt:${code}`); i++) code = code6();
      const r = { type, v: txt(b.v, 20), mem: [{ id, n: txt(b.name, 20) || uid, d: deck, seen: Date.now() }], P: {}, at: Date.now() };
      seat(r);
      await redis('SET', `rt:${code}`, JSON.stringify(r), 'EX', TTL);
      if (type === 'pub') await redis('SADD', 'rt:pub', code);
      return send(res, 200, { code });
    }
    if (op === 'list') {
      const codes = (await redis('SMEMBERS', 'rt:pub')) || [];
      if (!codes.length) return send(res, 200, { list: [] });
      const raw = await redis('MGET', ...codes.map(c => `rt:${c}`));
      const gone = [], list = [];
      codes.forEach((c, i) => {
        if (!raw[i]) { gone.push(c); return; }
        const r = JSON.parse(raw[i]); if (r.type !== 'pub') return;
        const live = r.mem.filter(m => Date.now() - (m.seen || 0) <= IDLE);
        if (!live.length) { gone.push(c); return; }
        list.push({ code: c, host: live[0].n, n: live.length, ph: r.ph, v: r.v, at: r.at });
      });
      if (gone.length) await redis('SREM', 'rt:pub', ...gone);
      list.sort((x, y) => (x.ph === 'wait' ? 0 : 1) - (y.ph === 'wait' ? 0 : 1) || y.at - x.at);
      return send(res, 200, { list: list.slice(0, 20) });
    }
    const code = String((req.method === 'GET' ? q(req, 'code') : b.code) || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return send(res, 400, { code: 'bad' });
    const key = `rt:${code}`;
    const raw = await redis('GET', key); if (!raw) return send(res, 404, { code: 'noroom' });
    const r = JSON.parse(raw);
    const save = async () => {
      if (!r.mem.length) { await redis('DEL', key); await redis('SREM', 'rt:pub', code); return; }
      await redis('SET', key, JSON.stringify(r), 'EX', TTL);
    };
    prune(r);

    if (op === 'join' && req.method === 'POST') {
      const have = r.mem.find(m => m.id === id);
      if (!have) {
        if (r.mem.length >= MAX_MEM) return send(res, 409, { code: 'full' });
        if (r.v && txt(b.v, 20) !== r.v) return send(res, 409, { code: 'ver', v: r.v });
        const deck = cleanDeck(b.deck); if (!deck) return send(res, 400, { code: 'bad' });
        r.mem.push({ id, n: txt(b.name, 20) || uid, d: deck, seen: Date.now() });
        if (r.ph === 'wait' && r.mem.length >= 2) seat(r);
      } else have.seen = Date.now();
      await save(); return send(res, 200, { ok: true });
    }
    const meM = r.mem.find(m => m.id === id);
    if (!meM) { await save(); return send(res, 403, { code: 'notin' }); }
    meM.seen = Date.now();
    const side = r.h === id ? 'h' : r.g === id ? 'g' : 'x';

    if (op === 'get') { await save(); return send(res, 200, { st: view(r, side, id) }); }
    if (op === 'choose' && req.method === 'POST') {
      if (r.ph !== 'toss' || r.tw !== side) return send(res, 409, { code: 'turn' });
      r.f1 = b.first ? side : other(side); r.turn = 1; r.ph = 'p1'; r.dl = Date.now() + PICK_MS + 4000;
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'pick' && req.method === 'POST') {
      if (num(b.turn, 0, 999) !== r.turn) return send(res, 409, { code: 'turn' });
      const first = firstOf(r);
      const mine = (r.ph === 'p1' && side === first) || (r.ph === 'p2' && side === other(first));
      if (!mine) return send(res, 409, { code: 'turn' });
      const P = r.P[r.turn] = r.P[r.turn] || {};
      P[r.ph === 'p1' ? 'f' : 's'] = cleanPicks(b.picks);
      advance(r); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'timeout' && req.method === 'POST') {
      if ((r.ph === 'p1' || r.ph === 'p2') && Date.now() > r.dl + GRACE) advance(r);
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'end' && req.method === 'POST') {
      if (inBattle(r) && side !== 'x') { r.ph = 'end'; r.end = { w: ['h', 'g', 'draw'].includes(b.w) ? b.w : 'draw', by: 'sim' }; }
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'rematch' && req.method === 'POST') {
      if (r.mem[0].id !== id) return send(res, 403, { code: 'host' });
      if (r.ph !== 'end') return send(res, 409, { code: 'turn' });
      seat(r); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'leave' && req.method === 'POST') {
      drop(r, id, 'leave'); await save(); return send(res, 200, { ok: true });
    }
    return send(res, 400, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
