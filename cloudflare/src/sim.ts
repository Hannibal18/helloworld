// 봇 좀비 시뮬레이션 — src/zombie.ts 의 호스트 로직 미러.
// 클라이언트 코드에서 브라우저 의존(particles, sprites, render) 제거한 순수 sim.

import { getStageProgress, ZOMBIE_SPEC, type Difficulty, type ZombieType } from './stages.js';

// 클라이언트 player.ts SPEED 와 일치.
const PLAYER_SPEED = 120;
const ZOMBIE_SPEED_PX = PLAYER_SPEED * 0.3;       // 36 px/s 기본
const ATTACK_RANGE_PX = 18;
const ATTACK_COOLDOWN_SEC = 1.67;
const ATTACK_MOTION_SEC = 0.45;

const INITIAL_SPAWN = 7;
const SPAWN_INTERVAL_BASE = 3.33;
const SPAWN_INTERVAL_MIN = 0.25;
const MAX_ZOMBIES = 72;

const BOSS_FIRST_AT = 90;
const BOSS_INTERVAL = 90;

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Zombie {
  id: string;
  type: ZombieType;
  x: number; y: number;
  dir: Dir;
  hp: number;
  maxHp: number;
  attackingUntil: number;
  lastAttackAt: number;
}

export interface Player {
  id: string;
  x: number; y: number;
  dead: boolean;
}

export interface BotWorld {
  mapW: number;
  mapH: number;
  // 통과 가능한 위치 sample (간이 collision — 외부에서 주입).
  // false 시 좀비 통과 가능. true 면 막힘.
  isBlocked: (x: number, y: number) => boolean;
}

export interface BotWaveState {
  active: boolean;
  startedAt: number;        // ms
  zombies: Zombie[];
  nextSpawnAt: number;      // ms
  nextBossAt: number;       // ms
  killCount: number;
  recentKillPoints: number[];
  difficulty: Difficulty;
  // 파티원 수 (room.ts 에서 갱신) → √N 비례 스폰.
  playerCount: number;
}

export function makeBotWave(): BotWaveState {
  return {
    active: false, startedAt: 0, zombies: [],
    nextSpawnAt: 0, nextBossAt: 0,
    killCount: 0, recentKillPoints: [],
    difficulty: 'normal',
    playerCount: 1,
  };
}

function partyScale(n: number): number {
  return Math.min(3.0, Math.sqrt(Math.max(1, n)));
}

function rngId(): string {
  return `z${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function currentStageZombie(state: BotWaveState, nowMs: number) {
  const elapsed = Math.max(0, (nowMs - state.startedAt) / 1000);
  return getStageProgress(state.difficulty, elapsed).stage.zombie;
}

function spawnIntervalSec(state: BotWaveState, nowMs: number): number {
  const z = currentStageZombie(state, nowMs);
  const base = SPAWN_INTERVAL_BASE * z.spawnIntervalMult / partyScale(state.playerCount);
  return Math.max(SPAWN_INTERVAL_MIN, base);
}

function pickZombieType(state: BotWaveState, nowMs: number): ZombieType {
  const z = currentStageZombie(state, nowMs);
  const tw = z.typeWeights;
  const arr: [ZombieType, number][] = [
    ['normal', tw.normal], ['fast', tw.fast], ['tank', tw.tank], ['gold', tw.gold],
  ];
  let total = 0;
  for (const [, w] of arr) total += Math.max(0, w);
  if (total <= 0) return 'normal';
  let r = Math.random() * total;
  for (const [t, w] of arr) {
    if ((r -= Math.max(0, w)) < 0) return t;
  }
  return 'normal';
}

// 맵 가장자리 랜덤 위치. isBlocked 통과 안 되면 30회 재시도.
function pickSpawnSpot(world: BotWorld): { x: number; y: number } | null {
  const margin = 64;
  for (let i = 0; i < 30; i++) {
    let x = 0, y = 0;
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { x = margin + Math.random() * (world.mapW - margin * 2); y = margin; }
    else if (side === 1) { x = margin + Math.random() * (world.mapW - margin * 2); y = world.mapH - margin; }
    else if (side === 2) { x = margin; y = margin + Math.random() * (world.mapH - margin * 2); }
    else { x = world.mapW - margin; y = margin + Math.random() * (world.mapH - margin * 2); }
    if (!world.isBlocked(x, y)) return { x, y };
  }
  return null;
}

export function startWave(state: BotWaveState, nowMs: number, world: BotWorld, difficulty: Difficulty): void {
  state.active = true;
  state.startedAt = nowMs;
  state.zombies = [];
  state.nextSpawnAt = nowMs + spawnIntervalSec(state, nowMs) * 1000;
  state.nextBossAt = nowMs + BOSS_FIRST_AT * 1000;
  state.killCount = 0;
  state.recentKillPoints = [];
  state.difficulty = difficulty;
  for (let i = 0; i < INITIAL_SPAWN; i++) {
    spawnOne(state, nowMs, world);
  }
}

function spawnOne(state: BotWaveState, nowMs: number, world: BotWorld, forceType?: ZombieType): void {
  const cap = Math.round(MAX_ZOMBIES * partyScale(state.playerCount));
  if (state.zombies.length >= cap) return;
  const spot = pickSpawnSpot(world);
  if (!spot) return;
  const type = forceType ?? pickZombieType(state, nowMs);
  const spec = ZOMBIE_SPEC[type];
  const hpMult = currentStageZombie(state, nowMs).hpMult;
  const hp = Math.max(1, Math.round(spec.hp * hpMult));
  state.zombies.push({
    id: rngId(), type,
    x: spot.x, y: spot.y, dir: 'down',
    hp, maxHp: hp,
    attackingUntil: 0, lastAttackAt: 0,
  });
}

// 매 tick 호출 (예: 100ms 주기). 좀비 AI + 스폰.
export function stepWave(state: BotWaveState, dtMs: number, nowMs: number, world: BotWorld, players: Player[]): void {
  if (!state.active) return;
  const dt = dtMs / 1000;

  // 스폰
  if (nowMs >= state.nextSpawnAt) {
    state.nextSpawnAt = nowMs + spawnIntervalSec(state, nowMs) * 1000;
    spawnOne(state, nowMs, world);
  }
  // 보스
  if (nowMs >= state.nextBossAt) {
    const z = currentStageZombie(state, nowMs);
    if (z.bossEnabled) {
      spawnOne(state, nowMs, world, 'boss');
      state.nextBossAt = nowMs + (BOSS_INTERVAL / partyScale(state.playerCount)) * 1000;
    } else {
      state.nextBossAt = nowMs + 5000;
    }
  }

  // 살아있는 플레이어 타깃
  const targets = players.filter((p) => !p.dead);
  if (targets.length === 0) return;

  const stageSpeedMult = currentStageZombie(state, nowMs).speedMult;
  for (const z of state.zombies) {
    if (nowMs / 1000 < z.attackingUntil) continue;
    // 가장 가까운 타깃
    let tx = targets[0].x, ty = targets[0].y;
    let bestD2 = (tx - z.x) ** 2 + (ty - z.y) ** 2;
    for (let i = 1; i < targets.length; i++) {
      const d2 = (targets[i].x - z.x) ** 2 + (targets[i].y - z.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; tx = targets[i].x; ty = targets[i].y; }
    }
    const dxT = tx - z.x;
    const dyT = ty - z.y;
    const distT = Math.hypot(dxT, dyT) || 1;
    if (distT <= ATTACK_RANGE_PX) {
      // 가까운 플레이어 공격 모션 (실제 데미지는 클라이언트가 자기 접촉 시 적용)
      const nowSec = nowMs / 1000;
      if (nowSec - z.lastAttackAt >= ATTACK_COOLDOWN_SEC) {
        z.lastAttackAt = nowSec;
        z.attackingUntil = nowSec + ATTACK_MOTION_SEC;
        z.dir = dirFromVec(dxT, dyT);
      }
      continue;
    }
    const nx = dxT / distT;
    const ny = dyT / distT;
    const speed = ZOMBIE_SPEED_PX * ZOMBIE_SPEC[z.type].speedMult * stageSpeedMult;
    // 축 분리 이동 + collision
    const nxX = z.x + nx * speed * dt;
    if (!world.isBlocked(nxX, z.y)) z.x = nxX;
    const nxY = z.y + ny * speed * dt;
    if (!world.isBlocked(z.x, nxY)) z.y = nxY;
    z.dir = dirFromVec(nx, ny);
  }
}

function dirFromVec(dx: number, dy: number): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// 데미지 적용 — hit_request 받았을 때 호출. 사망 시 점수 큐 push.
export function applyDamage(state: BotWaveState, zid: string, dmg: number): boolean {
  const z = state.zombies.find((x) => x.id === zid);
  if (!z) return false;
  z.hp -= Math.max(1, Math.round(dmg));
  if (z.hp > 0) return false;
  state.zombies = state.zombies.filter((x) => x.id !== zid);
  state.killCount += 1;
  state.recentKillPoints.push(ZOMBIE_SPEC[z.type].basePoints);
  return true;
}

// snapshot payload (zombie.ts ZombieSnapshotPayload 와 동일 schema)
export interface SnapshotPayload {
  hostNow: number;
  zombies: Array<{
    id: string; type: ZombieType;
    x: number; y: number; dir: Dir;
    hp: number; maxHp: number; attackingUntil: number;
  }>;
  killCount: number;
  newKillPoints: number[];
}

export function makeSnapshot(state: BotWaveState, hostNowSec: number): SnapshotPayload {
  const payload: SnapshotPayload = {
    hostNow: hostNowSec,
    zombies: state.zombies.map((z) => ({
      id: z.id, type: z.type, x: z.x, y: z.y, dir: z.dir,
      hp: z.hp, maxHp: z.maxHp, attackingUntil: z.attackingUntil,
    })),
    killCount: state.killCount,
    newKillPoints: state.recentKillPoints.slice(),
  };
  state.recentKillPoints.length = 0;
  return payload;
}
