/* 로컬 듀오 테스트 시드 — 프로덕션(DB/Render)과 완전히 무관, data.json만 만든다.
 *
 * 사용법:
 *   node devtest/seed.js <내_CF핸들> [파트너_핸들]
 *   node server.js
 *
 * 주의: 두 핸들 모두 "실존하는" 코드포스 핸들이어야 한다
 * (게임이 시작 시 두 사람의 푼 문제 목록을 CF API로 조회하기 때문).
 * 파트너는 아무 실존 핸들이면 됨 (기본값: tourist).
 */
const fs = require("fs");
const path = require("path");

const h1 = process.argv[2];
const h2 = process.argv[3] || "tourist";
if (!h1) {
  console.log("사용법: node devtest/seed.js <내_CF핸들> [파트너_핸들]");
  process.exit(1);
}
if (h1 === h2) {
  console.log("두 핸들은 서로 달라야 합니다 (방 참가 조건).");
  process.exit(1);
}

const f = path.join(__dirname, "..", "data.json");
let store = {};
try { store = JSON.parse(fs.readFileSync(f, "utf8")) } catch (e) {}
store.db = store.db || { users: {}, tokens: {} };
store.db.users = store.db.users || {};
store.db.tokens = store.db.tokens || {};
for (const h of [h1, h2]) {
  if (!store.db.users[h]) store.db.users[h] = { rating: 800, best: 0, games: 0, cfRating: null, cfRank: "unrated" };
}
store.db.tokens["dev1"] = { handle: h1, at: Date.now() };
store.db.tokens["dev2"] = { handle: h2, at: Date.now() };
fs.writeFileSync(f, JSON.stringify(store));

console.log(`
✅ data.json 시드 완료 (로컬 전용 — 실서버에 아무 영향 없음)

1) 서버 실행:        node server.js
2) 창 A (일반 창):    http://localhost:3000 접속 → F12 콘솔에 붙여넣기:

   localStorage.setItem("cftd3",JSON.stringify({token:"dev1",handle:"${h1}"}));location.reload();

3) 창 B (시크릿 창):  http://localhost:3000 접속 → F12 콘솔에 붙여넣기:

   localStorage.setItem("cftd3",JSON.stringify({token:"dev2",handle:"${h2}"}));location.reload();

4) 창 A에서 [방 만들기] → 코드를 창 B에 입력 → [참가]

초기화: data.json 삭제 후 다시 시드.
`);
