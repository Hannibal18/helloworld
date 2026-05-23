// 모바일 가상 컨트롤: 좌측 조이스틱 + 우측 공격/채팅 버튼.
// 멀티터치: 손가락마다 identifier가 다르므로, 조이스틱과 공격 버튼이 동시에 눌려도 둘 다 동작한다.

import { setStick, pressAttack } from './input';

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export interface ControlsOpts {
  onChat: () => void;
}

export function setupTouchControls(opts: ControlsOpts): void {
  const root = document.getElementById('touch-controls') as HTMLElement | null;
  const stick = document.getElementById('stick') as HTMLElement | null;
  const knob = document.getElementById('stick-knob') as HTMLElement | null;
  const btnAttack = document.getElementById('btn-attack') as HTMLElement | null;
  const btnChat = document.getElementById('btn-chat') as HTMLElement | null;

  if (!root || !stick || !knob || !btnAttack || !btnChat) return;

  if (!isTouchDevice()) {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');

  // ===== 조이스틱 =====
  let stickTouchId: number | null = null;
  let stickRect = stick.getBoundingClientRect();

  const refreshRect = () => { stickRect = stick.getBoundingClientRect(); };
  window.addEventListener('resize', refreshRect);
  window.addEventListener('orientationchange', refreshRect);

  const stickStart = (id: number, clientX: number, clientY: number) => {
    stickTouchId = id;
    refreshRect();
    moveKnob(clientX, clientY);
  };
  const moveKnob = (clientX: number, clientY: number) => {
    const cx = stickRect.left + stickRect.width / 2;
    const cy = stickRect.top + stickRect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const r = stickRect.width * 0.4; // 최대 반경
    const len = Math.hypot(dx, dy) || 1;
    const f = Math.min(1, len / r);
    const nx = (dx / len) * f;
    const ny = (dy / len) * f;
    knob.style.transform = `translate(${nx * r}px, ${ny * r}px)`;
    setStick(nx, ny);
  };
  const stickEnd = () => {
    stickTouchId = null;
    knob.style.transform = `translate(0px, 0px)`;
    setStick(0, 0);
  };

  stick.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    e.preventDefault();
    if (stickTouchId === null) stickStart(t.identifier, t.clientX, t.clientY);
  }, { passive: false });

  // 손가락이 스틱을 벗어나도 추적되도록 document 레벨에서 듣는다.
  document.addEventListener('touchmove', (e) => {
    if (stickTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickTouchId) {
        e.preventDefault();
        moveKnob(t.clientX, t.clientY);
        break;
      }
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (stickTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickTouchId) { stickEnd(); break; }
    }
  });
  document.addEventListener('touchcancel', (e) => {
    if (stickTouchId === null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stickTouchId) { stickEnd(); break; }
    }
  });

  // ===== 공격 버튼 =====
  // 조이스틱과 동시 동작을 위해 자체 touchstart 만 받고, 다른 손가락 식별자에 영향 X.
  const onAttackDown = (e: Event) => {
    e.preventDefault();
    pressAttack();
  };
  btnAttack.addEventListener('touchstart', onAttackDown, { passive: false });
  btnAttack.addEventListener('mousedown', onAttackDown);

  // ===== 채팅 버튼 =====
  const onChatDown = (e: Event) => {
    e.preventDefault();
    opts.onChat();
  };
  btnChat.addEventListener('touchstart', onChatDown, { passive: false });
  btnChat.addEventListener('click', onChatDown);
}
