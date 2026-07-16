/* 듀오 풀 시뮬레이션 — 에이전트 봇 2명이 "실제 게임 클라이언트 코드"로 한 판을 플레이
 *
 *   node devtest/simduo.js
 *
 * 원리: public/index.html의 게임 스크립트 전체를 가상 브라우저(DOM/캔버스/오디오 스텁)
 * 2개에 로드 → 실제 서버(임시 포트)에 접속 → 방 생성/참가/카드/건설/배속/웨이브/AC/정산을
 * 자율 수행하며 0.5초마다 두 화면의 상태 일치를 검사한다.
 * CF API만 가짜(결정적 문제셋)이고 나머지는 전부 실코드·실서버다.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data.json");
const BAK = DATA + ".sim-bak";
const PORT = 3998;
const BASEURL = "http://localhost:" + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "  — " + detail : ""));
}

/* ---------- 가짜 CF 문제셋 (양쪽 동일·결정적) ---------- */
const FAKEPROBS = [];
for (let i = 0; i < 500; i++)
  FAKEPROBS.push({ contestId: 1200 + (i % 250), index: "ABCD"[i % 4],
    name: "SimProblem " + i, rating: 800 + 100 * (i % 16), tags: [] });

/* ---------- 가상 브라우저 ---------- */
function ctx2d() {
  const t = {};
  return new Proxy(t, {
    get(o, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "createLinearGradient" || p === "createRadialGradient")
        return () => ({ addColorStop() {} });
      if (p === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (p in o) return o[p];
      return () => {};
    },
    set(o, p, v) { o[p] = v; return true },
  });
}
function anyObj() {
  const f = function () {};
  return new Proxy(f, {
    get(o, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === "then") return undefined; /* await 안전 */
      return anyObj();
    },
    set: () => true,
    apply: () => anyObj(),
    construct: () => anyObj(),
  });
}
function makeBrowser(name, token, handle) {
  const els = new Map();
  function mkEl(tag) {
    const e = {
      tagName: tag, style: {}, dataset: {}, value: "", textContent: "", innerHTML: "",
      disabled: false, checked: false, scrollTop: 0, scrollHeight: 0, offsetWidth: 0,
      width: 616, height: 440, src: "", children: [], _h: {},
      classList: (() => { const s = new Set(); return {
        add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)),
        toggle: (c, f) => { (f === undefined ? !s.has(c) : f) ? s.add(c) : s.delete(c) },
        contains: c => s.has(c) } })(),
      appendChild(c) { return c }, removeChild() {}, remove() {},
      addEventListener(t, f) { this._h[t] = f }, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 616, height: 440 }),
      focus() {}, click() {}, getContext: () => ctx2d(),
    };
    return e;
  }
  const store = { cftd3: JSON.stringify({ token, handle, muted: true, fx: "low", bgm: false }) };
  const sb = {
    name, errors: [], rafQ: [], acProblems: [],
    console: { log() {}, warn() {}, error() {} },
    Math, Date, JSON, Object, Array, Number, String, Boolean, Promise, Set, Map, RegExp,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Error, Symbol,
    setTimeout, setInterval, clearTimeout, clearInterval,
    performance: { now: () => performance.now() },
    innerWidth: 1280, innerHeight: 800,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] } },
    location: { reload() {}, href: BASEURL },
    navigator: { userAgent: "simbot" },
    AudioContext: anyObj(), webkitAudioContext: anyObj(), OfflineAudioContext: anyObj(),
    open: () => null, alert() {}, confirm: () => true,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    requestAnimationFrame: cb => { sb.rafQ.push(cb) },
    cancelAnimationFrame() {},
    fetch: async (url, opts) => {
      url = String(url);
      if (url.startsWith("/")) return fetch(BASEURL + url, opts);
      if (url.includes("codeforces.com/api/")) {
        const q = decodeURIComponent(url.split("/api/")[1]);
        let body;
        if (q.startsWith("problemset.problems"))
          body = { status: "OK", result: { problems: FAKEPROBS } };
        else if (q.startsWith("user.status"))
          body = { status: "OK", result: sb.acProblems.map(p => ({
            problem: { contestId: p.contestId, index: p.index }, verdict: "OK",
            creationTimeSeconds: Math.floor(Date.now() / 1000) })) };
        else if (q.startsWith("user.info"))
          body = { status: "OK", result: [{ rating: 1500, rank: "expert" }] };
        else body = { status: "OK", result: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  };
  sb.window = sb;
  sb.document = {
    getElementById: id => { if (!els.has(id)) els.set(id, mkEl("div")); return els.get(id) },
    createElement: tag => mkEl(tag),
    head: { appendChild() {} }, body: { appendChild() {} },
    addEventListener() {}, documentElement: mkEl("html"),
    querySelectorAll: () => [],
  };
  vm.createContext(sb);
  sb._els = els;
  return sb;
}
function run(sb, code) {
  try { return vm.runInContext(code, sb) }
  catch (e) { sb.errors.push("run(" + code.slice(0, 40) + "): " + e.message); return undefined }
}
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200) }
  check(what, false, "타임아웃 " + ms + "ms");
  return false;
}
function clickCell(sb, c, r) { /* 실제 캔버스 클릭 경로로 입력 */
  const cv = sb._els.get("cv");
  if (cv && cv._h.click) {
    try { cv._h.click({ clientX: c * 44 + 8, clientY: r * 44 + 8 }) }
    catch (e) { sb.errors.push("click: " + e.message) }
  }
}

/* ---------- 메인 ---------- */
(async () => {
  console.log("🤖🤖 듀오 시뮬레이션 — 봇 2명이 실제 클라이언트 코드로 플레이\n");
  if (fs.existsSync(DATA)) fs.copyFileSync(DATA, BAK);
  fs.writeFileSync(DATA, JSON.stringify({ db: {
    users: { botHost: { rating: 1111, best: 0, games: 0 }, botGuest: { rating: 999, best: 0, games: 0 } },
    tokens: { "sim-h": { handle: "botHost", at: Date.now() }, "sim-g": { handle: "botGuest", at: Date.now() } },
  }}));
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")],
    { env: { ...process.env, PORT: String(PORT), DATABASE_URL: "" }, stdio: "ignore" });

  const H = makeBrowser("HOST", "sim-h", "botHost");
  const G2 = makeBrowser("GUEST", "sim-g", "botGuest");
  const BOTS = [H, G2];
  /* rAF 펌프: 실제 게임 루프 구동 */
  const pump = setInterval(() => {
    for (const sb of BOTS) {
      const q = sb.rafQ.splice(0);
      const t = performance.now();
      for (const cb of q) { try { cb(t) } catch (e) { sb.errors.push("loop: " + (e && e.message)) } }
    }
  }, 25);

  /* 상태 일치 감시 (0.5초마다) */
  const S = (sb, ex) => { try { return vm.runInContext(ex, sb) } catch (e) { return "__ERR" } };
  const mismatches = {};
  const watch = setInterval(() => {
    if (!S(H, "G&&!G.over") || !S(G2, "G&&!G.over")) return;
    const snap = sb => ({
      wave: S(sb, "G.wave"), phase: S(sb, "G.phase"), hp: S(sb, "G.hp"),
      coins: S(sb, "Math.floor(G.coins)"), speed: S(sb, "speed"),
      act: S(sb, "ACT.map(p=>p.contestId+p.index).sort().join()"),
    });
    const a = snap(H), b = snap(G2), now = Date.now();
    const diff = (k, bad) => {
      if (bad) { mismatches[k] = mismatches[k] || now;
        if (now - mismatches[k] > 6000 && !mismatches[k + "_flag"]) {
          mismatches[k + "_flag"] = true;
          check("동기화 유지: " + k, false, JSON.stringify({ host: a[k], guest: b[k] }));
        }
      } else delete mismatches[k];
    };
    diff("wave", a.wave !== b.wave);
    diff("phase", a.phase !== b.phase);
    diff("hp", a.hp !== b.hp);
    diff("speed", a.speed !== b.speed);
    diff("act", a.act !== b.act);
    diff("coins", Math.abs(a.coins - b.coins) > 200);
  }, 500);

  try {
    /* 서버 대기 */
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { await sleep(300);
      try { await fetch(BASEURL + "/api/leaderboard"); up = true } catch (e) {} }
    if (!up) throw new Error("서버 기동 실패");

    /* 게임 클라이언트 로드 (양쪽) */
    const src = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    let script = src.match(/<script>([\s\S]*?)<\/script>/)[1];
    /* duoSync 내부에서 삼켜지는 예외를 노출 (디버그 계측) */
    script = script.replace("}catch(e){}\n  finally{if(DUO)DUO.syncing=false}",
      "}catch(e){(window.__syncErr=window.__syncErr||[]).push(String(e&&e.stack||e).slice(0,300))}\n  finally{if(DUO)DUO.syncing=false}");
    for (const sb of BOTS) run(sb, script);
    check("클라이언트 코드 로드 (봇 2)", H.errors.length === 0 && G2.errors.length === 0,
      (H.errors[0] || G2.errors[0] || ""));

    const login = await until(() => S(H, "PROFILE.rating") === 1111 && S(G2, "PROFILE.rating") === 999, "자동 로그인 → 로비", 8000);
    check("자동 로그인 → 로비", login,
      "host=" + S(H, "PROFILE&&PROFILE.rating") + " guest=" + S(G2, "PROFILE&&PROFILE.rating"));

    /* 방 생성/참가 */
    run(H, "duoCreate()");
    await until(() => S(H, "DUO&&DUO.code"), "방 생성");
    const code = S(H, "DUO.code");
    run(G2, `document.getElementById("duoCode").value=${JSON.stringify(code)};duoJoin()`);
    const started = await until(() => S(H, "!!G") && S(G2, "!!G"), "듀오 게임 개시 (양쪽)", 12000);
    check("듀오 게임 개시 (양쪽)", started, "code=" + code);
    if (!started) throw new Error("듀오 시작 실패");
    await sleep(1000);

    /* 카드: 게스트가 뽑기 → 양쪽 동일 세트 */
    run(G2, "drawProblem()");
    await until(() => S(H, "G.cards&&G.cards.length") && S(G2, "G.cards&&G.cards.length"), "카드 모달 양쪽 오픈", 8000);
    const ck = sb => S(sb, "(G.cards||[]).map(p=>p.contestId+p.index).sort().join()");
    check("카드 세트 양쪽 동일", ck(H) === ck(G2) && ck(H) !== "", ck(H));
    /* 중복 뽑기 시도 (양쪽 광클) */
    for (let i = 0; i < 4; i++) { run(H, "drawProblem()"); run(G2, "drawProblem()") }
    await sleep(800);
    check("중복 뽑기 차단 (여전히 같은 5장)", ck(H) === ck(G2) && S(H, "G.cards.length") === 5);

    /* 선택: 게스트 1장 → 호스트 1장 */
    run(G2, "doPick(0)");
    await sleep(1800);
    run(H, "doPick(0)");
    const actSync = await until(() =>
      S(H, "ACT.length") === 2 && S(G2, "ACT.length") === 2 &&
      S(H, "ACT.map(p=>p.contestId+p.index).sort().join()") === S(G2, "ACT.map(p=>p.contestId+p.index).sort().join()"),
      "공동 문제 2개 동기화", 7000);
    check("공동 문제 2개 동기화", actSync,
      S(H, "ACT.map(p=>p.contestId+p.index).join()"));
    if (!actSync) { /* 조기 진단 덤프 */
      console.log("  [진단] guest syncErr:", S(G2, 'JSON.stringify((window.__syncErr||[]).slice(0,2))'));
      console.log("  [진단] host  syncErr:", S(H, 'JSON.stringify((window.__syncErr||[]).slice(0,2))'));
      console.log("  [진단] guest DUO:", S(G2, 'DUO&&JSON.stringify({role:DUO.role,code:DUO.code,pollT:!!DUO.pollT,syncing:DUO.syncing})'));
      console.log("  [진단] guest room:", await fetch(BASEURL + "/api/room?code=" + S(G2, "DUO.code"))
        .then(r => r.text()).then(t => t.slice(0, 200)).catch(e => "ERR " + e.message));
    }

    /* 건설: 실제 캔버스 클릭 경로 + 같은 칸 광클 (호스트가 코인 지급 → 공유 확인 겸) */
    run(H, "G.coins=1000;syncUI()");
    await sleep(1800);
    run(G2, 'selShop="archer"');
    for (let i = 0; i < 5; i++) clickCell(G2, 2, 3); /* 같은 칸 5연타 */
    run(G2, 'selShop="cannon"'); clickCell(G2, 5, 4);
    run(H, 'selShop="archer"'); clickCell(H, 10, 4);
    await until(() => S(H, "G.towers.length") === 3 && S(G2, "G.towers.length") === 3, "타워 3개 양쪽 반영", 7000);
    check("타워 3개 양쪽 반영 (같은 칸 5연타 = 1개)",
      S(H, "G.towers.length") === 3 && S(G2, "G.towers.length") === 3,
      "host=" + S(H, "G.towers.length") + " guest=" + S(G2, "G.towers.length"));

    /* 배속: 게스트가 4x → 호스트 따라옴 */
    run(G2, "toggleSpeed()"); run(G2, "toggleSpeed()"); /* 1→2→4 */
    await until(() => S(H, "speed") === 4 && S(G2, "speed") === 4, "배속 4x 공유", 5000);
    check("배속 4x 공유", S(H, "speed") === 4 && S(G2, "speed") === 4);

    /* 웨이브: 게스트가 시작 (연타 포함) */
    run(G2, "callWave()"); run(G2, "callWave()");
    await until(() => S(H, "G.wave") === 1 && S(G2, "G.wave") === 1 &&
      S(H, 'G.phase') === "wave" && S(G2, 'G.phase') === "wave", "웨이브 1 동시 개전", 5000);
    check("웨이브 1 동시 개전 (게스트 트리거·연타 1회 처리)",
      S(H, "G.wave") === 1 && S(G2, "G.wave") === 1);

    /* 전투 중 업글 (게스트) */
    run(G2, "selTower=G.towers.findIndex(t=>t.c===2&&t.r===3);if(selTower>=0)upgrade()");
    await sleep(2200);
    const lvH = S(H, "(G.towers.find(t=>t.c===2&&t.r===3)||{}).lvl");
    check("전투 중 게스트 업글 → 호스트 반영", lvH === 2, "host lvl=" + lvH);

    /* 웨이브 종료 대기 — 남은 적을 빠르게 정리해 시간 단축 (호스트 판정) */
    for (let i = 0; i < 10 && S(H, 'G.phase') === "wave"; i++) {
      run(H, "G.spawnQ=[];G.enemies.forEach(e=>e.hp=Math.min(e.hp,1))");
      await sleep(700);
    }
    const ended = await until(() => S(H, "G.phase") === "prep" && S(G2, "G.phase") === "prep"
      && S(H, "G.wave") === 1 && S(G2, "G.wave") === 1, "웨이브 1 종료 → 준비 페이즈 일치", 10000);
    check("웨이브 종료 라운드 일치 (독립 진행 없음)", ended,
      "host w" + S(H, "G.wave") + "/" + S(H, "G.phase") + " guest w" + S(G2, "G.wave") + "/" + S(G2, "G.phase"));

    /* AC: 게스트가 공동 문제 해결 → 양쪽 목록 제거 + 공용 코인 */
    const tgt = S(G2, "ACT[0]&&JSON.stringify({contestId:ACT[0].contestId,index:ACT[0].index})");
    if (tgt && tgt !== "__ERR") {
      G2.acProblems.push(JSON.parse(tgt));
      const coinsBefore = S(H, "Math.floor(G.coins)");
      run(G2, "verify()");
      const acOk = await until(() => S(H, "ACT.length") === 1 && S(G2, "ACT.length") === 1, "AC 공유 (양쪽 목록 1개)", 8000);
      check("게스트 AC → 양쪽 문제 제거", acOk);
      await sleep(1000);
      check("AC 보상 공용 금고 입금", S(H, "Math.floor(G.coins)") > coinsBefore,
        coinsBefore + "→" + S(H, "Math.floor(G.coins)"));
    }

    /* 종료: 호스트 게임오버 → 양쪽 팀 정산 */
    run(H, "gameOver()");
    const overOk = await until(() => S(H, "G.over") === true && S(G2, "G.over") === true, "양쪽 종료 처리", 9000);
    check("양쪽 종료 처리", overOk);
    await sleep(1000);
    const dH = S(H, 'document.getElementById("goDelta").innerHTML') || "";
    const dG = S(G2, 'document.getElementById("goDelta").innerHTML') || "";
    check("팀 정산 결과 양쪽 표시 (TEAM)", String(dH).includes("TEAM") && String(dG).includes("TEAM"),
      String(dH).replace(/<[^>]+>/g, "").slice(0, 40));
    check("개인 레이팅 불변", S(H, "PROFILE.rating") === 1111 && S(G2, "PROFILE.rating") === 999,
      S(H, "PROFILE.rating") + "/" + S(G2, "PROFILE.rating"));

    /* 런타임 예외 수집 (duoSync 내부 포함) */
    const seH = S(H, '(window.__syncErr||[]).length'), seG = S(G2, '(window.__syncErr||[]).length');
    check("호스트 duoSync 예외 0건", !seH, S(H, '(window.__syncErr||["-"])[0]'));
    check("게스트 duoSync 예외 0건", !seG, S(G2, '(window.__syncErr||["-"])[0]'));
    check("호스트 봇 런타임 예외 0건", H.errors.length === 0, H.errors.slice(0, 2).join(" | "));
    check("게스트 봇 런타임 예외 0건", G2.errors.length === 0, G2.errors.slice(0, 2).join(" | "));
  } catch (e) {
    check("시뮬레이션 완주", false, e.message);
  } finally {
    clearInterval(pump); clearInterval(watch);
    server.kill();
    await sleep(400);
    if (fs.existsSync(BAK)) { fs.copyFileSync(BAK, DATA); fs.unlinkSync(BAK) }
    else try { fs.unlinkSync(DATA) } catch (e) {}
  }
  const fail = results.filter(r => !r.ok).length;
  console.log("\n" + "=".repeat(50));
  console.log(fail === 0
    ? `🎉 시뮬레이션 전 항목 PASS (${results.length}개) — 듀오 동기화 이상 없음`
    : `⚠️ ${fail}/${results.length} 항목 FAIL`);
  process.exit(fail ? 1 : 0);
})();
