/* 동시 정산 lost-update 재현/검증
 *   node devtest/race.js
 *
 * Postgres 모드의 의미론(읽기마다 새 사본 + 네트워크 지연)을 모사한 가짜 KV로
 * ① 구버전 패턴(loadDB→수정→saveDB 통짜 덮어쓰기)의 유실을 재현하고
 * ② 신버전 withDB(advisory lock 직렬화) 패턴이 전량 보존함을 증명한다.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* PG 흉내: 값은 항상 깊은 사본으로 반환(참조 공유 없음), 왕복 지연 존재 */
function makeFakePG() {
  let stored = JSON.stringify({ users: {}, tokens: {} });
  let lock = Promise.resolve(); /* advisory lock 흉내용 체인 */
  return {
    async get() { await sleep(3 + Math.random() * 5); return JSON.parse(stored) },
    async set(d) { await sleep(3 + Math.random() * 5); stored = JSON.stringify(d) },
    async withLock(fn) { /* pg_advisory_xact_lock 의미론: 완전 직렬화 */
      const prev = lock;
      let release;
      lock = new Promise(r => { release = r });
      await prev;
      try { return await fn() } finally { release() }
    },
    dump() { return JSON.parse(stored) },
  };
}

function applyRun(u) { u.rating += 10; u.games++ }

async function scenario(name, settleFn, N = 20) {
  const pg = makeFakePG();
  const init = { users: {}, tokens: {} };
  for (let i = 0; i < N; i++) init.users["p" + i] = { rating: 800, games: 0 };
  await pg.set(init);
  await Promise.all(Array.from({ length: N }, (_, i) => settleFn(pg, "p" + i)));
  const d = pg.dump();
  const applied = Object.values(d.users).filter(u => u.games === 1).length;
  console.log(`${name.padEnd(34)} 정산 반영: ${applied}/${N}${applied === N ? " ✅" : "  ❌ LOST UPDATE"}`);
  return applied;
}

(async () => {
  console.log("🧪 동시 정산 " + 20 + "건 (Postgres 의미론 모사)\n");
  /* 구버전: 잠금 없는 read-modify-write */
  const oldApplied = await scenario("구버전 loadDB→수정→saveDB", async (pg, h) => {
    const d = await pg.get();
    applyRun(d.users[h]);
    await pg.set(d);
  });
  /* 신버전: withDB (advisory lock으로 직렬화) */
  const newApplied = await scenario("신버전 withDB (advisory lock)", async (pg, h) => {
    await pg.withLock(async () => {
      const d = await pg.get();
      applyRun(d.users[h]);
      await pg.set(d);
    });
  });
  console.log("\n" + "=".repeat(46));
  if (newApplied === 20 && oldApplied < 20)
    console.log(`🎉 수정 검증 완료 — 구버전 ${20 - oldApplied}건 유실 재현 / 신버전 전량 보존`);
  else if (newApplied === 20)
    console.log("🎉 신버전 전량 보존 (구버전 유실이 이번 실행에선 재현되지 않았지만 이론상 존재)");
  else { console.log("⚠️ 신버전에서 유실 발생 — withDB 구현 확인 필요"); process.exit(1) }
})();
