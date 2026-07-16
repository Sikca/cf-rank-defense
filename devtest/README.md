# 듀오 모드 혼자 테스트하기

게임/서버 코드 수정 없이, 로컬 서버 + 테스트 토큰 2개로 2인 플레이를 혼자 검증한다.
`DATABASE_URL` 없이 실행하면 서버가 `data.json` 파일 저장 모드로 돌기 때문에
실서버(Render/Neon) 데이터와 완전히 분리된다.

## 준비 (최초 1회)

```bash
npm install
```

## 실행

```bash
node devtest/seed.js <내_CF핸들>        # 파트너 기본값: tourist
node server.js                          # http://localhost:3000
```

- **창 A** (일반 창): 접속 후 F12 콘솔에
  `localStorage.setItem("cftd3",JSON.stringify({token:"dev1",handle:"<내핸들>"}));location.reload();`
- **창 B** (시크릿 창 — localStorage가 분리되어야 함): 콘솔에
  `localStorage.setItem("cftd3",JSON.stringify({token:"dev2",handle:"tourist"}));location.reload();`

로그인 화면 없이 바로 로비로 들어가진다. 창 A에서 방 만들기 → 코드를 창 B에 입력 → 참가.

두 핸들 모두 실존해야 하는 이유: 듀오 시작 시 두 사람의 푼 문제 목록을
CF API에서 실제로 불러오기 때문. 파트너 핸들은 아무 실존 핸들이나 상관없다.

## 체크리스트 (v22 대개편 검증 항목)

| 항목 | 기대 동작 |
|---|---|
| 게스트(창 B) 건설/업글/판매 | 클릭 즉시 반영, 몇 초 뒤에도 롤백 없음 |
| 게스트 화면 전투 | 몬스터가 부드럽게 이동, 타워가 발사 (정지/순간이동 없음) |
| 카드 뽑기 | 양쪽 어디서 눌러도 즉시 열림, **두 창의 카드 5장이 동일** |
| 카드 중복 | 같은 웨이브에 다시 눌러도 같은 세트만 재오픈 (새로 생성 안 됨) |
| 카드 선택 | 한쪽이 고르면 1~2초 내 상대 모달에서도 그 카드가 사라짐 |
| 웨이브 시작 | 게스트가 눌러도 즉시 시작 ("시작 중..." 대기 없음), 양쪽 웨이브 번호 일치 |
| 코인/HP | 몇 초 내 양쪽 수치 수렴 |
| 제출 확인 | 내 핸들 창에서만 의미 있음 (실제 CF 제출 기준) |
| 게임 종료 | 양쪽 모두 정산 화면, data.json의 레이팅 변동 |

## 초기화

```bash
rm data.json && node devtest/seed.js <내_CF핸들>
```
