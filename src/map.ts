// Tiled (mapeditor.org) JSON 맵 로더.
//
// 기본 가정: orthogonal, 임베드 타일셋, data 는 uncompressed array (CSV/base64 지원 X).
// 레이어 이름 규약: ground / decor / objects_below / objects_above / collision / spawns.

export interface Tileset {
  firstgid: number;
  name: string;
  columns: number;
  tilecount: number;
  tilewidth: number;
  tileheight: number;
  image: HTMLImageElement | null; // null = 로드 실패
  imagePath: string;              // 디버그/에러 메시지용
  imageLoaded: boolean;
  imageError: string | null;
}

export type Layer =
  | { kind: 'tile';   id: number; name: string; width: number; height: number; data: Uint32Array; visible: boolean }
  | { kind: 'object'; id: number; name: string; objects: TmxObject[]; visible: boolean };

export interface TmxObject {
  id: number;
  name?: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  point?: boolean;
}

export interface CollisionRect {
  x0: number; y0: number;
  x1: number; y1: number;
}

export interface TileMap {
  widthTiles: number;
  heightTiles: number;
  tileW: number;
  tileH: number;
  pixelW: number;
  pixelH: number;
  layers: Layer[];
  tilesets: Tileset[];
  collisionRects: CollisionRect[];
  spawns: { x: number; y: number }[];
  // Optional: lookup by name
  layerByName: Map<string, Layer>;
}

// 가벼운 raw Tiled JSON 타입 (필요한 필드만)
interface RawMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  tilesets: RawTileset[];
  layers: RawLayer[];
}
interface RawTileset {
  firstgid: number;
  name?: string;
  columns?: number;
  tilecount?: number;
  tilewidth?: number;
  tileheight?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  source?: string; // 외부 .tsx 참조 — 본 로더는 미지원
}
interface RawLayer {
  id?: number;
  type: 'tilelayer' | 'objectgroup' | string;
  name: string;
  visible?: boolean;
  width?: number;
  height?: number;
  data?: number[] | string; // CSV 문자열 or 배열
  encoding?: string;        // 'csv' or undefined for array
  compression?: string;
  objects?: TmxObject[];
}

export async function loadMap(jsonUrl: string): Promise<TileMap> {
  const res = await fetch(jsonUrl);
  if (!res.ok) {
    throw new Error(
      `[map] '${jsonUrl}' 를 불러올 수 없습니다 (HTTP ${res.status}).\n` +
      `public/assets/maps/town.json 가 있는지 확인하세요. README 의 '맵 만들기' 섹션 참고.`,
    );
  }
  const raw = (await res.json()) as RawMap;

  // ===== 타일셋 로딩 =====
  const tilesets: Tileset[] = [];
  const jsonDir = jsonUrl.replace(/[^/]*$/, ''); // 디렉토리 경로
  const imagePromises: Promise<void>[] = [];

  for (const t of raw.tilesets) {
    if (t.source) {
      console.warn(`[map] external .tsx 참조 (${t.source}) 는 지원되지 않습니다. 타일셋을 맵에 embed 해주세요.`);
      continue;
    }
    const tilewidth  = t.tilewidth  ?? raw.tilewidth;
    const tileheight = t.tileheight ?? raw.tileheight;
    const columns    = t.columns    ?? Math.floor((t.imagewidth ?? 0) / tilewidth);
    const tilecount  = t.tilecount  ?? 0;
    const imagePath  = t.image ? new URL(t.image, location.origin + jsonDir).pathname : '';
    const ts: Tileset = {
      firstgid: t.firstgid,
      name: t.name ?? 'unnamed',
      columns,
      tilecount,
      tilewidth,
      tileheight,
      image: null,
      imagePath,
      imageLoaded: false,
      imageError: null,
    };
    tilesets.push(ts);

    if (imagePath) {
      const img = new Image();
      const p = new Promise<void>((resolve) => {
        img.onload = () => { ts.image = img; ts.imageLoaded = true; resolve(); };
        img.onerror = () => {
          ts.imageError = `이미지 로드 실패: ${imagePath}`;
          console.warn(`[map] ${ts.imageError}\n` +
            `public/assets/tilesets/ 에 해당 파일을 넣어주세요 (16×16 타일셋 PNG). ` +
            `없는 동안은 단색 placeholder 로 표시됩니다.`);
          resolve();
        };
        img.src = imagePath;
      });
      imagePromises.push(p);
    }
  }
  // firstgid 오름차순 정렬 (resolveTile 빠른 매칭)
  tilesets.sort((a, b) => a.firstgid - b.firstgid);
  await Promise.all(imagePromises);

  // ===== 레이어 파싱 =====
  const layers: Layer[] = [];
  const layerByName = new Map<string, Layer>();

  for (const rl of raw.layers) {
    if (rl.type === 'tilelayer') {
      if (!rl.data || !rl.width || !rl.height) continue;
      let arr: number[];
      if (typeof rl.data === 'string') {
        if (rl.encoding && rl.encoding !== 'csv') {
          throw new Error(`[map] '${rl.name}' 레이어 encoding=${rl.encoding} 는 미지원. Tiled Export 옵션에서 'CSV' 또는 'array' 로 저장하세요.`);
        }
        arr = rl.data.split(',').map((s) => parseInt(s.trim(), 10));
      } else {
        arr = rl.data;
      }
      const layer: Layer = {
        kind: 'tile',
        id: rl.id ?? 0,
        name: rl.name,
        width: rl.width,
        height: rl.height,
        data: new Uint32Array(arr),
        visible: rl.visible !== false,
      };
      layers.push(layer);
      layerByName.set(rl.name, layer);
    } else if (rl.type === 'objectgroup') {
      const layer: Layer = {
        kind: 'object',
        id: rl.id ?? 0,
        name: rl.name,
        objects: rl.objects ?? [],
        visible: rl.visible !== false,
      };
      layers.push(layer);
      layerByName.set(rl.name, layer);
    }
  }

  // ===== 충돌 모음 =====
  // 'collision' 이름의 레이어를 우선. objectgroup 이면 사각형들, tilelayer 면 비제로 칸이 16x16 충돌.
  const collisionRects: CollisionRect[] = [];
  const colLayer = layerByName.get('collision');
  if (colLayer) {
    if (colLayer.kind === 'object') {
      for (const o of colLayer.objects) {
        if (o.width > 0 && o.height > 0) {
          collisionRects.push({
            x0: o.x, y0: o.y,
            x1: o.x + o.width, y1: o.y + o.height,
          });
        }
      }
    } else {
      // tile layer collision
      const tw = raw.tilewidth, th = raw.tileheight;
      for (let i = 0; i < colLayer.data.length; i++) {
        if (colLayer.data[i] !== 0) {
          const tx = i % colLayer.width;
          const ty = Math.floor(i / colLayer.width);
          collisionRects.push({
            x0: tx * tw, y0: ty * th,
            x1: tx * tw + tw, y1: ty * th + th,
          });
        }
      }
    }
  }

  // ===== 스폰 모음 =====
  const spawns: { x: number; y: number }[] = [];
  const spawnLayer = layerByName.get('spawns');
  if (spawnLayer && spawnLayer.kind === 'object') {
    for (const o of spawnLayer.objects) {
      // Point object 의 (x, y) 또는 사각형의 중앙
      const cx = o.point ? o.x : o.x + o.width / 2;
      const cy = o.point ? o.y : o.y + o.height / 2;
      spawns.push({ x: cx, y: cy });
    }
  }

  return {
    widthTiles: raw.width,
    heightTiles: raw.height,
    tileW: raw.tilewidth,
    tileH: raw.tileheight,
    pixelW: raw.width * raw.tilewidth,
    pixelH: raw.height * raw.tileheight,
    layers,
    tilesets,
    collisionRects,
    spawns,
    layerByName,
  };
}

// gid → 타일셋 + sx/sy 매핑.
export function resolveTile(map: TileMap, gid: number):
  { tileset: Tileset; sx: number; sy: number; localId: number } | null
{
  if (gid <= 0) return null;
  for (let i = map.tilesets.length - 1; i >= 0; i--) {
    const ts = map.tilesets[i];
    if (gid >= ts.firstgid) {
      const localId = gid - ts.firstgid;
      const col = localId % ts.columns;
      const row = Math.floor(localId / ts.columns);
      return { tileset: ts, sx: col * ts.tilewidth, sy: row * ts.tileheight, localId };
    }
  }
  return null;
}

// 타일 한 칸 그리기 — 이미지 로드됐으면 drawImage, 아니면 placeholder 색.
export function drawTile(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  gid: number,
  dx: number,
  dy: number,
): void {
  if (gid <= 0) return;
  const r = resolveTile(map, gid);
  if (!r) return;
  if (r.tileset.image && r.tileset.imageLoaded) {
    ctx.drawImage(
      r.tileset.image,
      r.sx, r.sy, r.tileset.tilewidth, r.tileset.tileheight,
      dx, dy, r.tileset.tilewidth, r.tileset.tileheight,
    );
  } else {
    // Placeholder: gid 별로 다른 파스텔 색
    ctx.fillStyle = placeholderColor(gid);
    ctx.fillRect(dx, dy, r.tileset.tilewidth, r.tileset.tileheight);
    // 살짝 외곽 (격자 보이게)
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(dx, dy, r.tileset.tilewidth, 1);
    ctx.fillRect(dx, dy, 1, r.tileset.tileheight);
  }
}

function placeholderColor(gid: number): string {
  // 결정론적 hue
  const hue = (gid * 37) % 360;
  return `hsl(${hue}, 35%, 55%)`;
}

// 한 타일 레이어를 카메라 기준으로 그린다.
export function drawTileLayer(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  layer: Layer,
  cameraX: number,
  cameraY: number,
  viewW: number,
  viewH: number,
): void {
  if (layer.kind !== 'tile' || !layer.visible) return;
  const tw = map.tileW, th = map.tileH;
  const tx0 = Math.max(0, Math.floor(cameraX / tw));
  const ty0 = Math.max(0, Math.floor(cameraY / th));
  const tx1 = Math.min(layer.width  - 1, Math.floor((cameraX + viewW) / tw));
  const ty1 = Math.min(layer.height - 1, Math.floor((cameraY + viewH) / th));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const gid = layer.data[ty * layer.width + tx];
      if (gid <= 0) continue;
      drawTile(ctx, map, gid, Math.round(tx * tw - cameraX), Math.round(ty * th - cameraY));
    }
  }
}

// 충돌 검사: 발박스 AABB 가 충돌 영역에 부딪히면 true.
export function isBlocked(map: TileMap, cx: number, cy: number, hw: number, hh: number): boolean {
  const x0 = cx - hw, y0 = cy - hh, x1 = cx + hw, y1 = cy + hh;
  // 월드 경계
  if (x0 < 0 || y0 < 0 || x1 > map.pixelW || y1 > map.pixelH) return true;
  // 충돌 사각형 목록
  for (const r of map.collisionRects) {
    if (x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0) return true;
  }
  return false;
}

// 디버그용 — 충돌 영역 시각화
export function drawCollisionDebug(
  ctx: CanvasRenderingContext2D, map: TileMap,
  cameraX: number, cameraY: number,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 80, 80, 0.35)';
  ctx.strokeStyle = 'rgba(255, 40, 40, 0.85)';
  ctx.lineWidth = 1;
  for (const r of map.collisionRects) {
    const dx = Math.round(r.x0 - cameraX);
    const dy = Math.round(r.y0 - cameraY);
    const w  = Math.round(r.x1 - r.x0);
    const h  = Math.round(r.y1 - r.y0);
    ctx.fillRect(dx, dy, w, h);
    ctx.strokeRect(dx + 0.5, dy + 0.5, w - 1, h - 1);
  }
  ctx.restore();
}

export function drawGridDebug(
  ctx: CanvasRenderingContext2D, map: TileMap,
  cameraX: number, cameraY: number, viewW: number, viewH: number,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  const tw = map.tileW, th = map.tileH;
  const tx0 = Math.max(0, Math.floor(cameraX / tw));
  const ty0 = Math.max(0, Math.floor(cameraY / th));
  const tx1 = Math.min(map.widthTiles,  Math.floor((cameraX + viewW) / tw) + 1);
  const ty1 = Math.min(map.heightTiles, Math.floor((cameraY + viewH) / th) + 1);
  ctx.beginPath();
  for (let tx = tx0; tx <= tx1; tx++) {
    const x = Math.round(tx * tw - cameraX) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, viewH);
  }
  for (let ty = ty0; ty <= ty1; ty++) {
    const y = Math.round(ty * th - cameraY) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(viewW, y);
  }
  ctx.stroke();
  ctx.restore();
}
