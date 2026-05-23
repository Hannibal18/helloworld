# helloworld — 엄마 전쟁 (멀티플레이어 PvP)

브라우저에서 같은 맵에 접속해 캐릭터를 움직이고, 말풍선으로 채팅하고, 근접 공격으로 서로를 패는 BW/JRPG 풍 실시간 캐주얼 게임. **PC + 모바일 둘 다** 동일하게 플레이된다.

- 빌드/번들러: **Vite + Vanilla TypeScript**
- 렌더링: HTML5 Canvas 2D (저해상도 백버퍼 + 정수배 픽셀 업스케일)
- 맵: **Tiled (mapeditor.org)** JSON. 16×16 타일.
- 캐릭터: **LPC (Liberated Pixel Cup)** 스프라이트시트, 시작 시 0.5배 prescale.
- 실시간: **Supabase Realtime** (Broadcast + Presence). DB/Auth/Edge Function 사용 안 함.
- 폰트: Galmuri11 도트 폰트 (CDN). 폴백 monospace.

## 1. 셋업

### 1-1. Node.js 설치
프로젝트는 Node.js 18+ 가 필요하다. 없으면:
```bash
brew install node
# 또는 nvm 사용:  nvm install --lts
```

### 1-2. 의존성 설치
```bash
npm install
```

### 1-3. Supabase 프로젝트 생성
1. https://supabase.com 에서 새 프로젝트 생성.
2. **Project Settings → API** 에서 다음 두 값을 복사:
   - **Project URL** (예: `https://xxxx.supabase.co`)
   - **anon public key** (jwt 형태의 긴 문자열)
3. 프로젝트 루트에 `.env` 파일을 만들고 채운다 (`.env.example` 복사):
   ```bash
   cp .env.example .env
   ```
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGci...
   ```
4. Realtime 은 신규 프로젝트에서 **기본 활성화** 되어 있다 — Broadcast/Presence 는 추가 설정 없이 바로 동작한다. 별도의 테이블·RLS·마이그레이션 필요 없음.

> 🔒 `anon` key 는 클라이언트에 노출돼도 안전한 공개 키이지만, `.env` 파일은 `.gitignore` 에 포함돼 있어 커밋되지 않는다.

### 1-4. 실행
```bash
npm run dev
```
브라우저에서 `http://localhost:5173` 을 열면 끝. 멀티 플레이를 확인하려면 **탭 2~3개** 또는 **다른 기기**(같은 네트워크의 핸드폰)로 동시 접속해 본다.

> Vite dev 서버는 `host: true` 로 떠 있으므로, 같은 네트워크의 핸드폰에서 `http://<PC의-LAN-IP>:5173` 으로 접속할 수 있다.

## 1-5. 맵/타일셋 만들기 (Tiled)

### 폴더 구조
```
public/assets/
  maps/
    town.json                       ← Tiled JSON (샘플 포함)
  tilesets/
    forest_tiles.png                ← LPC Forest 타일셋 32×32 (포함, CC-BY-SA)
    forest_tiles.credits.txt        ← 원작자/라이선스 명시
    forest_tiles.preview.png        ← 참고용 프리뷰
public/sprites/
  character-spritesheet.png         ← LPC 캐릭터 시트 (포함)
```

### 1) 타일셋 PNG
**기본 포함**: `public/assets/tilesets/forest_tiles.png` (LPC Forest 32×32 타일셋, CC-BY-SA, Lanea Zimmerman 외).

다른 타일셋 사용하고 싶으면 [OpenGameArt](https://opengameart.org) 에서 **32×32 LPC 호환 타일셋** 검색해 받는다. (라이선스는 **CC0** / **CC-BY** / **CC-BY-SA** / **OGA-BY** 등 자유 라이선스만)

추천 검색어:
- `LPC 32x32 tileset`
- `LPC compatible terrain`
- `LPC town tileset`

⚠️ **닌텐도/포켓몬/스퀘어에닉스 등 상용 IP 의 추출 에셋은 절대 사용 금지** (저작권 침해).

### 2) Tiled 설치
1. https://www.mapeditor.org 에서 Tiled 다운로드 (무료 오픈소스)
2. 설치 후 실행

### 3) 맵 그리기
1. **File → New Map** :
   - Orientation: **Orthogonal**
   - Map size: 적당히 (예: 25×20)
   - Tile size: **32 × 32 px**
2. **Map → New Tileset...** → Image 선택 → `public/assets/tilesets/forest_tiles.png` (또는 본인 타일셋) → "**Embed in map**" 체크 → OK
3. **레이어를 아래 이름으로 만든다** (Layer 패널 우클릭 → New Layer):
   | 레이어 이름 | 타입 | 용도 |
   |---|---|---|
   | `ground` | Tile Layer | 흙·풀·길·광장 (맨 아래) |
   | `decor` | Tile Layer | 꽃·돌멩이 같은 작은 장식 (충돌 X) |
   | `objects_below` | Tile Layer | 나무 밑동·집 벽 등 캐릭터보다 **뒤** |
   | `objects_above` | Tile Layer | 나무 상단·지붕 등 캐릭터보다 **앞** (가림 효과) |
   | `collision` | Object Layer | 충돌 영역 (사각형으로 표시) |
   | `spawns` | Object Layer | 리스폰 지점 (Point 객체) |
4. 페인트 → 그리기. 키 큰 오브젝트(나무·집)는 밑동을 `objects_below`, 윗부분을 `objects_above` 에 분리.
5. **collision** 레이어에서 **Insert Rectangle** 툴로 충돌 영역 사각형 추가.
6. **spawns** 레이어에서 **Insert Point** 툴로 스폰 지점 찍기 (2~5개 권장).
7. **File → Export As → JSON** → `public/assets/maps/town.json` 로 저장 (덮어쓰기).

### 4) 새로고침
브라우저에서 `localhost:5173` 새로고침 → 새 맵이 보임.

> 💡 **샘플 맵 포함**: `public/assets/maps/town.json` 에 25×20 임시 맵이 들어있다. 타일셋 PNG 가 없으면 단색 placeholder 로 표시되니 일단 어떻게 보이는지 확인 후 자기 맵으로 교체.

### 5) 디버그 패널
게임 화면에서 **백틱(\`) 키**로 디버그 패널 토글:
- 캐릭터 스케일 슬라이더 (0.3~0.7) — 실시간 prescale
- 충돌박스 / 그리드 / 히트박스 시각화 토글
- 현재 좌표 / 타일 인덱스 표시

## 2. 조작

| | PC | 모바일 |
|---|---|---|
| 이동 | 방향키 / WASD | 좌측 가상 조이스틱 |
| 공격 | Space / 마우스 클릭 | 우측 공격 버튼 |
| 채팅 | Enter (입력) · Enter 전송 · Esc 취소 | 우측 채팅 버튼 |

- 멀티터치: 모바일에서 왼손 조이스틱 + 오른손 공격 버튼을 동시에 눌러도 둘 다 동작한다.

## 3. 시스템 사양

- 좌표 단위: **16px (1 타일)** 기준.
- 최대 HP **100**, 공격 데미지 **20**, 쿨다운 **0.5초**, 무적시간 **0.4초**, 넉백 **12px**.
- 히트박스: 바라보는 방향 앞쪽 **20px × 폭 18px**.
- 사망 후 **3초** 뒤 랜덤 스폰 지점에서 부활. **킬러는 3초간 제로투 댄스** (위치 고정).
- 위치 broadcast: 이동 중 **10/s**, 정지 직후 1회, 유휴 시 **1초 heartbeat**.

## 4. 권위 없는 분산형 전투

Supabase Realtime 은 메시지 중계만 한다 (서버 로직 없음). 따라서 각 클라이언트는 **자기 캐릭터의 상태(위치·HP·방향)** 에만 권위를 가진다.

1. 공격자는 공격 키를 누르면 자기 화면에서 스윙 모션을 재생하고, `attack` broadcast 를 보낸다.
2. 다른 클라이언트가 `attack` 을 받으면 **자기 캐릭터가 공격자의 히트박스 안인지 스스로 계산** 한다.
3. 맞았으면 자기 HP 를 깎고, 넉백·무적시간·피격 깜빡임을 적용한 뒤 `hp` (필요시 `death`) broadcast.

치팅이 가능한 구조지만 (자기 HP를 안 깎으면 안 죽음) 캐주얼 게임이라 수용하는 트레이드오프. (`src/player.ts` 참고)

## 5. 배포

정적 호스팅에 빌드 결과물(`dist/`)을 업로드하면 된다.

```bash
npm run build
```

### Vercel 예시
```bash
npx vercel deploy --prod
```
- Build Command: `npm run build`
- Output Directory: `dist`
- Environment Variables: 대시보드에서 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 등록.

### Netlify / Cloudflare Pages 도 비슷
- Build command: `npm run build`
- Publish directory: `dist`
- Env: 위 두 변수 등록.

## 6. 프로젝트 구조

```
helloworld/
  index.html
  package.json
  vite.config.ts
  tsconfig.json
  .env.example
  .gitignore
  README.md
  public/
    audio/Henesys Port Vibes.mp3   # BGM
    sprites/character-spritesheet.png  # LPC 캐릭터 시트
    assets/
      maps/town.json               # Tiled JSON (사용자 수정)
      tilesets/                    # 16x16 타일셋 PNG 들 (사용자 준비)
  src/
    main.ts        # 부트스트랩
    supabase.ts    # Supabase 클라이언트
    net.ts         # 채널 송수신 래퍼
    types.ts       # 공유 타입 + 네트워크 페이로드
    game.ts        # 게임 루프, 네트워크 콜백, 상태 통합
    player.ts      # 로컬 플레이어: 이동/충돌/공격 히트박스/피격
    input.ts       # 키보드/마우스/터치를 공통 inputState 로 통합
    controls.ts    # 모바일 가상 조이스틱·버튼 오버레이
    world.ts       # TILE 상수 + 카메라
    map.ts         # Tiled JSON 로더 + 타일 렌더 + 충돌
    sprites.ts     # 캐릭터 prescale + 댄스 픽셀아트
    render.ts      # 한 프레임 렌더 (레이어/Y-소트/오버레이)
    bubbles.ts     # 채팅 말풍선 DOM 오버레이
    debug.ts       # 디버그 패널 (` 키)
    audio.ts       # BGM
    ui.ts          # 입장 화면, 채팅 입력, HUD
    style.css
```

## 7. Assets / Credits

- **LPC 캐릭터 스프라이트시트** (`public/sprites/character-spritesheet.png`): Liberated Pixel Cup Universal Spritesheet Character Generator 에서 생성. base body / human male head / neutral expression (light skin).
  - 원작자: bluecarrot16, JaidynReiman, BenCreating, Evert, ElizaWy, TheraHedwig, MuffinElZangano, Durrani, Johannes Sjölund (wulax), Stephen Challener (Redshrike) 외
  - 라이선스: OGA-BY 3.0 / CC-BY-SA 3.0 / GPL 3.0
  - 출처: https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles
- **LPC Forest 타일셋** (`public/assets/tilesets/forest_tiles.png`): 32×32 LPC 호환.
  - 원작자: Lanea Zimmerman (Sharm), Tuomo Untinen, Hyptosis, Johann C, Manuel Riecke (MrBeast), William Thompson 외 — 자세한 내용은 `forest_tiles.credits.txt` 참고
  - 라이선스: **CC-BY-SA 3.0**
- **BGM** (`public/audio/Henesys Port Vibes.mp3`): 사용자 제공.

## 8. 향후 확장 메모 (현재는 구현 안 함)

- **킬 리더보드**: Supabase 에 `kills (id, name, kills, updated_at)` 테이블 + RLS, `death` 발생 시 killer 가 자기 카운트를 upsert, Postgres Changes 또는 폴링으로 화면 우측에 TOP 5 표시. (지금은 만들지 말 것.)

