# helloworld-server (Cloudflare Workers + Durable Object)

좀비 모드 협동 게임의 **호스트 봇** — 클라이언트(P2P 호스트) 대신
서버가 좀비 시뮬을 권위적으로 돌리도록 점진적 마이그.

## 현재 상태 (Phase 3 완료)

- ✅ Worker 진입점 (`POST /room/:roomId/start` → 그 룸 DO 깨우기)
- ✅ Durable Object (룸당 1 인스턴스, idle 5분 sleep)
- ✅ Supabase Realtime 채널 가입 (봇 ID = 사전순 최소 UUID)
- ✅ 좀비 시뮬 (spawn / AI / damage / snapshot)
- ✅ 5Hz snapshot broadcast (zombie_snapshot)
- ✅ zombie_hit_request 처리 (호스트 권위)
- ✅ pos / hp / death / revive 수신 → 플레이어 추적
- ✅ match_start 수신 → 난이도 캡처
- ✅ 클라이언트 자동 봇 호출 (`VITE_WORKER_URL` 설정 시 진입할 때 POST)
- ⏳ Phase 4: 배포 + 운영 (아래 참고)

## 설정

처음 1회:

```bash
cd cloudflare
npm install
npx wrangler login          # 브라우저로 Cloudflare 계정 인증
```

## Secret 등록 (배포 전 1회)

```bash
npx wrangler secret put SUPABASE_URL
# → 프롬프트에 https://....supabase.co 입력
npx wrangler secret put SUPABASE_ANON_KEY
# → 프롬프트에 anon key 입력
```

## 로컬 개발

```bash
npm run dev                 # http://localhost:8787
```

테스트:
```bash
curl -X POST http://localhost:8787/room/DEFAULT/start
curl http://localhost:8787/room/DEFAULT/status
```

## 배포

```bash
npm run deploy
```

배포 후 출력에 URL 표시 (예: `https://helloworld-server.<account>.workers.dev`).

## Phase 4 — 클라이언트와 연결

배포된 Worker URL 을 클라이언트 `.env` 에 추가:

```
VITE_WORKER_URL=https://helloworld-server.<account>.workers.dev
```

Vercel 배포본도 같은 env 추가 (Vercel 대시보드 → Settings → Environment Variables).
그 다음 `git push` → Vercel 자동 재배포. 이후부터 모든 매치는 봇이 호스트.

미설정 시 → 사용자 중 id 최소가 호스트 (기존 P2P 폴백).

## 검증

배포 후 모니터:
```bash
curl https://helloworld-server.<account>.workers.dev/room/B12345/status
# → { roomId, players, zombies, killCount, active, difficulty }
```

Wrangler tail (실시간 로그):
```bash
npx wrangler tail
```

## 디자인

### 봇 ID

`00000000-0000-0000-0000-000000000000` — 사전순 최소 UUID.
클라이언트의 `isLocalHost()` (id 최소 = 호스트) 가 자동으로 봇을 호스트로
인식. 클라이언트는 자기를 호스트로 안 봄 → 시뮬 권한 자동으로 봇에.

### Durable Object 1 인스턴스 = 1 룸

`env.ROOMS.idFromName(roomId)` 로 룸 ID 마다 결정적 DO 생성. 같은 룸
요청이 항상 같은 DO 로. 룸 비면 5분 후 자동 종료.

### 알람 (Phase 2 예정)

`this.state.storage.setAlarm()` 으로 주기적 sim tick. Phase 2 에서
50~100ms 주기로 좀비 AI 업데이트.

## 비용

- 무료 플랜: 100k 요청/일, 1M DO 알람/일
- 룸 1개 활성 = 알람 ~864k/일 (100ms 주기) — 거의 free tier 한도
- 활성 룸 많아지면 유료 ($5/월 부터)
