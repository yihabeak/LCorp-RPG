// 실시간 친선전 (베타) — 서버는 방 · 자리 · 각 턴의 선택만 보관한다. 전투 계산은 모든 브라우저가 같은 시드로 똑같이 한다.
// 방 종류: 'pub'(공개 · 목록에서 누구나) / 'code'(초대 코드). 방에는 최대 12명. 방장은 남아 있는 사람 중 가장 먼저 들어온 사람.
// 전투 방식(방장 설정): '1v1'(자리 2개) / 'team'(A팀 · B팀 각 5자리). 자리에 앉아 [준비]를 누르고, 앉은 사람이 모두 준비하면 시작.
// 흐름: 코인 토스(앞면 팀의 첫 사람이 선/후공 선택) → 턴마다 [선공 팀 50초 → 후공 팀 50초] → 다음 턴 선후공 교대.
// 선공 팀이 고른 스킬의 절반(반올림)은 후공 팀에게 ?로 숨겨진다. 끝난 턴은 모두에게 공개된다.
//
// POST /api/pvp { op:'new', slot, type, name, deck, v }   → { code }
// GET  /api/pvp?op=list&slot=n                            → { list }   공개 방 목록
// POST /api/pvp { op:'join', slot, code, name, deck, v }  → { ok }     (자리 없이 들어온다 = 관전)
// GET  /api/pvp?op=get&code=XXXXXX&slot=n                 → { st }
// POST /api/pvp { op:'mode', code, mode }                 → (방장 · 대기 중) '1v1' | 'team'
// POST /api/pvp { op:'sit', code, team }                  → 'A' | 'B' 자리에 앉기
// POST /api/pvp { op:'stand', code }                      → 자리에서 일어나기
// POST /api/pvp { op:'ready', code, on }                  → 준비 / 취소 (모두 준비되면 시작)
// POST /api/pvp { op:'choose', code, first }              → 토스에 이긴 팀의 첫 사람이 선공(true)/후공(false)
// POST /api/pvp { op:'pick', code, turn, picks }          → 내 유닛들의 선택
// POST /api/pvp { op:'timeout', code }                    → 시간이 지났으면 안 낸 사람은 빈 선택으로 넘긴다
// POST /api/pvp { op:'end', code, w }                     → 끝남 ('A' | 'B' | 'draw')
// POST /api/pvp { op:'rematch', code }                    → (방장) 대기실로
// POST /api/pvp { op:'leave', code }                      → 나가기
import crypto from 'node:crypto';
import { hasDb, redis, sessionUser, send, body, limited } from './_lib.js';

const TTL = 7200, PICK_MS = 50000, GRACE = 3000, MAX_MEM = 12, IDLE = 45000;
// 장비 id: 기본 영문·숫자·_ 에 변조 장비 표시(~)까지 — 예: baton~pierce
const ID = /^[A-Za-z0-9_][A-Za-z0-9_~.-]{0,63}$/;
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const txt = (v, n) => String(v || '').replace(/[<>&"']/g, '').slice(0, n);
const q = (req, k) => req.query?.[k] ?? new URL(req.url, 'http://x').searchParams.get(k);
const other = s => (s === 'A' ? 'B' : 'A');
const code6 = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const x of crypto.randomBytes(6)) s += A[x % A.length]; return s; };
const firstOf = r => (r.turn % 2 === 1 ? r.f1 : other(r.f1));
const cap = r => (r.mode === 'team' ? 5 : 1);
const fighting = r => r.ph === 'p1' || r.ph === 'p2';

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
    return { o, u: x.u == null ? null : num(x.u, 0, 9), sl: x.sl == null ? null : num(x.sl, 0, 40) };
  });
}
const seatOf = (r, id) => (r.seats.A.includes(id) ? 'A' : r.seats.B.includes(id) ? 'B' : null);
const teamOf = (r, id) => (r.bt ? (r.bt.A.some(x => x.id === id) ? 'A' : r.bt.B.some(x => x.id === id) ? 'B' : null) : null);
const present = (r, id) => r.mem.some(m => m.id === id);
// 이번 단계에 선택을 내야 하는 사람들: 그 팀에서 아직 방에 있는 사람
const owed = (r, team) => r.bt[team].map(x => x.id).filter(id => present(r, id));
function hideAll(f) {
  const used = [];
  for (const id of Object.keys(f)) f[id].forEach((p, i) => { if (p.o !== null) used.push([id, i]); });
  const n = Math.round(used.length / 2);
  for (let i = used.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [used[i], used[j]] = [used[j], used[i]]; }
  const hid = {}; used.slice(0, n).forEach(([id, i]) => { (hid[id] = hid[id] || []).push(i); });
  return hid;
}
function advance(r, force) {
  const t = r.turn, P = r.P[t] = r.P[t] || { f: {}, s: {} };
  const team = r.ph === 'p1' ? firstOf(r) : other(firstOf(r)), box = r.ph === 'p1' ? P.f : P.s;
  const left = owed(r, team).filter(id => !box[id]);
  if (left.length && !force) return;
  left.forEach(id => { box[id] = []; });
  if (r.ph === 'p1') { P.hid = hideAll(P.f); r.ph = 'p2'; r.dl = Date.now() + PICK_MS; }
  else { r.turn = t + 1; r.ph = 'p1'; r.dl = Date.now() + PICK_MS + 6000; r.P[r.turn] = { f: {}, s: {} }; }
}
function toLobby(r) {
  Object.assign(r, { ph: 'lobby', bt: null, seed: null, tw: null, f1: null, turn: 0, P: {}, end: null, dl: 0, ready: {} });
  r.seats.A = r.seats.A.filter(id => present(r, id)); r.seats.B = r.seats.B.filter(id => present(r, id));
}
function tryStart(r) {
  const S = [...r.seats.A, ...r.seats.B];
  if (r.ph !== 'lobby' || !r.seats.A.length || !r.seats.B.length || !S.every(id => r.ready[id])) return;
  const pick = id => { const m = r.mem.find(x => x.id === id); return { id, n: m.n, d: m.d }; };
  r.bt = { A: r.seats.A.map(pick), B: r.seats.B.map(pick), mode: r.mode };
  r.seed = crypto.randomInt(1, 2 ** 31 - 1); r.tw = crypto.randomInt(2) ? 'A' : 'B'; r.ph = 'toss'; r.turn = 0; r.P = {}; r.end = null;
}
function drop(r, id, why) {
  const i = r.mem.findIndex(m => m.id === id); if (i < 0) return;
  r.mem.splice(i, 1);
  r.seats.A = r.seats.A.filter(x => x !== id); r.seats.B = r.seats.B.filter(x => x !== id); delete r.ready[id];
  const team = teamOf(r, id);
  if (team && (r.ph === 'toss' || fighting(r))) {
    // 1:1이거나 그 팀에 남은 사람이 없으면 끝. 아니면 계속 (그 사람 유닛은 이후 행동 없음)
    if (r.bt.mode === '1v1' || !owed(r, team).length) { r.ph = 'end'; r.end = { w: other(team), by: why || 'leave', who: team }; }
    else if (r.ph === 'toss' && r.tw === team && r.bt[team][0].id === id) { /* 토스 승자가 떠나면 그 팀의 다음 사람이 고른다 */ }
    else if (fighting(r)) advance(r, false);
  }
}
function prune(r) { const now = Date.now(); for (const m of r.mem.slice()) if (now - (m.seen || 0) > IDLE) drop(r, m.id, 'idle'); }
function leaderOf(r, team) { return r.bt[team].map(x => x.id).find(id => present(r, id)); }
function view(r, me) {
  const myTeam = teamOf(r, me), P = {};
  for (const k of Object.keys(r.P)) {
    const t = +k, x = r.P[k];
    if (t < r.turn || r.ph === 'end') { P[k] = x; continue; }
    const first = firstOf(r);
    if (myTeam === first) P[k] = { f: x.f, done: Object.keys(x.f) };
    else if (myTeam === other(first)) {
      if (r.ph === 'p2') {
        const f = {}; for (const id of Object.keys(x.f)) f[id] = x.f[id].map((p, i) => ((x.hid[id] || []).includes(i) ? { o: p.o === null ? null : '?', u: p.u, sl: null } : p));
        P[k] = { f, s: x.s[me] ? { [me]: x.s[me] } : {}, done: Object.keys(x.s) };
      } else P[k] = { done: [] };
    } else P[k] = { done: Object.keys(r.ph === 'p1' ? x.f : x.s) };
  }
  return {
    me, type: r.type, mode: r.mode, host: r.mem[0] ? r.mem[0].id === me : false,
    mem: r.mem.map((m, i) => ({ id: m.id, n: m.n, seat: seatOf(r, m.id), ready: !!r.ready[m.id], host: i === 0 })),
    seats: r.seats, bt: r.bt, myTeam, leader: r.bt && r.tw ? leaderOf(r, r.tw) : null,
    seed: r.seed, tw: r.tw, f1: r.f1, turn: r.turn, ph: r.ph, dl: r.dl, now: Date.now(), end: r.end || null, v: r.v, P
  };
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
      const r = { type, mode: '1v1', v: txt(b.v, 20), mem: [{ id, n: txt(b.name, 20) || uid, d: deck, seen: Date.now() }], seats: { A: [], B: [] }, ready: {}, P: {}, at: Date.now() };
      toLobby(r);
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
        list.push({ code: c, host: live[0].n, n: live.length, ph: r.ph, mode: r.mode, v: r.v, at: r.at,
          free: r.ph === 'lobby' ? 2 * cap(r) - r.seats.A.length - r.seats.B.length : 0 });
      });
      if (gone.length) await redis('SREM', 'rt:pub', ...gone);
      list.sort((x, y) => (x.ph === 'lobby' ? 0 : 1) - (y.ph === 'lobby' ? 0 : 1) || y.at - x.at);
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
      } else have.seen = Date.now();
      await save(); return send(res, 200, { ok: true });
    }
    const meM = r.mem.find(m => m.id === id);
    if (!meM) { await save(); return send(res, 403, { code: 'notin' }); }
    meM.seen = Date.now();
    const isHost = r.mem[0].id === id;

    if (op === 'get') { if (fighting(r) && Date.now() > r.dl + GRACE + 2000) advance(r, true); await save(); return send(res, 200, { st: view(r, id) }); }
    if (op === 'mode' && req.method === 'POST') {
      if (!isHost || r.ph !== 'lobby') return send(res, 403, { code: 'host' });
      r.mode = b.mode === 'team' ? 'team' : '1v1'; r.seats = { A: [], B: [] }; r.ready = {};
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'sit' && req.method === 'POST') {
      if (r.ph !== 'lobby') return send(res, 409, { code: 'turn' });
      const team = b.team === 'B' ? 'B' : 'A';
      if (r.seats[team].includes(id)) { await save(); return send(res, 200, { ok: true }); }
      if (r.seats[team].length >= cap(r)) return send(res, 409, { code: 'seatfull' });
      r.seats.A = r.seats.A.filter(x => x !== id); r.seats.B = r.seats.B.filter(x => x !== id); r.seats[team].push(id); delete r.ready[id];
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'stand' && req.method === 'POST') {
      if (r.ph !== 'lobby') return send(res, 409, { code: 'turn' });
      r.seats.A = r.seats.A.filter(x => x !== id); r.seats.B = r.seats.B.filter(x => x !== id); delete r.ready[id];
      tryStart(r); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'ready' && req.method === 'POST') {
      if (r.ph !== 'lobby' || !seatOf(r, id)) return send(res, 409, { code: 'seat' });
      if (b.on) r.ready[id] = true; else delete r.ready[id];
      tryStart(r); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'choose' && req.method === 'POST') {
      if (r.ph !== 'toss' || leaderOf(r, r.tw) !== id) return send(res, 409, { code: 'turn' });
      r.f1 = b.first ? r.tw : other(r.tw); r.turn = 1; r.ph = 'p1'; r.dl = Date.now() + PICK_MS + 4000; r.P = { 1: { f: {}, s: {} } };
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'pick' && req.method === 'POST') {
      if (!fighting(r) || num(b.turn, 0, 999) !== r.turn) return send(res, 409, { code: 'turn' });
      const team = teamOf(r, id), first = firstOf(r);
      const mine = (r.ph === 'p1' && team === first) || (r.ph === 'p2' && team === other(first));
      if (!mine) return send(res, 409, { code: 'turn' });
      const P = r.P[r.turn] = r.P[r.turn] || { f: {}, s: {} };
      (r.ph === 'p1' ? P.f : P.s)[id] = cleanPicks(b.picks);
      advance(r, false); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'timeout' && req.method === 'POST') {
      if (fighting(r) && Date.now() > r.dl + GRACE) advance(r, true);
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'end' && req.method === 'POST') {
      if ((r.ph === 'toss' || fighting(r)) && teamOf(r, id)) { r.ph = 'end'; r.end = { w: ['A', 'B', 'draw'].includes(b.w) ? b.w : 'draw', by: 'sim' }; }
      await save(); return send(res, 200, { ok: true });
    }
    if (op === 'rematch' && req.method === 'POST') {
      if (!isHost) return send(res, 403, { code: 'host' });
      if (r.ph !== 'end') return send(res, 409, { code: 'turn' });
      toLobby(r); await save(); return send(res, 200, { ok: true });
    }
    if (op === 'leave' && req.method === 'POST') { drop(r, id, 'leave'); await save(); return send(res, 200, { ok: true }); }
    return send(res, 400, { code: 'bad' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
