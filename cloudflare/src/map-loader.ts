// 봇 맵 로더 — Tiled JSON 을 fetch + collision 인덱스 빌드.
// 클라이언트 src/map.ts 의 핵심만 포팅.

export interface BotMapData {
  widthTiles: number;
  heightTiles: number;
  tileW: number;
  tileH: number;
  pixelW: number;
  pixelH: number;
  // collision[y * widthTiles + x] = true → 막힘
  collision: Uint8Array;
}

interface TiledLayer {
  type: string;
  data?: number[];
  name?: string;
  properties?: Array<{ name: string; value: unknown }>;
}
interface TilesetRef {
  firstgid: number;
  source?: string;          // 외부 .tsj 참조
  tiles?: Array<{ id: number; properties?: Array<{ name: string; value: unknown }> }>;
}
interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets?: TilesetRef[];
}

let _cache: BotMapData | null = null;

export async function loadBotMap(jsonUrl: string): Promise<BotMapData> {
  if (_cache) return _cache;
  const r = await fetch(jsonUrl);
  if (!r.ok) throw new Error(`map ${jsonUrl} HTTP ${r.status}`);
  const raw = (await r.json()) as TiledMap;
  const widthTiles = raw.width;
  const heightTiles = raw.height;
  const tileW = raw.tilewidth;
  const tileH = raw.tileheight;
  const total = widthTiles * heightTiles;
  const collision = new Uint8Array(total);

  // 외부 .tsj 참조 타일셋은 fetch 해서 inline 타일 properties 받아옴.
  // (client src/map.ts 와 동일한 패턴.)
  const jsonDir = jsonUrl.replace(/[^/]*$/, '');
  const blockedGids = new Set<number>();
  for (const ts of raw.tilesets ?? []) {
    let tilesArr: TilesetRef['tiles'] = ts.tiles;
    if (ts.source) {
      try {
        const tsjUrl = new URL(ts.source, jsonDir).toString();
        const tsjRes = await fetch(tsjUrl);
        if (tsjRes.ok) {
          const tsjRaw = (await tsjRes.json()) as { tiles?: TilesetRef['tiles'] };
          tilesArr = tsjRaw.tiles;
        }
      } catch (e) {
        console.warn('[bot map] external tileset fetch failed', ts.source, e);
      }
    }
    for (const tt of tilesArr ?? []) {
      const isBlocked = (tt.properties ?? []).some(
        (p) => (p.name === 'blocked' || p.name === 'collision') && p.value === true,
      );
      if (isBlocked) blockedGids.add(ts.firstgid + tt.id);
    }
  }

  for (const layer of raw.layers) {
    if (layer.type !== 'tilelayer' || !layer.data) continue;
    const isCollisionLayer = (layer.name ?? '').toLowerCase().includes('collision')
      || (layer.properties ?? []).some((p) => p.name === 'collision' && p.value === true);
    for (let i = 0; i < layer.data.length && i < total; i++) {
      const gid = layer.data[i];
      if (gid === 0) continue;
      if (isCollisionLayer || blockedGids.has(gid)) collision[i] = 1;
    }
  }

  _cache = {
    widthTiles, heightTiles, tileW, tileH,
    pixelW: widthTiles * tileW,
    pixelH: heightTiles * tileH,
    collision,
  };
  return _cache;
}

export function isBlockedAt(map: BotMapData, x: number, y: number): boolean {
  const tx = Math.floor(x / map.tileW);
  const ty = Math.floor(y / map.tileH);
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  return map.collision[ty * map.widthTiles + tx] === 1;
}
