// 좀비 웨이브 시스템 — 협동 PvE.
//
// 설계:
//   - 호스트(presence id 최소 클라) 가 5분마다 wave_start broadcast.
//     모든 클라이언트가 받으면 2분간 좀비 시뮬레이션 시작.
//   - 좀비 시뮬은 각 클라이언트 독립 (보스와 같은 방식). 좀비 위치는 클라간 약간
//     달라질 수 있으나 데미지는 "자기 자신이 좀비 접촉 감지 → 자기 HP 깎기" 이므로
//     플레이어 체감엔 문제 없음.
//   - 좀비는 가장 가까운 *살아있는* 플레이어(로컬+원격)를 walk 모션으로 추격.
//   - 접촉 거리 안에서 spellcast 모션으로 공격, 데미지 8, 쿨다운 1.2초.
//
// LPC 행 (zombie.png 표준):
//   0~3:  Spellcast (Up/Left/Down/Right) — 공격 모션
//   8~11: Walk      (Up/Left/Down/Right) — 이동 모션 (col 0 idle, 1-8 cycle)

import type { TileMap } from './map';
import type { Camera } from './world';
import type { LocalPlayer } from './player';
import { ATTACK_COOLDOWN as PLAYER_ATTACK_COOLDOWN, ATTACK_DAMAGE as PLAYER_ATTACK_DAMAGE, BODY_HH, BODY_HW, BODY_OFF_Y, SPEED as PLAYER_SPEED, attackerHitbox } from './player';
import type { AttackPayload, Dir, RemotePlayer } from './types';

export const ZOMBIE_WAVE_DURATION_SEC = 120;     // 한 웨이브 길이 (2분)
export const ZOMBIE_WAVE_INTERVAL_SEC = 300;     // 웨이브 간 간격 (5분: 시작~다음 시작)
const INITIAL_SPAWN = 8;
const SPAWN_INTERVAL_SEC = 4;
const MAX_ZOMBIES = 30;
const ZOMBIE_SPEED_PX = PLAYER_SPEED * 0.3;      // 플레이어 속도의 30% (= 36 px/s)
const ZOMBIE_BODY_HW = BODY_HW;                  // 캐릭터와 동일 크기
const ZOMBIE_BODY_HH = BODY_HH;
const ATTACK_RANGE_PX = 18;                      // 닿았다고 판정할 거리
const ATTACK_DAMAGE = Math.round(PLAYER_ATTACK_DAMAGE / 2);  // 캐릭터 펀치의 1/2 (= 10)
// 공격 속도 = 플레이어 공격 속도의 30% → 쿨다운 = 플레이어 쿨다운 / 0.3
const ATTACK_COOLDOWN_SEC = PLAYER_ATTACK_COOLDOWN / 0.3;    // ≈ 1.67s
const ATTACK_MOTION_SEC = 0.45;                  // spellcast 1회 모션 길이
// 좀비 hitbox 반경 — 플레이어 공격이 좀비를 죽이는 판정용. 좀비 몸통 중심 기준.
const ZOMBIE_HIT_RADIUS = 14;

// LPC 행
const ROW_SPELL: Record<Dir, number> = { up: 0, left: 1, down: 2, right: 3 };
const ROW_WALK:  Record<Dir, number> = { up: 8, left: 9, down: 10, right: 11 };
const FRAME = 64;

interface Zombie {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  attackingUntil: number;  // > now 이면 spellcast 모션 그리기
  lastAttackAt: number;    // 쿨다운 체크
}

export interface ZombieWave {
  active: boolean;
  startedAt: number;
  endsAt: number;
  zombies: Zombie[];
  nextSpawnAt: number;
  // 호스트만 — 다음 웨이브 시작 시각
  nextWaveAt: number;
}

export function makeZombieWave(now: number): ZombieWave {
  return {
    active: false,
    startedAt: 0,
    endsAt: 0,
    zombies: [],
    nextSpawnAt: 0,
    // 첫 웨이브는 입장 60초 후 트리거, 이후 ZOMBIE_WAVE_INTERVAL_SEC(5분) 주기.
    nextWaveAt: now + 60,
  };
}

// ===== 스프라이트 로딩 =====
const sheet = new Image();
let sheetReady = false;
sheet.src = '/sprites/zombie.png';
sheet.onload = () => { sheetReady = true; };

// ===== 호스트만 호출 — wave_start 트리거 시점 결정 =====
export function maybeTriggerWave(
  wave: ZombieWave,
  now: number,
  isHost: boolean,
  onTrigger: () => void,
): void {
  if (!isHost) return;
  if (now < wave.nextWaveAt) return;
  // 다음 웨이브 예약은 시작 시각 기준으로
  wave.nextWaveAt = now + ZOMBIE_WAVE_INTERVAL_SEC;
  onTrigger();
}

// ===== 웨이브 시작 (broadcast 받았을 때 모든 클라이언트가 호출) =====
export function startWave(wave: ZombieWave, now: number, map: TileMap): void {
  wave.active = true;
  wave.startedAt = now;
  wave.endsAt = now + ZOMBIE_WAVE_DURATION_SEC;
  wave.zombies = [];
  wave.nextSpawnAt = now + SPAWN_INTERVAL_SEC;
  for (let i = 0; i < INITIAL_SPAWN; i++) {
    spawnOne(wave, now, map);
  }
}

function spawnOne(wave: ZombieWave, _now: number, map: TileMap): void {
  if (wave.zombies.length >= MAX_ZOMBIES) return;
  // 맵 가장자리 랜덤 위치 — 플레이어가 알아채기 좋게 외곽에서 등장
  const TILE = map.tileW;
  const margin = TILE * 2;
  let x = 0, y = 0;
  for (let i = 0; i < 20; i++) {
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { x = margin + Math.random() * (map.pixelW - margin * 2); y = margin; }
    else if (side === 1) { x = margin + Math.random() * (map.pixelW - margin * 2); y = map.pixelH - margin; }
    else if (side === 2) { x = margin; y = margin + Math.random() * (map.pixelH - margin * 2); }
    else { x = map.pixelW - margin; y = margin + Math.random() * (map.pixelH - margin * 2); }
    break;
  }
  wave.zombies.push({
    id: makeId(),
    x, y,
    dir: 'down',
    attackingUntil: 0,
    lastAttackAt: 0,
  });
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `z${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ===== 총알 vs 좀비 — 한 발 맞으면 죽음. 적중한 좀비 id 목록 반환 (호출자가 총알 제거에 사용). =====
const ZOMBIE_BULLET_HIT_RADIUS = 18; // 시각 크기 + 약간 여유
export function bulletHitsZombie(wave: ZombieWave, bx: number, by: number): string | null {
  if (!wave.active) return null;
  const R2 = ZOMBIE_BULLET_HIT_RADIUS * ZOMBIE_BULLET_HIT_RADIUS;
  for (const z of wave.zombies) {
    // 좀비 몸통 중심 = 발 기준 살짝 위 (그림 발 y = z.y, 몸 중심 ≈ z.y - HH)
    const cy = z.y - ZOMBIE_BODY_HH;
    const dx = z.x - bx;
    const dy = cy - by;
    if (dx * dx + dy * dy <= R2) return z.id;
  }
  return null;
}
export function killZombieById(wave: ZombieWave, id: string): boolean {
  const before = wave.zombies.length;
  wave.zombies = wave.zombies.filter((z) => z.id !== id);
  return wave.zombies.length < before;
}

// ===== 플레이어 공격 vs 좀비 — 한 대 맞으면 죽음 =====
// 누군가(로컬 or 원격) 공격 broadcast 발사 → 그 공격 hitbox 안 좀비를 자기 클라이언트에서 제거.
// 각 클라가 자기 좀비 시뮬에서 처리하므로 (좀비 위치 약간 다를 수 있음) 시각적으로 좀
// 어긋날 수 있으나 v1 단순화로 OK.
export function tryHitFromAttack(wave: ZombieWave, atk: AttackPayload): number {
  if (!wave.active || wave.zombies.length === 0) return 0;
  const hb = attackerHitbox(atk);
  let killed = 0;
  wave.zombies = wave.zombies.filter((z) => {
    // 좀비 몸통 AABB (몸통 중심 = z.y + 발 기준 살짝 위, 대충 z.y - HH)
    const zx0 = z.x - ZOMBIE_HIT_RADIUS;
    const zx1 = z.x + ZOMBIE_HIT_RADIUS;
    const zy0 = z.y - ZOMBIE_BODY_HH * 2;
    const zy1 = z.y;
    const hit = zx0 < hb.x1 && zx1 > hb.x0 && zy0 < hb.y1 && zy1 > hb.y0;
    if (hit) killed++;
    return !hit;
  });
  return killed;
}

// ===== 매 프레임 업데이트 — 좀비 AI + 자기 자신 (로컬 플레이어) 피격 처리 =====
export interface ZombieHitCallbacks {
  onLocalHit: (dmg: number, fromZombieId: string) => void;
}

export function updateWave(
  wave: ZombieWave,
  dt: number,
  now: number,
  map: TileMap,
  local: LocalPlayer,
  remotes: Iterable<RemotePlayer>,
  cb: ZombieHitCallbacks,
): void {
  if (!wave.active) return;
  if (now >= wave.endsAt) {
    wave.active = false;
    wave.zombies = [];
    return;
  }
  // 주기적 추가 스폰
  if (now >= wave.nextSpawnAt) {
    wave.nextSpawnAt = now + SPAWN_INTERVAL_SEC;
    spawnOne(wave, now, map);
  }
  // 살아있는 플레이어 목록 (타깃 후보)
  const targets: { x: number; y: number }[] = [];
  if (!local.dead) targets.push({ x: local.x, y: local.y });
  for (const r of remotes) if (!r.dead) targets.push({ x: r.renderX, y: r.renderY });
  if (targets.length === 0) return;

  for (const z of wave.zombies) {
    // 공격 모션 중이면 정지
    if (now < z.attackingUntil) continue;
    // 가장 가까운 타깃
    let tx = targets[0].x, ty = targets[0].y;
    let bestD2 = (tx - z.x) ** 2 + (ty - z.y) ** 2;
    for (let i = 1; i < targets.length; i++) {
      const d2 = (targets[i].x - z.x) ** 2 + (targets[i].y - z.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; tx = targets[i].x; ty = targets[i].y; }
    }
    // 로컬 플레이어와의 거리도 별도로 (피격 판정용)
    const dxLocal = local.x - z.x;
    const dyLocal = local.y - z.y;
    const distLocal = Math.hypot(dxLocal, dyLocal);
    if (!local.dead && distLocal <= ATTACK_RANGE_PX && now - z.lastAttackAt >= ATTACK_COOLDOWN_SEC) {
      z.lastAttackAt = now;
      z.attackingUntil = now + ATTACK_MOTION_SEC;
      // 공격 방향 = 플레이어 쪽
      z.dir = dirFromVec(dxLocal, dyLocal);
      cb.onLocalHit(ATTACK_DAMAGE, z.id);
      continue;
    }
    // 이동
    const dxT = tx - z.x;
    const dyT = ty - z.y;
    const distT = Math.hypot(dxT, dyT) || 1;
    if (distT > ATTACK_RANGE_PX) {
      const nx = dxT / distT;
      const ny = dyT / distT;
      z.x += nx * ZOMBIE_SPEED_PX * dt;
      z.y += ny * ZOMBIE_SPEED_PX * dt;
      z.dir = dirFromVec(nx, ny);
    }
  }
}

function dirFromVec(dx: number, dy: number): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// ===== 렌더 =====
// camera 좌표계 사용. 캐릭터와 동일한 prescale (0.5) 로 그림.
export function drawZombies(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  wave: ZombieWave,
  now: number,
  charScale: number = 0.5,
): void {
  if (!wave.active || !sheetReady) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const dstW = Math.round(FRAME * charScale);
  const dstH = Math.round(FRAME * charScale);
  const footY = Math.round(58 * charScale); // 캐릭터와 동일한 발 y
  for (const z of wave.zombies) {
    const sx = Math.round(z.x - camera.x);
    const sy = Math.round(z.y - camera.y);
    let row: number;
    let col: number;
    if (now < z.attackingUntil) {
      row = ROW_SPELL[z.dir];
      // spellcast 7 frame — 진행률에 따라 0..6
      const phase = 1 - (z.attackingUntil - now) / ATTACK_MOTION_SEC;
      col = Math.min(6, Math.floor(phase * 7));
    } else {
      row = ROW_WALK[z.dir];
      // 발자국 사이클 — walk 1~8
      col = 1 + Math.floor(now * 7) % 8;
    }
    const dx = sx - Math.round(dstW / 2);
    const dy = sy - footY;
    ctx.drawImage(sheet, col * FRAME, row * FRAME, FRAME, FRAME, dx, dy, dstW, dstH);
  }
  ctx.restore();
}

// ===== 좀비 타임 ambient — 화면에 불안한 느낌 =====
// 빨간 비네팅(가장자리만 어둑한 붉은빛) + 심장 박동 펄스로 알파 진동.
// 게임 캔버스(ctx2d) 위에 그림. renderFrame 직후, HUD 직전에 호출.
export function drawWaveAmbient(
  ctx: CanvasRenderingContext2D,
  wave: ZombieWave,
  now: number,
): void {
  if (!wave.active) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  // 심장 박동: 약 1초 주기, 들숨/날숨 두 박자 (lub-dub).
  // sin 두 개 합성으로 부드러운 더블 펄스.
  const t = now;
  const base = (Math.sin(t * Math.PI * 2 / 1.2) + 1) / 2;             // 0..1, 1.2s 주기
  const accent = Math.max(0, Math.sin(t * Math.PI * 2 / 1.2 + 1.2));  // 위상 어긋난 강조
  const pulse = Math.min(1, base * 0.7 + accent * 0.3);
  // 가장자리 비네팅 (radial gradient: 가운데 투명, 모서리로 갈수록 어둑한 적색)
  const cx = w / 2, cy = h / 2;
  const r0 = Math.min(w, h) * 0.25;        // 안쪽 투명 반경
  const r1 = Math.hypot(cx, cy);           // 대각선 = 모서리까지
  const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
  const edgeAlpha = 0.45 + pulse * 0.35;   // 0.45..0.80
  grad.addColorStop(0, 'rgba(60, 0, 0, 0)');
  grad.addColorStop(0.55, `rgba(80, 0, 0, ${edgeAlpha * 0.35})`);
  grad.addColorStop(1, `rgba(140, 0, 0, ${edgeAlpha})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // 살짝 전체 적색 틴트 (분위기) — 항상 약하게
  ctx.fillStyle = `rgba(80, 10, 10, ${0.06 + pulse * 0.04})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ===== HUD 타이머 (화면 중앙 상단) =====
export function drawWaveTimer(
  hudCtx: CanvasRenderingContext2D,
  wave: ZombieWave,
  now: number,
): void {
  if (!wave.active) return;
  const remain = Math.max(0, wave.endsAt - now);
  const mm = Math.floor(remain / 60);
  const ss = Math.floor(remain % 60).toString().padStart(2, '0');
  const text = `🧟 좀비 타임 ${mm}:${ss}`;
  const cssW = hudCtx.canvas.clientWidth;
  hudCtx.save();
  // 배경 박스
  hudCtx.font = '600 14px "Apple SD Gothic Neo","Malgun Gothic", system-ui, sans-serif';
  const padX = 10, padY = 4;
  const w = Math.ceil(hudCtx.measureText(text).width) + padX * 2;
  const h = 20 + padY * 2;
  const x = Math.round(cssW / 2 - w / 2);
  const y = 6;
  hudCtx.fillStyle = 'rgba(20, 4, 4, 0.82)';
  hudCtx.fillRect(x, y, w, h);
  hudCtx.strokeStyle = '#a02a2a';
  hudCtx.lineWidth = 1;
  hudCtx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  hudCtx.fillStyle = '#ffd0d0';
  hudCtx.textBaseline = 'middle';
  hudCtx.textAlign = 'center';
  hudCtx.fillText(text, Math.round(cssW / 2), y + h / 2);
  hudCtx.restore();
}

// 로컬 플레이어 몸통 AABB — 좀비가 다른 클라이언트의 원격 플레이어를 공격해도
// 그 플레이어 자기 자신의 클라이언트에서만 데미지 처리되므로 여기서는 사용 안 함.
// (참고용으로 유지)
export function getLocalBodyAabb(local: LocalPlayer): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: local.x - BODY_HW,
    x1: local.x + BODY_HW,
    y0: local.y + BODY_OFF_Y - BODY_HH,
    y1: local.y + BODY_OFF_Y + BODY_HH,
  };
}

// 좀비 자체 hitbox (참고용)
export { ZOMBIE_BODY_HW, ZOMBIE_BODY_HH };
