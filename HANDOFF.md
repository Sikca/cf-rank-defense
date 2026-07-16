# CF RANK DEFENSE — 프로젝트 인수인계 문서

AI 세션/협업자가 이 문서만 읽으면 이어서 작업할 수 있도록 정리한 요약. (v47 기준)

## 무엇인가
Codeforces 문제를 실제로 풀어(AC 검증) 코인을 벌고, 타워로 성을 지키는 랭크전 타워 디펜스.
ICPC/CP 연습용. 솔로 + 2인 듀오 협동 + 관전 + 랭킹 + 채팅.

## 스택 & 배포
- **프론트**: `public/index.html` 단일 파일 (HTML+Canvas+JS 전부). 이모지 대신 벡터 유닛.
- **서버**: `server.js` (Express). Render 무료 웹서비스. `DATABASE_URL` 있으면 Neon Postgres KV(`kv(k,v jsonb)` 단일 테이블), 없으면 로컬 `data.json`(개발용).
- **배포**: `git push` → Render 자동 재배포. DATABASE_URL은 Render 대시보드 env(저장소엔 없음).
- `cf-defense-netlify/`는 미러(비활성 사이트) — index.html 복사 + api.mts를 항상 동기화할 것.
- 슬립 방지: `/api/ping` (DB 안 건드림) + UptimeRobot 5분 간격.

## 게임 규칙 (현재)
- 총 **15웨이브** 클리어 = 승급. 성 HP 20, 누수 1(보스 5).
- 시작 코인 90. 킬 코인 거의 없음(normal 1, fast 0, tank 1, boss 5~8). 웨이브 보너스 1+wave/5.
- **코인은 문제 풀이가 주 수입**: reward = rating/4 + wave×34. 조기 시작 보너스 = 남은 준비시간/30 (최대 20).
- 카드: 솔로 3장/1선택, 듀오 5장/2선택. 태그 비공개, 교체 불가, 웨이브당 1세트.
- **출제 기준 = 내 레이팅에서 시작, 5웨이브마다 +100** (`diffFor()`), 카드는 기준 ±100~200.
- 준비시간: 문제 난이도별 (★900=15분 … ★2800+=95분, `prepMinutes`). 여러 문제면 최고 난이도 기준.
- 받은 이후의 CF 제출만 AC 인정 (`p.at` 기준).
- 적 HP 성장 **1.32^wave**, 웨이브당 몬스터 **8+3n**. 업글 화력 1.65배/레벨, 비용 1.7배, 최대 5레벨.
- **특수 보스** (5의 배수 웨이브, `bossKind/bossSpec`): 5 BERSERKER(빈사 시 속도 1.9배), 10 SUMMONER(3초마다 부하 소환), 15 OVERLORD(체력 17배 + 초당 1.2% 재생).
- 밸런스 기준치(봇): 문제 0개 → 웨이브 3 사망 / 매 웨이브 1문제 → 15 클리어.

## 레이팅
- 모두 800 시작. perf = 800 + min(wave, 1+solved×2)×90 + avg난이도/10 + solved×25. delta = (perf−rating)/6, 클램프 −120~+150. 15웨이브 클리어 시 최소 +50+solved×8.
- **듀오는 팀 레이팅만 변동**(pair 키, 800 시작) — 개인 레이팅 불변. 통계는 보상 큐에서 집계.
- 이탈 방지: 솔로는 하트비트(4초) 10분 끊기면 서버가 그 시점으로 자동 정산(`/api/me`). 듀오 스냅샷(`snap.duo`)은 제외.
- `settledAt`으로 다른 기기의 낡은 이어하기 저장본 무효화(이중 정산 방지).

## 캠페인 (v51)
- 별개 모드 (레이팅 무변동). `CAMPAIGN[]` 10스테이지: 맵(map)·waves·diff(출제 고정)·hp·coins·기믹(fastBias/tankBias/hpMult/finale[]).
- `setMap(cells)`로 경로 전환 (WAYPTS/PATHSET/정적 레이어 재생성). 랭크/듀오 시작 시 `MAP_DEFAULT` 복귀 필수.
- 클리어 별: 남은 HP ≥90% → 3, ≥50% → 2, 그 외 1. `POST /api/campaign {stage,stars}` → `users[h].campaign.sN` 최대값 유지.
- 해금: 이전 스테이지 별 ≥1. 캠페인 중엔 saveRun/방송(live)/정산 전부 비활성.
- 보스: 기본(5의 배수 웨이브) + `finale` 배열이 마지막 웨이브 보스를 교체(`G.bossKQ`).

## 인증/로그인
- 최초 1회: 4A에 컴파일 에러 제출 → `/api/verify-start` 이후 제출만 인정 → 토큰 발급.
- 이후: **핸들+비밀번호** (`/api/login`, `/api/setpw`). scrypt 솔트 해시. 응답에서 `userPub()`로 pw 제거 필수. 로그인 1분 8회 제한.

## 듀오 동기화 (핵심 설계 — 깨뜨리지 말 것)
- 호스트(방 생성자, role "def")가 시뮬 권위자. 게스트도 **완전한 로컬 시뮬**을 돌리고 스냅샷으로 보정.
- 서버 저장: `room-CODE`(메타+상태, 호스트만 씀) / `room-CODE-q`(액션·보상·채팅 큐, **append 전용 + 워터마크(sinceA/sinceR) 소비**) — 상태 쓰기가 큐를 덮어쓰면 안 되므로 분리했음. PG에선 jsonb 원자 append.
- 카드는 **시드 결정적**: seed = 방코드+웨이브(`seededRng/duoCards`), POOL은 정렬. 양쪽이 로컬에서 동일 5장 즉시 생성.
- 웨이브 큐도 결정적(`buildQueue`). 배속은 공유 설정(액션 t:"speed").
- 웨이브 종료 판정은 호스트만. 게스트 보정: 타워는 병합(쿨다운 유지), 적은 개별 페어링 스무딩(90px), 하드 리싱크는 웨이브/페이즈 어긋날 때만.
- 폴링: 전투 700ms / 준비 1.5s + 액션 후 350ms 빠른 싱크. `DUO.syncing` 가드는 **finally로 해제**(안 하면 영구 정지 버그).
- 서버 액션 리미터: 2초 8발 버스트, 단 wave/draw/pick/speed는 20발까지(절대 드롭 금지).
- 듀오 복귀: `cftd3duo` localStorage + 로비 복귀 버튼, 재입장 시 room.state에서 게임 복원(호스트가 wave0으로 덮어쓰는 사고 방지).

## 관전/라이브
- 솔로+듀오(호스트 명의, `duo:{partner}`) 하트비트 4초 → `live-핸들` 키. 목록/관전 신선도 **90초**(백그라운드 탭 타이머 스로틀 대응). 탭 복귀 시 즉시 1회 발신.
- 하트비트에 `run` 스냅샷 동봉 → 다른 기기 이어하기(`liveRun`, 10분 내).

## 동시성·무료 한도 (v53 핵심)
- **db 쓰기는 반드시 `withDB()`** — pg advisory lock(911) 트랜잭션으로 RMW 직렬화. 잠금 없는 loadDB→saveDB는 동시 정산 시 lost update(실측 19/20 유실)를 일으킴. `devtest/race.js`로 재현/검증.
- **휘발 키(live-/room-/chat)는 서버 메모리(MEM)** — 폴링이 DB를 안 깨움(Neon 컴퓨트 절약, 무료 100 CU-h/월). 재시작 시 소실 허용(방/라이브는 단명). 배포는 듀오 진행 중 피할 것.
- **Render 무료 대역폭 5GB/월** (2026-04 개편): gzip 압축 미들웨어, /api/live 목록 슬림(핸들·웨이브·HP·duo만), 관전 단건에서 run 제거, CF 프록시 problemset 4필드 슬림.
- Neon 무료: 100 CU-h/월, 유휴 scale-to-zero. MEM 분리 덕에 정산/로그인 순간에만 깨어남.

## 테스트 (배포 전 필수)
```
node devtest/verify.js    # 15항목: 프로토콜/정산/스팸/결정성
node devtest/simduo.js    # 봇 2명이 실코드로 듀오 한 판 (20항목)
node devtest/balance.js   # 밸런스 측정 (무문제/솔버 도달 웨이브)
node devtest/seed.js <핸들>  # 수동 2창 테스트용 시드 (+ node server.js)
node devtest/race.js      # 동시 정산 lost-update 재현/검증
```
전부 로컬 data.json만 사용(자동 백업/복원), 실서버 무영향.

## 주의사항
- index.html 수정 시 `cf-defense-netlify/public/index.html`에도 복사.
- 서버 공식 수정 시 `api.mts`(Netlify 미러)도 동일 반영.
- `data.json`은 .gitignore — 커밋 금지 (dev 토큰 포함).
- 하드코딩 잔재 주의: 웨이브 수/보스명 등은 상수(`CLEAR_WAVE`, `bossSpec`) 참조로 통일했음.
- 홈/가이드 문구는 사용자가 직접 다듬은 텍스트 — 임의로 AI투로 바꾸지 말 것.
- 성장률 1.32는 `enemyStats`와 `bossSpec` 두 곳에 있음 — 함께 바꿀 것.

## 운영 SQL (Neon)
- 전체 초기화: `UPDATE kv SET v=jsonb_set(v,'{users}',(SELECT jsonb_object_agg(key,value||'{"rating":800,"best":0,"games":0}'::jsonb) FROM jsonb_each(v->'users'))) WHERE k='db';`
- 듀오 랭킹 초기화: `UPDATE kv SET v=v-'duos' WHERE k='db';`
- 라이브/방 정리: `DELETE FROM kv WHERE k LIKE 'live-%' OR k LIKE 'room-%';`
