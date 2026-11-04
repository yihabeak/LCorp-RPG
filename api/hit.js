// POST /api/hit { vid, open?, li?, play?: { 'YYYY-MM-DD': 초 }, app?, mo?, ref?, ver?, src? }
// 접속 통계만 남긴다: 방문 수, 고유 방문자(HyperLogLog — 아이디·IP 원문은 저장하지 않음),
// 접속 지역(국가/도시 단위 집계), 시간대, 기기 종류, 설치 앱 여부, 들어온 사이트(도메인만), 게임 버전, 플레이 시간.
// 키는 100일 뒤 자동으로 지워진다.
import { hasDb, pipe, send, body, kday, STAT_TTL } from './_lib.js';

const VID = /^[A-Za-z0-9_-]{12,40}$/;
const clean = (s, n) => String(s || '').toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, n);

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, 405, { code: 'bad' });
    if (!hasDb) return send(res, 200, { ok: false });
    const b = body(req);
    const vid = String(b.vid || '');
    if (!VID.test(vid)) return send(res, 400, { code: 'bad' });
    const today = kday();
    const cmds = [];
    if (b.open) {
      const h = req.headers;
      const cc = String(h['x-vercel-ip-country'] || '??').slice(0, 2).toUpperCase().replace(/[^A-Z?]/g, '?');
      let city = '';
      try { city = decodeURIComponent(String(h['x-vercel-ip-city'] || '')); } catch { }
      city = city.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 30);
      const hr = String(new Date(Date.now() + 9 * 3600e3).getUTCHours()).padStart(2, '0');
      const ref = clean(b.ref, 40), ver = String(b.ver || '').replace(/[^0-9.]/g, '').slice(0, 12), src = clean(b.src, 16);
      cmds.push(['HINCRBY', 'st:' + today, 'v', 1]);              // 0: 방문 수
      cmds.push(['PFADD', 'st:u:' + today, vid]);                 // 고유 방문자
      cmds.push(['HINCRBY', 'st:' + today, 'l:' + cc + (city ? '/' + city : ''), 1]);
      cmds.push(['HINCRBY', 'st:' + today, 'hr:' + hr, 1]);       // 시간대 (한국 시간)
      cmds.push(['HINCRBY', 'st:' + today, b.mo ? 'dv:m' : 'dv:d', 1]);   // 모바일 / 컴퓨터
      cmds.push(['HINCRBY', 'st:' + today, b.app ? 'ap:app' : 'ap:web', 1]); // 설치한 앱 / 브라우저
      cmds.push(['HINCRBY', 'st:' + today, 'r:' + (ref || src && ('?' + src) || '-'), 1]);  // 들어온 곳 (도메인만, 없으면 -)
      if (ver) cmds.push(['HINCRBY', 'st:' + today, 'vr:' + ver, 1]);
      if (b.li) cmds.push(['HINCRBY', 'st:' + today, 'vl', 1]);   // 로그인 상태 방문
    }
    // 플레이 시간: 최근 3일 이내 날짜만, 하루 12시간까지
    const lim = Date.now() - 3 * 86400e3;
    Object.entries(b.play && typeof b.play === 'object' ? b.play : {}).slice(0, 4).forEach(([d, s]) => {
      const sec = Math.round(Number(s));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || d < kday(lim) || !(sec > 0)) return;
      cmds.push(['HINCRBY', 'st:' + d, 'p', Math.min(sec, 43200)]);
      cmds.push(['PFADD', 'st:pu:' + d, vid]);
      cmds.push(['EXPIRE', 'st:pu:' + d, STAT_TTL]);
    });
    if (!cmds.length) return send(res, 200, { ok: true });
    const r = await pipe(cmds);
    // 그날 첫 방문이면 수명을 한 번만 걸어 둔다
    if (b.open && r[0] === 1) await pipe([['EXPIRE', 'st:' + today, STAT_TTL], ['EXPIRE', 'st:u:' + today, STAT_TTL]]);
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server' });
  }
}
