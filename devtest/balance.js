/* 밸런스 측정 봇 — 실제 엔진으로 솔로 런을 고속 시뮬레이션
 *   node devtest/balance.js
 * A) 문제 0개 + 최적 배치/업글 → 몇 웨이브까지 가는가 (낮아야 정상)
 * B) 2웨이브마다 문제 1개 해결 가정 → 30웨이브 클리어 가능한가 (가능해야 정상)
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function ctx2d() {
  const t = {};
  return new Proxy(t, {
    get(o, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "createLinearGradient" || p === "createRadialGradient") return () => ({ addColorStop() {} });
      return p in o ? o[p] : () => {};
    },
    set(o, p, v) { o[p] = v; return true },
  });
}
function anyObj() {
  const f = function () {};
  return new Proxy(f, {
    get: (o, p) => p === Symbol.toPrimitive ? () => 0 : (p === "then" ? undefined : anyObj()),
    set: () => true, apply: () => anyObj(), construct: () => anyObj(),
  });
}
function makeSandbox() {
  const els = new Map();
  const mkEl = () => ({ style: {}, value: "", textContent: "", innerHTML: "", disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { return c }, remove() {}, addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0 }),
    getContext: () => ctx2d(), width: 616, height: 440, focus() {}, _h: {} });
  const store = { cftd3: JSON.stringify({ token: "t", handle: "bot", muted: true, fx: "low", bgm: false }) };
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    Math, Date, JSON, Object, Array, Number, String, Boolean, Promise, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Error, Symbol,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    performance: { now: () => Date.now() }, innerWidth: 1280, innerHeight: 800,
    localStorage: { getItem: k => store[k] ?? null, setItem(k, v) { store[k] = String(v) }, removeItem(k) { delete store[k] } },
    location: { reload() {} }, navigator: {},
    AudioContext: anyObj(), webkitAudioContext: anyObj(), OfflineAudioContext: anyObj(),
    open: () => null, alert() {}, confirm: () => true, prompt: () => null,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    fetch: async () => new Response("{}", { status: 200 }),
  };
  sb.window = sb;
  sb.document = {
    getElementById: id => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id) },
    createElement: () => mkEl(), head: { appendChild() {} }, body: { appendChild() {} },
    addEventListener() {}, documentElement: mkEl(), querySelectorAll: () => [],
  };
  vm.createContext(sb);
  const src = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  vm.runInContext(src.match(/<script>([\s\S]*?)<\/script>/)[1], sb);
  return sb;
}

/* 경로 커버리지 좋은 칸 순서 (사거리 110 기준) */
function bestSpots(sb) {
  const W = vm.runInContext("WAYPTS", sb), PATHSET = vm.runInContext("PATHSET", sb);
  const spots = [];
  for (let c = 0; c < 14; c++) for (let r = 0; r < 10; r++) {
    if (PATHSET.has(c + "," + r)) continue;
    const x = c * 44 + 22, y = r * 44 + 22;
    let cov = 0;
    for (const p of W) if (Math.hypot(p.x - x, p.y - y) <= 110) cov++;
    spots.push({ c, r, cov });
  }
  return spots.sort((a, b) => b.cov - a.cov);
}

function simulate(sb, { solveEveryWave = 0, solveRating = 1100 } = {}) {
  vm.runInContext("PROFILE={rating:800,best:0,games:0};BASE=1100;POOL=[{contestId:1,index:'A',rating:1100,name:'x'}];startGame()", sb);
  const CLEAR = vm.runInContext("CLEAR_WAVE", sb);
  const SPOTS = bestSpots(sb);
  const TOWERS = vm.runInContext("TOWERS", sb);
  const UPG = vm.runInContext("UPG_COSTM", sb);
  const buy = () => {
    for (let guard = 0; guard < 60; guard++) {
      const G = vm.runInContext("G", sb);
      const upT = G.towers.filter(t => t.lvl < 5).sort((a, b) => a.lvl - b.lvl)[0];
      const upCost = upT ? Math.round(TOWERS[upT.k].cost * Math.pow(UPG, upT.lvl)) : Infinity;
      const spot = SPOTS.find(s => vm.runInContext(`canPlace(${s.c},${s.r})`, sb));
      const nextKind = G.towers.length < 5 ? "archer" : (G.towers.length % 3 === 2 ? "cannon" : "archer");
      const buildCost = spot && G.towers.length < 12 ? TOWERS[nextKind].cost : Infinity;
      if (G.coins >= buildCost && (buildCost <= upCost || !upT)) {
        vm.runInContext(`G.coins-=${buildCost};G.towers.push({k:"${nextKind}",c:${spot.c},r:${spot.r},x:${spot.c * 44 + 22},y:${spot.r * 44 + 22},lvl:1,cd:0,invested:${buildCost},flash:0})`, sb);
      } else if (G.coins >= upCost) {
        vm.runInContext(`(function(){const t=G.towers.filter(t=>t.lvl<5).sort((a,b)=>a.lvl-b.lvl)[0];t.lvl++;t.invested+=${upCost};G.coins-=${upCost}})()`, sb);
      } else break;
    }
  };
  for (let step = 0; step < 400000; step++) {
    const st = vm.runInContext("G?{phase:G.phase,wave:G.wave,over:G.over,hp:G.hp}:null", sb);
    if (!st || st.over || st.wave >= CLEAR + 1) return st ? st.wave : 0;
    if (st.phase === "prep") {
      if (solveEveryWave && st.wave % solveEveryWave === 0)
        vm.runInContext(`(function(){const r=diffFor();G.coins+=rewardOf(r);G.solved++;G.solvedSum+=r})()`, sb);
      buy();
      vm.runInContext("G.prepEnd=Date.now();callWave()", sb); /* 즉시 시작 (조기 보너스 없음 가정) */
    } else {
      vm.runInContext("update(1/20,1/20)", sb);
    }
  }
  return vm.runInContext("G.wave", sb);
}

const runs = 3;
let a = [], b = [];
for (let i = 0; i < runs; i++) a.push(simulate(makeSandbox(), {}));
for (let i = 0; i < runs; i++) b.push(simulate(makeSandbox(), { solveEveryWave: 2, solveRating: 1100 }));
console.log("문제 0개 최적 플레이   → 도달 웨이브:", a.join(", "));
console.log("2웨이브당 추천문제 해결 → 도달 웨이브:", b.join(", "), " (클리어 = 마지막 웨이브 통과)");
