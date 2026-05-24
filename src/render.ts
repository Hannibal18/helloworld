// 한 프레임 렌더 — Tiled 레이어 + 캐릭터 Y-소트 + objects_above 가림.
//
// 레이어 순서:
//   ground → decor → objects_below → [캐릭터 Y-소트] → objects_above → 이름/HP/데미지 → 디버그 오버레이

import { type Camera } from './world';
import {
  CHAR_H, CHAR_W, DANCE_H, dancePoseFrame, drawCharacter, drawDancing,
} from './sprites';
import { ATTACK_SWING_DUR, BODY_HH, BODY_HW, BODY_OFF_Y, FOOT_HH, FOOT_HW, type LocalPlayer } from './player';
import { drawCollisionDebug, drawGridDebug, drawTile, drawTileLayer, type TileMap } from './map';
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

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  camera: Camera,
  local: LocalPlayer,
  remotes: RenderableRemote[],
  now: number,
  debug: DebugState,
  hud: HudLayer,
): void {
  ctx.imageSmoothingEnabled = false;

  // 1. 바닥 / 장식 — 항상 캐릭터 아래
  for (const name of ['ground', 'decor']) {
    const layer = map.layerByName.get(name);
    if (layer) drawTileLayer(ctx, map, layer, camera.x, camera.y, camera.viewW, camera.viewH);
  }

  // 2. Y-소트 — objects_below 의 각 타일과 캐릭터를 발 위치 기준으로 정렬해서 그림.
  //    한 화면에 보이는 칸만 수집 → 정렬 → 순서대로 그림.
  //    트리/바위의 footY = (ty+1)*tileH 즉 타일 바닥. 캐릭터의 footY = player.y.
  type SortItem =
    | { ySort: number; kind: 'local' }
    | { ySort: number; kind: 'remote'; remote: RenderableRemote }
    | { ySort: number; kind: 'tile'; gid: number; tx: number; ty: number };
  const items: SortItem[] = [];
  items.push({ ySort: local.y, kind: 'local' });
  for (const r of remotes) items.push({ ySort: r.y, kind: 'remote', remote: r });

  const objBelow = map.layerByName.get('objects_below');
  if (objBelow && objBelow.kind === 'tile' && objBelow.visible) {
    const tw = map.tileW, th = map.tileH;
    const tx0 = Math.max(0, Math.floor(camera.x / tw));
    const ty0 = Math.max(0, Math.floor(camera.y / th));
    const tx1 = Math.min(objBelow.width  - 1, Math.floor((camera.x + camera.viewW) / tw));
    const ty1 = Math.min(objBelow.height - 1, Math.floor((camera.y + camera.viewH) / th));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const gid = objBelow.data[ty * objBelow.width + tx];
        if (gid > 0) items.push({ ySort: (ty + 1) * th, kind: 'tile', gid, tx, ty });
      }
    }
  }
  items.sort((a, b) => a.ySort - b.ySort);

  for (const it of items) {
    if (it.kind === 'tile') {
      drawTile(ctx, map, it.gid,
        Math.round(it.tx * map.tileW - camera.x),
        Math.round(it.ty * map.tileH - camera.y));
    } else if (it.kind === 'local') {
      drawLocal(ctx, camera, local, now);
    } else if (it.kind === 'remote') {
      drawRemote(ctx, camera, it.remote, now);
    }
  }

  // 3. objects_above — 항상 캐릭터 위 (지붕·나무 윗부분 등 가림 효과 전용)
  const above = map.layerByName.get('objects_above');
  if (above) drawTileLayer(ctx, map, above, camera.x, camera.y, camera.viewW, camera.viewH);

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
