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

export type WeaponType = 'garlic' | 'pistol' | 'missile' | 'lightning';
export const WEAPON_TYPES: readonly WeaponType[] = ['garlic', 'pistol', 'missile', 'lightning'];

// ===== 드랍 가중치 (rarity tier) =====
// 액션 로그라이크 표준 패턴 — 약한 무기는 자주, 강한 무기는 드물게.
// 단순 가중 랜덤 (weighted random). 합 = 100 으로 % 직관적.
//   pistol    50%  common      — 약한 단발 권총 (튜토리얼 격)
//   missile   28%  uncommon    — 호밍, 안정적
//   lightning 15%  rare        — 체인, 멀티 타깃
//   garlic     7%  epic        — 무지향성 AOE, 가장 강력
const DROP_WEIGHTS: Record<WeaponType, number> = {
  pistol:    50,
  missile:   28,
  lightning: 15,
  garlic:     7,
};
function pickWeaponByWeight(): WeaponType {
  if (DEBUG_LIGHTNING_ONLY) return 'lightning';
  const total = WEAPON_TYPES.reduce((s, t) => s + DROP_WEIGHTS[t], 0);
  let r = Math.random() * total;
  for (const t of WEAPON_TYPES) {
    r -= DROP_WEIGHTS[t];
    if (r < 0) return t;
  }
  return WEAPON_TYPES[0];
}

// ===== !!! DEBUG: 라이트닝 테스트용 임시 모드 !!! =====
// 라이트닝만 드랍, max 12개, 즉시 스폰 + 2초 주기. 테스트 끝나면 아래 3 상수와
// pickWeaponByWeight / makeWeaponsState 의 nextSpawnAt 초기값을 원복.
const DEBUG_LIGHTNING_ONLY = true;
export const WEAPON_DROP_INTERVAL = DEBUG_LIGHTNING_ONLY ? 2 : 45;
export const WEAPON_MAX_DROPS = DEBUG_LIGHTNING_ONLY ? 12 : 3;
export const WEAPON_PICKUP_RADIUS = 18;
export const WEAPON_HOLD_DURATION = 30;

const COOLDOWN: Record<WeaponType, number> = {
  garlic:    1.5,
  pistol:    0.4,   // AK(0.15) 보다 느린 단발 권총
  missile:   1.0,
  lightning: 2.5,
};
const COLOR: Record<WeaponType, string> = {
  garlic:    '#d8ff80',
  pistol:    '#5fd06a',  // 초록 권총
  missile:   '#c060ff',
  lightning: '#ffd84a',
};
const SYMBOL: Record<WeaponType, string> = {
  garlic:    '🧄',
  pistol:    '🔫',
  missile:   '✨',
  lightning: '⚡',
};

// ===== 튜닝 =====
const GARLIC_RADIUS = 56;
const PISTOL_SPEED = 600;             // AK(520) 보다 빠른 총알
const PISTOL_LIFE = 0.7;
const MISSILE_SPEED = 280;
const MISSILE_LIFE = 1.6;
const MISSILE_HOMING_TURN_RATE = 6;  // radians/sec — 회전 한계
// 라이트닝 — 차지/방출 시스템 (특수 메커니즘).
const LIGHTNING_LIFE = 0.18;           // 단일 zigzag 라이트닝 비주얼 지속
const LIGHTNING_MAX_CHARGE_SEC = 3.0;  // 풀차지까지 시간
const LIGHTNING_MAX_BOLTS = 10;        // 풀차지 시 최대 번개 개수
const LIGHTNING_MIN_BOLTS = 1;
const LIGHTNING_BOLT_STAGGER = 0.08;   // 번개간 간격
const LIGHTNING_CLOUD_LIFE = 1.2;      // 구름 표시 시간
const LIGHTNING_RANGE_VIEW_PAD = 64;   // 카메라 viewport 밖 좀비도 약간 잡음
// 풀차지 후 자동 발사 전 깜빡임 시퀀스 — 눈이 3회 깜빡 (close/open).
const LIGHTNING_BLINK_PER_SEC = 0.16;  // 한 사이클(closed→open) 시간
const LIGHTNING_BLINK_COUNT = 3;
const LIGHTNING_BLINK_TOTAL = LIGHTNING_BLINK_PER_SEC * LIGHTNING_BLINK_COUNT;

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
  type: 'pistol' | 'missile';
  x: number; y: number;
  vx: number; vy: number;
  bornAt: number;
  angle: number;            // 현재 진행 각도 (homing 갱신용)
}
interface LightningBolt {
  // 메인 폴리라인 (시작 → 끝)
  pts: { x: number; y: number }[];
  // 메인 라인에서 갈라져 나간 가지들 (각 가지도 폴리라인)
  branches: { x: number; y: number }[][];
  bornAt: number;
}
// 번개 타격 위치 임팩트 섬광 — 짧게 확장되는 원
interface LightningImpact {
  x: number;
  y: number;
  bornAt: number;
}
const IMPACT_LIFE = 0.25;
const ORIGIN_FLASH_LIFE = 0.12;
// 차지 발사 시 만들어지는 폭풍 — 구름 + 다발 번개.
interface LightningStorm {
  cloudWorldX: number;       // 카메라 fire 시점 기준 화면 가운데 위쪽
  cloudWorldY: number;
  bornAt: number;
  bolts: {
    triggerAt: number;       // 이 시각 되면 실제 zombie kill + visual 추가
    targetX: number;
    targetY: number;
    fired: boolean;
  }[];
}

export interface WeaponsState {
  drops: Map<string, WeaponDrop>;
  projectiles: Projectile[];
  bolts: LightningBolt[];
  impacts: LightningImpact[];
  storms: LightningStorm[];
  // 보유 무기: 타입 → 만료 시각(sec). now < 만료 면 보유 중.
  owned: Map<WeaponType, number>;
  // 마지막 발사 시각 (쿨다운)
  lastFire: Map<WeaponType, number>;
  nextSpawnAt: number;
  // 라이트닝 차지 시작 시각 (null = 차지 중 아님)
  lightningChargeStartedAt: number | null;
  // 풀차지 도달 시각 (null = 아직 풀차지 아님). 풀차지 이후 깜빡임 시퀀스 진행.
  lightningFullChargedAt: number | null;
}

export function makeWeaponsState(now: number): WeaponsState {
  return {
    drops: new Map(),
    projectiles: [],
    bolts: [],
    impacts: [],
    storms: [],
    owned: new Map(),
    lastFire: new Map(),
    nextSpawnAt: DEBUG_LIGHTNING_ONLY ? now : now + 25, // DEBUG: 즉시 / 평소: 25초 후
    lightningChargeStartedAt: null,
    lightningFullChargedAt: null,
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
  const type = pickWeaponByWeight();
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
      case 'pistol':    firePistol(state, now, local); break;
      case 'missile':   fireMissile(state, now, local, wave); break;
      // lightning 은 차지/방출 — fireOwnedWeapons 에서 처리 안 함 (handleLightningInput)
      case 'lightning': break;
    }
  }
}

// ===== 라이트닝 차지/방출 =====
// game.ts 가 매 프레임 호출. attackHeld edge 감지해서:
//   - false→true (press): 차지 시작
//   - true→false (release): 차지량 비례 번개 storm 생성
//   - 차지 중에도 무기 만료/사망 등 가드
export function handleLightningInput(
  state: WeaponsState,
  now: number,
  attackHeldNow: boolean,
  attackHeldPrev: boolean,
  local: LocalPlayer,
  wave: ZombieWave,
  camera: { x: number; y: number; viewW: number; viewH: number },
): void {
  const isLightning = !local.dead && (state.owned.get('lightning') ?? 0) > now;
  if (!isLightning) {
    state.lightningChargeStartedAt = null;
    state.lightningFullChargedAt = null;
    return;
  }
  // press → 차지 시작
  if (attackHeldNow && !attackHeldPrev) {
    state.lightningChargeStartedAt = now;
    state.lightningFullChargedAt = null;
  }
  // hold → 풀차지 도달 감지
  if (attackHeldNow && state.lightningChargeStartedAt !== null && state.lightningFullChargedAt === null) {
    const frac = (now - state.lightningChargeStartedAt) / LIGHTNING_MAX_CHARGE_SEC;
    if (frac >= 1) state.lightningFullChargedAt = now;
  }
  const origin = lightningOriginFor(local.x, local.y);
  // 풀차지 후 깜빡임 시퀀스 끝 → 자동 발사
  if (state.lightningFullChargedAt !== null && (now - state.lightningFullChargedAt) >= LIGHTNING_BLINK_TOTAL) {
    state.lightningChargeStartedAt = null;
    state.lightningFullChargedAt = null;
    spawnLightningStorm(state, now, 1.0, wave, camera, origin);
    return;
  }
  // release before 풀차지 — 현재 차지량 비례로 발사 (풀차지 직후 release 도 1.0)
  if (!attackHeldNow && attackHeldPrev && state.lightningChargeStartedAt !== null) {
    const chargeFrac = Math.min(1, (now - state.lightningChargeStartedAt) / LIGHTNING_MAX_CHARGE_SEC);
    state.lightningChargeStartedAt = null;
    state.lightningFullChargedAt = null;
    spawnLightningStorm(state, now, chargeFrac, wave, camera, origin);
  }
}

// 라이트닝 차지 진행률 (0..1) — UI 바 렌더용
export function lightningChargeLevel(state: WeaponsState, now: number): number {
  if (state.lightningChargeStartedAt === null) return 0;
  return Math.min(1, (now - state.lightningChargeStartedAt) / LIGHTNING_MAX_CHARGE_SEC);
}

// 차지 중 캐릭터 근처에 그릴 "눈" 상태 — 렌더용
// frame: 0..2 (eyes.png 의 프레임 인덱스), alpha: 0..1
export function lightningEyesVisual(state: WeaponsState, now: number): { frame: number; alpha: number } | null {
  if (state.lightningChargeStartedAt === null) return null;
  if (state.lightningFullChargedAt !== null) {
    // 풀차지 — 100% 불투명 + 프레임 2 고정 + 깜빡임 (closed=프레임0, open=프레임2)
    const t = now - state.lightningFullChargedAt;
    const cyc = t / LIGHTNING_BLINK_PER_SEC;        // 사이클 진행
    // 한 사이클 전반 = closed (frame 0), 후반 = open (frame 2)
    const inCycle = cyc - Math.floor(cyc);
    const frame = inCycle < 0.5 ? 0 : 2;
    return { frame, alpha: 1.0 };
  }
  // 차지 중 — alpha 50%, 프레임은 차지 진행률에 따라 0→2
  const frac = Math.min(1, (now - state.lightningChargeStartedAt) / LIGHTNING_MAX_CHARGE_SEC);
  const frame = Math.min(2, Math.floor(frac * 3));
  return { frame, alpha: 0.5 };
}

// 번개 origin = 눈 위치 (캐릭터 머리 위쪽 고정 오프셋). 발사 시점의 local 좌표 사용.
const LIGHTNING_ORIGIN_OFFSET_Y = -60; // local.y(발) 에서 위쪽으로

function spawnLightningStorm(
  state: WeaponsState, now: number, chargeFrac: number, wave: ZombieWave,
  camera: { x: number; y: number; viewW: number; viewH: number },
  origin?: { x: number; y: number },
): void {
  const boltCount = Math.max(
    LIGHTNING_MIN_BOLTS,
    Math.round(LIGHTNING_MIN_BOLTS + chargeFrac * (LIGHTNING_MAX_BOLTS - LIGHTNING_MIN_BOLTS)),
  );
  // viewport 안 좀비 후보 — 카메라 박스 + pad
  const minX = camera.x - LIGHTNING_RANGE_VIEW_PAD;
  const maxX = camera.x + camera.viewW + LIGHTNING_RANGE_VIEW_PAD;
  const minY = camera.y - LIGHTNING_RANGE_VIEW_PAD;
  const maxY = camera.y + camera.viewH + LIGHTNING_RANGE_VIEW_PAD;
  const candidates = wave.zombies.filter(
    (z) => z.x >= minX && z.x <= maxX && z.y >= minY && z.y <= maxY,
  );
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const picks = candidates.slice(0, boltCount);

  const ox = origin?.x ?? camera.x + camera.viewW / 2;
  const oy = origin?.y ?? camera.y + 28;
  const storm: LightningStorm = {
    cloudWorldX: ox,
    cloudWorldY: oy,
    bornAt: now,
    bolts: [],
  };
  for (let i = 0; i < picks.length; i++) {
    storm.bolts.push({
      triggerAt: now + i * LIGHTNING_BOLT_STAGGER,
      targetX: picks[i].x,
      targetY: picks[i].y,
      fired: false,
    });
  }
  for (let i = picks.length; i < boltCount; i++) {
    storm.bolts.push({
      triggerAt: now + i * LIGHTNING_BOLT_STAGGER,
      targetX: camera.x + Math.random() * camera.viewW,
      targetY: camera.y + Math.random() * camera.viewH,
      fired: false,
    });
  }
  state.storms.push(storm);
}

// origin offset 헬퍼 — 게임 루프가 spawn 직전 local 위치 기반으로 호출
export function lightningOriginFor(localX: number, localY: number): { x: number; y: number } {
  return { x: localX, y: localY + LIGHTNING_ORIGIN_OFFSET_Y };
}

// 매 프레임 storm 진행 — trigger 도달한 bolt 는 실제 좀비 죽이고 시각 효과 추가.
function stepStorms(state: WeaponsState, now: number, wave: ZombieWave): void {
  // 만료 제거
  state.storms = state.storms.filter((s) => now - s.bornAt < LIGHTNING_CLOUD_LIFE);
  for (const s of state.storms) {
    for (const b of s.bolts) {
      if (b.fired) continue;
      if (now < b.triggerAt) continue;
      b.fired = true;
      // 가장 가까운 좀비 죽임 (target 위치 기준 반경 22)
      const zid = bulletHitsZombie(wave, b.targetX, b.targetY);
      if (zid) killZombieById(wave, zid);
      // 시각 — 구름→타깃 zigzag (가지치기 + 임팩트 섬광 동반)
      const pts = buildZigzag(s.cloudWorldX, s.cloudWorldY, b.targetX, b.targetY, 5, 22);
      const branches = generateBranches(pts);
      state.bolts.push({ pts, branches, bornAt: now });
      state.impacts.push({ x: b.targetX, y: b.targetY, bornAt: now });
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

function firePistol(state: WeaponsState, now: number, local: LocalPlayer): void {
  // 단발 직선 — 캐릭터 진행 방향, AK 보다 느린 발사 빈도 + 빠른 총알.
  const a = dirAngle(local);
  const cx = local.x;
  const cy = local.y + BODY_OFF_Y;
  state.projectiles.push({
    pid: randomId(), type: 'pistol',
    x: cx, y: cy,
    vx: Math.cos(a) * PISTOL_SPEED,
    vy: Math.sin(a) * PISTOL_SPEED,
    bornAt: now,
    angle: a,
  });
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

// 구버전 자동 체인 라이트닝 제거 — 차지/방출 방식으로 대체 (spawnLightningStorm).

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

// ===== 헬퍼: 지그재그 폴리라인 + 가지치기 =====
type Pt = { x: number; y: number };
function buildZigzag(ax: number, ay: number, bx: number, by: number, segs: number, jitter: number): Pt[] {
  const pts: Pt[] = [{ x: ax, y: ay }];
  const dx = bx - ax;
  const dy = by - ay;
  // 진행 방향 수직 단위 (jitter 적용 축)
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const j = (Math.random() - 0.5) * 2 * jitter;
    pts.push({ x: ax + dx * t + nx * j, y: ay + dy * t + ny * j });
  }
  pts.push({ x: bx, y: by });
  return pts;
}
function generateBranches(mainPts: Pt[]): Pt[][] {
  const branches: Pt[][] = [];
  // 각 중간 노드에서 40% 확률로 가지 1개 분기
  for (let i = 1; i < mainPts.length - 1; i++) {
    if (Math.random() > 0.4) continue;
    const start = mainPts[i];
    const prev = mainPts[i - 1];
    const dx = start.x - prev.x;
    const dy = start.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    // 수직 방향 ± 랜덤
    const sign = Math.random() < 0.5 ? -1 : 1;
    const px = (-dy / len) * sign;
    const py = (dx / len) * sign;
    const branchLen = 14 + Math.random() * 22;
    const subSegs = 2 + Math.floor(Math.random() * 2); // 2~3
    const branch: Pt[] = [{ x: start.x, y: start.y }];
    let cx = start.x, cy = start.y;
    for (let k = 1; k <= subSegs; k++) {
      cx += (px * branchLen / subSegs) + (Math.random() - 0.5) * 6;
      cy += (py * branchLen / subSegs) + (Math.random() - 0.5) * 6;
      branch.push({ x: cx, y: cy });
    }
    branches.push(branch);
  }
  return branches;
}

// ===== 매 프레임 — 발사체 위치 갱신 + 좀비 충돌 + 만료 =====
export function stepProjectiles(state: WeaponsState, dt: number, now: number, wave: ZombieWave): void {
  // 라이트닝 비주얼 만료
  state.bolts = state.bolts.filter((b) => now - b.bornAt <= LIGHTNING_LIFE);
  state.impacts = state.impacts.filter((i) => now - i.bornAt <= IMPACT_LIFE);
  // 라이트닝 폭풍 — 구름 + 다발 번개
  stepStorms(state, now, wave);
  // 발사체
  state.projectiles = state.projectiles.filter((p) => {
    const life = p.type === 'pistol' ? PISTOL_LIFE : MISSILE_LIFE;
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
  // 절차적 구름 제거 — 라이트닝 원점은 차지 중 그려진 "눈" 위치.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 폴리라인을 현재 alpha 로 한 번 그리는 헬퍼 (반복 호출 위해 분리)
  const strokePoly = (pts: Pt[], color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const sx = Math.round(p.x - camera.x);
      const sy = Math.round(p.y - camera.y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  };

  // ----- 라이트닝 bolt (메인 + 가지) -----
  for (const b of state.bolts) {
    const age = (now - b.bornAt) / LIGHTNING_LIFE;
    const alpha = Math.max(0, 1 - age);
    // 4-layer: outer glow (very wide, faint) → soft mid → bright yellow → white core
    strokePoly(b.pts, `rgba(180, 120, 255, ${alpha * 0.18})`, 12);   // 보라 글로우
    strokePoly(b.pts, `rgba(255, 230, 140, ${alpha * 0.35})`, 7);    // 노란 글로우
    strokePoly(b.pts, `rgba(255, 240, 120, ${alpha})`, 3.5);          // 옐로 본체
    strokePoly(b.pts, `rgba(255, 255, 255, ${alpha})`, 1.4);          // 흰 코어
    // 가지 — 얇고 빠르게 페이드
    const branchAlpha = alpha * 0.7;
    for (const br of b.branches) {
      strokePoly(br, `rgba(255, 230, 140, ${branchAlpha * 0.35})`, 5);
      strokePoly(br, `rgba(255, 240, 120, ${branchAlpha})`, 2);
      strokePoly(br, `rgba(255, 255, 255, ${branchAlpha})`, 0.9);
    }
    // 원점 섬광 — bolt 첫 점에서 짧게 (눈 위치 근처)
    if (b.pts.length > 0 && age < ORIGIN_FLASH_LIFE / LIGHTNING_LIFE) {
      const flashAlpha = 1 - (age * LIGHTNING_LIFE / ORIGIN_FLASH_LIFE);
      const o = b.pts[0];
      const ox = Math.round(o.x - camera.x);
      const oy = Math.round(o.y - camera.y);
      ctx.fillStyle = `rgba(255, 255, 220, ${flashAlpha * 0.85})`;
      ctx.beginPath(); ctx.arc(ox, oy, 8 + flashAlpha * 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
      ctx.beginPath(); ctx.arc(ox, oy, 3 + flashAlpha * 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ----- 임팩트 섬광 (타격 위치에서 확장되는 원) -----
  for (const im of state.impacts) {
    const age = (now - im.bornAt) / IMPACT_LIFE;
    if (age < 0 || age > 1) continue;
    const sx = Math.round(im.x - camera.x);
    const sy = Math.round(im.y - camera.y);
    const fade = 1 - age;
    // 확장 ring
    const r1 = 6 + age * 30;
    ctx.strokeStyle = `rgba(255, 230, 120, ${fade * 0.7})`;
    ctx.lineWidth = 2.5 * fade + 0.5;
    ctx.beginPath(); ctx.arc(sx, sy, r1, 0, Math.PI * 2); ctx.stroke();
    // 내부 white burst (작아짐)
    const r2 = 12 * fade;
    ctx.fillStyle = `rgba(255, 255, 220, ${fade * 0.55})`;
    ctx.beginPath(); ctx.arc(sx, sy, r2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${fade})`;
    ctx.beginPath(); ctx.arc(sx, sy, r2 * 0.45, 0, Math.PI * 2); ctx.fill();
    // 짧은 파편 8방향 라인
    if (age < 0.45) {
      const spokeAlpha = 1 - age / 0.45;
      ctx.strokeStyle = `rgba(255, 240, 160, ${spokeAlpha * 0.8})`;
      ctx.lineWidth = 1.2;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const r0 = 4 + age * 18;
        const r3 = 10 + age * 26;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * r0, sy + Math.sin(a) * r0);
        ctx.lineTo(sx + Math.cos(a) * r3, sy + Math.sin(a) * r3);
        ctx.stroke();
      }
    }
  }
  // 발사체
  for (const p of state.projectiles) {
    const sx = Math.round(p.x - camera.x);
    const sy = Math.round(p.y - camera.y);
    if (p.type === 'pistol') {
      // 초록 총알 + 잔상 (AK 노란 총알과 구분)
      const tailLen = 10;
      const norm = Math.hypot(p.vx, p.vy) || 1;
      const tx = sx - (p.vx / norm) * tailLen;
      const ty = sy - (p.vy / norm) * tailLen;
      ctx.strokeStyle = 'rgba(95, 208, 106, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(sx, sy); ctx.stroke();
      ctx.fillStyle = '#c8ffd0';
      ctx.fillRect(sx - 2, sy - 2, 4, 4);
      ctx.fillStyle = '#5fd06a';
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
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

// ===== AK 스프라이트 (머리 위 아이콘 + 드랍에 재사용) =====
const akImg = new Image();
let akReady = false;
akImg.src = '/sprites/items/ak47.png';
akImg.onload = () => { akReady = true; };

// ===== 라이트닝 차지 시각 — eyes 스프라이트 (96×32, 3프레임 32×32) =====
const EYES_FRAME = 32;
const EYES_SCALE = 1.5;   // 32 → 48 px 로 살짝 키워서 잘 보이게
const eyesImg = new Image();
let eyesReady = false;
eyesImg.src = '/sprites/effects/eyes.png';
eyesImg.onload = () => { eyesReady = true; };

// 캐릭터 근처(머리 위쪽)에 차지 중인 눈을 그림.
// renderer 가 game loop 에서 lightningEyesVisual() 결과 받아 호출.
export function drawLightningEyes(
  ctx: CanvasRenderingContext2D, camera: Camera,
  ownerX: number, ownerY: number, charH: number,
  visual: { frame: number; alpha: number },
): void {
  if (!eyesReady) return;
  const dst = Math.round(EYES_FRAME * EYES_SCALE);
  const sx = Math.round(ownerX - camera.x - dst / 2);
  // 머리 위 (charH 만큼 올라가서 + 무기 아이콘 살짝 위)
  const sy = Math.round(ownerY - camera.y - charH - 60);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, visual.alpha));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    eyesImg,
    visual.frame * EYES_FRAME, 0, EYES_FRAME, EYES_FRAME,
    sx, sy, dst, dst,
  );
  ctx.restore();
}

// ===== 캐릭터 머리 위 보유 무기 아이콘 =====
// 황금 테두리 원 안에 무기 표시 — AK 는 실제 sprite, 나머지는 색점+심볼.
type IconItem =
  | { kind: 'ak' }
  | { kind: 'weapon'; type: WeaponType };

export function drawOwnedIcons(
  ctx: CanvasRenderingContext2D, camera: Camera,
  ownerX: number, ownerY: number, charH: number,
  weapons: WeaponType[], hasGun: boolean,
  chargeLevel: number = 0,  // 0..1, 라이트닝 차지 중일 때만 0보다 큼
): void {
  const items: IconItem[] = [];
  if (hasGun) items.push({ kind: 'ak' });
  for (const w of weapons) items.push({ kind: 'weapon', type: w });
  if (items.length === 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.font = '700 14px "Apple SD Gothic Neo", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ICON_R = 15;                       // 9 → 15 로 키움 (한 번에 한 무기라 시인성 우선)
  const GAP = 4;
  const total = items.length * (ICON_R * 2) + (items.length - 1) * GAP;
  const startX = Math.round(ownerX - camera.x - total / 2 + ICON_R);
  const y = Math.round(ownerY - camera.y - charH - 22);
  for (let i = 0; i < items.length; i++) {
    const sx = startX + i * (ICON_R * 2 + GAP);
    // 황금 테두리 + 어둑한 안쪽
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.arc(sx, y, ICON_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const it = items[i];
    if (it.kind === 'ak') {
      if (akReady) {
        // AK 비율 유지하면서 원 안에 꽉 차게 — 가로 우선 fit
        const maxW = ICON_R * 2 - 4;
        const maxH = ICON_R * 2 - 4;
        const aspect = akImg.width / akImg.height;
        let w = maxW;
        let h = w / aspect;
        if (h > maxH) { h = maxH; w = h * aspect; }
        ctx.drawImage(akImg, sx - w / 2, y - h / 2, w, h);
      } else {
        ctx.fillStyle = '#aaa';
        ctx.beginPath(); ctx.arc(sx, y, 5, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      // 색점 + 이모지 심볼
      ctx.fillStyle = COLOR[it.type];
      ctx.beginPath(); ctx.arc(sx, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a0e08';
      ctx.fillText(SYMBOL[it.type], sx, y + 1);
    }
  }
  // 라이트닝 차지 바 — 캐릭터 머리(charH 위쪽) 와 무기 아이콘 사이 중앙
  if (chargeLevel > 0) {
    const headTopY = Math.round(ownerY - camera.y - charH);
    const iconBottomY = y + ICON_R + 1;
    const barCx = Math.round(ownerX - camera.x);
    const barCy = Math.round((headTopY + iconBottomY) / 2);
    const barW = 32;
    const barH = 5;
    const bx = barCx - barW / 2;
    const by = barCy - barH / 2;
    // 외곽
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = 'rgba(60,60,60,0.95)';
    ctx.fillRect(bx, by, barW, barH);
    // 채움 (노란-주황 그라데이션 느낌)
    const fillW = Math.round(barW * chargeLevel);
    // 풀차지면 흰빛 펄스
    const fullPulse = chargeLevel >= 1 ? (Math.sin(performance.now() / 80) + 1) / 2 : 0;
    ctx.fillStyle = chargeLevel >= 1
      ? `rgba(${255}, ${255}, ${180 + fullPulse * 75}, 1)`
      : '#ffd84a';
    ctx.fillRect(bx, by, fillW, barH);
  }
  ctx.restore();
}
