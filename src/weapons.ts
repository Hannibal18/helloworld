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
import { play as playSfx, type SfxHandle } from './sfx';
import { killZombieById, type ZombieWave } from './zombie';
import {
  CFG_WEAPON_TYPES,
  getStageChargedCount,
  getStageWeaponsCurrent,
} from './config';

export type WeaponType = 'lightning' | 'ice' | 'curse';
export const WEAPON_TYPES: readonly WeaponType[] = ['lightning', 'ice', 'curse'];

// 스테이지 weapons 설정 / 헬퍼들은 config.ts 에서 노출 (순환 import 회피).
// 이 모듈은 그것들을 그대로 사용 + 내부 약식 alias 만 둠.
const stageChargedCount = getStageChargedCount;

// ===== 드랍 가중치 (rarity tier) =====
// 액션 로그라이크 표준 패턴 — 약한 무기는 자주, 강한 무기는 드물게.
// 단순 가중 랜덤 (weighted random) — 폴백용. 평소엔 스테이지 설정이 우선.
//   lightning  체인, 멀티 타깃
//   ice        차지/방출 AOE 결빙(킬)
//   curse      차지/방출 다중 즉사
const DROP_WEIGHTS: Record<WeaponType, number> = {
  lightning: 1,
  ice:       1,
  curse:     1,
};
function pickWeaponByWeight(): WeaponType {
  if (DEBUG_LIGHTNING_ONLY) return 'lightning';
  // 스테이지 설정 우선 — allowed=false 인 무기는 제외, dropWeights 로 가중.
  const sw = getStageWeaponsCurrent();
  if (sw) {
    let total = 0;
    for (const w of CFG_WEAPON_TYPES) {
      if (!sw.allowed[w]) continue;
      total += Math.max(0, sw.dropWeights[w] ?? 0);
    }
    if (total > 0) {
      let r = Math.random() * total;
      for (const w of CFG_WEAPON_TYPES) {
        if (!sw.allowed[w]) continue;
        const wt = Math.max(0, sw.dropWeights[w] ?? 0);
        if ((r -= wt) < 0) return w as WeaponType;
      }
    }
  }
  // 폴백: 모듈 기본 가중치
  const total2 = WEAPON_TYPES.reduce((s, t) => s + DROP_WEIGHTS[t], 0);
  let r = Math.random() * total2;
  for (const t of WEAPON_TYPES) {
    r -= DROP_WEIGHTS[t];
    if (r < 0) return t;
  }
  return WEAPON_TYPES[0];
}

// ===== !!! DEBUG: 라이트닝 테스트용 임시 모드 !!! =====
// 라이트닝만 드랍, max 12개, 즉시 스폰 + 2초 주기. 테스트 끝나면 아래 3 상수와
// pickWeaponByWeight / makeWeaponsState 의 nextSpawnAt 초기값을 원복.
const DEBUG_LIGHTNING_ONLY = false;
export const WEAPON_DROP_INTERVAL = DEBUG_LIGHTNING_ONLY ? 2 : 45;
export const WEAPON_MAX_DROPS = DEBUG_LIGHTNING_ONLY ? 12 : 3;
export const WEAPON_PICKUP_RADIUS = 18;
export const WEAPON_HOLD_DURATION = 30;

const COLOR: Record<WeaponType, string> = {
  lightning: '#ffd84a',
  ice:       '#88e0ff',
  curse:     '#222',
};
const SYMBOL: Record<WeaponType, string> = {
  lightning: '⚡',
  ice:       '❄',
  curse:     '💀',
};

// ===== 튜닝 =====
// 라이트닝 — 차지/방출 시스템 (특수 메커니즘).
const LIGHTNING_LIFE = 0.18;           // 단일 zigzag 라이트닝 비주얼 지속
const LIGHTNING_MAX_CHARGE_SEC = 3.0;  // 풀차지까지 시간
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
  bornAt: number;
  bolts: {
    triggerAt: number;       // 이 시각 되면 실제 zombie kill + visual 추가
    originX: number;         // 발사 origin (구름 위치) — 슬롯마다 다름
    originY: number;
    targetX: number;
    targetY: number;
    fired: boolean;
  }[];
}

export interface WeaponsState {
  drops: Map<string, WeaponDrop>;
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
  // 차지 시작 시 1회 생성하는 7개 구름의 플레이어 상대 좌표 (rx, ry).
  lightningCloudOffsets: { rx: number; ry: number }[];
  // 차지형 애니메이션 캐스트 (ice, curse 각각). 라이트닝과 같은 흐름이지만
  // 비주얼은 스프라이트 시트 애니메이션, 효과는 마커 위치별 nearest-zombie 즉사.
  ice: AnimCastState;
  curse: AnimCastState;
}

export function makeWeaponsState(now: number): WeaponsState {
  return {
    drops: new Map(),
    bolts: [],
    impacts: [],
    storms: [],
    owned: new Map(),
    lastFire: new Map(),
    nextSpawnAt: DEBUG_LIGHTNING_ONLY ? now : now + 25, // DEBUG: 즉시 / 평소: 25초 후
    lightningChargeStartedAt: null,
    lightningFullChargedAt: null,
    lightningCloudOffsets: [],
    ice: makeAnimCastState(),
    curse: makeAnimCastState(),
  };
}

// ===== 호스트만 — 새 드랍 스폰 =====
export function maybeSpawn(
  state: WeaponsState, now: number, map: TileMap, isHost: boolean,
  emit: (drop: WeaponDrop) => void,
): void {
  if (!isHost) return;
  if (now < state.nextSpawnAt) return;
  const sw = getStageWeaponsCurrent();
  state.nextSpawnAt = now + (sw?.dropIntervalSec ?? WEAPON_DROP_INTERVAL);
  if (state.drops.size >= (sw?.maxDropsOnGround ?? WEAPON_MAX_DROPS)) return;
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
// 보유 무기 만료 처리 (모든 무기가 차지/방출 방식이라 자동 발사는 없음).
// _local / _wave / _fired 는 시그니처 유지를 위해 남겨둠 — 새 무기 추가 대비.
export function fireOwnedWeapons(
  state: WeaponsState, now: number, _local: LocalPlayer, _wave: ZombieWave, _fired: (type: WeaponType) => void,
): void {
  for (const [type, expireAt] of Array.from(state.owned.entries())) {
    if (now >= expireAt) { state.owned.delete(type); state.lastFire.delete(type); }
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
  // press → 차지 시작 (구름 위치 새로 뽑음)
  if (attackHeldNow && !attackHeldPrev) {
    state.lightningChargeStartedAt = now;
    state.lightningFullChargedAt = null;
    generateCloudOffsets(state);
  }
  // hold → 풀차지 도달 감지
  if (attackHeldNow && state.lightningChargeStartedAt !== null && state.lightningFullChargedAt === null) {
    const frac = (now - state.lightningChargeStartedAt) / LIGHTNING_MAX_CHARGE_SEC;
    if (frac >= 1) state.lightningFullChargedAt = now;
  }
  // 풀차지 후 깜빡임 시퀀스 끝 → 자동 발사 (모든 7 구름).
  // 손가락 떼지 않았으면 즉시 새 차지 시작 → 자동 반복 (차지~번개~차지~번개).
  if (state.lightningFullChargedAt !== null && (now - state.lightningFullChargedAt) >= LIGHTNING_BLINK_TOTAL) {
    spawnLightningStorm(state, now, 1.0, wave, camera, local.x, local.y);
    if (attackHeldNow) {
      state.lightningChargeStartedAt = now;
      state.lightningFullChargedAt = null;
      generateCloudOffsets(state);
    } else {
      state.lightningChargeStartedAt = null;
      state.lightningFullChargedAt = null;
    }
    return;
  }
  // 풀차지 안된 상태에서 손 떼면 — 발사 없이 차지 취소.
  // (정책: 라이트닝/얼음/저주는 풀차지 이후에만 발사.)
  if (!attackHeldNow && attackHeldPrev && state.lightningChargeStartedAt !== null) {
    state.lightningChargeStartedAt = null;
    state.lightningFullChargedAt = null;
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
  // 차지 중 — 0.3초 동안 0→0.5 fade-in, 이후 0.5 유지. 프레임은 차지 진행률에 따라 0→2.
  const elapsed = now - state.lightningChargeStartedAt;
  const frac = Math.min(1, elapsed / LIGHTNING_MAX_CHARGE_SEC);
  const frame = Math.min(2, Math.floor(frac * 3));
  const fadeIn = Math.min(1, elapsed / 0.3);
  return { frame, alpha: 0.5 * fadeIn };
}

// 구름 N개 위치에서 각각 1발씩 번개 발사. N = 현재 스테이지의 chargedReleaseCount.
// (이 함수는 풀차지 도달 시에만 호출됨 — chargeFrac 인자는 시그니처 유지용으로 무시.)
function spawnLightningStorm(
  state: WeaponsState, now: number, _chargeFrac: number, wave: ZombieWave,
  camera: { x: number; y: number; viewW: number; viewH: number },
  localX: number, localY: number,
): void {
  const cloudCount = lightningCloudCount();
  // viewport 안 좀비 후보
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
  const storm: LightningStorm = { bornAt: now, bolts: [] };
  for (let i = 0; i < cloudCount; i++) {
    const origin = cloudSlotPos(state, localX, localY, i);
    const target = candidates[i] ?? {
      x: camera.x + Math.random() * camera.viewW,
      y: camera.y + Math.random() * camera.viewH,
    };
    storm.bolts.push({
      triggerAt: now + i * LIGHTNING_BOLT_STAGGER,
      originX: origin.x, originY: origin.y,
      targetX: target.x, targetY: target.y,
      fired: false,
    });
  }
  state.storms.push(storm);
}

// 매 프레임 storm 진행 — trigger 도달한 bolt 는 실제 좀비 죽이고 시각 효과 추가.
// fire 시점 zombie 탐색 반경 — bullet 충돌(18px) 보다 훨씬 넓게.
// 이유: spawn ~ fire 사이 stagger 동안 좀비가 이동 + 원래 후보가 부족했던 슬롯도
// fire 시점에 새로 찾아질 수 있게.
const LIGHTNING_FIRE_SEEK_RADIUS = 60;

function findNearestZombieIn(wave: ZombieWave, x: number, y: number, radius: number, exclude: Set<string>) {
  if (!wave.active) return null;
  const r2 = radius * radius;
  let best: { id: string; x: number; y: number } | null = null;
  let bestD2 = r2;
  for (const z of wave.zombies) {
    if (exclude.has(z.id)) continue;
    const dx = z.x - x;
    const dy = z.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = { id: z.id, x: z.x, y: z.y }; }
  }
  return best;
}

function stepStorms(state: WeaponsState, now: number, wave: ZombieWave): void {
  // 만료 제거
  state.storms = state.storms.filter((s) => now - s.bornAt < LIGHTNING_CLOUD_LIFE);
  for (const s of state.storms) {
    // 같은 storm 안에서 이미 죽인 좀비 중복 제외 (다른 bolt 가 또 잡지 않게)
    const claimed = new Set<string>();
    for (const b of s.bolts) {
      if (b.fired) continue;
      if (now < b.triggerAt) continue;
      b.fired = true;
      // 1순위: 저장된 target 좌표 근처 (stagger 사이 이동 보정용 60px)
      let hit = findNearestZombieIn(wave, b.targetX, b.targetY, LIGHTNING_FIRE_SEEK_RADIUS, claimed);
      // 2순위: 못 찾으면 구름 origin 근처에서 전 viewport 범위로 다시 — 빈 슬롯도 명중 기회
      if (!hit) {
        hit = findNearestZombieIn(wave, b.originX, b.originY, LIGHTNING_RANGE_VIEW_PAD * 4, claimed);
      }
      let tx = b.targetX, ty = b.targetY;
      if (hit) {
        killZombieById(wave, hit.id);
        claimed.add(hit.id);
        // 시각도 실제 hit 위치로 갱신 — 좀비에게 정확히 꽂히는 그림
        tx = hit.x; ty = hit.y;
      }
      const pts = buildZigzag(b.originX, b.originY, tx, ty, 5, 22);
      const branches = generateBranches(pts);
      state.bolts.push({ pts, branches, bornAt: now });
      state.impacts.push({ x: tx, y: ty, bornAt: now });
      // 효과음 — bolt 한 발당 한 번. 변형 4종 중 랜덤.
      playSfx('lightning_bolt');
    }
  }
}

// 구버전 자동 체인 라이트닝 제거 — 차지/방출 방식으로 대체 (spawnLightningStorm).

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

// ===== 매 프레임 — 라이트닝/얼음/저주 비주얼 진행 =====
// (dt 미사용 — 차지/방출 인프라가 시각 자체적으로 시간 관리)
export function stepProjectiles(state: WeaponsState, _dt: number, now: number, wave: ZombieWave): void {
  // 라이트닝 비주얼 만료
  state.bolts = state.bolts.filter((b) => now - b.bornAt <= LIGHTNING_LIFE);
  state.impacts = state.impacts.filter((i) => now - i.bornAt <= IMPACT_LIFE);
  // 라이트닝 폭풍 — 구름 + 다발 번개
  stepStorms(state, now, wave);
  // 차지형 애니메이션 캐스트(ice, curse) — 위치별 triggerAt 발화 + 만료 제거
  stepAnimCastEffects(state, now, wave);
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
  ctx.restore();
}

// ===== AK 스프라이트 (머리 위 아이콘 + 드랍에 재사용) =====
const akImg = new Image();
let akReady = false;
akImg.src = '/sprites/items/ak47.png';
akImg.onload = () => { akReady = true; };

// ===== 라이트닝 차지 시각 — eyes 스프라이트 (96×32, 3프레임 32×32) =====
const EYES_FRAME = 32;
const EYES_SCALE = 1.3;
const eyesImg = new Image();
let eyesReady = false;
eyesImg.src = '/sprites/effects/eyes.png';
eyesImg.onload = () => { eyesReady = true; };
eyesImg.onerror = (e) => { console.error('[weapons] eyes.png load failed', e); };

// ===== 멀티 구름 — 차지 진행도에 따라 N개 구름이 플레이어 주변에 분산 =====
// 캡 = MAX_CLOUDS (상수). 실제 사용 갯수는 스테이지 chargedReleaseCount 가 결정.
const LIGHTNING_MAX_CLOUDS = 12;
const CLOUD_MIN_RADIUS = 70;     // 플레이어 중심에서 최소 거리 (캐릭터 안 가리게)
const CLOUD_MAX_RADIUS = 150;    // 최대 거리
const CLOUD_VERTICAL_SQUASH = 0.6; // 세로로 약간 납작 (위쪽이 더 많이 분포)
const CLOUD_Y_BIAS = -20;        // 평균 y 보정 (캐릭터 발 기준)
const CLOUD_MIN_PAIR_DIST = 56;  // 구름끼리 최소 간격 (밀집 방지)

// 현재 스테이지 기준 구름 갯수 (1..MAX_CLOUDS).
function lightningCloudCount(): number {
  return stageChargedCount(LIGHTNING_MAX_CLOUDS);
}

// 차지 시작 시 N개 구름의 상대 좌표(rx, ry) 를 한 번 뽑음. rejection sampling 으로
// 너무 밀집하지 않게. 플레이어를 따라 움직이도록 상대 좌표 유지.
function generateCloudOffsets(state: WeaponsState): void {
  const n = lightningCloudCount();
  const offsets: { rx: number; ry: number }[] = [];
  let safety = 0;
  while (offsets.length < n && safety++ < 200) {
    const angle = Math.random() * Math.PI * 2;
    const radius = CLOUD_MIN_RADIUS + Math.random() * (CLOUD_MAX_RADIUS - CLOUD_MIN_RADIUS);
    const rx = Math.cos(angle) * radius;
    const ry = Math.sin(angle) * radius * CLOUD_VERTICAL_SQUASH + CLOUD_Y_BIAS;
    // 다른 구름과 너무 가까우면 reject
    const tooClose = offsets.some(
      (o) => (o.rx - rx) ** 2 + (o.ry - ry) ** 2 < CLOUD_MIN_PAIR_DIST * CLOUD_MIN_PAIR_DIST,
    );
    if (tooClose) continue;
    offsets.push({ rx, ry });
  }
  // 안 채워졌으면 빈 자리는 그냥 랜덤
  while (offsets.length < n) {
    const angle = Math.random() * Math.PI * 2;
    const radius = CLOUD_MIN_RADIUS + Math.random() * (CLOUD_MAX_RADIUS - CLOUD_MIN_RADIUS);
    offsets.push({
      rx: Math.cos(angle) * radius,
      ry: Math.sin(angle) * radius * CLOUD_VERTICAL_SQUASH + CLOUD_Y_BIAS,
    });
  }
  state.lightningCloudOffsets = offsets;
}

// 슬롯 i 의 월드 좌표 = 플레이어 위치 + 상대 오프셋. 오프셋은 charge start 시점에 픽스.
function cloudSlotPos(state: WeaponsState, localX: number, localY: number, i: number): { x: number; y: number } {
  const off = state.lightningCloudOffsets[i] ?? { rx: 0, ry: -40 };
  return { x: localX + off.rx, y: localY + off.ry };
}

// 슬롯 i 의 현재 시각 상태 (보일지/투명도/프레임). null = 아직 등장 안 함.
function cloudSlotVisual(
  state: WeaponsState, now: number, i: number,
): { frame: number; alpha: number } | null {
  if (state.lightningChargeStartedAt === null) return null;
  // 슬롯 i 는 chargeFrac = i / N 에 도달했을 때 등장 (N = 현재 스테이지 구름 수)
  const n = lightningCloudCount();
  const appearChargeFrac = n > 0 ? (i + 1) / n : 1;
  const appearAt = state.lightningChargeStartedAt + appearChargeFrac * LIGHTNING_MAX_CHARGE_SEC;
  if (now < appearAt) return null;
  // 풀차지 → 동기 깜빡임 (모든 슬롯 동일 프레임)
  if (state.lightningFullChargedAt !== null) {
    const t = now - state.lightningFullChargedAt;
    const cyc = t / LIGHTNING_BLINK_PER_SEC;
    const inCycle = cyc - Math.floor(cyc);
    const frame = inCycle < 0.5 ? 0 : 2;
    return { frame, alpha: 1.0 };
  }
  // 차지 중 — alpha 0→0.5 fade in (0.3s), frame 2 고정
  const localElapsed = now - appearAt;
  const fadeIn = Math.min(1, localElapsed / 0.3);
  return { frame: 2, alpha: 0.5 * fadeIn };
}

// 게임 루프가 호출 — 현재 보이는 모든 구름 렌더.
export function drawLightningClouds(
  ctx: CanvasRenderingContext2D, camera: Camera,
  state: WeaponsState, now: number,
  localX: number, localY: number,
): void {
  if (state.lightningChargeStartedAt === null) return;
  const dst = Math.round(EYES_FRAME * EYES_SCALE);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const n = lightningCloudCount();
  for (let i = 0; i < n; i++) {
    const vis = cloudSlotVisual(state, now, i);
    if (!vis) continue;
    const pos = cloudSlotPos(state, localX, localY, i);
    const sx = Math.round(pos.x - camera.x - dst / 2);
    const sy = Math.round(pos.y - camera.y - dst / 2);
    ctx.globalAlpha = Math.max(0, Math.min(1, vis.alpha));
    if (eyesReady) {
      ctx.drawImage(
        eyesImg,
        vis.frame * EYES_FRAME, 0, EYES_FRAME, EYES_FRAME,
        sx, sy, dst, dst,
      );
    } else {
      // 폴백 — 보라 원 + 흰 글자 (이미지 미로딩 즉시 진단)
      ctx.fillStyle = '#c060ff';
      ctx.beginPath(); ctx.arc(sx + dst / 2, sy + dst / 2, dst / 2 - 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', sx + dst / 2, sy + dst / 2);
    }
  }
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

// ===== 차지형 애니메이션 캐스트 (ice, curse 공용 인프라) =====
// 라이트닝과 같은 press→charge→full→cast 사이클. 차이점:
//   - 비주얼은 32×32 스프라이트 시트(전체 N프레임)를 마커마다 재생
//   - 차지 중: frame 0 마커가 플레이어 주변 위치에 차례로 등장 (라이트닝 구름과 동일 분포)
//   - 풀차지 → 짧은 깜빡임 → 캐스트: 마커 위치에서 애니메이션 풀 재생 + 그 위치 nearest 좀비 즉사
//   - 손가락 떼지 않으면 라이트닝처럼 즉시 새 차지 시작

interface AnimCastConfig {
  spriteSrc: string;
  frameCount: number;
  frameSize: number;        // 시트의 단일 프레임 크기 (정사각형 가정)
  frameDurMs: number;       // 캐스트 시 각 프레임 표시 시간
  maxChargeSec: number;
  blinkPerSec: number;
  blinkCount: number;
  // 옵션 SFX — 정의되면 sfx.ts 의 키로 재생.
  sfxChargeKey?: string;    // press 시 1회
  sfxHitKey?: string;       // 폭발 시 — staggerSec 적용 시 매 위치마다 재생
  maxMarkers: number;
  minRadius: number;
  maxRadius: number;
  yBias: number;
  minPairDist: number;
  castScale: number;        // 캐스트 재생 시 픽셀 배율
  markerScale: number;      // 차지 마커 픽셀 배율
  killRadius: number;       // 각 캐스트 위치 기준 nearest-zombie 탐색 반경
  // 폭발을 순차적으로 — i 번째 위치는 (i × staggerSec) 만큼 지연.
  // 0 이면 일제히. 0.15 = 150ms 간격.
  staggerSec: number;
}

// 캐스트 1회 — 여러 위치가 순차 폭발. 각 위치는 자기 triggerAt 에 발화.
interface AnimCastEvent {
  bornAt: number;
  positions: { x: number; y: number; triggerAt: number; fired: boolean }[];
}

interface AnimCastState {
  chargeStartedAt: number | null;
  fullChargedAt: number | null;
  markerOffsets: { rx: number; ry: number }[];
  casts: AnimCastEvent[];
  // 현재 재생 중인 차지 SFX 핸들 (sfxChargeKey 사용 시) — 차지 종료 시 stop.
  chargeSfxHandle: SfxHandle | null;
}

function makeAnimCastState(): AnimCastState {
  return { chargeStartedAt: null, fullChargedAt: null, markerOffsets: [], casts: [], chargeSfxHandle: null };
}

function stopChargeSfx(state: AnimCastState): void {
  if (state.chargeSfxHandle) {
    try { state.chargeSfxHandle.stop(); } catch { /* noop */ }
    state.chargeSfxHandle = null;
  }
}

const ICE_CONFIG: AnimCastConfig = {
  spriteSrc: '/sprites/effects/ice_freeze.png',
  frameCount: 5,
  frameSize: 32,
  frameDurMs: 120,
  maxChargeSec: 2.0,
  blinkPerSec: 0.14,
  blinkCount: 2,
  maxMarkers: 5,
  minRadius: 60,
  maxRadius: 130,
  yBias: -16,
  minPairDist: 52,
  castScale: 1.6,
  markerScale: 1.1,
  killRadius: 44,
  staggerSec: 0,             // 얼음 = 일제 (생성 순서 효과 X)
};

const CURSE_CONFIG: AnimCastConfig = {
  spriteSrc: '/sprites/effects/skull_curse.png',
  frameCount: 6,
  frameSize: 32,
  frameDurMs: 100,
  maxChargeSec: 2.5,
  blinkPerSec: 0.16,
  blinkCount: 2,
  sfxChargeKey: 'curse_charge',
  sfxHitKey: 'curse_hit',
  maxMarkers: 5,
  minRadius: 60,
  maxRadius: 130,
  yBias: -16,
  minPairDist: 52,
  castScale: 2.34,           // 1.8 × 1.3 — 폭발 비주얼 1.3배
  markerScale: 1.43,         // 1.1 × 1.3 — 차지 구름 1.3배
  killRadius: 62,            // 48 × 1.3 — 폭발 범위 1.3배
  staggerSec: 0.15,          // 생긴 순서대로 150ms 간격 폭발
};

// 단일 위치 애니메이션 길이 (모든 프레임 재생).
function castFrameLifeSec(cfg: AnimCastConfig): number {
  return (cfg.frameCount * cfg.frameDurMs) / 1000;
}
// 캐스트 이벤트가 화면에 남아 있어야 할 총 시간 = 마지막 위치의 시작 + 프레임 길이.
function castTotalLifeSec(cfg: AnimCastConfig, n: number): number {
  return (Math.max(0, n - 1) * cfg.staggerSec) + castFrameLifeSec(cfg);
}

// ===== 스프라이트 로딩 =====
const iceImg = new Image();
let iceReady = false;
iceImg.src = ICE_CONFIG.spriteSrc;
iceImg.onload = () => { iceReady = true; };
iceImg.onerror = (e) => { console.error('[weapons] ice_freeze.png load failed', e); };

const curseImg = new Image();
let curseReady = false;
curseImg.src = CURSE_CONFIG.spriteSrc;
curseImg.onload = () => { curseReady = true; };
curseImg.onerror = (e) => { console.error('[weapons] skull_curse.png load failed', e); };

// 마커 N개 위치를 한 번에 뽑는다 — 라이트닝 구름과 동일 분포 (rejection sampling).
function generateAnimMarkers(state: AnimCastState, cfg: AnimCastConfig): void {
  const SQUASH = 0.6;
  const out: { rx: number; ry: number }[] = [];
  let safety = 0;
  while (out.length < cfg.maxMarkers && safety++ < 200) {
    const angle = Math.random() * Math.PI * 2;
    const radius = cfg.minRadius + Math.random() * (cfg.maxRadius - cfg.minRadius);
    const rx = Math.cos(angle) * radius;
    const ry = Math.sin(angle) * radius * SQUASH + cfg.yBias;
    const tooClose = out.some(
      (o) => (o.rx - rx) ** 2 + (o.ry - ry) ** 2 < cfg.minPairDist * cfg.minPairDist,
    );
    if (tooClose) continue;
    out.push({ rx, ry });
  }
  while (out.length < cfg.maxMarkers) {
    const angle = Math.random() * Math.PI * 2;
    const radius = cfg.minRadius + Math.random() * (cfg.maxRadius - cfg.minRadius);
    out.push({
      rx: Math.cos(angle) * radius,
      ry: Math.sin(angle) * radius * SQUASH + cfg.yBias,
    });
  }
  state.markerOffsets = out;
}

// 캐스트 스케줄 — N개 위치 캡처 + 각 위치를 i × staggerSec 지연 후 발화하도록 등록.
// 실제 폭발/킬/SFX 는 stepAnimCasts 가 triggerAt 도달 시 처리.
function executeCast(
  state: AnimCastState, cfg: AnimCastConfig, count: number,
  now: number, localX: number, localY: number, _wave: ZombieWave,
): void {
  const positions: { x: number; y: number; triggerAt: number; fired: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const off = state.markerOffsets[i] ?? { rx: 0, ry: -40 };
    positions.push({
      x: localX + off.rx,
      y: localY + off.ry,
      triggerAt: now + i * cfg.staggerSec,
      fired: false,
    });
  }
  state.casts.push({ bornAt: now, positions });
}

// 위치 1개의 발화 — nearest 좀비 1마리 킬 + hit SFX (중복 방지용 claimed Set 외부 주입).
function firePosition(cfg: AnimCastConfig, wave: ZombieWave, p: { x: number; y: number }, claimed: Set<string>): void {
  const r2 = cfg.killRadius * cfg.killRadius;
  let bestId: string | null = null;
  let bestD2 = r2;
  for (const z of wave.zombies) {
    if (claimed.has(z.id)) continue;
    const dx = z.x - p.x;
    const dy = (z.y - 14) - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; bestId = z.id; }
  }
  if (bestId !== null) {
    claimed.add(bestId);
    killZombieById(wave, bestId);
  }
  if (cfg.sfxHitKey) playSfx(cfg.sfxHitKey);
}

function handleAnimCastInput(
  state: AnimCastState, cfg: AnimCastConfig, owned: boolean,
  now: number, attackHeldNow: boolean, attackHeldPrev: boolean,
  localX: number, localY: number, wave: ZombieWave,
): void {
  if (!owned) {
    state.chargeStartedAt = null;
    state.fullChargedAt = null;
    stopChargeSfx(state);
    return;
  }
  // press → 차지 시작 + 차지 SFX 재생 시작
  if (attackHeldNow && !attackHeldPrev) {
    state.chargeStartedAt = now;
    state.fullChargedAt = null;
    generateAnimMarkers(state, cfg);
    stopChargeSfx(state);   // 이전 핸들 정리 (안전)
    if (cfg.sfxChargeKey) state.chargeSfxHandle = playSfx(cfg.sfxChargeKey);
  }
  // hold → 풀차지 도달 감지 (도달 시 즉시 차지 SFX 정지)
  if (attackHeldNow && state.chargeStartedAt !== null && state.fullChargedAt === null) {
    const frac = (now - state.chargeStartedAt) / cfg.maxChargeSec;
    if (frac >= 1) {
      state.fullChargedAt = now;
      stopChargeSfx(state);
    }
  }
  // 풀차지 후 깜빡임 시퀀스 끝 → 캐스트 (스테이지 chargedReleaseCount 만큼) +
  // 홀드 중이면 즉시 새 차지 시작.
  const blinkTotal = cfg.blinkPerSec * cfg.blinkCount;
  if (state.fullChargedAt !== null && (now - state.fullChargedAt) >= blinkTotal) {
    const n = stageChargedCount(cfg.maxMarkers);
    executeCast(state, cfg, n, now, localX, localY, wave);
    // hit SFX 는 stepAnimCasts 가 각 위치 발화 시 재생 (순차).
    if (attackHeldNow) {
      state.chargeStartedAt = now;
      state.fullChargedAt = null;
      generateAnimMarkers(state, cfg);
      stopChargeSfx(state);
      if (cfg.sfxChargeKey) state.chargeSfxHandle = playSfx(cfg.sfxChargeKey);
    } else {
      state.chargeStartedAt = null;
      state.fullChargedAt = null;
    }
    return;
  }
  // 풀차지 안된 상태에서 손 떼면 — 발사 없이 차지 취소 + SFX 정지.
  if (!attackHeldNow && attackHeldPrev && state.chargeStartedAt !== null) {
    state.chargeStartedAt = null;
    state.fullChargedAt = null;
    stopChargeSfx(state);
  }
}

function stepAnimCasts(state: AnimCastState, cfg: AnimCastConfig, now: number, wave: ZombieWave): void {
  // 각 캐스트 내 위치별로 triggerAt 도달 시 발화 (킬 + SFX). 한 캐스트 안에서
  // 위치끼리는 같은 좀비 중복 킬 X — claimed Set 으로 격리.
  for (const c of state.casts) {
    let claimed: Set<string> | null = null;
    for (const p of c.positions) {
      if (p.fired || now < p.triggerAt) continue;
      if (!claimed) claimed = new Set<string>();
      firePosition(cfg, wave, p, claimed);
      p.fired = true;
    }
  }
  // 만료 — 마지막 위치 발화 + 프레임 재생이 끝났을 때
  state.casts = state.casts.filter((c) => now - c.bornAt < castTotalLifeSec(cfg, c.positions.length));
}

function animCastChargeLevel(state: AnimCastState, cfg: AnimCastConfig, now: number): number {
  if (state.chargeStartedAt === null) return 0;
  return Math.min(1, (now - state.chargeStartedAt) / cfg.maxChargeSec);
}

// 차지 마커 한 슬롯의 현재 상태 (frame, alpha). null = 아직 등장 안 함.
function animCastMarkerVisual(
  state: AnimCastState, cfg: AnimCastConfig, now: number, i: number, totalN: number,
): { frame: number; alpha: number } | null {
  if (state.chargeStartedAt === null) return null;
  const appearChargeFrac = totalN > 0 ? (i + 1) / totalN : 1;
  const appearAt = state.chargeStartedAt + appearChargeFrac * cfg.maxChargeSec;
  if (now < appearAt) return null;
  // 풀차지 동기 깜빡임 — frame 0 ↔ 1
  if (state.fullChargedAt !== null) {
    const t = now - state.fullChargedAt;
    const cyc = t / cfg.blinkPerSec;
    const inCycle = cyc - Math.floor(cyc);
    const frame = inCycle < 0.5 ? 0 : Math.min(cfg.frameCount - 1, 1);
    return { frame, alpha: 1.0 };
  }
  // 차지 중 — fade in 0.3s, frame 0 고정
  const localElapsed = now - appearAt;
  const fadeIn = Math.min(1, localElapsed / 0.3);
  return { frame: 0, alpha: 0.6 * fadeIn };
}

function drawAnimCastMarkers(
  ctx: CanvasRenderingContext2D, camera: Camera,
  state: AnimCastState, cfg: AnimCastConfig,
  img: HTMLImageElement, ready: boolean, fallbackColor: string,
  now: number, localX: number, localY: number,
): void {
  if (state.chargeStartedAt === null) return;
  const dst = Math.round(cfg.frameSize * cfg.markerScale);
  const n = stageChargedCount(cfg.maxMarkers);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < n; i++) {
    const vis = animCastMarkerVisual(state, cfg, now, i, n);
    if (!vis) continue;
    const off = state.markerOffsets[i] ?? { rx: 0, ry: -40 };
    const sx = Math.round(localX + off.rx - camera.x - dst / 2);
    const sy = Math.round(localY + off.ry - camera.y - dst / 2);
    ctx.globalAlpha = Math.max(0, Math.min(1, vis.alpha));
    if (ready) {
      ctx.drawImage(img, vis.frame * cfg.frameSize, 0, cfg.frameSize, cfg.frameSize, sx, sy, dst, dst);
    } else {
      ctx.fillStyle = fallbackColor;
      ctx.beginPath();
      ctx.arc(sx + dst / 2, sy + dst / 2, dst / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawAnimCastEffects(
  ctx: CanvasRenderingContext2D, camera: Camera,
  state: AnimCastState, cfg: AnimCastConfig,
  img: HTMLImageElement, ready: boolean, now: number,
): void {
  if (state.casts.length === 0 || !ready) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const dst = Math.round(cfg.frameSize * cfg.castScale);
  for (const c of state.casts) {
    for (const p of c.positions) {
      // 위치별 자기 triggerAt 부터 애니메이션 시작 — stagger 시 순차 표시.
      const elapsedMs = (now - p.triggerAt) * 1000;
      if (elapsedMs < 0) continue;        // 아직 차례 아님
      const frame = Math.floor(elapsedMs / cfg.frameDurMs);
      if (frame >= cfg.frameCount) continue;
      const sx = Math.round(p.x - camera.x - dst / 2);
      const sy = Math.round(p.y - camera.y - dst / 2);
      ctx.drawImage(img, frame * cfg.frameSize, 0, cfg.frameSize, cfg.frameSize, sx, sy, dst, dst);
    }
  }
  ctx.restore();
}

// ===== ice / curse 퍼블릭 래퍼 =====

export function handleIceInput(
  state: WeaponsState, now: number, attackHeldNow: boolean, attackHeldPrev: boolean,
  local: LocalPlayer, wave: ZombieWave,
): void {
  const owned = !local.dead && (state.owned.get('ice') ?? 0) > now;
  handleAnimCastInput(state.ice, ICE_CONFIG, owned, now, attackHeldNow, attackHeldPrev, local.x, local.y, wave);
}

export function handleCurseInput(
  state: WeaponsState, now: number, attackHeldNow: boolean, attackHeldPrev: boolean,
  local: LocalPlayer, wave: ZombieWave,
): void {
  const owned = !local.dead && (state.owned.get('curse') ?? 0) > now;
  handleAnimCastInput(state.curse, CURSE_CONFIG, owned, now, attackHeldNow, attackHeldPrev, local.x, local.y, wave);
}

export function stepAnimCastEffects(state: WeaponsState, now: number, wave: ZombieWave): void {
  stepAnimCasts(state.ice, ICE_CONFIG, now, wave);
  stepAnimCasts(state.curse, CURSE_CONFIG, now, wave);
}

export function iceChargeLevel(state: WeaponsState, now: number): number {
  return animCastChargeLevel(state.ice, ICE_CONFIG, now);
}
export function curseChargeLevel(state: WeaponsState, now: number): number {
  return animCastChargeLevel(state.curse, CURSE_CONFIG, now);
}

export function drawIceCast(
  ctx: CanvasRenderingContext2D, camera: Camera, state: WeaponsState, now: number,
  localX: number, localY: number,
): void {
  drawAnimCastMarkers(ctx, camera, state.ice, ICE_CONFIG, iceImg, iceReady, '#88e0ff', now, localX, localY);
  drawAnimCastEffects(ctx, camera, state.ice, ICE_CONFIG, iceImg, iceReady, now);
}

export function drawCurseCast(
  ctx: CanvasRenderingContext2D, camera: Camera, state: WeaponsState, now: number,
  localX: number, localY: number,
): void {
  drawAnimCastMarkers(ctx, camera, state.curse, CURSE_CONFIG, curseImg, curseReady, '#444', now, localX, localY);
  drawAnimCastEffects(ctx, camera, state.curse, CURSE_CONFIG, curseImg, curseReady, now);
}
