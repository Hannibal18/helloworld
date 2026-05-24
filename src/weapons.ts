// 4종 자동 무기 시스템 — 뱀파이어 서바이벌 느낌.
// 모두 땅 드랍 → 픽업 시 30초 보유 → 공격 버튼 누르고 있으면 각자 쿨다운대로 자동 발사.
// 좀비만 데미지 (PvP 영향 없음).
//
// 네트워크:
//   - 호스트가 weapon_drop broadcast (랜덤 타입)
//   - 누가 줍든 weapon_pickup broadcast → 모든 클라가 같은 드랍 제거
//   - 발사체는 로컬 전용 (각 클라가 자기 좀비 시뮬과 부딪힘)

import { isBlocked, type TileMap } from './map';
import type { Camera } from './world';
import type { LocalPlayer } from './player';
import { BODY_OFF_Y } from './player';
import { bulletHitsZombie, killZombieById, type ZombieWave } from './zombie';

export type WeaponType = 'garlic' | 'knives' | 'missile' | 'lightning';
export const WEAPON_TYPES: readonly WeaponType[] = ['garlic', 'knives', 'missile', 'lightning'];

export const WEAPON_DROP_INTERVAL = 45;   // sec (AK 60s 보다 살짝 짧게)
export const WEAPON_MAX_DROPS = 3;
export const WEAPON_PICKUP_RADIUS = 18;
export const WEAPON_HOLD_DURATION = 30;

const COOLDOWN: Record<WeaponType, number> = {
  garlic:    1.5,
  knives:    0.8,
  missile:   1.0,
  lightning: 2.5,
};
const COLOR: Record<WeaponType, string> = {
  garlic:    '#d8ff80',
  knives:    '#ffffff',
  missile:   '#c060ff',
  lightning: '#ffd84a',
};
const SYMBOL: Record<WeaponType, string> = {
  garlic:    '🧄',
  knives:    '🗡',
  missile:   '✨',
  lightning: '⚡',
};

// ===== 튜닝 =====
const GARLIC_RADIUS = 56;
const KNIFE_SPEED = 460;
const KNIFE_LIFE = 0.55;
const KNIFE_FAN_ANGLE = 0.35;  // radians, ±0.35 = 약 40° 부채
const MISSILE_SPEED = 280;
const MISSILE_LIFE = 1.6;
const MISSILE_HOMING_TURN_RATE = 6;  // radians/sec — 회전 한계
const LIGHTNING_RANGE = 140;
const LIGHTNING_CHAIN = 2;             // 추가 체인 점프 횟수
const LIGHTNING_CHAIN_RANGE = 110;
const LIGHTNING_LIFE = 0.18;           // 라이트닝 비주얼 지속

// ===== 타입 =====
export interface WeaponDrop {
  id: string;
  type: WeaponType;
  x: number;
  y: number;
  spawnedAt: number;
}
interface Projectile {
  pid: string;
  type: 'knives' | 'missile';
  x: number; y: number;
  vx: number; vy: number;
  bornAt: number;
  angle: number;            // 현재 진행 각도 (homing 갱신용)
}
interface LightningBolt {
  // 폴리라인 좌표들 (시작 → 첫 적 → 체인 1 → 체인 2)
  pts: { x: number; y: number }[];
  bornAt: number;
}

export interface WeaponsState {
  drops: Map<string, WeaponDrop>;
  projectiles: Projectile[];
  bolts: LightningBolt[];
  // 보유 무기: 타입 → 만료 시각(sec). now < 만료 면 보유 중.
  owned: Map<WeaponType, number>;
  // 마지막 발사 시각 (쿨다운)
  lastFire: Map<WeaponType, number>;
  nextSpawnAt: number;
}

export function makeWeaponsState(now: number): WeaponsState {
  return {
    drops: new Map(),
    projectiles: [],
    bolts: [],
    owned: new Map(),
    lastFire: new Map(),
    nextSpawnAt: now + 25, // 첫 드랍 25초 후
  };
}

// ===== 호스트만 — 새 드랍 스폰 =====
export function maybeSpawn(
  state: WeaponsState, now: number, map: TileMap, isHost: boolean,
  emit: (drop: WeaponDrop) => void,
): void {
  if (!isHost) return;
  if (now < state.nextSpawnAt) return;
  state.nextSpawnAt = now + WEAPON_DROP_INTERVAL;
  if (state.drops.size >= WEAPON_MAX_DROPS) return;
  const pos = pickSpawnTile(map);
  if (!pos) return;
  const type = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
  emit({ id: randomId(), type, x: pos.x, y: pos.y, spawnedAt: now });
}

function pickSpawnTile(map: TileMap): { x: number; y: number } | null {
  const TILE = map.tileW;
  for (let i = 0; i < 30; i++) {
    const tx = Math.floor(Math.random() * map.widthTiles);
    const ty = Math.floor(Math.random() * map.heightTiles);
    const x = tx * TILE + TILE / 2;
    const y = ty * TILE + TILE / 2;
    if (!isBlocked(map, x, y, 8, 8)) return { x, y };
  }
  return null;
}
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `w${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ===== 픽업 =====
export function findPickup(state: WeaponsState, fx: number, fy: number): WeaponDrop | null {
  const R2 = WEAPON_PICKUP_RADIUS * WEAPON_PICKUP_RADIUS;
  for (const d of state.drops.values()) {
    const dx = d.x - fx, dy = d.y - fy;
    if (dx * dx + dy * dy <= R2) return d;
  }
  return null;
}
// 한 번에 한 무기만 — 새 무기 부여 시 기존 보유 무기는 모두 제거.
// (AK 와의 상호 배제는 호출자가 local.gunUntil = 0 로 따로 처리)
export function grantOwnership(state: WeaponsState, type: WeaponType, now: number): void {
  state.owned.clear();
  state.lastFire.clear();
  state.owned.set(type, now + WEAPON_HOLD_DURATION);
}
// AK 픽업 시 호출 — 보조 무기 전부 해제.
export function clearAllOwned(state: WeaponsState): void {
  state.owned.clear();
  state.lastFire.clear();
}

// ===== 자동 발사 — 보유한 무기 각자 쿨다운대로 =====
// attackHeld=true 일 때 매 프레임 호출. 좀비 wave 참조해서 타깃 찾고 데미지 적용.
export function fireOwnedWeapons(
  state: WeaponsState, now: number, local: LocalPlayer, wave: ZombieWave, fired: (type: WeaponType) => void,
): void {
  if (local.dead) return;
  for (const [type, expireAt] of Array.from(state.owned.entries())) {
    if (now >= expireAt) { state.owned.delete(type); state.lastFire.delete(type); continue; }
    const last = state.lastFire.get(type) ?? -Infinity;
    if (now - last < COOLDOWN[type]) continue;
    state.lastFire.set(type, now);
    fired(type);
    switch (type) {
      case 'garlic':    fireGarlic(state, now, local, wave); break;
      case 'knives':    fireKnives(state, now, local); break;
      case 'missile':   fireMissile(state, now, local, wave); break;
      case 'lightning': fireLightning(state, now, local, wave); break;
    }
  }
}

function fireGarlic(_state: WeaponsState, _now: number, local: LocalPlayer, wave: ZombieWave): void {
  // 즉시 AOE — 캐릭터 몸 중심 반경 안 좀비 전부 즉살
  const cx = local.x, cy = local.y + BODY_OFF_Y;
  const R2 = GARLIC_RADIUS * GARLIC_RADIUS;
  wave.zombies = wave.zombies.filter((z) => {
    const dx = z.x - cx, dy = z.y - cy;
    return dx * dx + dy * dy > R2;
  });
}

function fireKnives(state: WeaponsState, now: number, local: LocalPlayer): void {
  // 3-fan: 캐릭터 진행 방향 기준 -0.35 / 0 / +0.35 라디안
  const baseAngle = dirAngle(local);
  const cx = local.x;
  const cy = local.y + BODY_OFF_Y;
  for (const offset of [-KNIFE_FAN_ANGLE, 0, KNIFE_FAN_ANGLE]) {
    const a = baseAngle + offset;
    state.projectiles.push({
      pid: randomId(), type: 'knives',
      x: cx, y: cy,
      vx: Math.cos(a) * KNIFE_SPEED,
      vy: Math.sin(a) * KNIFE_SPEED,
      bornAt: now,
      angle: a,
    });
  }
}

function fireMissile(state: WeaponsState, now: number, local: LocalPlayer, wave: ZombieWave): void {
  const cx = local.x;
  const cy = local.y + BODY_OFF_Y;
  // 발사 각도는 가장 가까운 좀비 방향, 없으면 진행 방향
  let a = dirAngle(local);
  const target = nearestZombie(wave, cx, cy);
  if (target) a = Math.atan2(target.y - cy, target.x - cx);
  state.projectiles.push({
    pid: randomId(), type: 'missile',
    x: cx, y: cy,
    vx: Math.cos(a) * MISSILE_SPEED,
    vy: Math.sin(a) * MISSILE_SPEED,
    bornAt: now,
    angle: a,
  });
}

function fireLightning(state: WeaponsState, now: number, local: LocalPlayer, wave: ZombieWave): void {
  const sx = local.x, sy = local.y + BODY_OFF_Y;
  const first = nearestZombie(wave, sx, sy, LIGHTNING_RANGE);
  if (!first) return;
  const pts: { x: number; y: number }[] = [{ x: sx, y: sy }, { x: first.x, y: first.y }];
  killZombieById(wave, first.id);
  let last = first;
  const exclude = new Set<string>([first.id]);
  for (let i = 0; i < LIGHTNING_CHAIN; i++) {
    const next = nearestZombie(wave, last.x, last.y, LIGHTNING_CHAIN_RANGE, exclude);
    if (!next) break;
    pts.push({ x: next.x, y: next.y });
    killZombieById(wave, next.id);
    exclude.add(next.id);
    last = next;
  }
  state.bolts.push({ pts, bornAt: now });
}

function dirAngle(local: LocalPlayer): number {
  // 캐릭터 방향(p.dir) 기반 라디안 (오른쪽=0)
  switch (local.dir) {
    case 'right': return 0;
    case 'down':  return Math.PI / 2;
    case 'left':  return Math.PI;
    case 'up':    return -Math.PI / 2;
  }
}

function nearestZombie(
  wave: ZombieWave, x: number, y: number,
  maxRange: number = Infinity,
  exclude?: Set<string>,
): { id: string; x: number; y: number } | null {
  if (!wave.active) return null;
  const maxR2 = maxRange * maxRange;
  let best: { id: string; x: number; y: number } | null = null;
  let bestD2 = maxR2;
  for (const z of wave.zombies) {
    if (exclude?.has(z.id)) continue;
    const dx = z.x - x, dy = z.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = { id: z.id, x: z.x, y: z.y }; }
  }
  return best;
}

// ===== 매 프레임 — 발사체 위치 갱신 + 좀비 충돌 + 만료 =====
export function stepProjectiles(state: WeaponsState, dt: number, now: number, wave: ZombieWave): void {
  // 라이트닝 비주얼 만료
  state.bolts = state.bolts.filter((b) => now - b.bornAt <= LIGHTNING_LIFE);
  // 발사체
  state.projectiles = state.projectiles.filter((p) => {
    const life = p.type === 'knives' ? KNIFE_LIFE : MISSILE_LIFE;
    if (now - p.bornAt > life) return false;
    // missile homing
    if (p.type === 'missile') {
      const t = nearestZombie(wave, p.x, p.y);
      if (t) {
        const targetAngle = Math.atan2(t.y - p.y, t.x - p.x);
        let diff = targetAngle - p.angle;
        // wrap to [-PI, PI]
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const maxTurn = MISSILE_HOMING_TURN_RATE * dt;
        if (diff > maxTurn) diff = maxTurn;
        if (diff < -maxTurn) diff = -maxTurn;
        p.angle += diff;
        p.vx = Math.cos(p.angle) * MISSILE_SPEED;
        p.vy = Math.sin(p.angle) * MISSILE_SPEED;
      }
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // 좀비 충돌
    const zid = bulletHitsZombie(wave, p.x, p.y);
    if (zid) {
      killZombieById(wave, zid);
      return false;
    }
    return true;
  });
}

// ===== 렌더: 드랍 (땅 위), 발사체 (날아다님), 보유 아이콘 (캐릭터 머리 위) =====

export function drawWeaponDrops(
  ctx: CanvasRenderingContext2D, camera: Camera, drops: Iterable<WeaponDrop>, now: number,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.font = '700 14px "Apple SD Gothic Neo", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const RING_R = 16;
  for (const d of drops) {
    const sx = Math.round(d.x - camera.x);
    const sy = Math.round(d.y - camera.y);
    const phase = (now - d.spawnedAt) * 3.2;
    const pulse = (Math.sin(phase) + 1) / 2;
    const r = RING_R + pulse * 4;
    const alpha = 0.55 + pulse * 0.45;
    // 황금 펄스 링
    ctx.strokeStyle = `rgba(255, 215, 80, ${alpha * 0.35})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, r + 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `rgba(255, 215, 80, ${alpha})`;
    ctx.lineWidth = 1.5 + pulse;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    // 안쪽 어둑
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.arc(sx, sy, RING_R - 2, 0, Math.PI * 2); ctx.fill();
    // 무기 색 점 + 심볼
    ctx.fillStyle = COLOR[d.type];
    ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.fill();
    // 심볼 (emoji 가 캔버스에서 흑백으로 렌더될 수 있어 글자 기준만 안내)
    ctx.fillStyle = '#1a0e08';
    ctx.fillText(SYMBOL[d.type], sx, sy + 1);
  }
  ctx.restore();
}

export function drawProjectiles(
  ctx: CanvasRenderingContext2D, camera: Camera, state: WeaponsState, now: number,
): void {
  ctx.save();
  // 라이트닝
  for (const b of state.bolts) {
    const age = (now - b.bornAt) / LIGHTNING_LIFE;
    const alpha = 1 - age;
    ctx.strokeStyle = `rgba(255, 240, 120, ${alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < b.pts.length; i++) {
      const p = b.pts[i];
      const sx = Math.round(p.x - camera.x);
      const sy = Math.round(p.y - camera.y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    // 안쪽 더 밝은 코어
    ctx.strokeStyle = `rgba(255, 255, 220, ${alpha})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < b.pts.length; i++) {
      const p = b.pts[i];
      const sx = Math.round(p.x - camera.x);
      const sy = Math.round(p.y - camera.y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  // 발사체
  for (const p of state.projectiles) {
    const sx = Math.round(p.x - camera.x);
    const sy = Math.round(p.y - camera.y);
    if (p.type === 'knives') {
      // 작은 흰 삼각형 (진행 방향 기준)
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(p.angle);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(-4, 3); ctx.lineTo(-4, -3); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#aaaaaa';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    } else {
      // missile — 보라 orb + 글로우
      ctx.fillStyle = 'rgba(192, 96, 255, 0.35)';
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c060ff';
      ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(sx, sy, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// ===== 캐릭터 머리 위 보유 무기 아이콘 =====
// 각 무기는 작은 황금 테두리 원 + 색점 + 심볼. 가로로 나열.
export function drawOwnedIcons(
  ctx: CanvasRenderingContext2D, camera: Camera,
  ownerX: number, ownerY: number, charH: number,
  weapons: WeaponType[], hasGun: boolean,
): void {
  const items: { color: string; symbol: string }[] = [];
  if (hasGun) items.push({ color: '#888', symbol: '🔫' });
  for (const w of weapons) items.push({ color: COLOR[w], symbol: SYMBOL[w] });
  if (items.length === 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.font = '700 10px "Apple SD Gothic Neo", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ICON_R = 7;
  const GAP = 3;
  const total = items.length * (ICON_R * 2) + (items.length - 1) * GAP;
  const startX = Math.round(ownerX - camera.x - total / 2 + ICON_R);
  const y = Math.round(ownerY - camera.y - charH - 18);
  for (let i = 0; i < items.length; i++) {
    const sx = startX + i * (ICON_R * 2 + GAP);
    // 황금 테두리 + 어둑한 안쪽
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 1.2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(sx, y, ICON_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // 색점
    ctx.fillStyle = items[i].color;
    ctx.beginPath(); ctx.arc(sx, y, 3, 0, Math.PI * 2); ctx.fill();
    // 심볼 살짝 아래
    ctx.fillStyle = '#1a0e08';
    ctx.fillText(items[i].symbol, sx, y + 1);
  }
  ctx.restore();
}
