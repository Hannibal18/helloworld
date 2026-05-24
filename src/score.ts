// 좀비 모드 점수/콤보/생존 시간 — 로컬 플레이어 1인 전용 state.
//
// 콤보: 마지막 킬로부터 COMBO_WINDOW_SEC 안에 다음 킬이 들어오면 콤보 증가.
//      배율 = min(COMBO_MAX, 콤보 카운트). 점수 = BASE * 배율.
// 시간 점수: 매 초 +TIME_POINTS_PER_SEC 자동 누적.

const KILL_BASE_POINTS = 10;
const COMBO_WINDOW_SEC = 2.0;
const COMBO_MAX = 8;
const TIME_POINTS_PER_SEC = 1;  // 1초 생존 = 1점
const KILL_POP_DURATION = 0.4;
const COMBO_BREAK_FX_SEC = 0.4;  // 콤보가 만료되면 짧게 알림

export interface ScoreState {
  startedAt: number;            // 모드 시작 시각 (sec)
  kills: number;                // 총 킬 수
  totalScore: number;           // 누적 점수 (킬 + 시간)
  timeBudget: number;           // 매 프레임 dt 누적해서 1초 단위로 변환
  // 콤보
  comboCount: number;
  lastKillAt: number;
  maxCombo: number;
  // 시각 효과용 (HUD pop)
  lastKillScore: number;        // 마지막 킬로 얻은 점수
  killPopUntil: number;         // killScore 팝업 종료
  comboPopUntil: number;        // 콤보 변경 시 잠깐 강조
  comboBreakUntil: number;      // 콤보 끊겼다 알림
  prevComboShown: number;
}

export function makeScore(now: number): ScoreState {
  return {
    startedAt: now,
    kills: 0,
    totalScore: 0,
    timeBudget: 0,
    comboCount: 0,
    lastKillAt: -Infinity,
    maxCombo: 0,
    lastKillScore: 0,
    killPopUntil: 0,
    comboPopUntil: 0,
    comboBreakUntil: 0,
    prevComboShown: 0,
  };
}

// 좀비 1마리 처치 시 호출. 점수 + 콤보 갱신.
// basePoints 생략하면 KILL_BASE_POINTS(10) 기본. 특수 좀비는 zombie.ts 의 spec.basePoints 전달.
export function addKill(s: ScoreState, now: number, basePoints: number = KILL_BASE_POINTS): void {
  s.kills += 1;
  const inWindow = now - s.lastKillAt <= COMBO_WINDOW_SEC;
  s.comboCount = inWindow ? s.comboCount + 1 : 1;
  s.lastKillAt = now;
  if (s.comboCount > s.maxCombo) s.maxCombo = s.comboCount;
  const mult = Math.min(COMBO_MAX, s.comboCount);
  const earned = basePoints * mult;
  s.totalScore += earned;
  s.lastKillScore = earned;
  s.killPopUntil = now + KILL_POP_DURATION;
  s.comboPopUntil = now + KILL_POP_DURATION;
}

// 매 프레임 호출 — 생존 시간 보너스, 콤보 만료 체크.
export function updateScore(s: ScoreState, dt: number, now: number): void {
  s.timeBudget += dt;
  while (s.timeBudget >= 1) {
    s.timeBudget -= 1;
    s.totalScore += TIME_POINTS_PER_SEC;
  }
  if (s.comboCount > 0 && now - s.lastKillAt > COMBO_WINDOW_SEC) {
    if (s.prevComboShown >= 2) s.comboBreakUntil = now + COMBO_BREAK_FX_SEC;
    s.comboCount = 0;
  }
  if (s.comboCount > 0) s.prevComboShown = s.comboCount;
}

// 현재 콤보 배율 (1~COMBO_MAX). 0 = 콤보 안 됨.
export function currentComboMult(s: ScoreState): number {
  return Math.min(COMBO_MAX, s.comboCount);
}

// ===== localStorage 최고 기록 =====
const LS_KEY = 'helloworld:zombie:best';
export interface BestRecord {
  score: number;
  kills: number;
  survivalSec: number;
  maxCombo: number;
}
const EMPTY_BEST: BestRecord = { score: 0, kills: 0, survivalSec: 0, maxCombo: 0 };

export function loadBest(): BestRecord {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...EMPTY_BEST };
    const parsed = JSON.parse(raw);
    return {
      score: Number(parsed.score) || 0,
      kills: Number(parsed.kills) || 0,
      survivalSec: Number(parsed.survivalSec) || 0,
      maxCombo: Number(parsed.maxCombo) || 0,
    };
  } catch {
    return { ...EMPTY_BEST };
  }
}

// 현재 run 결과로 기록 갱신. 갱신된 필드 목록 반환 (NEW RECORD 연출용).
export function commitBest(s: ScoreState, now: number): { updated: (keyof BestRecord)[]; best: BestRecord } {
  const survivalSec = Math.max(0, now - s.startedAt);
  const cur = loadBest();
  const updated: (keyof BestRecord)[] = [];
  const next: BestRecord = { ...cur };
  if (s.totalScore > cur.score)      { next.score = s.totalScore; updated.push('score'); }
  if (s.kills > cur.kills)           { next.kills = s.kills; updated.push('kills'); }
  if (survivalSec > cur.survivalSec) { next.survivalSec = survivalSec; updated.push('survivalSec'); }
  if (s.maxCombo > cur.maxCombo)     { next.maxCombo = s.maxCombo; updated.push('maxCombo'); }
  if (updated.length > 0) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* 시크릿 모드 등 */ }
  }
  return { updated, best: next };
}

// 점수 등급 — 사망 화면 표시용. 임계값 직관 조정.
export function gradeFor(totalScore: number): { letter: string; color: string; tag: string } {
  if (totalScore >= 8000) return { letter: 'S', color: '#ffe080', tag: '전설' };
  if (totalScore >= 5000) return { letter: 'A+', color: '#ffd84a', tag: '훌륭' };
  if (totalScore >= 3000) return { letter: 'A',  color: '#ffd84a', tag: '잘함' };
  if (totalScore >= 1500) return { letter: 'B',  color: '#9cd96a', tag: '괜찮음' };
  if (totalScore >= 500)  return { letter: 'C',  color: '#c9b58d', tag: '평범' };
  return { letter: 'D', color: '#c84a4a', tag: '아쉬움' };
}

// ===== HUD 렌더 — 화면 중앙 상단 점수 + 콤보 =====
export function drawScoreHud(hudCtx: CanvasRenderingContext2D, s: ScoreState, now: number): void {
  const cssW = hudCtx.canvas.clientWidth;
  hudCtx.save();
  hudCtx.textAlign = 'center';
  hudCtx.textBaseline = 'middle';

  // 점수 — 가운데 큰 숫자
  const popT = Math.max(0, s.killPopUntil - now) / KILL_POP_DURATION;  // 1 → 0
  const scoreScale = 1 + popT * 0.18;
  const scoreFontPx = Math.round(28 * scoreScale);
  hudCtx.font = `900 ${scoreFontPx}px "Galmuri11","Apple SD Gothic Neo", system-ui, sans-serif`;
  const scoreText = s.totalScore.toLocaleString();
  const cx = Math.round(cssW / 2);
  const sy = 22 + Math.round(scoreFontPx * 0.5);

  hudCtx.lineWidth = 4;
  hudCtx.strokeStyle = '#1a0e08';
  hudCtx.strokeText(scoreText, cx, sy);
  hudCtx.fillStyle = popT > 0 ? '#fff' : '#ffd84a';
  hudCtx.fillText(scoreText, cx, sy);

  // 콤보 — 점수 바로 아래
  const combo = currentComboMult(s);
  if (combo >= 2) {
    const cPopT = Math.max(0, s.comboPopUntil - now) / KILL_POP_DURATION;
    const cScale = 1 + cPopT * 0.25;
    const cPx = Math.round(20 * cScale);
    hudCtx.font = `900 ${cPx}px "Galmuri11", system-ui, sans-serif`;
    const cText = `COMBO ×${combo}`;
    const cy = sy + Math.round(scoreFontPx * 0.7) + 4;
    hudCtx.lineWidth = 3;
    hudCtx.strokeStyle = '#1a0e08';
    hudCtx.strokeText(cText, cx, cy);
    hudCtx.fillStyle = combo >= 6 ? '#ff7a4a' : combo >= 4 ? '#ffd84a' : '#fff7a0';
    hudCtx.fillText(cText, cx, cy);
  } else if (now < s.comboBreakUntil) {
    const t = Math.max(0, s.comboBreakUntil - now) / COMBO_BREAK_FX_SEC;
    hudCtx.globalAlpha = t;
    hudCtx.font = `700 14px "Galmuri11", system-ui, sans-serif`;
    const cy = sy + Math.round(scoreFontPx * 0.7) + 4;
    hudCtx.fillStyle = '#c84a4a';
    hudCtx.fillText('콤보 끊김', cx, cy);
    hudCtx.globalAlpha = 1;
  }

  // 마지막 킬 점수 — score 바로 옆에서 위로 떠오르며 페이드
  if (popT > 0 && s.lastKillScore > 0) {
    const offY = (1 - popT) * 24;
    hudCtx.globalAlpha = popT;
    hudCtx.font = `900 16px "Galmuri11", system-ui, sans-serif`;
    hudCtx.fillStyle = '#fff7a0';
    hudCtx.fillText(`+${s.lastKillScore}`, cx + 70, sy - offY);
    hudCtx.globalAlpha = 1;
  }

  hudCtx.restore();
}
