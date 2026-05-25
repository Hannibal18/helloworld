// 봇용 스테이지 프리셋 — src/config.ts 의 presets 미러.
// 클라이언트와 별도로 유지 (DO 가 src/ import 불가). 밸런스 변경 시 양쪽 동기 필요.

export type Difficulty = 'easy' | 'normal' | 'hell';
export type ZombieType = 'normal' | 'fast' | 'tank' | 'gold' | 'boss';

export interface StageConfig {
  name: string;
  durationSec: number;
  zombie: {
    hpMult: number;
    speedMult: number;
    spawnIntervalMult: number;
    typeWeights: { normal: number; fast: number; tank: number; gold: number };
    bossEnabled: boolean;
  };
}

function mkStage(name: string, dur: number,
  hpMult: number, speedMult: number, spawnIntervalMult: number,
  weights: [number, number, number, number],   // normal/fast/tank/gold
  bossEnabled: boolean,
): StageConfig {
  return {
    name, durationSec: dur,
    zombie: {
      hpMult, speedMult, spawnIntervalMult,
      typeWeights: { normal: weights[0], fast: weights[1], tank: weights[2], gold: weights[3] },
      bossEnabled,
    },
  };
}

export const PRESETS: Record<Difficulty, StageConfig[]> = {
  easy: [
    mkStage('🟢 EASY 1', 60,  1.0, 1.0, 1.1, [100, 0, 0, 0], false),
    mkStage('🟢 EASY 2', 60,  1.0, 1.05, 0.9, [60, 35, 5, 0], false),
    mkStage('🟢 EASY 3', 90,  1.15, 1.1, 0.7, [45, 35, 18, 2], true),
    mkStage('🟢 EASY 4', 999, 1.25, 1.15, 0.55, [35, 35, 25, 5], true),
  ],
  normal: [
    mkStage('🟡 NORMAL 1', 60,  1.0, 1.05, 0.9, [70, 25, 5, 0], false),
    mkStage('🟡 NORMAL 2', 75,  1.15, 1.15, 0.7, [50, 30, 18, 2], true),
    mkStage('🟡 NORMAL 3', 90,  1.3, 1.25, 0.55, [35, 35, 25, 5], true),
    mkStage('🟡 NORMAL 4', 999, 1.5, 1.35, 0.42, [25, 35, 30, 10], true),
  ],
  hell: [
    mkStage('🔴 HELL 1', 50, 1.1, 1.2, 0.65, [50, 40, 10, 0], true),
    mkStage('🔴 HELL 2', 70, 1.25, 1.3, 0.5, [35, 35, 25, 5], true),
    mkStage('🔴 HELL 3', 80, 1.45, 1.4, 0.4, [25, 35, 30, 10], true),
    mkStage('🔴 HELL 4', 90, 1.65, 1.45, 0.35, [15, 30, 40, 15], true),
    mkStage('🔴 HELL 5', 999, 1.9, 1.55, 0.3, [10, 25, 45, 20], true),
  ],
};

export interface StageProgress {
  stage: StageConfig;
  index: number;
  loopIdx: number;
}

const LOOP_DIFFICULTY_STEP = 0.15;

export function getStageProgress(diff: Difficulty, elapsed: number): StageProgress {
  const stages = PRESETS[diff];
  const totalLoopDur = stages.reduce((s, st) => s + Math.max(1, st.durationSec), 0);
  let t = Math.max(0, elapsed);
  let loopIdx = 0;
  if (totalLoopDur > 0) {
    loopIdx = Math.floor(t / totalLoopDur);
    t = t - loopIdx * totalLoopDur;
  }
  let acc = 0;
  for (let i = 0; i < stages.length; i++) {
    const dur = Math.max(1, stages[i].durationSec);
    if (t < acc + dur) {
      return { stage: applyLoopMult(stages[i], loopIdx), index: i, loopIdx };
    }
    acc += dur;
  }
  const last = stages[stages.length - 1];
  return { stage: applyLoopMult(last, loopIdx), index: stages.length - 1, loopIdx };
}

function applyLoopMult(s: StageConfig, loopIdx: number): StageConfig {
  if (loopIdx === 0) return s;
  const m = 1 + LOOP_DIFFICULTY_STEP * loopIdx;
  return {
    ...s,
    zombie: {
      ...s.zombie,
      hpMult: s.zombie.hpMult * m,
      speedMult: s.zombie.speedMult * (1 + LOOP_DIFFICULTY_STEP * loopIdx * 0.5),
      spawnIntervalMult: s.zombie.spawnIntervalMult / m,
    },
  };
}

// ===== 좀비 타입 spec (zombie.ts ZOMBIE_SPEC 미러) =====
export interface ZombieTypeSpec {
  speedMult: number;
  hp: number;
  basePoints: number;
  scale: number;
}
export const ZOMBIE_SPEC: Record<ZombieType, ZombieTypeSpec> = {
  normal: { speedMult: 1.0, hp: 1,  basePoints: 10,  scale: 1.0 },
  fast:   { speedMult: 1.8, hp: 1,  basePoints: 18,  scale: 0.85 },
  tank:   { speedMult: 0.55, hp: 4, basePoints: 35,  scale: 1.35 },
  gold:   { speedMult: 1.2, hp: 1,  basePoints: 80,  scale: 1.0 },
  boss:   { speedMult: 0.5, hp: 18, basePoints: 250, scale: 2.0 },
};
