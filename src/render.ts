// 한 프레임 렌더 — Tiled 레이어 + 캐릭터 Y-소트 + objects_above 가림.
//
// 레이어 순서:
//   ground → decor → objects_below → [캐릭터 Y-소트] → objects_above → 이름/HP/데미지 → 디버그 오버레이

import { type Camera } from './world';
import {
  CHAR_H, CHAR_W, DANCE_H, dancePoseFrame, drawCharacter, drawDancing,
} from './sprites';
import { ATTACK_SWING_DUR, BODY_HH, BODY_HW, BODY_OFF_Y, FOOT_HH, FOOT_HW, type LocalPlayer } from './player';
import { drawCollisionDebug, drawGridDebug, drawTile, drawTileLayer, tileHasCollision, type TileMap } from './map';
import type { DebugState } from './debug';
import type { RemotePlayer } from './types';

export interface RenderableRemote {
  id: string;
  name: string;
  color: string;
  charIdx: number;
  x: number;       // 화면용 (renderX)
  y: number;
  dir: RemotePlayer['dir'];
  moving: boolean;
  attackPhase: number;
  hitFlash: boolean;
  hp: number;
  maxHp: number;
  chatText: string;
  chatShow: boolean;
  dead: boolean;
  kills: number;
  dancing: boolean;
  danceStart: number;
}

export interface HudLayer {
  ctx: CanvasRenderingContext2D;
  /** 백버퍼 1px → CSS px 변환 계수. (worldX - camera.x) * displayScale = HUD 캔버스 좌표. */
  displayScale: number;
}

/** 시야 비네트 — 회전/스트레치 + 동심원 그라데이션.
 *  offset-center 콘 대신: 캔버스를 facing 방향으로 회전 + X 축 스트레치 한 다음
 *  동심원 라디얼 그라데이션 그림. 동심원이라 isophote 깨끗하고, transform 으로 방향성 부여. */
export interface VisionConfig {
  /** 시야 중심 (월드 좌표). 보통 캐릭터 몸통 중심. */
  worldX: number;
  worldY: number;
  /** 바라보는 방향 (정규화 벡터). 0,0 이면 무방향 (등방 원). */
  facingDx: number;
  facingDy: number;
  /** 기본 시야 반경 (transformed 좌표 기준 px). */
  radius: number;
  /** 앞쪽 늘림 비율 (1.0 = 원, 1.5 = 앞뒤로 1.5x 타원). */
  forwardStretch?: number;
  /** 앞쪽 시프트 — transformed 좌표에서 그라데이션 중심을 +X 로 이동. 0 = 캐릭터 중심. */
  forwardOffset?: number;
  /** FWD 원 반경 배율. 1.0 = vision.radius 그대로, 1.3 = FWD 가 OMNI 보다 30% 큼 (앞쪽 + 두꼐 동시 증가). */
  forwardScale?: number;
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  camera: Camera,
  local: LocalPlayer,
  remotes: RenderableRemote[],
  now: number,
  debug: DebugState,
  hud: HudLayer,
  vision?: VisionConfig | null,
): void {
  ctx.imageSmoothingEnabled = false;

  // 0. 캔버스 클리어 — 맵이 화면보다 작을 때(예: cops 대기실 같은 작은 맵을
  //    모바일 세로에서 보면 viewH > map.pixelH) 맵 바깥 영역에 이전 프레임 픽셀이
  //    남아 잔상이 생김. 검정으로 매 프레임 덮는다.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, camera.viewW, camera.viewH);

  // 1. 캐릭터 아래 — 모든 tile 레이어를 문서 순서로 그림.
  //    예외: objects_below (Y-sort) / objects_above (캐릭터 위) 는 따로.
  //    그 외 이름(ground, decor, decor2, "Tile Layer 3", 등) 은 모두 배경.
  for (const layer of map.layers) {
    if (layer.kind !== 'tile' || !layer.visible) continue;
    if (layer.name === 'objects_below' || layer.name === 'objects_above') continue;
    drawTileLayer(ctx, map, layer, camera.x, camera.y, camera.viewW, camera.viewH, now);
  }

  // 2. Y-소트 — objects_below 의 각 타일 + object layer 의 tile-objects + 캐릭터를
  //    발(footY) 위치 기준으로 정렬해서 그림.
  //    object layer 의 tile-object:
  //      - 충돌박스 있는 타일 (예: 줄기) → Y-sort 에 참여 (캐릭터와 앞/뒤 자연 정렬)
  //      - 충돌박스 없는 타일 (예: 잎) → 항상 캐릭터 위 (objects_above 와 동일 취급)
  // 'above' = per-tile 폴리곤 영역 (예: 나무 줄기 윗부분). Y-sort 에 참여해서
  //  캐릭터가 폴리곤 발 위치(폴리곤 내 최하단 Y)보다 남쪽이면 캐릭터 위에 그려져 가리고,
  //  북쪽이면 캐릭터가 폴리곤 위에 그려져 보임.
  type SortItem =
    | { ySort: number; kind: 'local' }
    | { ySort: number; kind: 'remote'; remote: RenderableRemote }
    | { ySort: number; kind: 'tile'; gid: number; tx: number; ty: number }
    | { ySort: number; kind: 'obj'; gid: number; px: number; py: number }
    | { ySort: number; kind: 'above'; gid: number; worldX: number; worldY: number; poly: Array<[number, number]> };
  const items: SortItem[] = [];
  // 충돌 없는 object tile-objects (잎 등) — 캐릭터 위에 그릴 것들. 별도 큐.
  const overObjs: Array<{ gid: number; px: number; py: number }> = [];

  // gid 의 above 폴리곤들을 임시 큐에 모음 — 같은 트리(4-이웃 타일들)는 하나의 cluster 로 묶어
  // 공통 footY (cluster 의 max footY) 로 Y-sort. 안 그러면 한 트리 안의 잎/줄기 폴리곤이
  // 따로 Y-sort 돼서 캐릭터가 잎 앞이지만 줄기 뒤 같은 어색한 상태 발생.
  type AboveCandidate = { gid: number; worldX: number; worldY: number; poly: Array<[number, number]>; localMaxY: number };
  const aboveCandidates: AboveCandidate[] = [];
  const addAboveItems = (gid: number, worldX: number, worldY: number): void => {
    if (gid <= 0) return;
    for (let i = map.tilesets.length - 1; i >= 0; i--) {
      const ts = map.tilesets[i];
      if (gid < ts.firstgid) continue;
      const lid = gid - ts.firstgid;
      const polys = ts.tileAboveRegions.get(lid);
      if (!polys || polys.length === 0) return;
      for (const poly of polys) {
        let maxY = -Infinity;
        for (const [, py] of poly) if (py > maxY) maxY = py;
        aboveCandidates.push({ gid, worldX, worldY, poly, localMaxY: maxY });
      }
      return;
    }
  };
  items.push({ ySort: local.y, kind: 'local' });
  for (const r of remotes) items.push({ ySort: r.y, kind: 'remote', remote: r });

  {
    const tw = map.tileW, th = map.tileH;
    const tx0 = Math.max(0, Math.floor(camera.x / tw));
    const ty0 = Math.max(0, Math.floor(camera.y / th));
    // 모든 tile 레이어 순회: objects_below 는 Y-sort 자체 렌더에 참여, 그 외(decor 등) 는
    // 이미 배경으로 그려졌지만 above 영역만 Y-sort 에 참여시킴.
    for (const layer of map.layers) {
      if (layer.kind !== 'tile' || !layer.visible) continue;
      if (layer.name === 'objects_above') continue;     // 통째로 위에 그려짐
      const isBelow = layer.name === 'objects_below';
      const tx1 = Math.min(layer.width  - 1, Math.floor((camera.x + camera.viewW) / tw));
      const ty1 = Math.min(layer.height - 1, Math.floor((camera.y + camera.viewH) / th));
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const gid = layer.data[ty * layer.width + tx];
          if (gid <= 0) continue;
          if (isBelow) items.push({ ySort: (ty + 1) * th, kind: 'tile', gid, tx, ty });
          addAboveItems(gid, tx * tw, ty * th);
        }
      }
    }
  }
  // 모든 object layer 의 tile-objects (gid 있는 것) — Tiled 에서 드래그로 배치한 트리·바위 등.
  // (x, y) 는 bottom-left → top-left = (x, y - height). footY = y (bottom 그대로).
  for (const layer of map.layers) {
    if (layer.kind !== 'object' || !layer.visible) continue;
    for (const o of layer.objects) {
      if (!o.gid) continue;
      const objH = o.height > 0 ? o.height : map.tileH;
      const px = o.x;
      const py = o.y - objH;       // top-left for drawing
      // 카메라 컬링 (대충)
      if (px + (o.width || map.tileW) < camera.x || px > camera.x + camera.viewW) continue;
      if (py + objH < camera.y || py > camera.y + camera.viewH) continue;
      const hasColl = tileHasCollision(map, o.gid);
      if (hasColl) {
        items.push({ ySort: o.y, kind: 'obj', gid: o.gid, px, py });
        addAboveItems(o.gid, px, py);     // 충돌 있는 obj 도 above 영역 Y-sort
      } else {
        overObjs.push({ gid: o.gid, px, py });
        // 충돌 없는 obj (잎 등) 는 통째로 위에 → above 폴리곤 redundant. skip.
      }
    }
  }
  // ===== above 클러스터링 =====
  // 4-이웃 (tile-grid 기준) 으로 맞닿은 above 후보들을 union-find 로 묶고, cluster 의 max
  // footY 를 그 cluster 전원의 ySort 로 사용. tile 크기 단위로 grid key 생성.
  if (aboveCandidates.length > 0) {
    const TW = map.tileW, TH = map.tileH;
    // key = "tx,ty" — 후보가 차지하는 grid 셀 (top-left 기준)
    const cellKey = (c: AboveCandidate) => `${Math.round(c.worldX / TW)},${Math.round(c.worldY / TH)}`;
    const parent = new Map<number, number>();
    const find = (i: number): number => {
      let r = i;
      while (parent.get(r)! !== r) r = parent.get(r)!;
      // path compression
      while (parent.get(i)! !== r) { const next = parent.get(i)!; parent.set(i, r); i = next; }
      return r;
    };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

    // 셀 → 후보 index (한 셀에 여러 폴리곤 있을 수 있으니 배열)
    const cellToIdxs = new Map<string, number[]>();
    for (let i = 0; i < aboveCandidates.length; i++) {
      parent.set(i, i);
      const k = cellKey(aboveCandidates[i]);
      let arr = cellToIdxs.get(k);
      if (!arr) { arr = []; cellToIdxs.set(k, arr); }
      arr.push(i);
    }
    // 같은 셀의 모든 후보 union + 4-이웃 셀들 union
    for (const [k, idxs] of cellToIdxs) {
      for (let j = 1; j < idxs.length; j++) union(idxs[0], idxs[j]);
      const [tx, ty] = k.split(',').map(Number);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nk = `${tx+dx},${ty+dy}`;
        const nidxs = cellToIdxs.get(nk);
        if (nidxs) union(idxs[0], nidxs[0]);
      }
    }
    // root → max footY (worldY + localMaxY)
    const rootMaxY = new Map<number, number>();
    for (let i = 0; i < aboveCandidates.length; i++) {
      const r = find(i);
      const fy = aboveCandidates[i].worldY + aboveCandidates[i].localMaxY;
      const cur = rootMaxY.get(r);
      if (cur === undefined || fy > cur) rootMaxY.set(r, fy);
    }
    // items 에 push (cluster footY 로 ySort)
    for (let i = 0; i < aboveCandidates.length; i++) {
      const c = aboveCandidates[i];
      const r = find(i);
      const ySort = rootMaxY.get(r)!;
      items.push({ kind: 'above', ySort, gid: c.gid, worldX: c.worldX, worldY: c.worldY, poly: c.poly });
    }
  }

  items.sort((a, b) => a.ySort - b.ySort);

  // above 폴리곤 클립 + 소스 타일 드로우 (애니메이션 gid swap 처리).
  const drawAboveClipped = (gid: number, worldX: number, worldY: number, poly: Array<[number, number]>): void => {
    for (let i = map.tilesets.length - 1; i >= 0; i--) {
      const ts = map.tilesets[i];
      if (gid < ts.firstgid) continue;
      let sourceLid = gid - ts.firstgid;
      const frames = ts.tileAnimations.get(sourceLid);
      if (frames && frames.length > 0) {
        const total = ts.tileAnimTotal.get(sourceLid) ?? 0;
        if (total > 0) {
          const t = (now * 1000) % total;
          let acc = 0;
          for (const f of frames) { acc += Math.max(1, f.duration); if (t < acc) { sourceLid = f.tileid; break; } }
        }
      }
      if (!ts.image || !ts.imageLoaded) return;
      const sx = (sourceLid % ts.columns) * ts.tilewidth;
      const sy = Math.floor(sourceLid / ts.columns) * ts.tileheight;
      const dx = Math.round(worldX - camera.x);
      const dy = Math.round(worldY - camera.y);
      if (poly.length < 3) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(Math.round(dx + poly[0][0]), Math.round(dy + poly[0][1]));
      for (let k = 1; k < poly.length; k++) ctx.lineTo(Math.round(dx + poly[k][0]), Math.round(dy + poly[k][1]));
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(ts.image, sx, sy, ts.tilewidth, ts.tileheight, dx, dy, ts.tilewidth, ts.tileheight);
      ctx.restore();
      return;
    }
  };

  for (const it of items) {
    if (it.kind === 'tile') {
      drawTile(ctx, map, it.gid,
        Math.round(it.tx * map.tileW - camera.x),
        Math.round(it.ty * map.tileH - camera.y),
        now);
    } else if (it.kind === 'obj') {
      drawTile(ctx, map, it.gid,
        Math.round(it.px - camera.x),
        Math.round(it.py - camera.y),
        now);
    } else if (it.kind === 'above') {
      drawAboveClipped(it.gid, it.worldX, it.worldY, it.poly);
    } else if (it.kind === 'local') {
      drawLocal(ctx, camera, local, now);
    } else if (it.kind === 'remote') {
      drawRemote(ctx, camera, it.remote, now);
    }
  }

  // 3. objects_above tile layer + 충돌 없는 object tile-objects (잎 등) — 항상 캐릭터 위
  const above = map.layerByName.get('objects_above');
  if (above) drawTileLayer(ctx, map, above, camera.x, camera.y, camera.viewW, camera.viewH, now);
  for (const o of overObjs) {
    drawTile(ctx, map, o.gid,
      Math.round(o.px - camera.x),
      Math.round(o.py - camera.y),
      now);
  }

  // (above 폴리곤은 위 Y-sort items 에 통합됨 — 캐릭터가 폴리곤 발 위치보다 남쪽이면 가리지 않음.)

  // 4. 이름/HP/킬 — HUD 오버레이 캔버스에 그림 (full DPR, 크리스프 텍스트).
  //    HUD 캔버스는 게임 캔버스보다 해상도가 높으므로 좌표는 (worldX - camera.x) * displayScale 로 변환.
  hud.ctx.clearRect(0, 0, hud.ctx.canvas.width / (window.devicePixelRatio || 1), hud.ctx.canvas.height / (window.devicePixelRatio || 1));
  for (const r of remotes) {
    drawNameHpKills(hud.ctx, camera, hud.displayScale, r.x, r.y, r.name, r.color, r.hp, r.maxHp, r.kills, false, r.dancing);
  }
  const localDancing = now < local.danceUntil;
  drawNameHpKills(hud.ctx, camera, hud.displayScale, local.x, local.y, local.name, local.color, local.hp, local.maxHp, local.kills, true, localDancing);

  // 5. 부유 데미지 텍스트 — 팝업 스케일 + 떠오름 + 페이드.
  for (const f of local.floats) {
    const age = now - f.birth;
    if (age < 0 || age > 0.9) continue;
    // 페이드: 마지막 30% 만 페이드
    const alpha = age > 0.6 ? 1 - (age - 0.6) / 0.3 : 1;
    // 팝 스케일: 0.4 → 1.3 → 1.0
    let scale = 1;
    if (age < 0.12)        scale = 0.4 + (age / 0.12) * 0.9;
    else if (age < 0.22)   scale = 1.3 - ((age - 0.12) / 0.1) * 0.3;
    // 위로 떠오름
    const ox = Math.round(f.x - camera.x);
    const oy = Math.round(f.y - camera.y - age * 24);
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.font = `bold 14px 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 굵은 검정 외곽
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#1a0e08';
    ctx.strokeText(f.text, 0, 0);
    // 본체
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, 0, 0);
    ctx.restore();
  }

  // 6. 디버그 오버레이
  if (debug.showGrid) drawGridDebug(ctx, map, camera.x, camera.y, camera.viewW, camera.viewH);
  if (debug.showCollision) drawCollisionDebug(ctx, map, camera.x, camera.y);
  if (debug.showHitbox) drawHitboxes(ctx, camera, local, remotes);

  // 7. 시야 비네트 — 스타크래프트식 fog of war.
  //    offscreen 캔버스에 검정 fog 채우고 destination-out 으로 부드러운 원을 "구멍 뚫음".
  //    동심원 라디얼 그라데이션이라 등밝기 곡선이 깨끗한 원 (offset-center 콘 artifact 없음).
  //    여러 원 (omni + 앞쪽) 을 동시에 erase → 자연스러운 oval/cone 모양 union.
  //    완성된 fog 오버레이를 drawImage 로 게임/HUD 캔버스에 합성.
  if (vision) {
    const sx = vision.worldX - camera.x;
    const sy = vision.worldY - camera.y;
    const fwdShift = (vision.forwardOffset ?? 0);
    const stretch = vision.forwardStretch ?? 1.0;
    const r = Math.max(20, vision.radius);
    const dx = vision.facingDx, dy = vision.facingDy;
    const buildFog = (W: number, H: number, scale: number): HTMLCanvasElement => {
      const fog = getFogCanvas(W, H);
      const fctx = fog.getContext('2d')!;
      fctx.setTransform(1, 0, 0, 1, 0, 0);   // reset (캐시 재사용)
      fctx.globalCompositeOperation = 'source-over';
      fctx.fillStyle = '#000';
      fctx.fillRect(0, 0, W, H);
      fctx.globalCompositeOperation = 'destination-out';
      const cx = sx * scale, cy = sy * scale;
      // 부드러운 단조 감소 stops — 안쪽 plateau 없음, 가장자리까지 균등하게 어두워짐.
      // 약간 concave (slow start, faster mid, slow end) 로 자연스러운 라이트 폴오프.
      const addSoftStops = (grad: CanvasGradient) => {
        grad.addColorStop(0,    'rgba(255,255,255,1.0)');
        grad.addColorStop(0.2,  'rgba(255,255,255,0.82)');
        grad.addColorStop(0.4,  'rgba(255,255,255,0.6)');
        grad.addColorStop(0.6,  'rgba(255,255,255,0.36)');
        grad.addColorStop(0.8,  'rgba(255,255,255,0.15)');
        grad.addColorStop(1,    'rgba(255,255,255,0)');
      };
      // (1) OMNI — 캐릭터 중심 동심원. 반경 = full r (FWD 와 같음) → OMNI 경계 안 보임.
      const omniR = Math.max(8, r * scale);
      const og = fctx.createRadialGradient(cx, cy, 0, cx, cy, omniR);
      addSoftStops(og);
      fctx.fillStyle = og;
      fctx.fillRect(0, 0, W, H);
      // (2) FWD — facing 방향으로 시프트 + X 스트레치 (회전된 좌표계에서 동심원)
      if (dx !== 0 || dy !== 0) {
        const fx = (sx + dx * fwdShift) * scale;
        const fy = (sy + dy * fwdShift) * scale;
        const fwdR = Math.max(8, r * (vision.forwardScale ?? 1) * scale);
        fctx.save();
        fctx.translate(fx, fy);
        fctx.rotate(Math.atan2(dy, dx));
        fctx.scale(stretch, 1);
        const fg = fctx.createRadialGradient(0, 0, 0, 0, 0, fwdR);
        addSoftStops(fg);
        fctx.fillStyle = fg;
        fctx.fillRect(-W * 2, -H * 2, W * 4, H * 4);
        fctx.restore();
      }
      return fog;
    };
    // game 캔버스
    const fogGame = buildFog(camera.viewW, camera.viewH, 1);
    ctx.drawImage(fogGame, 0, 0);
    // HUD 캔버스 (CSS px 단위 — displayScale 만큼 더 큼)
    const dpr = window.devicePixelRatio || 1;
    const hudW = hud.ctx.canvas.width / dpr;
    const hudH = hud.ctx.canvas.height / dpr;
    const fogHud = buildFog(hudW, hudH, hud.displayScale);
    hud.ctx.drawImage(fogHud, 0, 0);
  }
}

// offscreen fog 캔버스 캐시 — 매 프레임 alloc 안 하고 재사용 (사이즈 바뀌면 리사이즈).
let _fogCanvasGame: HTMLCanvasElement | null = null;
let _fogCanvasHud: HTMLCanvasElement | null = null;
function getFogCanvas(w: number, h: number): HTMLCanvasElement {
  // 두 사이즈 가능 (game/hud) — 그냥 1개로 캐시 못 함. 사이즈로 분기.
  // 간단히: 두 개 캐시, 사이즈 다르면 game/hud 중 작은 쪽으로 식별.
  // 실용적으로는 호출자 측에서 game 먼저 → hud 둘 다 다른 사이즈일 가능성 큼.
  // 그냥 사이즈 ≤ 800 → game 캐시, 그 이상 → hud 캐시.
  const useHud = w > 800;
  let c = useHud ? _fogCanvasHud : _fogCanvasGame;
  if (!c) { c = document.createElement('canvas'); if (useHud) _fogCanvasHud = c; else _fogCanvasGame = c; }
  if (c.width !== Math.ceil(w) || c.height !== Math.ceil(h)) {
    c.width = Math.ceil(w);
    c.height = Math.ceil(h);
  }
  return c;
}

// 댄스 중인 캐릭터 발 밑에 옅은 분홍 그림자.
function drawDanceGlow(ctx: CanvasRenderingContext2D, footScreenX: number, footScreenY: number, now: number): void {
  const pulse = 1 + Math.sin(now * 6) * 0.08;
  const r = 18 * pulse;
  const g = ctx.createRadialGradient(footScreenX, footScreenY - 1, 0, footScreenX, footScreenY - 1, r);
  g.addColorStop(0, 'rgba(255, 130, 180, 0.25)');
  g.addColorStop(1, 'rgba(255, 130, 180, 0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(footScreenX, footScreenY - 1, r, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawLocal(ctx: CanvasRenderingContext2D, camera: Camera, p: LocalPlayer, now: number): void {
  const footX = Math.round(p.x - camera.x);
  const footY = Math.round(p.y - camera.y);

  if (now < p.danceUntil) {
    drawDanceGlow(ctx, footX, footY, now);
    const pose = dancePoseFrame(now, p.danceStart);
    drawDancing(ctx, footX, footY, p.color, pose);
    return;
  }

  const attackElapsed = p.attackUntil - now;
  const attackPhase = attackElapsed > 0 ? 1 - (attackElapsed / ATTACK_SWING_DUR) : -1;

  const overlayX = footX - CHAR_W / 2;
  const overlayY = footY - CHAR_H;

  const flash = now < p.hitFlashUntil;
  if (flash) {
    ctx.save();
    drawCharacter(ctx, footX, footY, p.charIdx, p.dir, p.moving, attackPhase, p.dead, now);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255, 60, 60, 0.55)';
    ctx.fillRect(overlayX, overlayY, CHAR_W, CHAR_H);
    ctx.restore();
  } else if (now < p.iFrameUntil) {
    const blink = Math.floor(now * 12) % 2 === 0;
    ctx.save();
    if (!blink) ctx.globalAlpha = 0.5;
    drawCharacter(ctx, footX, footY, p.charIdx, p.dir, p.moving, attackPhase, p.dead, now);
    ctx.restore();
  } else {
    drawCharacter(ctx, footX, footY, p.charIdx, p.dir, p.moving, attackPhase, p.dead, now);
  }
}

function drawRemote(ctx: CanvasRenderingContext2D, camera: Camera, r: RenderableRemote, now: number): void {
  const footX = Math.round(r.x - camera.x);
  const footY = Math.round(r.y - camera.y);

  if (r.dancing) {
    drawDanceGlow(ctx, footX, footY, now);
    const pose = dancePoseFrame(now, r.danceStart);
    drawDancing(ctx, footX, footY, r.color, pose);
    return;
  }

  const overlayX = footX - CHAR_W / 2;
  const overlayY = footY - CHAR_H;

  if (r.hitFlash) {
    ctx.save();
    drawCharacter(ctx, footX, footY, r.charIdx, r.dir, r.moving, r.attackPhase, r.dead, now);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255, 60, 60, 0.55)';
    ctx.fillRect(overlayX, overlayY, CHAR_W, CHAR_H);
    ctx.restore();
  } else {
    drawCharacter(ctx, footX, footY, r.charIdx, r.dir, r.moving, r.attackPhase, r.dead, now);
  }
}

function drawNameHpKills(
  ctx: CanvasRenderingContext2D, camera: Camera, displayScale: number,
  worldX: number, worldY: number,
  name: string, _color: string,
  hp: number, maxHp: number, kills: number,
  isLocal: boolean,
  dancing: boolean,
): void {
  // 백버퍼 좌표 → HUD(CSS px) 좌표. 캐릭터 발/머리 위치는 백버퍼 단위라 displayScale 로 환산.
  const baseX = Math.round((worldX - camera.x) * displayScale);
  const heightAbove = (dancing ? DANCE_H : CHAR_H) * displayScale;
  const footScreenY = Math.round((worldY - camera.y) * displayScale);
  const label = kills > 0 ? `${name} · ${kills}` : name;

  // ===== HP 바 — 머리 위. CSS px 단위라 segment/간격을 시각 비율로 다시 정함. =====
  const SEGMENTS = 14;
  const segW = 4;
  const segGap = 1;
  const barW = SEGMENTS * segW + (SEGMENTS - 1) * segGap;
  const barH = 6;
  const bx = baseX - Math.floor(barW / 2);
  const by = Math.round((worldY - camera.y) * displayScale - heightAbove - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  const filledSegs = hp <= 0 ? 0 : Math.max(1, Math.floor(SEGMENTS * pct));
  const fillColor = pct > 0.5 ? '#5fd06a' : pct > 0.25 ? '#e0c050' : '#d04a4a';
  for (let i = 0; i < SEGMENTS; i++) {
    const segX = bx + i * (segW + segGap);
    ctx.fillStyle = i < filledSegs ? fillColor : '#3a1212';
    ctx.fillRect(segX, by, segW, barH);
  }
  // ===== 이름 — 발 아래. CSS px 기준 크기. HUD 캔버스라 1:1 픽셀에 안티앨리어싱 살아있음. =====
  ctx.font = `600 14px 'Apple SD Gothic Neo', 'Malgun Gothic', '맑은 고딕', 'Noto Sans KR', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const textY = footScreenY + 20;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // 얇은 검정 외곽선 + 연한 그림자로 자연스럽게.
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.strokeText(label, baseX, textY);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = isLocal ? '#fff7a8' : '#ffffff';
  ctx.fillText(label, baseX, textY);
  ctx.restore();
}

function drawHitboxes(
  ctx: CanvasRenderingContext2D, camera: Camera,
  local: LocalPlayer, remotes: RenderableRemote[],
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,80,0.9)';
  ctx.lineWidth = 1;
  const box = (cx: number, cy: number, hw: number, hh: number) => {
    ctx.strokeRect(
      Math.round(cx - hw - camera.x) + 0.5,
      Math.round(cy - hh - camera.y) + 0.5,
      hw * 2 - 1, hh * 2 - 1,
    );
  };
  // local — 발박스 + 몸통
  box(local.x, local.y - FOOT_HH, FOOT_HW, FOOT_HH);
  ctx.strokeStyle = 'rgba(80,255,255,0.85)';
  box(local.x, local.y + BODY_OFF_Y, BODY_HW, BODY_HH);
  // remote 들도
  ctx.strokeStyle = 'rgba(255,200,80,0.7)';
  for (const r of remotes) {
    box(r.x, r.y - FOOT_HH, FOOT_HW, FOOT_HH);
  }
  ctx.restore();
}

export function attackPhaseFor(attackUntil: number, nowSec: number): number {
  const remain = attackUntil - nowSec;
  if (remain <= 0) return -1;
  return 1 - remain / ATTACK_SWING_DUR;
}

// ===== 총 (AK) 오버레이 =====
// 드랍(황금 펄스 테두리 + 작은 총 그림), 보유 중 캐릭터 옆 따라다니는 총, 총알.
// 게임 캐릭터 위에 그려지므로 캐릭터 Y-소트 후에 호출.

const gunImg = new Image();
let gunReady = false;
gunImg.src = '/sprites/items/ak47.png';
gunImg.onload = () => { gunReady = true; };

export function ensureGunSprite(): boolean {
  return gunReady;
}

interface GunDropLite { id: string; x: number; y: number; spawnedAt: number }
interface BulletLite { x: number; y: number; vx: number; vy: number }
interface HeldGunOwner { x: number; y: number; dir: 'up'|'down'|'left'|'right' }

export function drawGunOverlay(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  drops: Iterable<GunDropLite>,
  bullets: Iterable<BulletLite>,
  heldOwners: Iterable<HeldGunOwner>,
  now: number,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // ----- 드랍: 황금 펄스 테두리 + 안쪽에 작은 총 -----
  const RING_R = 16;
  const GUN_W_DROP = 22;
  const GUN_H_DROP = 9;
  for (const d of drops) {
    const sx = Math.round(d.x - camera.x);
    const sy = Math.round(d.y - camera.y);
    // 펄스: sin 으로 반경 ±3px, 두께 1~2.5px, 투명도 0.5~1
    const phase = (now - d.spawnedAt) * 3.2; // ≈ 0.5Hz × 2π
    const pulse = (Math.sin(phase) + 1) / 2; // 0..1
    const r = RING_R + pulse * 4;
    const alpha = 0.55 + pulse * 0.45;
    // 바깥쪽 흐릿한 글로우
    ctx.strokeStyle = `rgba(255, 215, 80, ${alpha * 0.35})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 2, 0, Math.PI * 2);
    ctx.stroke();
    // 메인 황금 링
    ctx.strokeStyle = `rgba(255, 215, 80, ${alpha})`;
    ctx.lineWidth = 1.5 + pulse;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    // 안쪽 그림자 깔고 총 그림
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(sx, sy, RING_R - 2, 0, Math.PI * 2);
    ctx.fill();
    if (gunReady) {
      ctx.drawImage(gunImg, sx - GUN_W_DROP / 2, sy - GUN_H_DROP / 2, GUN_W_DROP, GUN_H_DROP);
    }
  }

  // ----- 보유 총: 캐릭터 옆 (방향에 따라 좌/우 어깨 높이) -----
  // 가로는 절반(80→40), 세로는 두 배(32→64) — 세로로 길쭉한 모양.
  const GUN_W_HELD = 40;
  const GUN_H_HELD = 64;
  if (gunReady) {
    for (const o of heldOwners) {
      const sx = Math.round(o.x - camera.x);
      const sy = Math.round(o.y - camera.y);
      const yOff = -28;
      let xOff = 6;
      let flip = false;
      if (o.dir === 'left') { xOff = -6 - GUN_W_HELD; flip = true; }
      else if (o.dir === 'right') { xOff = 6; flip = false; }
      else if (o.dir === 'up') { xOff = -GUN_W_HELD / 2; }
      else { xOff = -GUN_W_HELD / 2; }
      ctx.save();
      if (flip) {
        ctx.translate(sx + xOff + GUN_W_HELD, sy + yOff);
        ctx.scale(-1, 1);
        ctx.drawImage(gunImg, 0, 0, GUN_W_HELD, GUN_H_HELD);
      } else {
        ctx.drawImage(gunImg, sx + xOff, sy + yOff, GUN_W_HELD, GUN_H_HELD);
      }
      ctx.restore();
    }
  }

  // ----- 총알: 노란 픽셀 + 진행 방향 잔상 -----
  for (const b of bullets) {
    const sx = Math.round(b.x - camera.x);
    const sy = Math.round(b.y - camera.y);
    // 잔상 (반대 방향으로 8px)
    const tailLen = 8;
    const norm = Math.hypot(b.vx, b.vy) || 1;
    const tx = sx - (b.vx / norm) * tailLen;
    const ty = sy - (b.vy / norm) * tailLen;
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    // 머리 픽셀
    ctx.fillStyle = '#fff7a0';
    ctx.fillRect(sx - 2, sy - 2, 4, 4);
    ctx.fillStyle = '#ffd64a';
    ctx.fillRect(sx - 1, sy - 1, 2, 2);
  }

  ctx.restore();
}

// ===== 데미지 플래시 오버레이 =====
// HP 감소 직후 화면 전체에 짧은 붉은 번쩍임. damageFlashUntil 만료까지 0.3초.
export function drawDamageFlash(
  ctx: CanvasRenderingContext2D,
  damageFlashUntil: number,
  now: number,
): void {
  const remain = damageFlashUntil - now;
  if (remain <= 0) return;
  const total = 0.3;
  const t = Math.max(0, Math.min(1, remain / total)); // 1 → 0
  const alpha = t * 0.45;                              // 0 → 0.45
  ctx.save();
  ctx.fillStyle = `rgba(255, 30, 30, ${alpha})`;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}
