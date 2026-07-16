/* CF 랭크 디펜스 서버 (Render + Neon PostgreSQL)
 * - DATABASE_URL 있으면 Postgres KV, 없으면 로컬 data.json (개발용)
 * - Netlify Functions 버전과 API 100% 호환
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(require("compression")()); /* 대역폭 절감: 모든 응답 gzip */
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ================= KV 저장소 (Postgres 또는 파일) ================= */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}
/* 휘발성 데이터(방·라이브·채팅)는 서버 메모리 — 폴링이 DB를 깨우지 않고,
 * 같은 객체 참조라 RMW 경합도 없음. 내구 데이터("db")만 Postgres. */
const MEM = new Map();
const isEphemeral = k => k !== "db";
const DATA_FILE = path.join(__dirname, "data.json");
let FILESTORE = {};
try { FILESTORE = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) } catch (e) {}
let fileSaveT = null;
function fileSave() {
  clearTimeout(fileSaveT);
  fileSaveT = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(FILESTORE), () => {}), 300);
}
async function kvInit() {
  if (pool) await pool.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)");
}
async function kvGet(k) {
  if (pool) {
    if (isEphemeral(k)) return MEM.get(k) ?? null;
    const r = await pool.query("SELECT v FROM kv WHERE k=$1", [k]);
    return r.rows[0] ? r.rows[0].v : null;
  }
  return FILESTORE[k] ?? null;
}
async function kvSet(k, v) {
  if (pool) {
    if (isEphemeral(k)) { MEM.set(k, v); return }
    await pool.query("INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2",
      [k, JSON.stringify(v)]);
  } else { FILESTORE[k] = v; fileSave() }
}
async function kvDel(k) {
  if (pool) {
    if (isEphemeral(k)) { MEM.delete(k); return }
    await pool.query("DELETE FROM kv WHERE k=$1", [k]);
  }
  else { delete FILESTORE[k]; fileSave() }
}
async function kvList(prefix) {
  if (pool) {
    const out = [];
    for (const [key, value] of MEM) if (key.startsWith(prefix)) out.push({ key, value });
    return out;
  }
  return Object.entries(FILESTORE).filter(([k]) => k.startsWith(prefix))
    .map(([key, value]) => ({ key, value }));
}

async function loadDB() {
  return (await kvGet("db")) || { users: {}, tokens: {} };
}
async function saveDB(d) { await kvSet("db", d) }
/* db 변경은 반드시 이 헬퍼로 — advisory lock으로 read-modify-write를 직렬화해
 * 동시 정산 시 lost update(레이팅 증발)를 차단한다. */
async function withDB(mutator) {
  if (!pool) { /* 파일 모드: 같은 객체 참조라 경합 없음 */
    const d = await loadDB();
    const r = await mutator(d);
    await saveDB(d);
    return r;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(911)");
    const res = await client.query("SELECT v FROM kv WHERE k='db'");
    const d = res.rows[0] ? res.rows[0].v : { users: {}, tokens: {} };
    const r = await mutator(d);
    await client.query(
      "INSERT INTO kv(k,v) VALUES('db',$1) ON CONFLICT(k) DO UPDATE SET v=$1",
      [JSON.stringify(d)]);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    try { await client.query("ROLLBACK") } catch (_) {}
    throw e;
  } finally { client.release() }
}

/* ================= CF API (문제셋 10분 캐시) ================= */
const cache = new Map();
async function cfApi(pathq, cacheMs = 0) {
  if (cacheMs) {
    const c = cache.get(pathq);
    if (c && Date.now() - c.at < cacheMs) return c.data;
  }
  const r = await fetch("https://codeforces.com/api/" + pathq);
  const d = await r.json();
  if (d.status !== "OK") throw new Error(d.comment || "CF API error");
  if (cacheMs) cache.set(pathq, { at: Date.now(), data: d.result });
  return d.result;
}
const json = (res, data, status = 200) => res.status(status).json(data);
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message || "server error" }));

/* ---------- 킵얼라이브 (DB 안 건드림 — Neon은 계속 절전 가능) ---------- */
app.get("/api/ping", (req, res) => res.json({ ok: true, t: Date.now() }));

/* ---------- CF 프록시 ---------- */
app.get("/api/cf", wrap(async (req, res) => {
  const p = String(req.query.path || "");
  if (!/^(problemset\.problems|user\.status|user\.info)(\?|$)/.test(p))
    return json(res, { status: "FAILED", comment: "not allowed" }, 400);
  try {
    const cacheMs = p.startsWith("problemset.problems") ? 10 * 60 * 1000 : 0;
    let result = await cfApi(p, cacheMs);
    if (p.startsWith("problemset.problems") && result && result.problems) {
      /* 폴백 대역폭 절감: 클라이언트가 쓰는 필드만 */
      result = { problems: result.problems.map(q => ({
        contestId: q.contestId, index: q.index, name: q.name, rating: q.rating })) };
    }
    json(res, { status: "OK", result });
  } catch (e) { json(res, { status: "FAILED", comment: e.message }, 502) }
}));

/* ---------- 인증 시작 ---------- */
app.post("/api/verify-start", wrap(async (req, res) => {
  const handle = String(req.body.handle || "").trim();
  if (!/^[\w.-]{1,30}$/.test(handle)) return json(res, { error: "잘못된 핸들 형식" }, 400);
  await withDB(d => {
    const pv = (d.pendingVerify = d.pendingVerify || {});
    for (const h of Object.keys(pv))
      if (Date.now() - pv[h] > 30 * 60 * 1000) delete pv[h];
    pv[handle] = Date.now();
  });
  json(res, { ok: true });
}));

/* ---------- 인증 확인: '인증 시작' 이후의 4A 컴파일 에러만 ---------- */
app.post("/api/verify", wrap(async (req, res) => {
  const handle = String(req.body.handle || "").trim();
  if (!/^[\w.-]{1,30}$/.test(handle)) return json(res, { error: "잘못된 핸들 형식" }, 400);
  const dPre = await loadDB();
  const t0 = (dPre.pendingVerify || {})[handle];
  if (!t0) return json(res, { error: "'인증 시작'을 먼저 눌러주세요." }, 400);
  let subs;
  try { subs = await cfApi("user.status?handle=" + encodeURIComponent(handle) + "&from=1&count=15") }
  catch (e) { return json(res, { error: e.message }, 502) }
  const ok = subs.find(s => s.problem.contestId === 4 && s.problem.index === "A"
    && s.verdict === "COMPILATION_ERROR"
    && s.creationTimeSeconds * 1000 >= t0 - 15000
    && Date.now() - s.creationTimeSeconds * 1000 < 15 * 60 * 1000);
  if (!ok) return json(res, { error: "'인증 시작' 이후 제출된 4A 컴파일 에러가 없습니다. 지금 제출하고 다시 시도하세요." }, 403);
  let cfRating = null, cfRank = "unrated";
  try {
    const info = (await cfApi("user.info?handles=" + encodeURIComponent(handle)))[0];
    cfRating = info.rating || null; cfRank = info.rank || "unrated";
  } catch (e) {}
  const token = crypto.randomBytes(32).toString("hex");
  const profile = await withDB(d => {
    /* 모두 최하 레이팅(800)에서 시작 */
    if (!d.users[handle]) d.users[handle] = {
      rating: 800,
      best: 0, games: 0, cfRating, cfRank,
    };
    Object.assign(d.users[handle], { cfRating, cfRank });
    d.tokens[token] = { handle, at: Date.now() };
    if (d.pendingVerify) delete d.pendingVerify[handle];
    return userPub(d.users[handle]);
  });
  json(res, { token, handle, profile });
}));

/* ---------- 비밀번호 로그인 (CF 인증은 최초 1회) ---------- */
const pwHash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
/* 응답에 비밀번호 해시가 새어나가지 않도록 */
const userPub = u => { if (!u) return u; const { pw, ...r } = u; return { ...r, hasPw: !!pw } };

app.post("/api/setpw", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const pw = String(req.body.password || "");
  if (pw.length < 6 || pw.length > 64) return json(res, { error: "비밀번호는 6~64자" }, 400);
  const salt = crypto.randomBytes(16).toString("hex");
  await withDB(d => { if (d.users[h]) d.users[h].pw = { salt, hash: pwHash(pw, salt) } });
  json(res, { ok: true });
}));
const loginRate = {};
app.post("/api/login", wrap(async (req, res) => {
  const handle = String(req.body.handle || "").trim();
  const pw = String(req.body.password || "");
  if (!/^[\w.-]{1,30}$/.test(handle)) return json(res, { error: "잘못된 핸들 형식" }, 400);
  /* 무차별 대입 방어: 핸들당 1분 8회 */
  const now = Date.now();
  const winL = (loginRate[handle] = (loginRate[handle] || []).filter(t => now - t < 60000));
  if (winL.length >= 8) return json(res, { error: "시도 횟수 초과 — 1분 후 다시 시도하세요" }, 429);
  winL.push(now);
  const token = crypto.randomBytes(32).toString("hex");
  const u = await withDB(d => {
    const u2 = d.users[handle];
    if (!u2 || !u2.pw) return null;
    if (pwHash(pw, u2.pw.salt) !== u2.pw.hash) return "badpw";
    d.tokens[token] = { handle, at: Date.now() };
    return u2;
  });
  if (!u) return json(res, { error: "비밀번호 미설정 계정 — 코드포스 인증(최초 1회) 후 비밀번호를 설정하세요" }, 403);
  if (u === "badpw") return json(res, { error: "비밀번호가 일치하지 않습니다" }, 403);
  let liveRun = null;
  try {
    const snapL = await kvGet("live-" + handle);
    if (snapL && !snapL.over && snapL.run && Date.now() - snapL.ts < 10 * 60 * 1000) liveRun = snapL.run;
  } catch (e) {}
  json(res, { token, handle, profile: userPub(u), liveRun });
}));

/* 미완주 런 정산 (하트비트 기반) */
function applyRun(u, wave, solved, avgRating) {
  /* 웨이브 인정은 푼 문제 수 비례 + 난이도가 주항 (같은 웨이브·같은 솔브라도 어려운 문제면 perf가 크게 다름) */
  const waveEff = Math.min(wave, 1 + solved * 2);
  const diffBonus = solved ? Math.max(0, avgRating - 800) * 0.45 : 0;
  const perf = Math.round(800 + waveEff * 45 + solved * 18 + diffBonus);
  let delta = Math.round((perf - u.rating) / 6);
  delta = Math.max(-120, Math.min(150, delta));
  const promoted = wave >= 15;
  if (promoted) delta = Math.min(150, Math.max(delta, 50 + solved * 8));
  const old = u.rating;
  u.rating = Math.max(0, u.rating + delta);
  u.best = Math.max(u.best, wave);
  u.games++;
  u.settledAt = Date.now(); /* 다른 기기의 낡은 이어하기 저장본 무효화 기준 */
  return { old, rating: u.rating, delta, perf, best: u.best, promoted, wave };
}

function authOf(d, req) {
  const t = d.tokens[String((req.body && req.body.token) || req.query.token || "")];
  return t ? t.handle : null;
}
/* 핫패스용 토큰 캐시 — 폴링마다 유저 전체 DB를 읽지 않도록 (지연 감소) */
const tokenCache = new Map();
async function authCached(req) {
  const tk = String((req.body && req.body.token) || req.query.token || "");
  if (!tk) return null;
  const hit = tokenCache.get(tk);
  if (hit && Date.now() - hit.at < 60000) return hit.h;
  const d = await loadDB();
  const h = authOf(d, req);
  if (h) tokenCache.set(tk, { h, at: Date.now() });
  return h;
}

app.get("/api/me", wrap(async (req, res) => {
  const d = await loadDB();
  const h = authOf(d, req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  /* 도망 방지: 진행 중이던 런의 하트비트가 10분 이상 끊겼으면 그 시점으로 정산 */
  let autoSettled = null;
  try {
    const snap = await kvGet("live-" + h);
    if (snap && !snap.over && !snap.duo && Date.now() - snap.ts > 10 * 60 * 1000) { /* 듀오는 방 정산이 담당 */
      const avg = snap.solved ? (snap.sum || 0) / snap.solved : 0;
      autoSettled = await withDB(d2 => applyRun(d2.users[h], snap.wave || 0, snap.solved || 0, avg));
      if (autoSettled && d.users[h]) Object.assign(d.users[h], { rating: autoSettled.rating, best: autoSettled.best });
      await kvDel("live-" + h);
    }
  } catch (e) {}
  /* 10분 내 하트비트가 있는 진행 중 판 → 어느 기기서든 이어하기 */
  let liveRun = null;
  try {
    const snap2 = await kvGet("live-" + h);
    if (snap2 && !snap2.over && snap2.run && Date.now() - snap2.ts < 10 * 60 * 1000) liveRun = snap2.run;
  } catch (e) {}
  json(res, { handle: h, profile: userPub(d.users[h]), autoSettled, liveRun });
}));

/* ---------- 게임 결과 정산 ---------- */
app.post("/api/result", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const wave = Math.max(0, Math.min(200, Math.floor(+req.body.wave || 0)));
  const solved = Math.max(0, Math.min(50, Math.floor(+req.body.solved || 0)));
  const avgRating = Math.max(0, Math.min(3500, +req.body.avgRating || 0));
  const r = await withDB(d => d.users[h] ? applyRun(d.users[h], wave, solved, avgRating) : null);
  if (!r) return json(res, { error: "unknown user" }, 400);
  try { await kvDel("live-" + h) } catch (e) {}
  json(res, r);
}));

/* ---------- 캠페인 진행도 (별 저장, 최대값 유지) ---------- */
app.post("/api/campaign", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const stage = Math.max(1, Math.min(10, Math.floor(+req.body.stage || 0)));
  const stars = Math.max(1, Math.min(3, Math.floor(+req.body.stars || 0)));
  if (!req.body.stage || !req.body.stars) return json(res, { error: "bad request" }, 400);
  const campaign = await withDB(d => {
    const u = d.users[h];
    if (!u) return null;
    u.campaign = u.campaign || {};
    u.campaign["s" + stage] = Math.max(u.campaign["s" + stage] || 0, stars);
    return u.campaign;
  });
  json(res, { ok: true, campaign });
}));

/* ---------- 랭킹 ---------- */
app.get("/api/leaderboard", wrap(async (req, res) => {
  const d = await loadDB();
  json(res, Object.entries(d.users)
    .map(([handle, u]) => ({ handle, rating: u.rating, best: u.best, games: u.games }))
    .sort((a, b) => b.rating - a.rating).slice(0, 100));
}));
app.get("/api/leaderboard/duo", wrap(async (req, res) => {
  const d = await loadDB();
  json(res, Object.entries(d.duos || {})
    .map(([pair, u]) => ({ pair, rating: u.rating, best: u.best, games: u.games }))
    .sort((a, b) => b.rating - a.rating).slice(0, 50));
}));

/* ---------- 글로벌 채팅 ---------- */
app.get("/api/chat", wrap(async (req, res) => {
  const c = await kvGet("chat");
  json(res, (c && c.msgs) || []);
}));
app.post("/api/chat", wrap(async (req, res) => {
  const d = await loadDB();
  const h = authOf(d, req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const msg = String(req.body.msg || "").slice(0, 200).trim();
  if (!msg) return json(res, { error: "빈 메시지" }, 400);
  const c = (await kvGet("chat")) || { msgs: [] };
  c.msgs.push({ h, m: msg, t: Date.now() });
  c.msgs = c.msgs.slice(-80);
  await kvSet("chat", c);
  json(res, { ok: true });
}));

/* ---------- 관전 (스냅샷) ---------- */
app.post("/api/live", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const s = req.body.state || {};
  const snap = {
    handle: h, ts: Date.now(),
    wave: Math.max(0, Math.min(200, Math.floor(+s.wave || 0))),
    hp: Math.max(0, Math.min(20, Math.floor(+s.hp || 0))),
    coins: Math.max(0, Math.min(1e6, Math.floor(+s.coins || 0))),
    solved: Math.max(0, Math.min(50, Math.floor(+s.solved || 0))),
    sum: Math.max(0, Math.min(200000, Math.floor(+s.sum || 0))),
    phase: s.phase === "wave" ? "wave" : "prep",
    prepT: Math.max(0, Math.min(6000, Math.floor(+s.prepT || 0))),
    probRating: Math.max(0, Math.min(3500, Math.floor(+s.probRating || 0))),
    over: !!s.over,
    towers: Array.isArray(s.towers) ? s.towers.slice(0, 60).map(tw => ({
      k: ["archer", "cannon", "mage", "sniper"].includes(tw.k) ? tw.k : "archer",
      c: Math.max(0, Math.min(13, Math.floor(+tw.c || 0))),
      r: Math.max(0, Math.min(9, Math.floor(+tw.r || 0))),
      lvl: Math.max(1, Math.min(5, Math.floor(+tw.lvl || 1))),
    })) : [],
  };
  /* 다른 기기 이어하기용 복원 스냅샷 (크기 제한) */
  if (s.run && JSON.stringify(s.run).length < 15000) snap.run = s.run;
  if (s.duo) snap.duo = { partner: String(s.duo.partner || "").slice(0, 30) };
  await kvSet("live-" + h, snap);
  json(res, { ok: true });
}));
app.get("/api/live", wrap(async (req, res) => {
  const h = req.query.handle;
  if (h) {
    const snap = await kvGet("live-" + h);
    if (!snap || Date.now() - snap.ts > 90000) return json(res, { error: "방송 종료" }, 404);
    const { run, ...pub } = snap;
    return json(res, pub);
  }
  const rows = await kvList("live-");
  const now = Date.now();
  /* 90초 신선도 + 목록은 슬림 필드만 (towers/run 제외 — 대역폭 절감) */
  json(res, rows.map(r => r.value)
    .filter(s => s && now - s.ts < 90000 && !s.over)
    .slice(0, 30)
    .map(s => ({ handle: s.handle, wave: s.wave, hp: s.hp, duo: s.duo || null })));
}));

/* ================= 듀오 협동 모드 =================
 * room-CODE   : 메타+호스트 상태 (호스트만 씀)
 * room-CODE-q : 액션/보상/채팅 큐 (append 전용, 워터마크 소비)
 *  → 호스트의 상태 쓰기가 게스트 요청을 덮어쓰던 레이스 제거 */
const roomKey = c => "room-" + c;
const qKey = c => "room-" + c + "-q";
const memberOf = (room, h) => room && (room.host === h || room.guest === h);
let qSeq = 0;
const qId = () => Date.now() * 100 + (qSeq = (qSeq + 1) % 100);
/* append 전용 (Postgres: 단일 UPDATE로 원자적) */
async function qAppend(code, field, item) {
  const k = qKey(code);
  if (pool) {
    await pool.query(
      `INSERT INTO kv(k,v) VALUES($1, jsonb_build_object($2::text, jsonb_build_array($3::jsonb)))
       ON CONFLICT(k) DO UPDATE SET v = jsonb_set(kv.v, ARRAY[$2::text],
         (COALESCE(kv.v->($2::text),'[]'::jsonb) || ($3::jsonb)))`,
      [k, field, JSON.stringify(item)]);
  } else {
    const q = FILESTORE[k] || {};
    (q[field] = q[field] || []).push(item);
    FILESTORE[k] = q; fileSave();
  }
}
async function qGet(code) {
  return (await kvGet(qKey(code))) || {};
}
/* 큐가 너무 길면만 잘라냄 (호스트 폴에서 호출 — 드물게) */
async function qPrune(code, q) {
  let dirty = false;
  for (const f of ["actions", "rewards", "chat"]) {
    if (Array.isArray(q[f]) && q[f].length > 150) { q[f] = q[f].slice(-100); dirty = true }
  }
  if (dirty) await kvSet(qKey(code), q);
}

app.post("/api/room/create", wrap(async (req, res) => {
  const d = await loadDB();
  const h = authOf(d, req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const code = Math.random().toString(36).slice(2, 6).toUpperCase();
  await kvSet(roomKey(code), {
    code, host: h, guest: null, created: Date.now(),
    state: null, result: null, settled: false,
  });
  await kvDel(qKey(code)); /* 같은 코드 재사용 시 이전 큐 제거 */
  json(res, { code });
}));
app.post("/api/room/join", wrap(async (req, res) => {
  const d = await loadDB();
  const h = authOf(d, req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const code = String(req.body.code || "").toUpperCase();
  const room = await kvGet(roomKey(code));
  if (!room) return json(res, { error: "방을 찾을 수 없습니다" }, 404);
  if (room.host !== h && room.guest && room.guest !== h)
    return json(res, { error: "방이 가득 찼습니다" }, 403);
  if (room.host !== h && !room.guest) { room.guest = h; await kvSet(roomKey(code), room) }
  json(res, room);
}));
app.get("/api/room", wrap(async (req, res) => {
  const code = String(req.query.code || "").toUpperCase();
  const room = await kvGet(roomKey(code));
  if (!room) return json(res, { error: "no room" }, 404);
  const q = await qGet(code);
  json(res, { ...room, chat: q.chat || [] });
}));
app.post("/api/room/state", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const code = String(req.body.code || "").toUpperCase();
  const room = await kvGet(roomKey(code));
  if (!room || !memberOf(room, h)) return json(res, { error: "not member" }, 403);
  const isDefender = !room.state || room.state.defender === h;
  const stale = room.state && Date.now() - (room.state.ts || 0) > 25000;
  if (!isDefender && !stale) return json(res, { error: "not defender" }, 403);
  const s = req.body.state || {};
  room.state = { ...s, ts: Date.now() };
  const q = await qGet(code);
  if (room.state.over && !room.settled) {
    room.settled = true;
    /* 듀오는 팀 레이팅만 변동 — 개인(솔로) 레이팅은 건드리지 않는다 */
    const stats = {};
    for (const r0 of q.rewards || []) {
      const st = stats[r0.by] || (stats[r0.by] = { n: 0, sum: 0 });
      st.n++; st.sum += r0.rating || 0;
    }
    const wave = Math.max(0, Math.min(200, Math.floor(+room.state.wave || 0)));
    const promoted = wave >= 15;
    room.result = {};
    if (room.host && room.guest) {
      const pairKey = [room.host, room.guest].sort().join(" + ");
      room.result._duo = await withDB(d => {
        d.duos = d.duos || {};
        const duo = d.duos[pairKey] || { rating: 800, best: 0, games: 0 }; /* 팀도 최하점 시작 */
        let n = 0, sum = 0;
        for (const hh of [room.host, room.guest]) {
          const st = stats[hh] || { n: 0, sum: 0 };
          n += st.n; sum += st.sum;
        }
        const waveEffT = Math.min(wave, 1 + n * 2);
        const tDiffBonus = n ? Math.max(0, sum / n - 800) * 0.45 : 0;
        const tPerf = Math.round(800 + waveEffT * 45 + n * 15 + tDiffBonus);
        let tDelta = Math.round((tPerf - duo.rating) / 6);
        tDelta = Math.max(-120, Math.min(150, tDelta));
        if (promoted) tDelta = Math.min(150, Math.max(tDelta, 50 + n * 6));
        const tOld = duo.rating;
        duo.rating = Math.max(0, duo.rating + tDelta);
        duo.best = Math.max(duo.best, wave); duo.games++;
        d.duos[pairKey] = duo;
        return { pair: pairKey, old: tOld, rating: duo.rating, delta: tDelta, best: duo.best, promoted };
      });
    }
  }
  await kvSet(roomKey(code), room);
  /* 워터마크 이후 항목만 전달 — 큐 재작성 없음 */
  const sinceA = +req.body.sinceA || 0, sinceR = +req.body.sinceR || 0;
  const actions = (q.actions || []).filter(a => a.id > sinceA && a.by !== h);
  const rewards = (q.rewards || []).filter(r0 => r0.id > sinceR);
  await qPrune(code, q);
  json(res, { ok: true, actions, rewards, chat: q.chat || [] });
}));
/* 듀오 팀 채팅 */
app.post("/api/room/chat", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const code = String(req.body.code || "").toUpperCase();
  const room = await kvGet(roomKey(code));
  if (!room || !memberOf(room, h)) return json(res, { error: "not member" }, 403);
  const msg = String(req.body.msg || "").slice(0, 200).trim();
  if (!msg) return json(res, { error: "빈 메시지" }, 400);
  await qAppend(code, "chat", { h, m: msg, t: Date.now() });
  const q = await qGet(code);
  json(res, { ok: true, chat: (q.chat || []).slice(-40) });
}));
/* 서버 측 스팸 방어: 버스트 허용 (2초에 8발까지 정상, 초과분만 드롭)
 * — 배속 2연타 같은 정상적인 빠른 조작은 통과시킨다 */
const actRate = {};
app.post("/api/room/action", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const nowA = Date.now();
  const critical = ["wave", "draw", "pick", "speed"].includes(String((req.body.action || {}).t));
  const win = (actRate[h] = (actRate[h] || []).filter(t => nowA - t < 2000));
  /* 웨이브/카드/선택/배속은 절대 드롭하지 않는다 (게임 진행 필수 액션) */
  if (win.length >= (critical ? 20 : 8)) return json(res, { ok: true, dropped: true });
  win.push(nowA);
  const code = String(req.body.code || "").toUpperCase();
  const room = await kvGet(roomKey(code));
  if (!room || !memberOf(room, h)) return json(res, { error: "not member" }, 403);
  const a = req.body.action || {};
  await qAppend(code, "actions", {
    id: qId(), by: h,
    t: String(a.t || "").slice(0, 8), k: String(a.k || "").slice(0, 10),
    c: Math.floor(+a.c || 0), r: Math.floor(+a.r || 0), i: Math.floor(+a.i || 0),
  });
  json(res, { ok: true });
}));
app.post("/api/room/reward", wrap(async (req, res) => {
  const h = await authCached(req);
  if (!h) return json(res, { error: "unauthorized" }, 401);
  const code = String(req.body.code || "").toUpperCase();
  const room = await kvGet(roomKey(code));
  if (!room || !memberOf(room, h)) return json(res, { error: "not member" }, 403);
  const rating = Math.max(0, Math.min(3500, Math.floor(+req.body.rating || 0)));
  const amount = Math.max(0, Math.min(1500, Math.floor(+req.body.amount || 0)));
  await qAppend(code, "rewards", {
    id: qId(), by: h, amount, rating, applied: !!req.body.applied,
    cid: Math.floor(+req.body.cid || 0), idx: String(req.body.idx || "").slice(0, 4),
  });
  json(res, { ok: true });
}));

const PORT = process.env.PORT || 3000;
kvInit().then(() => {
  app.listen(PORT, () => console.log("🏰 CF 랭크 디펜스 (" + (pool ? "PostgreSQL" : "파일 저장") + "): http://localhost:" + PORT));
}).catch(e => { console.error("DB 초기화 실패:", e); process.exit(1) });
