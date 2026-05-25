# tiled-mcp

Tiled JSON 맵 파일을 직접 조작하는 MCP 서버. Claude Code 에서 도구로 호출.

## 도구

| 도구 | 설명 |
|---|---|
| `tiled_summary` | 맵 요약 (크기, 레이어, 타일셋) |
| `tiled_paint_rect` | tilelayer 사각형 영역 채우기 (gid=0 이면 지움) |
| `tiled_add_object` | objectgroup 에 오브젝트 추가 (spawn 포인트 등) |
| `tiled_set_tile_property` | 타일셋의 타일에 property 설정 (예: blocked=true) |
| `tiled_get_tile` | 특정 좌표 타일 gid 조회 |

## 설치 (한 번만)

```bash
cd tools/tiled-mcp
npm install
```

## Claude Code 등록

Claude Code 설정 파일 `~/.claude.json` (또는 OS별 설정 파일) 에 추가:

```json
{
  "mcpServers": {
    "tiled": {
      "command": "npx",
      "args": ["tsx", "/Users/han/Developer/helloworld/tools/tiled-mcp/src/index.ts"]
    }
  }
}
```

(또는 Claude Code CLI `claude mcp add tiled --command "npx" --args "tsx,$(pwd)/src/index.ts"`)

저장 → Claude Code 재시작 (또는 새 세션) → 다음부터 `tiled_*` 도구 사용 가능.

## 검증

설정 후 새 세션에서:
```
tiled_summary(path: "public/maps/zombie_road.json")
```

JSON 요약이 나오면 성공.

## 예시 사용

광장 맵의 EASY 구역을 5×5 풀밭(gid=12)으로 만들기:
```
tiled_paint_rect(
  path: "public/maps/zombie_road.json",
  layer: "ground",
  x: 9, y: 9, w: 5, h: 5,
  gid: 12,
)
```

스폰 포인트 추가:
```
tiled_add_object(
  path: "public/maps/zombie_road.json",
  layer: "spawns",
  name: "spawn",
  x: 480, y: 320,
  point: true,
)
```

타일을 blocked 로 마킹 (collision):
```
tiled_set_tile_property(
  path: "public/maps/zombie_road.json",
  tileset: "trees",
  tileId: 3,
  property: "blocked",
  value: true,
)
```

## 주의

- 외부 .tsx 타일셋 (`source` 참조) 의 속성은 직접 못 바꿈. inline 타일셋만 지원.
- 파일 쓰기 시 2-space indent + 끝 newline 으로 정규화 (diff 안정성).
- 백업 안 함 — git 으로 변경 추적할 것.
