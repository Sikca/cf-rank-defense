# 🏰 CF 랭크 디펜스 — Render + Neon 무료 배포판

폴링 호출 무제한(Render) + 데이터 영구 보존(Neon PostgreSQL) 구성.
100명 규모까지 완전 무료로 감당 가능합니다.

## 배포 (약 10분)

### 1. Neon — 무료 PostgreSQL
1. https://neon.tech 가입 → New Project 생성
2. 대시보드의 **Connection string** 복사 (`postgresql://...` 형태)

### 2. GitHub에 올리기
이 폴더를 GitHub 저장소로 push:
```bash
git init && git add . && git commit -m "cf rank defense"
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

### 3. Render — 무료 웹서비스
1. https://render.com 가입 → **New → Web Service** → GitHub 저장소 연결
2. 자동 감지 확인: Build `npm install` / Start `node server.js` / Plan **Free**
3. **Environment → Add Environment Variable**:
   - Key: `DATABASE_URL`
   - Value: (1에서 복사한 Neon connection string)
4. Deploy → 완료되면 `https://<이름>.onrender.com` 이 공개 주소

## 무료 플랜 특성
- **호출 무제한** — 폴링(채팅/관전/듀오) 걱정 없음. 대역폭 월 5GB
- **15분 유휴 시 슬립** → 첫 접속이 ~30초 느림.
  해결: https://uptimerobot.com (무료) 에서 5분 간격으로 사이트 URL을 ping하는 모니터 등록
- 데이터는 Neon에 저장되므로 재배포/재시작에도 유지
- `DATABASE_URL` 없이 실행하면 로컬 `data.json` 파일 저장 (개발용)

## 로컬 실행
```bash
npm install
npm start   # http://localhost:3000
```

## Netlify에서 데이터 이전
기존 Netlify Blobs의 유저 데이터(레이팅 등)를 옮기려면:
Netlify 대시보드 → 프로젝트 → Blobs → `cf-defense` 스토어 → `db` 키 내용 복사 →
Neon SQL Editor에서:
```sql
INSERT INTO kv(k,v) VALUES('db','<복사한 JSON>') ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v;
```
