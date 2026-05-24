// 밸런스 대시보드 UI — 별도 Vite 엔트리 (/dashboard.html).
//
// 사용 흐름:
//   1) 사용자가 폼 수정 → 로컬 사본(draft) 갱신
//   2) "💾 저장" 클릭 → localStorage 저장 + BroadcastChannel 로 게임 탭에 push
//   3) 게임 탭은 onConfigChange 로 즉시 반영
//
// Export/Import 는 JSON 텍스트로 — 디바이스간 설정 공유용.

import {
  CFG_WEAPON_TYPES, CFG_ZOMBIE_TYPES, DEFAULT_CONFIG, emptyStage,
  getConfig, resetConfig, setConfig,
  type CfgWeaponType, type CfgZombieType, type GameConfig, type StageConfig,
} from './config';

const ZOMBIE_LABEL: Record<CfgZombieType, string> = {
  normal: '🧟 일반', fast: '🏃 빠른', tank: '🛡 탱크', gold: '💰 골드',
};
const WEAPON_LABEL: Record<CfgWeaponType, string> = {
  lightning: '⚡ 라이트닝', ice: '❄ 얼음', curse: '💀 저주',
};

// 작업본 — 폼이 매번 setConfig 하지 않고 메모리에서 누적, "저장" 시 한 번에 커밋.
let draft: GameConfig = deepClone(getConfig());

function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

function toast(msg: string, kind: 'ok' | 'danger' = 'ok'): void {
  const t = $<HTMLDivElement>('toast');
  t.textContent = msg;
  t.classList.remove('hidden', 'danger');
  if (kind === 'danger') t.classList.add('danger');
  setTimeout(() => t.classList.add('hidden'), 1800);
}

// ===== 렌더 =====
function render(): void {
  const root = $<HTMLDivElement>('dash-root');
  root.innerHTML = '';
  root.appendChild(renderGlobalSection());
  root.appendChild(renderStagesSection());
}

function el(tag: string, opts: { className?: string; html?: string; text?: string } = {}, children: (HTMLElement | string)[] = []): HTMLElement {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.html !== undefined) e.innerHTML = opts.html;
  if (opts.text !== undefined) e.textContent = opts.text;
  for (const c of children) e.append(c);
  return e;
}

interface NumberFieldOpts { label: string; hint?: string; step?: number; min?: number; max?: number; }
function numberField(value: number, opts: NumberFieldOpts, onChange: (v: number) => void): HTMLElement {
  const wrap = el('div', { className: 'field' });
  wrap.append(el('label', { className: 'field-label', text: opts.label }));
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'field-input';
  input.value = String(value);
  if (opts.step !== undefined) input.step = String(opts.step);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) onChange(v);
  });
  wrap.append(input);
  if (opts.hint) wrap.append(el('div', { className: 'field-hint', text: opts.hint }));
  return wrap;
}

function checkbox(value: boolean, label: string, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = value;
  cb.addEventListener('change', () => onChange(cb.checked));
  wrap.append(cb, document.createTextNode(label));
  return wrap;
}

// ----- 글로벌 섹션 -----
function renderGlobalSection(): HTMLElement {
  const sec = el('section', { className: 'dash-section' });
  sec.append(
    el('h2', {}, ['🌐 글로벌 설정']),
    el('p', { className: 'dash-section-desc', text: '플레이어/점수/콤보 같은 게임 전체 공통 값.' }),
  );

  const playerBlock = el('div', { className: 'stage-sub' });
  playerBlock.append(el('h3', { text: '플레이어' }));
  const playerGrid = el('div', { className: 'field-grid' });
  playerGrid.append(
    numberField(draft.player.hpMax, { label: '최대 HP', step: 1, min: 1 }, (v) => { draft.player.hpMax = v; }),
    numberField(draft.player.moveSpeedMult, { label: '이동 속도 배율', step: 0.05, min: 0.1, hint: '1.0 = 기본' }, (v) => { draft.player.moveSpeedMult = v; }),
  );
  playerBlock.append(playerGrid);

  const scoreBlock = el('div', { className: 'stage-sub' });
  scoreBlock.append(el('h3', { text: '점수 / 콤보' }));
  const scoreGrid = el('div', { className: 'field-grid' });
  scoreGrid.append(
    numberField(draft.score.killBase, { label: '킬 기본 점수', step: 1, min: 1 }, (v) => { draft.score.killBase = v; }),
    numberField(draft.score.comboWindowSec, { label: '콤보 윈도우 (초)', step: 0.1, min: 0.1 }, (v) => { draft.score.comboWindowSec = v; }),
    numberField(draft.score.comboMax, { label: '콤보 최대 배율', step: 1, min: 1 }, (v) => { draft.score.comboMax = v; }),
    numberField(draft.score.timePointsPerSec, { label: '초당 생존 점수', step: 1, min: 0 }, (v) => { draft.score.timePointsPerSec = v; }),
  );
  scoreBlock.append(scoreGrid);

  const loopBlock = el('div', { className: 'stage-sub' });
  loopBlock.append(el('h3', { text: '루프 (마지막 스테이지 이후)' }));
  const loopGrid = el('div', { className: 'field-grid' });
  const loopWrap = el('div', { className: 'field' });
  loopWrap.append(el('label', { className: 'field-label', text: '마지막 스테이지 끝나면 처음부터' }));
  const loopRow = el('div', { className: 'field-row' });
  loopRow.append(checkbox(draft.loopLastStage, '루프 사용', (v) => { draft.loopLastStage = v; }));
  loopWrap.append(loopRow);
  loopGrid.append(
    loopWrap,
    numberField(draft.loopDifficultyStep, { label: '루프당 난이도 증가율', step: 0.05, min: 0, hint: '0.15 = 한 바퀴 돌 때마다 +15%' }, (v) => { draft.loopDifficultyStep = v; }),
  );
  loopBlock.append(loopGrid);

  sec.append(playerBlock, scoreBlock, loopBlock);
  return sec;
}

// ----- 스테이지 섹션 -----
function renderStagesSection(): HTMLElement {
  const sec = el('section', { className: 'dash-section' });
  sec.append(
    el('h2', {}, ['🎯 스테이지']),
    el('p', { className: 'dash-section-desc', text: '시간 순서대로 진행됩니다. 각 스테이지에서 좀비 구성·무기 드랍을 정밀 조정.' }),
  );
  draft.stages.forEach((stage, idx) => sec.append(renderStageCard(stage, idx)));

  const addBtn = el('button', { className: 'stage-add', text: '+ 스테이지 추가' });
  addBtn.addEventListener('click', () => {
    draft.stages.push(emptyStage(`Stage ${draft.stages.length + 1}`));
    render();
  });
  sec.append(addBtn);
  return sec;
}

function renderStageCard(stage: StageConfig, idx: number): HTMLElement {
  const card = el('div', { className: 'stage-card' });

  // 헤더 — 번호, 이름, 위/아래/삭제
  const head = el('div', { className: 'stage-card-head' });
  head.append(el('span', { className: 'stage-num', text: String(idx + 1) }));
  const nameInput = document.createElement('input');
  nameInput.className = 'field-input';
  nameInput.value = stage.name;
  nameInput.addEventListener('input', () => { stage.name = nameInput.value; });
  head.append(nameInput);

  const btns = el('div', { className: 'stage-btns' });
  const upBtn = el('button', { className: 'dash-btn icon-btn', text: '↑' });
  upBtn.title = '위로';
  upBtn.addEventListener('click', () => {
    if (idx > 0) {
      [draft.stages[idx - 1], draft.stages[idx]] = [draft.stages[idx], draft.stages[idx - 1]];
      render();
    }
  });
  const downBtn = el('button', { className: 'dash-btn icon-btn', text: '↓' });
  downBtn.title = '아래로';
  downBtn.addEventListener('click', () => {
    if (idx < draft.stages.length - 1) {
      [draft.stages[idx], draft.stages[idx + 1]] = [draft.stages[idx + 1], draft.stages[idx]];
      render();
    }
  });
  const delBtn = el('button', { className: 'dash-btn dash-btn-danger icon-btn', text: '🗑' });
  delBtn.title = '삭제';
  delBtn.addEventListener('click', () => {
    if (draft.stages.length === 1) { toast('마지막 스테이지는 삭제할 수 없어요', 'danger'); return; }
    if (!confirm(`"${stage.name}" 삭제할까요?`)) return;
    draft.stages.splice(idx, 1);
    render();
  });
  btns.append(upBtn, downBtn, delBtn);
  head.append(btns);
  card.append(head);

  // 기본 — 지속 시간
  const baseGrid = el('div', { className: 'field-grid' });
  baseGrid.append(
    numberField(stage.durationSec, { label: '지속 시간 (초)', step: 5, min: 5 }, (v) => { stage.durationSec = v; }),
  );
  card.append(baseGrid);

  // 좀비 블록
  card.append(renderZombieBlock(stage));
  // 무기 블록
  card.append(renderWeaponsBlock(stage));

  return card;
}

function renderZombieBlock(stage: StageConfig): HTMLElement {
  const block = el('div', { className: 'stage-sub' });
  block.append(el('h3', { text: '🧟 좀비' }));

  const grid = el('div', { className: 'field-grid' });
  grid.append(
    numberField(stage.zombie.hpMult, { label: 'HP 배율', step: 0.1, min: 0.1, hint: '탱크·보스에 큰 영향' }, (v) => { stage.zombie.hpMult = v; }),
    numberField(stage.zombie.speedMult, { label: '속도 배율', step: 0.05, min: 0.1 }, (v) => { stage.zombie.speedMult = v; }),
    numberField(stage.zombie.spawnIntervalMult, { label: '스폰 간격 배율', step: 0.05, min: 0.1, hint: '작을수록 많이 나옴' }, (v) => { stage.zombie.spawnIntervalMult = v; }),
  );
  block.append(grid);

  const wGridLabel = el('div', { className: 'field-label', text: '타입별 스폰 가중치 (합쳐서 비율로 환산)' });
  wGridLabel.style.marginTop = '10px';
  block.append(wGridLabel);
  const wGrid = el('div', { className: 'weight-grid' });
  for (const t of CFG_ZOMBIE_TYPES) {
    wGrid.append(el('div', { className: 'weight-name', text: ZOMBIE_LABEL[t] }));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-input';
    input.min = '0'; input.step = '1';
    input.value = String(stage.zombie.typeWeights[t] ?? 0);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) stage.zombie.typeWeights[t] = Math.max(0, v);
    });
    wGrid.append(input);
  }
  block.append(wGrid);

  const bossRow = el('div', { className: 'field-row' });
  bossRow.style.marginTop = '8px';
  bossRow.append(checkbox(stage.zombie.bossEnabled, '👹 보스 등장 (90초 주기)', (v) => { stage.zombie.bossEnabled = v; }));
  block.append(bossRow);

  return block;
}

function renderWeaponsBlock(stage: StageConfig): HTMLElement {
  const block = el('div', { className: 'stage-sub' });
  block.append(el('h3', { text: '🗡 무기' }));

  const grid = el('div', { className: 'field-grid' });
  grid.append(
    numberField(stage.weapons.dropIntervalSec, { label: '드랍 간격 (초)', step: 1, min: 1 }, (v) => { stage.weapons.dropIntervalSec = v; }),
    numberField(stage.weapons.maxDropsOnGround, { label: '땅에 동시 존재 최대', step: 1, min: 1 }, (v) => { stage.weapons.maxDropsOnGround = v; }),
    numberField(stage.weapons.damageMult, { label: '데미지 배율', step: 0.1, min: 0.1, hint: '총알/투사체 공격력' }, (v) => { stage.weapons.damageMult = v; }),
  );
  block.append(grid);

  // 허용 무기
  const allowLabel = el('div', { className: 'field-label', text: '이 스테이지에서 드랍 가능한 무기' });
  allowLabel.style.marginTop = '10px';
  block.append(allowLabel);
  const checkGrid = el('div', { className: 'check-grid' });
  for (const w of CFG_WEAPON_TYPES) {
    checkGrid.append(checkbox(stage.weapons.allowed[w], WEAPON_LABEL[w], (v) => { stage.weapons.allowed[w] = v; }));
  }
  block.append(checkGrid);

  // 드랍 가중치
  const wLabel = el('div', { className: 'field-label', text: '무기별 드랍 가중치' });
  wLabel.style.marginTop = '10px';
  block.append(wLabel);
  const wGrid = el('div', { className: 'weight-grid' });
  for (const w of CFG_WEAPON_TYPES) {
    wGrid.append(el('div', { className: 'weight-name', text: WEAPON_LABEL[w] }));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-input';
    input.min = '0'; input.step = '1';
    input.value = String(stage.weapons.dropWeights[w] ?? 0);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) stage.weapons.dropWeights[w] = Math.max(0, v);
    });
    wGrid.append(input);
  }
  block.append(wGrid);

  // 무기별 쿨다운 배율 — 작을수록 빠른 발사 (0.5 = 두 배 빠르게)
  const cdLabel = el('div', { className: 'field-label', text: '무기별 쿨다운 배율 (작을수록 빠른 발사)' });
  cdLabel.style.marginTop = '10px';
  block.append(cdLabel);
  const cdGrid = el('div', { className: 'weight-grid' });
  for (const w of CFG_WEAPON_TYPES) {
    cdGrid.append(el('div', { className: 'weight-name', text: WEAPON_LABEL[w] }));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-input';
    input.min = '0.1'; input.step = '0.05';
    input.value = String(stage.weapons.perWeapon?.[w]?.cooldownMult ?? 1);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) {
        if (!stage.weapons.perWeapon) {
          stage.weapons.perWeapon = { lightning: { cooldownMult: 1 }, ice: { cooldownMult: 1 }, curse: { cooldownMult: 1 } };
        }
        stage.weapons.perWeapon[w].cooldownMult = Math.max(0.1, v);
      }
    });
    cdGrid.append(input);
  }
  block.append(cdGrid);

  return block;
}

// ===== 액션 =====
function save(): void {
  setConfig(deepClone(draft));
  toast('💾 저장 완료 — 게임 탭에 반영됐어요');
}

function doReset(): void {
  if (!confirm('정말 기본값으로 되돌릴까요? 모든 커스텀 설정이 사라집니다.')) return;
  draft = deepClone(resetConfig() || DEFAULT_CONFIG);
  render();
  toast('↺ 기본값 복원됨');
}

function doExport(): void {
  const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `helloworld-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('📤 JSON 다운로드 시작');
}

function doImport(): void {
  $<HTMLInputElement>('import-file').click();
}

// ===== 부팅 =====
function init(): void {
  render();
  $<HTMLButtonElement>('btn-save').addEventListener('click', save);
  $<HTMLButtonElement>('btn-reset').addEventListener('click', doReset);
  $<HTMLButtonElement>('btn-export').addEventListener('click', doExport);
  $<HTMLButtonElement>('btn-import').addEventListener('click', doImport);
  $<HTMLInputElement>('import-file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    f.text().then((text) => {
      try {
        const parsed = JSON.parse(text);
        setConfig(parsed);
        draft = deepClone(getConfig());
        render();
        toast('📥 가져오기 완료');
      } catch {
        toast('JSON 파싱 실패', 'danger');
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
