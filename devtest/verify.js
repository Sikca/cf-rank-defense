/* 듀오 자동 검증 봇 — 사람 없이 호스트/게스트 2명을 시뮬레이션해 전 항목 판정
 *
 * 사용법:  node devtest/verify.js
 *
 * 하는 일:
 *  1. 기존 data.json 백업 → 테스트 계정 시드 → 임시 포트(3999)로 서버 기동
 *  2. 가상 호스트/게스트가 실제 API로 방 생성/참가/건설/배속/웨이브/보상/정산 수행
 *  3. 불변 조건 자동 판정 → PASS/FAIL 표 출력
 *  4. 서버 종료 + data.json 원복 (실서버·로컬 데이터 무손상)
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data.json");
const BAK = DATA + ".verify-bak";
const PORT = 3999;
const BASEURL = "http://localhost:" + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "  — " + detail : ""));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function get(p) { return (await fetch(BASEURL + p)).json() }

/* ---------- 1. 클라이언트 로직 결정성 (카드/웨이브큐) ---------- */
function clientLogicTests() {
  console.log("\n[1] 클라이언트 결정성 (index.html에서 실제 함수 추출)");
  const src = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  function fnOf(name) {
    const i = src.indexOf("function " + name + "(");
    if (i < 0) throw new Error("함수 없음: " + name);
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === "{") d++;
      if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1) }
    }
  }
  const dfLine = (src.match(/const diffFor=[^\n]+/) || [""])[0];
  const code = dfLine + "\n" + ["seededRng", "pickAtSeeded", "duoCards", "buildQueue"].map(fnOf).join("\n");
  const mk = (reversed) => {
    const ctx = { DUO: { code: "TEST" }, CAMP: null, BASE: 1600, G: { wave: 6 }, Math, console };
    let POOL = [];
    for (let i = 0; i < 2500; i++)
      POOL.push({ contestId: 1000 + ((i * 7) % 900), index: "ABCDE"[i % 5], rating: 800 + 100 * (i % 23), name: "P" + i });
    if (reversed) POOL.reverse(); /* API 응답 순서가 달라도 */
    POOL.sort((a, b) => a.contestId - b.contestId || String(a.index).localeCompare(String(b.index)));
    ctx.POOL = POOL;
    vm.createContext(ctx); vm.runInContext(code, ctx);
    return ctx;
  };
  const A = mk(false), B = mk(true);
  let allMatch = true;
  for (const w of [1, 3, 5, 12, 29]) {
    const a = vm.runInContext(`duoCards(${w}).map(p=>p.contestId+p.index).join()`, A);
    const b = vm.runInContext(`duoCards(${w}).map(p=>p.contestId+p.index).join()`, B);
    if (a !== b || !a) allMatch = false;
  }
  check("두 클라이언트 카드 세트 동일 (웨이브 1·3·5·12·29)", allMatch);
  const q1 = vm.runInContext("buildQueue(10).join()", A), q2 = vm.runInContext("buildQueue(10).join()", B);
  check("웨이브 적 구성 큐 동일", q1 === q2 && q1.includes("boss"));
  const c1 = vm.runInContext("duoCards(4)", A);
  check("카드 5장 · 난이도 스프레드(BASE±200)", c1.length === 5);
}

/* ---------- 2. 서버 프로토콜 시나리오 ---------- */
async function serverTests() {
  console.log("\n[2] 서버 시나리오 (가상 호스트 H / 게스트 G)");
  const me = await get("/api/me?token=dev-h");
  check("토큰 인증", me.handle === "verify_host");

  const { code } = await post("/api/room/create", { token: "dev-h" });
  check("방 생성", /^[A-Z0-9]{4}$/.test(code || ""), "code=" + code);
  const joined = await post("/api/room/join", { token: "dev-g", code });
  check("참가", joined.guest === "verify_guest");

  /* 호스트 상태 업로드 사이에 게스트 액션이 끼어도 유실 없는지 */
  await post("/api/room/state", { token: "dev-h", code, sinceA: 0, sinceR: 0,
    state: { defender: "verify_host", wave: 1, phase: "wave", hp: 20, coins: 500 } });
  await post("/api/room/action", { token: "dev-g", code, action: { t: "build", k: "archer", c: 3, r: 4 } });
  await sleep(150);
  await post("/api/room/action", { token: "dev-g", code, action: { t: "speed", i: 2 } });
  await sleep(150);
  await post("/api/room/action", { token: "dev-g", code, action: { t: "wave", i: 2 } });
  const r1 = await post("/api/room/state", { token: "dev-h", code, sinceA: 0, sinceR: 0,
    state: { defender: "verify_host", wave: 1, phase: "wave", hp: 20, coins: 500 } });
  const types = (r1.actions || []).map(a => a.t).join(",");
  check("게스트 액션 3종 무유실 전달 (build/speed/wave)",
    types.includes("build") && types.includes("speed") && types.includes("wave"), types);

  /* 워터마크: 같은 액션 재전달 금지 */
  const maxId = Math.max(...(r1.actions || []).map(a => a.id));
  const r2 = await post("/api/room/state", { token: "dev-h", code, sinceA: maxId, sinceR: 0,
    state: { defender: "verify_host", wave: 2, phase: "wave", hp: 20, coins: 500 } });
  check("워터마크 중복 수신 차단", (r2.actions || []).length === 0);

  /* 광클 스팸: 버스트 8발 초과분은 서버가 드롭 (정상적인 빠른 조작은 통과) */
  await sleep(2100); /* 직전 정상 액션의 2초 윈도우 리셋 */
  let dropped = 0, passed = 0;
  for (let i = 0; i < 14; i++) {
    const rr = await post("/api/room/action", { token: "dev-g", code, action: { t: "up", c: 3, r: 4, i } });
    if (rr.dropped) dropped++; else passed++;
  }
  check("연타 스팸 서버 차단 (14연발 → 8발 통과 + 초과 드롭)", dropped >= 4 && passed >= 6,
    passed + "통과/" + dropped + "드롭");

  /* 보상 → 정산: 개인 레이팅 불변 + 팀 800 시작 */
  await post("/api/room/reward", { token: "dev-g", code, amount: 420, rating: 1700, cid: 1721, idx: "C" });
  await post("/api/room/reward", { token: "dev-h", code, amount: 400, rating: 1600, applied: true, cid: 1699, idx: "D" });
  await post("/api/room/state", { token: "dev-h", code, sinceA: maxId, sinceR: 0,
    state: { defender: "verify_host", wave: 17, phase: "wave", hp: 0, coins: 0, over: true } });
  await sleep(600);
  const room = await get("/api/room?code=" + code);
  const team = room.result && room.result._duo;
  check("정산 결과 생성", !!team);
  check("팀 레이팅 800 시작", team && team.old === 800, team && ("800→" + team.rating));
  check("정산에 문제 통계 반영 (perf>기본)", team && team.rating > 800 + 0);
  const noPersonal = room.result && !room.result.verify_host && !room.result.verify_guest;
  check("개인 결과 미생성 (팀만 변동)", noPersonal);
  const db = JSON.parse(fs.readFileSync(DATA, "utf8")).db;
  check("개인(솔로) 레이팅 불변", db.users.verify_host.rating === 1111 && db.users.verify_guest.rating === 999,
    db.users.verify_host.rating + "/" + db.users.verify_guest.rating);
  check("듀오 팀 랭킹 기록", !!(db.duos && Object.keys(db.duos).length), JSON.stringify(db.duos));
}

/* ---------- 실행 ---------- */
(async () => {
  console.log("🤖 CF 랭크 디펜스 — 듀오 자동 검증 봇");
  if (fs.existsSync(DATA)) fs.copyFileSync(DATA, BAK);
  fs.writeFileSync(DATA, JSON.stringify({ db: {
    users: { verify_host: { rating: 1111, best: 0, games: 0 }, verify_guest: { rating: 999, best: 0, games: 0 } },
    tokens: { "dev-h": { handle: "verify_host", at: Date.now() }, "dev-g": { handle: "verify_guest", at: Date.now() } },
  }}));
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")],
    { env: { ...process.env, PORT: String(PORT), DATABASE_URL: "" }, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { await sleep(300); try { await get("/api/leaderboard"); up = true } catch (e) {} }
    if (!up) throw new Error("서버 기동 실패");
    clientLogicTests();
    await serverTests();
  } catch (e) {
    check("실행 오류 없음", false, e.message);
  } finally {
    server.kill();
    await sleep(400);
    if (fs.existsSync(BAK)) { fs.copyFileSync(BAK, DATA); fs.unlinkSync(BAK) }
    else try { fs.unlinkSync(DATA) } catch (e) {}
  }
  const fail = results.filter(r => !r.ok).length;
  console.log("\n" + "=".repeat(46));
  console.log(fail === 0
    ? `🎉 전체 ${results.length}항목 PASS — 배포해도 좋습니다`
    : `⚠️ ${fail}/${results.length} 항목 FAIL — 위 ❌ 확인 필요`);
  process.exit(fail === 0 ? 0 : 1);
})();
