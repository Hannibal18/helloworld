// Tiled MCP 서버 — Tiled JSON 맵 파일을 안전하게 조작.
// stdio transport — Claude Code 에 등록해서 사용.
//
// 등록 방법은 ../../tools/tiled-mcp/README.md 참고.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  addObject, paintRect, readMap, setTileProperty, summarize, writeMap,
} from './tiled.js';

const server = new Server(
  { name: 'tiled', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ===== 도구 정의 =====

const TOOLS: Tool[] = [
  {
    name: 'tiled_summary',
    description:
      'Tiled JSON 맵 파일을 읽고 요약 반환 (맵 크기, 레이어 목록, 타일셋 목록). 편집 전에 구조 파악할 때 사용.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '맵 JSON 파일 경로 (절대 또는 상대)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'tiled_paint_rect',
    description:
      '특정 tilelayer 의 사각형 영역을 단일 gid 로 채움. gid=0 이면 지움. 영역 밖은 자동 스킵.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        layer: { type: 'string', description: '대상 tilelayer 이름' },
        x: { type: 'number', description: '시작 x (타일 단위)' },
        y: { type: 'number', description: '시작 y (타일 단위)' },
        w: { type: 'number', description: '폭 (타일 수)' },
        h: { type: 'number', description: '높이 (타일 수)' },
        gid: { type: 'number', description: '채울 타일 gid (0 = 지움)' },
      },
      required: ['path', 'layer', 'x', 'y', 'w', 'h', 'gid'],
    },
  },
  {
    name: 'tiled_add_object',
    description:
      '특정 objectgroup 레이어에 오브젝트 추가 (예: spawn 포인트). point=true 면 점, 아니면 width/height 사각형.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        layer: { type: 'string', description: '대상 objectgroup 이름' },
        name: { type: 'string', description: '오브젝트 이름 (예: "spawn")' },
        type: { type: 'string', description: '오브젝트 타입 (선택)' },
        x: { type: 'number', description: '월드 px 좌표' },
        y: { type: 'number', description: '월드 px 좌표' },
        width: { type: 'number', description: '사각형 너비 (point=false 일 때)' },
        height: { type: 'number', description: '사각형 높이' },
        point: { type: 'boolean', description: 'true 면 점 오브젝트' },
        properties: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: {},
              type: { type: 'string' },
            },
            required: ['name', 'value'],
          },
          description: 'Tiled custom properties 배열',
        },
      },
      required: ['path', 'layer', 'x', 'y'],
    },
  },
  {
    name: 'tiled_set_tile_property',
    description:
      '타일셋 내 특정 tileId 에 custom property 설정 (예: blocked=true). 콜리전 마킹용.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        tileset: { type: 'string', description: '타일셋 이름' },
        tileId: { type: 'number', description: 'tileset 내 local id (gid 아님)' },
        property: { type: 'string', description: 'property 이름 (예: blocked)' },
        value: { description: 'property 값 (bool / int / string)' },
        propType: { type: 'string', description: 'Tiled property type (bool/int/string/float)', default: 'bool' },
      },
      required: ['path', 'tileset', 'tileId', 'property', 'value'],
    },
  },
  {
    name: 'tiled_get_tile',
    description: '특정 tilelayer 의 (x, y) 타일 gid 반환. 디버그/검증용.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        layer: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['path', 'layer', 'x', 'y'],
    },
  },
];

// ===== 핸들러 =====

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'tiled_summary': {
        const path = String(args.path);
        const { map, absPath } = await readMap(path);
        return ok(summarize(map, absPath));
      }
      case 'tiled_paint_rect': {
        const path = String(args.path);
        const { map, absPath } = await readMap(path);
        const result = paintRect(
          map, String(args.layer),
          Number(args.x), Number(args.y), Number(args.w), Number(args.h),
          Number(args.gid),
        );
        await writeMap(absPath, map);
        return ok({ path: absPath, ...result });
      }
      case 'tiled_add_object': {
        const path = String(args.path);
        const { map, absPath } = await readMap(path);
        const obj = addObject(map, String(args.layer), {
          name: args.name as string | undefined,
          type: args.type as string | undefined,
          x: Number(args.x), y: Number(args.y),
          width: args.width != null ? Number(args.width) : undefined,
          height: args.height != null ? Number(args.height) : undefined,
          point: args.point === true || undefined,
          properties: args.properties as { name: string; value: unknown; type?: string }[] | undefined,
        });
        await writeMap(absPath, map);
        return ok({ path: absPath, added: obj });
      }
      case 'tiled_set_tile_property': {
        const path = String(args.path);
        const { map, absPath } = await readMap(path);
        const result = setTileProperty(
          map, String(args.tileset), Number(args.tileId),
          String(args.property), args.value,
          (args.propType as string | undefined) ?? 'bool',
        );
        await writeMap(absPath, map);
        return ok({ path: absPath, ...result });
      }
      case 'tiled_get_tile': {
        const path = String(args.path);
        const { map } = await readMap(path);
        const layer = map.layers.find((l) => l.name === args.layer);
        if (!layer || layer.type !== 'tilelayer' || !layer.data) {
          throw new Error(`tilelayer not found: ${args.layer}`);
        }
        const w = layer.width ?? map.width;
        const idx = Number(args.y) * w + Number(args.x);
        const gid = layer.data[idx] ?? 0;
        return ok({ x: Number(args.x), y: Number(args.y), gid });
      }
      default:
        return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err(String((e as Error).message ?? e));
  }
});

function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}
function err(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}

// ===== 시작 =====

const transport = new StdioServerTransport();
await server.connect(transport);
// 로그는 stderr 로만 (stdout 은 protocol 전용)
process.stderr.write('[tiled-mcp] ready\n');
