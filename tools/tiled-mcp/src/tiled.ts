// Tiled JSON 헬퍼 — 읽기/쓰기 + 레이어/타일셋 위치 + 안전한 mutation.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

// Tiled JSON 형식 — 필요한 필드만 (확장 가능).
export interface TiledTileProp { name: string; type?: string; value: unknown; }
export interface TiledTilesetTile { id: number; properties?: TiledTileProp[]; }
export interface TiledTileset {
  firstgid: number;
  name?: string;
  source?: string;          // 외부 .tsx 참조 (이 MCP 는 inline 또는 일부만 다룸)
  tilewidth?: number;
  tileheight?: number;
  tilecount?: number;
  columns?: number;
  image?: string;
  tiles?: TiledTilesetTile[];
}

export interface TiledObject {
  id?: number;
  name?: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  properties?: TiledTileProp[];
  point?: boolean;
}

export interface TiledLayer {
  id?: number;
  name: string;
  type: 'tilelayer' | 'objectgroup' | 'imagelayer' | 'group';
  width?: number;
  height?: number;
  data?: number[];          // tilelayer
  objects?: TiledObject[];  // objectgroup
  properties?: TiledTileProp[];
  visible?: boolean;
  opacity?: number;
}

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
  nextobjectid?: number;
  [k: string]: unknown;
}

// ===== IO =====

export async function readMap(path: string): Promise<{ map: TiledMap; absPath: string }> {
  const absPath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const raw = await readFile(absPath, 'utf-8');
  const map = JSON.parse(raw) as TiledMap;
  return { map, absPath };
}

export async function writeMap(absPath: string, map: TiledMap): Promise<void> {
  // Tiled 자체 포맷 유지 — 2-space indent + 끝 newline. diff 안정성을 위해.
  await writeFile(absPath, JSON.stringify(map, null, 2) + '\n', 'utf-8');
}

// ===== 레이어/타일셋 헬퍼 =====

export function findLayer(map: TiledMap, name: string): TiledLayer | null {
  return map.layers.find((l) => l.name === name) ?? null;
}

export function findTilesetByName(map: TiledMap, name: string): TiledTileset | null {
  return map.tilesets.find((t) => t.name === name) ?? null;
}

export function findTilesetByFirstgid(map: TiledMap, gid: number): TiledTileset | null {
  // gid 가 포함된 타일셋 = firstgid 가 가장 큰데 gid 이하인 것
  let best: TiledTileset | null = null;
  for (const t of map.tilesets) {
    if (t.firstgid <= gid && (!best || t.firstgid > best.firstgid)) best = t;
  }
  return best;
}

// (x,y) → tilelayer data 인덱스. 범위 밖이면 -1.
export function tileIndex(map: TiledMap, layer: TiledLayer, x: number, y: number): number {
  const w = layer.width ?? map.width;
  const h = layer.height ?? map.height;
  if (x < 0 || y < 0 || x >= w || y >= h) return -1;
  return y * w + x;
}

// ===== mutation =====

export interface PaintResult { layer: string; painted: number; skipped: number; }

export function paintRect(
  map: TiledMap, layerName: string,
  x: number, y: number, w: number, h: number, gid: number,
): PaintResult {
  const layer = findLayer(map, layerName);
  if (!layer) throw new Error(`layer not found: ${layerName}`);
  if (layer.type !== 'tilelayer' || !layer.data) throw new Error(`not a tilelayer: ${layerName}`);
  let painted = 0, skipped = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = tileIndex(map, layer, xx, yy);
      if (i < 0) { skipped++; continue; }
      layer.data[i] = gid;
      painted++;
    }
  }
  return { layer: layerName, painted, skipped };
}

export function addObject(
  map: TiledMap, layerName: string, obj: Omit<TiledObject, 'id'>,
): TiledObject {
  const layer = findLayer(map, layerName);
  if (!layer) throw new Error(`layer not found: ${layerName}`);
  if (layer.type !== 'objectgroup') throw new Error(`not an objectgroup: ${layerName}`);
  if (!layer.objects) layer.objects = [];
  const nextId = (map.nextobjectid ?? Math.max(0, ...layer.objects.map((o) => o.id ?? 0)) + 1);
  const newObj: TiledObject = { id: nextId, ...obj };
  layer.objects.push(newObj);
  map.nextobjectid = nextId + 1;
  return newObj;
}

export interface SetPropResult { tilesetName: string; tileId: number; property: string; value: unknown; }

export function setTileProperty(
  map: TiledMap, tilesetName: string, tileId: number,
  propName: string, propValue: unknown, propType: string = 'bool',
): SetPropResult {
  const ts = findTilesetByName(map, tilesetName);
  if (!ts) throw new Error(`tileset not found: ${tilesetName}`);
  if (!ts.tiles) ts.tiles = [];
  let tile = ts.tiles.find((t) => t.id === tileId);
  if (!tile) {
    tile = { id: tileId, properties: [] };
    ts.tiles.push(tile);
  }
  if (!tile.properties) tile.properties = [];
  const existing = tile.properties.find((p) => p.name === propName);
  if (existing) {
    existing.value = propValue;
    if (propType) existing.type = propType;
  } else {
    tile.properties.push({ name: propName, type: propType, value: propValue });
  }
  return { tilesetName, tileId, property: propName, value: propValue };
}

// ===== 요약 =====

export interface MapSummary {
  path: string;
  size: { widthTiles: number; heightTiles: number; tileW: number; tileH: number; pixelW: number; pixelH: number; };
  layers: Array<{ name: string; type: string; size?: { w: number; h: number }; objectCount?: number; visible: boolean }>;
  tilesets: Array<{ name: string; firstgid: number; tilecount?: number; columns?: number; image?: string; external?: string }>;
}

export function summarize(map: TiledMap, absPath: string): MapSummary {
  return {
    path: absPath,
    size: {
      widthTiles: map.width, heightTiles: map.height,
      tileW: map.tilewidth, tileH: map.tileheight,
      pixelW: map.width * map.tilewidth, pixelH: map.height * map.tileheight,
    },
    layers: map.layers.map((l) => ({
      name: l.name, type: l.type,
      size: l.type === 'tilelayer' ? { w: l.width ?? map.width, h: l.height ?? map.height } : undefined,
      objectCount: l.type === 'objectgroup' ? (l.objects?.length ?? 0) : undefined,
      visible: l.visible !== false,
    })),
    tilesets: map.tilesets.map((t) => ({
      name: t.name ?? '(external)',
      firstgid: t.firstgid,
      tilecount: t.tilecount,
      columns: t.columns,
      image: t.image,
      external: t.source,
    })),
  };
}
