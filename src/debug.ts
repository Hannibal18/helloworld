// 개발용 디버그 패널. 백틱(`) 키로 토글.
// 캐릭터 prescale 슬라이더, 충돌/그리드/히트박스 시각화 토글, 현재 좌표 표시.

export interface DebugState {
  visible: boolean;
  showCollision: boolean;
  showGrid: boolean;
  showHitbox: boolean;
  charScale: number;     // LPC prescale 배율 (작을수록 캐릭터 작음)
  viewTilesWide: number; // 화면에 보일 가로 타일 수 (클수록 더 멀리 보임)
  // 게임 루프가 매 프레임 채워주는 정보 (옵션)
  playerX?: number;
  playerY?: number;
  tileX?: number;
  tileY?: number;
}

let panelEl: HTMLElement | null = null;
let coordEl: HTMLElement | null = null;
let tileEl: HTMLElement | null = null;
let scaleValEl: HTMLElement | null = null;

export function setupDebugPanel(
  state: DebugState,
  onScaleChange: (scale: number) => void,
  onViewChange: (tilesWide: number) => void,
): void {
  const root = document.getElementById('game');
  if (!root) return;

  const el = document.createElement('div');
  el.id = 'debug-panel';
  el.className = 'debug-panel hidden';
  el.innerHTML = `
    <div class="dbg-title">DEBUG <span class="dbg-hint">(\` to toggle)</span></div>
    <div class="dbg-row">좌표: <span id="dbg-coord">-</span></div>
    <div class="dbg-row">타일: <span id="dbg-tile">-</span></div>
    <div class="dbg-row">
      <label>시야 (가로 타일 수) <span id="dbg-view-val">${state.viewTilesWide}</span></label>
      <input id="dbg-view" type="range" min="14" max="40" step="1" value="${state.viewTilesWide}" />
    </div>
    <div class="dbg-row">
      <label>캐릭터 스케일 <span id="dbg-scale-val">${state.charScale.toFixed(2)}</span></label>
      <input id="dbg-scale" type="range" min="0.4" max="1.2" step="0.05" value="${state.charScale}" />
    </div>
    <div class="dbg-row"><label><input type="checkbox" id="dbg-col">충돌 박스</label></div>
    <div class="dbg-row"><label><input type="checkbox" id="dbg-grid">그리드</label></div>
    <div class="dbg-row"><label><input type="checkbox" id="dbg-hitbox">히트박스</label></div>
  `;
  root.appendChild(el);
  panelEl = el;
  coordEl = el.querySelector('#dbg-coord');
  tileEl  = el.querySelector('#dbg-tile');
  scaleValEl = el.querySelector('#dbg-scale-val');

  const scaleInput = el.querySelector('#dbg-scale') as HTMLInputElement;
  scaleInput.addEventListener('input', () => {
    const v = parseFloat(scaleInput.value);
    state.charScale = v;
    if (scaleValEl) scaleValEl.textContent = v.toFixed(2);
    onScaleChange(v);
  });

  const viewInput = el.querySelector('#dbg-view') as HTMLInputElement;
  const viewValEl = el.querySelector('#dbg-view-val');
  viewInput.addEventListener('input', () => {
    const v = parseInt(viewInput.value, 10);
    state.viewTilesWide = v;
    if (viewValEl) viewValEl.textContent = String(v);
    onViewChange(v);
  });

  const colBox = el.querySelector('#dbg-col') as HTMLInputElement;
  colBox.checked = state.showCollision;
  colBox.addEventListener('change', () => { state.showCollision = colBox.checked; });

  const gridBox = el.querySelector('#dbg-grid') as HTMLInputElement;
  gridBox.checked = state.showGrid;
  gridBox.addEventListener('change', () => { state.showGrid = gridBox.checked; });

  const hitBox = el.querySelector('#dbg-hitbox') as HTMLInputElement;
  hitBox.checked = state.showHitbox;
  hitBox.addEventListener('change', () => { state.showHitbox = hitBox.checked; });

  // 토글 키
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.code === 'Backquote') {
      // 채팅 입력 중이면 무시
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      state.visible = !state.visible;
      el.classList.toggle('hidden', !state.visible);
      e.preventDefault();
    }
  });
}

// 게임 루프에서 호출 — 현재 좌표/타일 표시.
export function updateDebugInfo(state: DebugState, x: number, y: number, tileSize: number): void {
  if (!state.visible || !panelEl) return;
  state.playerX = x;
  state.playerY = y;
  state.tileX = Math.floor(x / tileSize);
  state.tileY = Math.floor(y / tileSize);
  if (coordEl) coordEl.textContent = `${x.toFixed(1)}, ${y.toFixed(1)}`;
  if (tileEl)  tileEl.textContent  = `${state.tileX}, ${state.tileY}`;
}
