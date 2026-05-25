// 게임 밸런스 중앙 설정.
//
// 대시보드(/dashboard.html)에서 편집 → localStorage 저장 → BroadcastChannel 로
// 같은 도메인의 게임 탭에 즉시 반영(라이브 튜닝). 게임은 모든 튜닝값을 여기서 읽음.
//
// 순환 import 회피: ZombieType / WeaponType 을 zombie.ts / weapons.ts 가 아닌
// 여기서 직접 선언 (string union). 두 모듈은 config.ts 를 import 만 함.

export const CFG_ZOMBIE_TYPES = ['normal', 'fast', 'tank', 'gold', 'frank'] as const;
export type CfgZombieType = typeof CFG_ZOMBIE_TYPES[number];

export const CFG_WEAPON_TYPES = ['lightning', 'ice', 'curse'] as const;
export type CfgWeaponType = typeof CFG_WEAPON_TYPES[number];

export interface StageConfig {
  name: string;
  durationSec: number;
  zombie: {
    hpMult: number;             // 좀비 HP 배율 (스폰 시 적용)
    speedMult: number;          // 좀비 속도 배율
    spawnIntervalMult: number;  // 스폰 간격 배율 (작을수록 자주 스폰)
    typeWeights: Record<CfgZombieType, number>;
    bossEnabled: boolean;
  };
  weapons: {
    dropIntervalSec: number;
    maxDropsOnGround: number;
    allowed: Record<CfgWeaponType, boolean>;
    dropWeights: Record<CfgWeaponType, number>;
    damageMult: number;         // 글로벌 데미지 배율 (모든 무기 공통)
    perWeapon: Record<CfgWeaponType, { cooldownMult: number }>;  // 보조 무기 발사 간격 배율
    // AK 강도 — 스테이지 올라갈수록 초당 발사량 증가용.
    // 1.0 = 기본 (0.15s 간격), 2.0 = 두 배 빠름.
    akFireRateMult: number;
    // 라이트닝/얼음/저주 풀차지 시 발사 (구름/마커) 갯수. Stage 1 = 2, 후반 = 7~.
    // 캡 = LIGHTNING_MAX_CLOUDS (weapons.ts 상수, 현재 10).
    chargedReleaseCount: number;
  };
}

function defaultPerWeapon(): Record<CfgWeaponType, { cooldownMult: number }> {
  return {
    lightning: { cooldownMult: 1 }, ice: { cooldownMult: 1 }, curse: { cooldownMult: 1 },
  };
}

export interface GameConfig {
  version: 4;
  player: {
    hpMax: number;
    moveSpeedMult: number;
  };
  score: {
    killBase: number;
    comboWindowSec: number;
    comboMax: number;
    timePointsPerSec: number;
  };
  stages: StageConfig[];                                  // 기본/단독 진입용
  presets?: Record<'easy' | 'normal' | 'hell', StageConfig[]>;  // 매치메이킹 난이도별
  loopLastStage: boolean;
  loopDifficultyStep: number;
}

// ===== 기본 스테이지 5개 (Stage 1 = 워밍업, Stage 5 = 지옥) =====
type ZombieInput = Omit<Partial<StageConfig['zombie']>, 'typeWeights'> & {
  typeWeights?: Partial<Record<CfgZombieType, number>>;
};
function mkStage(name: string, dur: number, z: ZombieInput, w: Partial<StageConfig['weapons']>): StageConfig {
  return {
    name,
    durationSec: dur,
    zombie: {
      hpMult: z.hpMult ?? 1,
      speedMult: z.speedMult ?? 1,
      spawnIntervalMult: z.spawnIntervalMult ?? 1,
      typeWeights: { normal: 100, fast: 0, tank: 0, gold: 0, frank: 0, ...(z.typeWeights ?? {}) },
      bossEnabled: z.bossEnabled ?? false,
    },
    weapons: {
      dropIntervalSec: w.dropIntervalSec ?? 45,
      maxDropsOnGround: w.maxDropsOnGround ?? 3,
      allowed: { lightning: true, ice: false, curse: false, ...(w.allowed ?? {}) },
      dropWeights: { lightning: 12, ice: 8, curse: 5, ...(w.dropWeights ?? {}) },
      damageMult: w.damageMult ?? 1,
      perWeapon: { ...defaultPerWeapon(), ...(w.perWeapon ?? {}) },
      akFireRateMult: w.akFireRateMult ?? 1,
      chargedReleaseCount: w.chargedReleaseCount ?? 2,
    },
  };
}

export const DEFAULT_CONFIG: GameConfig = {
  version: 4,
  player: { hpMax: 140, moveSpeedMult: 1 },
  score: { killBase: 10, comboWindowSec: 2, comboMax: 8, timePointsPerSec: 1 },
  stages: [
    // 🧪 임시 테스트 스테이지 — 얼음/저주/라이트닝 빠른 드랍 + 좀비 적게.
    mkStage('Stage 1 — 🧪 무기 테스트', 300,
      { typeWeights: { normal: 100, fast: 0, tank: 0, gold: 0 }, spawnIntervalMult: 2.0 },
      {
        dropIntervalSec: 3,
        maxDropsOnGround: 12,
        allowed: { lightning: true, ice: true, curse: true },
        dropWeights: { lightning: 1, ice: 1, curse: 1 },
        akFireRateMult: 0.1,
        chargedReleaseCount: 5,  // 테스트라 충분히 보이게
      },
    ),
    mkStage('Stage 2 — 빠른 적 등장', 60,
      { typeWeights: { normal: 70, fast: 25, tank: 0, gold: 5 }, spawnIntervalMult: 0.85, speedMult: 1.05 },
      { dropIntervalSec: 30, allowed: { lightning: true, ice: false, curse: false }, akFireRateMult: 0.3, chargedReleaseCount: 2 },
    ),
    mkStage('Stage 3 — 탱크 합류', 90,
      { typeWeights: { normal: 55, fast: 30, tank: 12, gold: 3 }, spawnIntervalMult: 0.7, speedMult: 1.1, hpMult: 1.1, bossEnabled: true },
      { dropIntervalSec: 25, allowed: { lightning: true, ice: true, curse: false }, akFireRateMult: 0.7, chargedReleaseCount: 3 },
    ),
    mkStage('Stage 4 — 밀려온다', 90,
      { typeWeights: { normal: 40, fast: 35, tank: 20, gold: 5 }, spawnIntervalMult: 0.55, speedMult: 1.15, hpMult: 1.2, bossEnabled: true },
      { dropIntervalSec: 22, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.2, chargedReleaseCount: 5 },
    ),
    mkStage('Stage 5 — 지옥', 120,
      { typeWeights: { normal: 30, fast: 35, tank: 30, gold: 5 }, spawnIntervalMult: 0.4, speedMult: 1.25, hpMult: 1.4, bossEnabled: true },
      { dropIntervalSec: 18, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 2.0, chargedReleaseCount: 8 },
    ),
  ],
  loopLastStage: true,
  loopDifficultyStep: 0.15,
  // ===== 매치메이킹 난이도 프리셋 (전반적으로 어렵게 — 쉬운 것 보다 도전적이게) =====
  presets: {
    easy: [
      mkStage('🟢 EASY 1 — 적응', 60,
        { typeWeights: { normal: 100, fast: 0, tank: 0, gold: 0 }, spawnIntervalMult: 1.1, speedMult: 1.0 },
        { dropIntervalSec: 20, allowed: { lightning: true, ice: false, curse: false }, akFireRateMult: 0.7, chargedReleaseCount: 2 },
      ),
      mkStage('🟢 EASY 2 — 속도', 60,
        { typeWeights: { normal: 60, fast: 35, tank: 5, gold: 0 }, spawnIntervalMult: 0.9, speedMult: 1.05 },
        { dropIntervalSec: 18, allowed: { lightning: true, ice: true, curse: false }, akFireRateMult: 1.0, chargedReleaseCount: 3 },
      ),
      mkStage('🟢 EASY 3 — 합류', 90,
        { typeWeights: { normal: 45, fast: 35, tank: 18, gold: 2 }, spawnIntervalMult: 0.7, speedMult: 1.1, hpMult: 1.15, bossEnabled: true },
        { dropIntervalSec: 16, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.3, chargedReleaseCount: 4 },
      ),
      mkStage('🟢 EASY 4 — 끝없는', 999,
        { typeWeights: { normal: 35, fast: 35, tank: 25, gold: 5 }, spawnIntervalMult: 0.55, speedMult: 1.15, hpMult: 1.25, bossEnabled: true },
        { dropIntervalSec: 14, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.5, chargedReleaseCount: 5 },
      ),
    ],
    normal: [
      mkStage('🟡 NORMAL 1 — 본격', 60,
        { typeWeights: { normal: 70, fast: 25, tank: 5, gold: 0 }, spawnIntervalMult: 0.9, speedMult: 1.05 },
        { dropIntervalSec: 18, allowed: { lightning: true, ice: false, curse: false }, akFireRateMult: 0.6, chargedReleaseCount: 2 },
      ),
      mkStage('🟡 NORMAL 2 — 탱크', 75,
        { typeWeights: { normal: 50, fast: 30, tank: 18, gold: 2 }, spawnIntervalMult: 0.7, speedMult: 1.15, hpMult: 1.15, bossEnabled: true },
        { dropIntervalSec: 15, allowed: { lightning: true, ice: true, curse: false }, akFireRateMult: 1.0, chargedReleaseCount: 3 },
      ),
      mkStage('🟡 NORMAL 3 — 압박', 90,
        { typeWeights: { normal: 35, fast: 35, tank: 25, gold: 5 }, spawnIntervalMult: 0.55, speedMult: 1.25, hpMult: 1.3, bossEnabled: true },
        { dropIntervalSec: 13, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.4, chargedReleaseCount: 4 },
      ),
      mkStage('🟡 NORMAL 4 — 끝없는', 999,
        { typeWeights: { normal: 25, fast: 35, tank: 30, gold: 10 }, spawnIntervalMult: 0.42, speedMult: 1.35, hpMult: 1.5, bossEnabled: true },
        { dropIntervalSec: 11, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.8, chargedReleaseCount: 6 },
      ),
    ],
    hell: [
      mkStage('🔴 HELL 1 — 적의 환영', 50,
        { typeWeights: { normal: 50, fast: 40, tank: 10, gold: 0 }, spawnIntervalMult: 0.65, speedMult: 1.2, hpMult: 1.1, bossEnabled: true },
        { dropIntervalSec: 14, allowed: { lightning: true, ice: false, curse: false }, akFireRateMult: 0.5, chargedReleaseCount: 2 },
      ),
      mkStage('🔴 HELL 2 — 탱크 행렬', 70,
        { typeWeights: { normal: 35, fast: 35, tank: 25, gold: 5 }, spawnIntervalMult: 0.5, speedMult: 1.3, hpMult: 1.25, bossEnabled: true },
        { dropIntervalSec: 12, allowed: { lightning: true, ice: true, curse: false }, akFireRateMult: 1.0, chargedReleaseCount: 3 },
      ),
      mkStage('🔴 HELL 3 — 광기', 80,
        { typeWeights: { normal: 25, fast: 35, tank: 30, gold: 10 }, spawnIntervalMult: 0.4, speedMult: 1.4, hpMult: 1.45, bossEnabled: true },
        { dropIntervalSec: 10, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.5, chargedReleaseCount: 5 },
      ),
      mkStage('🔴 HELL 4 — 절망', 90,
        { typeWeights: { normal: 15, fast: 30, tank: 40, gold: 15 }, spawnIntervalMult: 0.35, speedMult: 1.45, hpMult: 1.65, bossEnabled: true },
        { dropIntervalSec: 9, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 1.8, chargedReleaseCount: 7 },
      ),
      mkStage('🔴 HELL 5 — 끝없는 죽음', 999,
        { typeWeights: { normal: 10, fast: 25, tank: 45, gold: 20 }, spawnIntervalMult: 0.3, speedMult: 1.55, hpMult: 1.9, bossEnabled: true },
        { dropIntervalSec: 8, allowed: { lightning: true, ice: true, curse: true }, akFireRateMult: 2.2, chargedReleaseCount: 10 },
      ),
    ],
  },
};

// ===== 저장/로드 =====
const STORAGE_KEY = 'helloworld:config:v1';
const CHANNEL_NAME = 'helloworld-config';

function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

// 저장된 설정과 기본값을 머지 — 필드가 추가돼도 옛 저장본이 깨지지 않게.
// 버전이 다르면 stages 만 기본값으로 리셋 (플레이어/점수 등 글로벌은 보존).
function migrate(raw: unknown): GameConfig {
  if (!raw || typeof raw !== 'object') return deepClone(DEFAULT_CONFIG);
  const r = raw as Partial<GameConfig>;
  const versionOk = r.version === 4;
  const merged: GameConfig = {
    version: 4,
    player: { ...DEFAULT_CONFIG.player, ...(r.player ?? {}) },
    score: { ...DEFAULT_CONFIG.score, ...(r.score ?? {}) },
    stages: versionOk && Array.isArray(r.stages) && r.stages.length > 0
      ? r.stages.map((s) => mergeStage(s as Partial<StageConfig>))
      : deepClone(DEFAULT_CONFIG.stages),
    loopLastStage: r.loopLastStage ?? DEFAULT_CONFIG.loopLastStage,
    loopDifficultyStep: r.loopDifficultyStep ?? DEFAULT_CONFIG.loopDifficultyStep,
  };
  return merged;
}

function mergeStage(s: Partial<StageConfig>): StageConfig {
  const base = DEFAULT_CONFIG.stages[0];
  return {
    name: s.name ?? base.name,
    durationSec: s.durationSec ?? base.durationSec,
    zombie: {
      hpMult: s.zombie?.hpMult ?? base.zombie.hpMult,
      speedMult: s.zombie?.speedMult ?? base.zombie.speedMult,
      spawnIntervalMult: s.zombie?.spawnIntervalMult ?? base.zombie.spawnIntervalMult,
      typeWeights: { ...base.zombie.typeWeights, ...(s.zombie?.typeWeights ?? {}) },
      bossEnabled: s.zombie?.bossEnabled ?? base.zombie.bossEnabled,
    },
    weapons: {
      dropIntervalSec: s.weapons?.dropIntervalSec ?? base.weapons.dropIntervalSec,
      maxDropsOnGround: s.weapons?.maxDropsOnGround ?? base.weapons.maxDropsOnGround,
      allowed: { ...base.weapons.allowed, ...(s.weapons?.allowed ?? {}) },
      dropWeights: { ...base.weapons.dropWeights, ...(s.weapons?.dropWeights ?? {}) },
      damageMult: s.weapons?.damageMult ?? base.weapons.damageMult,
      perWeapon: { ...defaultPerWeapon(), ...(s.weapons?.perWeapon ?? {}) },
      akFireRateMult: s.weapons?.akFireRateMult ?? base.weapons.akFireRateMult,
      chargedReleaseCount: s.weapons?.chargedReleaseCount ?? base.weapons.chargedReleaseCount,
    },
  };
}

let current: GameConfig = loadFromStorage();
const listeners = new Set<(cfg: GameConfig) => void>();

function loadFromStorage(): GameConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return deepClone(DEFAULT_CONFIG);
    return migrate(JSON.parse(raw));
  } catch {
    return deepClone(DEFAULT_CONFIG);
  }
}

export function getConfig(): GameConfig {
  return current;
}

export function setConfig(cfg: GameConfig, fromChannel = false): void {
  current = cfg;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* 시크릿 모드 */ }
  if (!fromChannel && channel) channel.postMessage({ type: 'update', cfg });
  for (const l of listeners) l(cfg);
}

export function resetConfig(): GameConfig {
  const fresh = deepClone(DEFAULT_CONFIG);
  setConfig(fresh);
  return fresh;
}

export function onConfigChange(fn: (cfg: GameConfig) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// 다른 탭(대시보드↔게임)에서 변경 시 라이브 반영.
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
if (channel) {
  channel.onmessage = (e) => {
    const d = e.data as { type?: string; cfg?: GameConfig } | null;
    if (d?.type === 'update' && d.cfg) setConfig(d.cfg, true);
  };
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try { setConfig(migrate(JSON.parse(e.newValue)), true); } catch { /* noop */ }
    }
  });
}

// ===== 스테이지 진행 — 경과 시간으로 현재 스테이지/잔여 시간 계산 =====
export interface StageProgress {
  stage: StageConfig;       // 루프 난이도 보정이 적용된 사본
  rawStage: StageConfig;    // 원본 (대시보드 표시용)
  index: number;
  loopIdx: number;
  totalIdx: number;         // 전체 진행 순번 (loopIdx * len + index)
  remainingSec: number;
  stageElapsed: number;
}

export function getStageProgress(cfg: GameConfig, elapsed: number): StageProgress {
  const stages = getActiveStages(cfg);
  if (stages.length === 0) {
    const f = DEFAULT_CONFIG.stages[0];
    return { stage: f, rawStage: f, index: 0, loopIdx: 0, totalIdx: 0, remainingSec: Infinity, stageElapsed: 0 };
  }
  const totalLoopDur = stages.reduce((s, st) => s + Math.max(1, st.durationSec), 0);
  let t = Math.max(0, elapsed);
  let loopIdx = 0;
  if (cfg.loopLastStage && totalLoopDur > 0) {
    loopIdx = Math.floor(t / totalLoopDur);
    t = t - loopIdx * totalLoopDur;
  } else if (t >= totalLoopDur) {
    const last = stages[stages.length - 1];
    const applied = applyLoopMult(last, loopIdx, cfg.loopDifficultyStep);
    return { stage: applied, rawStage: last, index: stages.length - 1, loopIdx, totalIdx: stages.length - 1, remainingSec: Infinity, stageElapsed: t - (totalLoopDur - Math.max(1, last.durationSec)) };
  }
  let acc = 0;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const dur = Math.max(1, s.durationSec);
    if (t < acc + dur) {
      const applied = applyLoopMult(s, loopIdx, cfg.loopDifficultyStep);
      return {
        stage: applied,
        rawStage: s,
        index: i,
        loopIdx,
        totalIdx: loopIdx * stages.length + i,
        remainingSec: acc + dur - t,
        stageElapsed: t - acc,
      };
    }
    acc += dur;
  }
  const last = stages[stages.length - 1];
  const applied = applyLoopMult(last, loopIdx, cfg.loopDifficultyStep);
  return { stage: applied, rawStage: last, index: stages.length - 1, loopIdx, totalIdx: loopIdx * stages.length + stages.length - 1, remainingSec: 0, stageElapsed: 0 };
}

function applyLoopMult(s: StageConfig, loopIdx: number, step: number): StageConfig {
  if (loopIdx === 0 || step === 0) return s;
  const m = 1 + step * loopIdx;
  return {
    ...s,
    name: `${s.name} (Loop ${loopIdx + 1})`,
    zombie: {
      ...s.zombie,
      hpMult: s.zombie.hpMult * m,
      speedMult: s.zombie.speedMult * (1 + step * loopIdx * 0.5),
      spawnIntervalMult: s.zombie.spawnIntervalMult / m,
    },
    weapons: { ...s.weapons },
  };
}

// 빈 스테이지 한 칸 — 대시보드 "추가" 버튼에서 사용
export function emptyStage(name: string): StageConfig {
  return mergeStage({ name, durationSec: 60 });
}

// ===== 활성 stages 오버라이드 (매치메이킹 난이도 적용용) =====
// game.ts 가 배틀 시작 시 setActiveStagesOverride(preset) 호출 →
// getStageProgress 가 cfg.stages 대신 이걸 사용. null 이면 cfg.stages.
let _stagesOverride: StageConfig[] | null = null;
export function setActiveStagesOverride(s: StageConfig[] | null): void {
  _stagesOverride = s;
}
export function getActiveStages(cfg: GameConfig): StageConfig[] {
  return _stagesOverride ?? cfg.stages;
}

// ===== 현재 스테이지 weapons 캐시 =====
// 순환 import 회피용: weapons.ts / player.ts / game.ts 가 공유. 이 모듈은
// 의존성이 없으므로 어느 모듈에서나 안전하게 import 가능.
let _currentStageWeapons: StageConfig['weapons'] | null = null;
export function setStageWeapons(w: StageConfig['weapons'] | null): void {
  _currentStageWeapons = w;
}
export function getStageWeaponsCurrent(): StageConfig['weapons'] | null {
  return _currentStageWeapons;
}
export function getStageDamageMult(): number {
  return _currentStageWeapons?.damageMult ?? 1;
}
// AK 발사 간격에 곱할 배율. fireRateMult 클수록 cooldown 작아짐.
export function getStageAkCooldownMult(): number {
  const m = _currentStageWeapons?.akFireRateMult ?? 1;
  return m > 0 ? 1 / m : 1;
}
// 라이트닝/얼음/저주 풀차지 시 발사 갯수. cap 으로 상한 클램프.
export function getStageChargedCount(cap: number): number {
  const n = _currentStageWeapons?.chargedReleaseCount ?? 2;
  return Math.max(1, Math.min(cap, Math.round(n)));
}
