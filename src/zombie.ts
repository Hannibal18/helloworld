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

import { isBlocked, type TileMap } from './map';
import type { Camera } from './world';
import type { LocalPlayer } from './player';
import { spawnBloodBurst } from './particles';
import { ATTACK_COOLDOWN as PLAYER_ATTACK_COOLDOWN, ATTACK_DAMAGE as PLAYER_ATTACK_DAMAGE, BODY_HH, BODY_HW, BODY_OFF_Y, SPEED as PLAYER_SPEED, attackerHitbox } from './player';
import { currentCharScale } from './sprites';
import { CFG_ZOMBIE_TYPES, getConfig, getStageProgress } from './config';
import type { AttackPayload, Dir, RemotePlayer, ZombieSnapshotPayload } from './types';

// 연속 스폰 모드 — 입장 후 끝없이 좀비 등장. 난이도는 config 의 스테이지가 결정.
// 파티원 수 비례: spawn / max / boss 빈도 모두 √(playerCount) 곱 (cap 3.0).
const INITIAL_SPAWN = 7;
const SPAWN_INTERVAL_BASE = 3.33;
const SPAWN_INTERVAL_MIN = 0.25;
const MAX_ZOMBIES = 72;

// 파티원 수 — game.ts 가 매 프레임 setRoomPlayerCount() 갱신. 1 이상.
// 좀비/무기 모두 이 partyScale 을 사용 (weapons.ts 도 import).
let _playerCount = 1;
export function setRoomPlayerCount(n: number): void {
  _playerCount = Math.max(1, n);
}
export function getPartyScale(): number {
  return Math.min(3.0, Math.sqrt(_playerCount));
}
// 내부용 별칭 (이전 코드 호환)
function partyScale(): number {
  return getPartyScale();
}
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

// ===== 몬스터 타입 — 점수/체력/스피드/외형 차등 =====
// zombie = 기존 LPC zombie 스프라이트. frank = 별도 스프라이트시트 (frank.png).
// sheet 필드로 두 종류 분리: 'zombie' / 'frank'.
export type ZombieType = 'normal' | 'fast' | 'tank' | 'gold' | 'boss' | 'frank';

interface ZombieTypeSpec {
  sheet: 'zombie' | 'frank';     // 어느 스프라이트시트 사용
  speedMult: number;
  hp: number;
  basePoints: number;
  scale: number;
  tint: string | null;
  showHpBar: boolean;
}
export const ZOMBIE_SPEC: Record<ZombieType, ZombieTypeSpec> = {
  normal: { sheet: 'zombie', speedMult: 1.0, hp: 1,  basePoints: 10,  scale: 1.0,  tint: null,                          showHpBar: false },
  fast:   { sheet: 'zombie', speedMult: 1.8, hp: 1,  basePoints: 18,  scale: 0.85, tint: 'rgba(140,255,160,0.45)',      showHpBar: false },
  tank:   { sheet: 'zombie', speedMult: 0.55, hp: 4, basePoints: 35,  scale: 1.35, tint: 'rgba(180,90,255,0.55)',       showHpBar: true  },
  gold:   { sheet: 'zombie', speedMult: 1.2, hp: 1,  basePoints: 80,  scale: 1.0,  tint: 'rgba(255,200,40,0.65)',       showHpBar: false },
  boss:   { sheet: 'zombie', speedMult: 0.5, hp: 18, basePoints: 250, scale: 2.0,  tint: 'rgba(255,40,40,0.5)',         showHpBar: true  },
  // 🟢 Frank — 초록 LPC 몬스터, 새 스프라이트. 좀비보다 빠르고 hp 살짝 ↑
  frank:  { sheet: 'frank',  speedMult: 1.3, hp: 2,  basePoints: 25,  scale: 1.0,  tint: null,                          showHpBar: false },
};

interface Zombie {
  id: string;
  type: ZombieType;
  x: number;
  y: number;
  dir: Dir;
  hp: number;
  maxHp: number;
  attackingUntil: number;
  lastAttackAt: number;
}

export interface ZombieWave {
  active: boolean;
  startedAt: number;
  zombies: Zombie[];
  nextSpawnAt: number;
  nextStartAt: number;
  killCount: number;
  // 보스 — 시작 후 BOSS_FIRST_AT, 이후 BOSS_INTERVAL 마다.
  nextBossAt: number;
  // 처치된 좀비의 점수 큐 — game.ts 가 매 프레임 drain 해서 score 에 반영.
  recentKillPoints: number[];
  // 호스트 권위 시뮬 플래그 — game.ts 가 매 프레임 isLocalHost() 로 세팅.
  // true = 풀 시뮬 (spawn/AI/damage 모두 자기 결정), false = snapshot 받아서 대체.
  isHostSim: boolean;
}

const BOSS_FIRST_AT = 90;    // 첫 보스 = 시작 후 90s
const BOSS_INTERVAL = 90;    // 이후 90s 마다

export function makeZombieWave(now: number): ZombieWave {
  return {
    active: false,
    startedAt: 0,
    zombies: [],
    nextSpawnAt: 0,
    nextStartAt: now + 3,
    killCount: 0,
    nextBossAt: Infinity,
    recentKillPoints: [],
    isHostSim: false,
  };
}

export function setHostSim(wave: ZombieWave, isHost: boolean): void {
  wave.isHostSim = isHost;
}

// 현재 스테이지의 zombie 설정 — getStageProgress 로 elapsed → stage 매핑.
function currentStageZombie(wave: ZombieWave, now: number) {
  const elapsed = Math.max(0, now - wave.startedAt);
  return getStageProgress(getConfig(), elapsed).stage.zombie;
}

// 현재 spawn 주기 — 스테이지 spawnIntervalMult × (1/partyScale) — 파티 많을수록 자주.
function currentSpawnInterval(wave: ZombieWave, now: number): number {
  const z = currentStageZombie(wave, now);
  const base = SPAWN_INTERVAL_BASE * z.spawnIntervalMult / partyScale();
  return Math.max(SPAWN_INTERVAL_MIN, base);
}

// ===== 스프라이트 로딩 =====
const zombieSheet = new Image();
let zombieSheetReady = false;
zombieSheet.src = '/sprites/zombie.png';
zombieSheet.onload = () => { zombieSheetReady = true; };

const frankSheet = new Image();
let frankSheetReady = false;
frankSheet.src = '/sprites/frank.png';
frankSheet.onload = () => { frankSheetReady = true; };

function pickSheet(spec: ZombieTypeSpec): { img: HTMLImageElement; ready: boolean } {
  if (spec.sheet === 'frank') return { img: frankSheet, ready: frankSheetReady };
  return { img: zombieSheet, ready: zombieSheetReady };
}

// 틴트용 오프스크린 캔버스 — source-atop 이 메인 캔버스에선 잔디 같은
// 불투명 배경까지 칠해버려 박스 전체가 보이는 버그 회피.
// 좀비 1프레임만 그리고 그 안에서 source-atop 으로 픽셀만 색칠 후 main 으로 복사.
const _tintCanvas: HTMLCanvasElement = (typeof document !== 'undefined') ? document.createElement('canvas') : null as unknown as HTMLCanvasElement;
const _tintCtx: CanvasRenderingContext2D | null = _tintCanvas ? _tintCanvas.getContext('2d') : null;
if (_tintCanvas) { _tintCanvas.width = 64; _tintCanvas.height = 64; }

// ===== 호스트만 호출 — 첫 시작 트리거 (1회만). 이후 끝없이 진행. =====
export function maybeTriggerWave(
  wave: ZombieWave,
  now: number,
  isHost: boolean,
  onTrigger: () => void,
): void {
  if (!isHost) return;
  if (wave.active) return;
  if (now < wave.nextStartAt) return;
  wave.nextStartAt = Infinity; // 다시 트리거 안 하도록
  onTrigger();
}

// ===== 좀비 모드 시작 (broadcast 받았을 때 모든 클라이언트가 호출). =====
// 한 번 시작하면 끝없이 진행 — endsAt 없음.
export function startWave(wave: ZombieWave, now: number, map: TileMap): void {
  wave.active = true;
  wave.startedAt = now;
  wave.zombies = [];
  wave.nextSpawnAt = now + currentSpawnInterval(wave, now);
  wave.nextBossAt = now + BOSS_FIRST_AT;
  wave.recentKillPoints = [];
  for (let i = 0; i < INITIAL_SPAWN; i++) {
    spawnOne(wave, now, map);
  }
}

// 스테이지의 typeWeights 로 가중 랜덤. 모두 0 이면 normal 폴백.
function pickZombieType(wave: ZombieWave, now: number): ZombieType {
  const tw = currentStageZombie(wave, now).typeWeights;
  let total = 0;
  for (const t of CFG_ZOMBIE_TYPES) total += Math.max(0, tw[t] ?? 0);
  if (total <= 0) return 'normal';
  let r = Math.random() * total;
  for (const t of CFG_ZOMBIE_TYPES) {
    const w = Math.max(0, tw[t] ?? 0);
    if ((r -= w) < 0) return t as ZombieType;
  }
  return 'normal';
}

function spawnOne(wave: ZombieWave, now: number, map: TileMap, forceType?: ZombieType): void {
  if (wave.zombies.length >= Math.round(MAX_ZOMBIES * partyScale())) return;
  const TILE = map.tileW;
  const margin = TILE * 2;
  // 통과 가능한 위치를 찾을 때까지 재시도 — 나무/물 위 스폰 방지.
  // 최대 16번 → 못 찾으면 이번 틱은 스폰 포기 (다음 nextSpawnAt 에 재시도).
  const ZF_HW = ZOMBIE_BODY_HW * 0.7;
  const ZF_HH = 5;
  let x = 0, y = 0;
  let placed = false;
  for (let tries = 0; tries < 16; tries++) {
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { x = margin + Math.random() * (map.pixelW - margin * 2); y = margin; }
    else if (side === 1) { x = margin + Math.random() * (map.pixelW - margin * 2); y = map.pixelH - margin; }
    else if (side === 2) { x = margin; y = margin + Math.random() * (map.pixelH - margin * 2); }
    else { x = map.pixelW - margin; y = margin + Math.random() * (map.pixelH - margin * 2); }
    if (!isBlocked(map, x, y - ZF_HH, ZF_HW, ZF_HH)) { placed = true; break; }
  }
  if (!placed) return;
  const type = forceType ?? pickZombieType(wave, now);
  const spec = ZOMBIE_SPEC[type];
  const hpMult = currentStageZombie(wave, now).hpMult;
  const hp = Math.max(1, Math.round(spec.hp * hpMult));
  wave.zombies.push({
    id: makeId(),
    type,
    x, y,
    dir: 'down',
    hp,
    maxHp: hp,
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
// ===== 데미지 라우팅 (호스트/비-호스트) =====
// 모든 데미지 시도는 intentZombieHit 를 거침.
//   호스트 → 직접 killZombieById 적용 + 다음 snapshot 에 반영.
//   비-호스트 → 시각 효과(피)만 + game.ts 가 hit_request broadcast (intent 콜백).
// game.ts 가 startup 에 setHitIntentHandler() 로 broadcast 함수 주입.
let _onHitIntent: ((zid: string, dmg: number) => void) | null = null;
export function setHitIntentHandler(fn: ((zid: string, dmg: number) => void) | null): void {
  _onHitIntent = fn;
}

export function intentZombieHit(wave: ZombieWave, zid: string, damage: number = 1): void {
  if (!wave.active) return;
  if (wave.isHostSim) {
    killZombieById(wave, zid, damage);
    return;
  }
  // 비-호스트: 시각 피드백 (피) + broadcast 요청
  const z = wave.zombies.find((x) => x.id === zid);
  if (z) {
    const now = performance.now() / 1000;
    spawnBloodBurst(z.x, z.y - ZOMBIE_BODY_HH, now);
  }
  _onHitIntent?.(zid, damage);
}

// ===== 스냅샷 적용 (비-호스트 전용) =====
// 호스트가 broadcast 한 좀비 전체 상태로 wave.zombies 교체.
// 기존 attackingUntil 같은 클라이언트 측 상태 보존 가능하면 보존.
export function applyZombieSnapshot(wave: ZombieWave, p: ZombieSnapshotPayload, localNow: number): void {
  // 시각 보정: hostNow → localNow 변환 offset
  const tOff = localNow - p.hostNow;
  const oldById = new Map<string, Zombie>();
  for (const z of wave.zombies) oldById.set(z.id, z);
  const next: Zombie[] = [];
  for (const item of p.zombies) {
    const old = oldById.get(item.id);
    next.push({
      id: item.id,
      type: item.type as ZombieType,
      x: item.x, y: item.y,
      dir: item.dir,
      hp: item.hp,
      maxHp: item.maxHp,
      attackingUntil: typeof item.attackingUntil === 'number' ? item.attackingUntil + tOff : (old?.attackingUntil ?? 0),
      lastAttackAt: old?.lastAttackAt ?? 0,
    });
  }
  wave.zombies = next;
  wave.killCount = p.killCount;
  for (const pts of p.newKillPoints) wave.recentKillPoints.push(pts);
}

// ===== 스냅샷 생성 (호스트 전용) =====
// 호스트가 매 SNAPSHOT_INTERVAL 마다 호출. recentKillPoints 는 비워서 다음 사이클에 누적.
export function makeZombieSnapshot(wave: ZombieWave, hostNow: number): ZombieSnapshotPayload {
  const payload: ZombieSnapshotPayload = {
    hostNow,
    zombies: wave.zombies.map((z) => ({
      id: z.id, type: z.type, x: z.x, y: z.y, dir: z.dir,
      hp: z.hp, maxHp: z.maxHp, attackingUntil: z.attackingUntil,
    })),
    killCount: wave.killCount,
    newKillPoints: wave.recentKillPoints.slice(),
  };
  wave.recentKillPoints.length = 0;
  return payload;
}

// damage 만큼 깎고, hp <= 0 이면 제거 + 점수 큐 push + killCount 증가.
// 호스트에서만 호출 (비-호스트는 intentZombieHit → broadcast 경로 사용).
// damage 미지정 시 현재 스테이지의 weapons.damageMult (round) 자동 적용.
export function killZombieById(wave: ZombieWave, id: string, damage?: number): boolean {
  const z = wave.zombies.find((x) => x.id === id);
  if (!z) return false;
  const now = performance.now() / 1000;
  const dmg = damage !== undefined
    ? Math.max(1, Math.round(damage))
    : Math.max(1, Math.round(getStageDamageMult(wave, now)));
  z.hp -= dmg;
  spawnBloodBurst(z.x, z.y - ZOMBIE_BODY_HH, now);
  if (z.hp > 0) return false;
  // 사망
  const spec = ZOMBIE_SPEC[z.type];
  wave.zombies = wave.zombies.filter((x) => x.id !== id);
  wave.killCount += 1;
  wave.recentKillPoints.push(spec.basePoints);
  return true;
}

function getStageDamageMult(wave: ZombieWave, now: number): number {
  if (!wave.active) return 1;
  const elapsed = Math.max(0, now - wave.startedAt);
  return getStageProgress(getConfig(), elapsed).stage.weapons.damageMult;
}

// ===== 플레이어 공격 vs 좀비 — 한 대 맞으면 죽음 =====
// 누군가(로컬 or 원격) 공격 broadcast 발사 → 그 공격 hitbox 안 좀비를 자기 클라이언트에서 제거.
// 각 클라가 자기 좀비 시뮬에서 처리하므로 (좀비 위치 약간 다를 수 있음) 시각적으로 좀
// 어긋날 수 있으나 v1 단순화로 OK.
export function tryHitFromAttack(wave: ZombieWave, atk: AttackPayload): number {
  if (!wave.active || wave.zombies.length === 0) return 0;
  const hb = attackerHitbox(atk);
  const now = performance.now() / 1000;
  let killed = 0;
  const survivors: Zombie[] = [];
  for (const z of wave.zombies) {
    const zx0 = z.x - ZOMBIE_HIT_RADIUS;
    const zx1 = z.x + ZOMBIE_HIT_RADIUS;
    const zy0 = z.y - ZOMBIE_BODY_HH * 2;
    const zy1 = z.y;
    const hit = zx0 < hb.x1 && zx1 > hb.x0 && zy0 < hb.y1 && zy1 > hb.y0;
    if (!hit) { survivors.push(z); continue; }
    z.hp -= 1;
    spawnBloodBurst(z.x, z.y - ZOMBIE_BODY_HH, now);
    if (z.hp > 0) { survivors.push(z); continue; }
    killed++;
    const spec = ZOMBIE_SPEC[z.type];
    wave.recentKillPoints.push(spec.basePoints);
  }
  wave.zombies = survivors;
  wave.killCount += killed;
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
  // ===== 비-호스트: 좀비 위치/HP 는 snapshot 으로 받음. 여기선 로컬 플레이어
  //       접촉 데미지만 처리 (자기 HP 깎임 + 좀비 attack 애니메이션 트리거).
  if (!wave.isHostSim) {
    for (const z of wave.zombies) {
      if (now < z.attackingUntil) continue;
      if (local.dead) continue;
      const dx = local.x - z.x;
      const dy = local.y - z.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= ATTACK_RANGE_PX && now - z.lastAttackAt >= ATTACK_COOLDOWN_SEC) {
        z.lastAttackAt = now;
        z.attackingUntil = now + ATTACK_MOTION_SEC;
        z.dir = dirFromVec(dx, dy);
        cb.onLocalHit(ATTACK_DAMAGE, z.id);
      }
    }
    return;
  }
  // ===== 호스트: 풀 시뮬 (spawn/AI/contact) =====
  // 연속 스폰 — 종료 없음. spawn 주기는 시간 따라 가속.
  if (now >= wave.nextSpawnAt) {
    wave.nextSpawnAt = now + currentSpawnInterval(wave, now);
    spawnOne(wave, now, map);
  }
  // 보스 — 90초 주기. 현재 스테이지에서 bossEnabled=false 면 스킵하고 다음 틱.
  if (now >= wave.nextBossAt) {
    if (currentStageZombie(wave, now).bossEnabled) {
      spawnOne(wave, now, map, 'boss');
      wave.nextBossAt = now + BOSS_INTERVAL / partyScale();
    } else {
      // 활성화 안 됨 — 짧게 기다렸다가 재확인
      wave.nextBossAt = now + 5;
    }
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
    // 이동 — 타입별 스피드 배율 적용
    const dxT = tx - z.x;
    const dyT = ty - z.y;
    const distT = Math.hypot(dxT, dyT) || 1;
    if (distT > ATTACK_RANGE_PX) {
      const nx = dxT / distT;
      const ny = dyT / distT;
      const stageSpeedMult = currentStageZombie(wave, now).speedMult;
      const speed = ZOMBIE_SPEED_PX * ZOMBIE_SPEC[z.type].speedMult * stageSpeedMult;
      // 축 분리 이동 + 타일 충돌 체크 — 나무/돌 통과 방지.
      // (좀비는 발 영역만 충돌 — 플레이어와 동일 패턴.)
      const ZF_HW = ZOMBIE_BODY_HW * 0.7;
      const ZF_HH = 5;
      const newX = z.x + nx * speed * dt;
      if (!isBlocked(map, newX, z.y - ZF_HH, ZF_HW, ZF_HH)) z.x = newX;
      const newY = z.y + ny * speed * dt;
      if (!isBlocked(map, z.x, newY - ZF_HH, ZF_HW, ZF_HH)) z.y = newY;
      z.dir = dirFromVec(nx, ny);
    }
  }
}

function dirFromVec(dx: number, dy: number): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// ===== 렌더 =====
// camera 좌표계 사용. 캐릭터 현재 prescale 과 동일한 크기로 그림 (currentCharScale()).
// 디버그 슬라이더로 캐릭터 스케일 바뀌어도 자동 동기화.
export function drawZombies(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  wave: ZombieWave,
  now: number,
  charScale: number = currentCharScale(),
): void {
  if (!wave.active) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const baseW = FRAME * charScale;
  for (const z of wave.zombies) {
    const spec = ZOMBIE_SPEC[z.type];
    const sheet = pickSheet(spec);
    if (!sheet.ready) continue;   // 자기 시트 로드 전이면 그 좀비만 스킵
    const dstW = Math.round(baseW * spec.scale);
    const dstH = dstW;
    const footY = Math.round(58 * charScale * spec.scale);
    const sx = Math.round(z.x - camera.x);
    const sy = Math.round(z.y - camera.y);
    let row: number;
    let col: number;
    if (now < z.attackingUntil) {
      row = ROW_SPELL[z.dir];
      const phase = 1 - (z.attackingUntil - now) / ATTACK_MOTION_SEC;
      col = Math.min(6, Math.floor(phase * 7));
    } else {
      row = ROW_WALK[z.dir];
      col = 1 + Math.floor(now * 7) % 8;
    }
    const dx = sx - Math.round(dstW / 2);
    const dy = sy - footY;
    if (spec.tint && _tintCtx) {
      _tintCtx.globalCompositeOperation = 'source-over';
      _tintCtx.clearRect(0, 0, FRAME, FRAME);
      _tintCtx.imageSmoothingEnabled = false;
      _tintCtx.drawImage(sheet.img, col * FRAME, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
      _tintCtx.globalCompositeOperation = 'source-atop';
      _tintCtx.fillStyle = spec.tint;
      _tintCtx.fillRect(0, 0, FRAME, FRAME);
      _tintCtx.globalCompositeOperation = 'source-over';
      ctx.drawImage(_tintCanvas, 0, 0, FRAME, FRAME, dx, dy, dstW, dstH);
    } else {
      ctx.drawImage(sheet.img, col * FRAME, row * FRAME, FRAME, FRAME, dx, dy, dstW, dstH);
    }
    // HP 바 (탱크/보스만)
    if (spec.showHpBar && z.hp < z.maxHp) {
      const barW = dstW;
      const barH = 3;
      const bx = dx;
      const by = dy - 5;
      ctx.fillStyle = '#1a0e08';
      ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
      ctx.fillStyle = '#400000';
      ctx.fillRect(bx, by, barW, barH);
      ctx.fillStyle = z.type === 'boss' ? '#ff5050' : '#c84a4a';
      ctx.fillRect(bx, by, Math.round(barW * (z.hp / z.maxHp)), barH);
    }
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
  const elapsed = Math.max(0, now - wave.startedAt);
  const mm = Math.floor(elapsed / 60);
  const ss = Math.floor(elapsed % 60).toString().padStart(2, '0');
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
