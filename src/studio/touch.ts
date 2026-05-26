// 모바일 전용 UI 셋업.
//  - 좌/우 드로워 토글 (📁 미디어, ⚙️ 속성)
//  - 가상 조이스틱 — armedTrackId 있을 때만 표시
//  - 이중탭 줌 / 핀치 / 당겨새로고침 방지 (선택적)

import { state, subscribe } from './state';
import { setStick, isTouchDevice } from './input';

export function initTouch(): void {
  setupDrawers();
  setupStick();
  // iOS Safari 의 더블탭 줌 / 핀치 줌 차단은 viewport meta 로 일부 처리됨.
  // 추가로 게임 영역만 touch-action: none 으로 (CSS 에 이미 적용).
  // 당겨새로고침 방지 — body overscroll 차단.
  document.documentElement.style.overscrollBehavior = 'none';
}

// ===== 드로워 =====

function setupDrawers(): void {
  const bin = document.querySelector('.st-bin') as HTMLElement | null;
  const props = document.querySelector('.st-props') as HTMLElement | null;
  const toggleBin = document.getElementById('btn-toggle-bin');
  const toggleProps = document.getElementById('btn-toggle-props');
  const backdrop = document.getElementById('drawer-backdrop');
  if (!bin || !props || !toggleBin || !toggleProps || !backdrop) return;

  const closeAll = () => {
    bin.classList.remove('st-open');
    props.classList.remove('st-open');
    backdrop.classList.add('hidden');
  };
  const openBin = () => {
    props.classList.remove('st-open');
    bin.classList.add('st-open');
    backdrop.classList.remove('hidden');
  };
  const openProps = () => {
    bin.classList.remove('st-open');
    props.classList.add('st-open');
    backdrop.classList.remove('hidden');
  };
  toggleBin.addEventListener('click', () => {
    bin.classList.contains('st-open') ? closeAll() : openBin();
  });
  toggleProps.addEventListener('click', () => {
    props.classList.contains('st-open') ? closeAll() : openProps();
  });
  backdrop.addEventListener('click', closeAll);
  // 빈에서 "사용" 누르면 자연스럽게 닫히도록 — 빈 영역 내부의 use 버튼 위임.
  bin.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('use')) {
      // 약간 늦춰 — notify() 가 빈을 다시 그릴 시간 줌.
      setTimeout(closeAll, 80);
    }
  });
}

// ===== 가상 조이스틱 =====

let stickEl!: HTMLElement;
let knobEl!: HTMLElement;
let pointerId: number | null = null;
let stickRect: DOMRect | null = null;
const STICK_RADIUS_RATIO = 0.4; // CSS 110px → 44px max throw

function setupStick(): void {
  stickEl = document.getElementById('touch-stick') as HTMLElement;
  knobEl = document.getElementById('touch-stick-knob') as HTMLElement;
  if (!stickEl || !knobEl) return;

  // 표시/숨김 — 터치기기 + armedTrackId 있을 때만.
  const updateVis = () => {
    const shouldShow = isTouchDevice() && !!state.rt.armedTrackId;
    stickEl.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) {
      setStick(0, 0);
      knobEl.style.transform = 'translate(0,0)';
    }
  };
  subscribe(updateVis);
  updateVis();

  const refreshRect = () => { stickRect = stickEl.getBoundingClientRect(); };
  window.addEventListener('resize', refreshRect);
  window.addEventListener('orientationchange', refreshRect);

  const updateKnob = (cx: number, cy: number) => {
    if (!stickRect) refreshRect();
    if (!stickRect) return;
    const ox = stickRect.left + stickRect.width / 2;
    const oy = stickRect.top + stickRect.height / 2;
    const dx = cx - ox;
    const dy = cy - oy;
    const r = stickRect.width * STICK_RADIUS_RATIO;
    const len = Math.hypot(dx, dy) || 1;
    const f = Math.min(1, len / r);
    const nx = (dx / len) * f;
    const ny = (dy / len) * f;
    knobEl.style.transform = `translate(${nx * r}px, ${ny * r}px)`;
    setStick(nx, ny);
  };
  const reset = () => {
    pointerId = null;
    knobEl.style.transform = 'translate(0,0)';
    setStick(0, 0);
  };

  stickEl.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return;
    e.preventDefault();
    pointerId = e.pointerId;
    refreshRect();
    stickEl.setPointerCapture(e.pointerId);
    updateKnob(e.clientX, e.clientY);
  });
  stickEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    updateKnob(e.clientX, e.clientY);
  });
  const onEnd = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    try { stickEl.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    reset();
  };
  stickEl.addEventListener('pointerup', onEnd);
  stickEl.addEventListener('pointercancel', onEnd);
  stickEl.addEventListener('lostpointercapture', () => reset());
}
