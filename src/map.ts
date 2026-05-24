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
  // localId(타일셋 내부 ID) → 타일 내부 좌표(0..tilewidth) 기준 충돌 사각형들.
  // Tiled 의 Tile Collision Editor 로 그린 도형. width/height 0 인 Point 객체는 무시.
  tileCollisions: Map<number, Array<{ x: number; y: number; w: number; h: number }>>;
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
  source?: string;   // 외부 .tsj 참조 — fetch 해서 embed 처럼 처리
  tiles?: RawTilesetTile[]; // per-tile 데이터 (충돌·애니메이션·속성)
}
interface RawTilesetTile {
  id: number;
  objectgroup?: {
    objects?: Array<{
      x: number;
      y: number;
      width?: number;
      height?: number;
    }>;
  };
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

  for (const tRef of raw.tilesets) {
    // 외부 .tsj 참조면 fetch 해서 embedded 처럼 펼친다.
    let t: RawTileset = tRef;
    let tilesetDir = jsonDir;
    if (tRef.source) {
      const tsjUrl = new URL(tRef.source, location.origin + jsonDir).pathname;
      const tsjRes = await fetch(tsjUrl);
      if (!tsjRes.ok) {
        console.warn(`[map] 외부 타일셋 ${tsjUrl} 로드 실패 (HTTP ${tsjRes.status}). 스킵합니다.`);
        continue;
      }
      const tsjRaw = (await tsjRes.json()) as RawTileset;
      t = { ...tsjRaw, firstgid: tRef.firstgid };
      tilesetDir = tsjUrl.replace(/[^/]*$/, ''); // .tsj 가 있는 폴더 기준으로 image 경로 해석
    }

    const tilewidth  = t.tilewidth  ?? raw.tilewidth;
    const tileheight = t.tileheight ?? raw.tileheight;
    const columns    = t.columns    ?? Math.floor((t.imagewidth ?? 0) / tilewidth);
    const tilecount  = t.tilecount  ?? 0;
    const imagePath  = t.image ? new URL(t.image, location.origin + tilesetDir).pathname : '';

    // per-tile 충돌 도형 모음 — Tile Collision Editor 의 사각형들.
    // width 또는 height 가 0/undefined 인 객체는 Point 도구로 찍은 점이라 무시.
    const tileCollisions = new Map<number, Array<{ x: number; y: number; w: number; h: number }>>();
    for (const tileEntry of t.tiles ?? []) {
      const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const o of tileEntry.objectgroup?.objects ?? []) {
        const w = o.width ?? 0;
        const h = o.height ?? 0;
        if (w > 0 && h > 0) rects.push({ x: o.x, y: o.y, w, h });
      }
      if (rects.length > 0) tileCollisions.set(tileEntry.id, rects);
    }

    const ts: Tileset = {
      firstgid: tRef.firstgid,
      name: t.name ?? 'unnamed',
      columns,
      tilecount,
      tilewidth,
      tileheight,
      image: null,
      imagePath,
      imageLoaded: false,
      imageError: null,
      tileCollisions,
    };
    tilesets.push(ts);

    if (imagePath) {
      const img = new Image();
      const p = new Promise<void>((resolve) => {
        img.onload = () => { ts.image = img; ts.imageLoaded = true; resolve(); };
        img.onerror = () => {
          ts.imageError = `이미지 로드 실패: ${imagePath}`;
          console.warn(`[map] ${ts.imageError}\n` +
            `해당 폴더에 PNG 파일을 넣어주세요. 없는 동안은 단색 placeholder 로 표시됩니다.`);
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
  // 두 가지 소스를 합쳐서 만든다:
  //  1) 'collision' 이름의 별도 레이어 (objectgroup or tilelayer) — 레거시/town.json 방식
  //  2) 모든 tile layer 의 각 타일에 대해, 타일셋이 갖는 per-tile 충돌 도형 — zombie_road 방식
  //     (Tiled 의 Tile Collision Editor 에서 그린 사각형들)
  const collisionRects: CollisionRect[] = [];

  // 1) 별도 collision 레이어
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

  // 2) per-tile 충돌 — 모든 tile layer 를 훑으며 각 타일이 자체 충돌박스를 갖는지 확인.
  //    같은 칸에 여러 레이어가 겹쳐도 OK (중복 충돌박스 생겨도 isBlocked 결과 동일).
  const tw = raw.tilewidth, th = raw.tileheight;
  for (const layer of layers) {
    if (layer.kind !== 'tile') continue;
    for (let i = 0; i < layer.data.length; i++) {
      const gid = layer.data[i];
      if (gid <= 0) continue;
      // 인라인 tileset 매칭 (resolveTile 과 같은 로직이지만 TileMap 객체가 아직 없으므로).
      let matched: Tileset | null = null;
      for (let j = tilesets.length - 1; j >= 0; j--) {
        if (gid >= tilesets[j].firstgid) { matched = tilesets[j]; break; }
      }
      if (!matched) continue;
      const localId = gid - matched.firstgid;
      const localRects = matched.tileCollisions.get(localId);
      if (!localRects) continue;
      const tx = i % layer.width;
      const ty = Math.floor(i / layer.width);
      const worldX0 = tx * tw;
      const worldY0 = ty * th;
      for (const lr of localRects) {
        collisionRects.push({
          x0: worldX0 + lr.x,
          y0: worldY0 + lr.y,
          x1: worldX0 + lr.x + lr.w,
          y1: worldY0 + lr.y + lr.h,
        });
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
