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

// ===== 가상 조이스틱 (TouchEvent — iOS Safari 호환) =====

let stickEl!: HTMLElement;
let knobEl!: HTMLElement;
let stickTouchId: number | null = null;
let stickRect: DOMRect | null = null;
const STICK_RADIUS_RATIO = 0.4;

function setupStick(): void {
  stickEl = document.getElementById('touch-stick') as HTMLElement;
  knobEl = document.getElementById('touch-stick-knob') as HTMLElement;
  if (!stickEl || !knobEl) return;

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
    stickTouchId = null;
    knobEl.style.transform = 'translate(0,0)';
    setStick(0, 0);
  };

  // touchstart 는 stick 자체에서만 (다른 손가락이 다른 곳을 만져도 무시).
  stickEl.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    e.preventDefault();
    if (stickTouchId === null) {
      stickTouchId = t.identifier;
      refreshRect();
      updateKnob(t.clientX, t.clientY);
    }
  }, { passive: false });

  // 손가락이 stick 밖으로 나가도 따라가도록 document 에서 listen.
  document.addEventListener('touchmove', (e) => {
    if (stickTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickTouchId) {
        e.preventDefault();
        updateKnob(t.clientX, t.clientY);
        break;
      }
    }
  }, { passive: false });

  const endHandler = (e: TouchEvent): void => {
    if (stickTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickTouchId) { reset(); break; }
    }
  };
  document.addEventListener('touchend', endHandler);
  document.addEventListener('touchcancel', endHandler);

  // 데스크톱 폴백 — 마우스로도 조이스틱 테스트 가능 (모바일이 안 보이면 안 동작)
  let mouseDown = false;
  stickEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    mouseDown = true; refreshRect();
    updateKnob(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    updateKnob(e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false; reset();
  });

  // 표시/숨김 — 터치기기 + armedTrackId 있을 때만. (reset 정의 이후에 호출돼야 TDZ 회피)
  const updateVis = () => {
    const shouldShow = isTouchDevice() && !!state.rt.armedTrackId;
    stickEl.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) reset();
  };
  subscribe(updateVis);
  updateVis();
}
