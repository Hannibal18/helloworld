// 모바일 가상 컨트롤: 좌측 조이스틱 + 우측 공격 버튼.
// 채팅은 입력칸 항상 표시되므로 별도 버튼 없음.
// 멀티터치: 손가락마다 identifier가 다르므로, 조이스틱과 공격 버튼이 동시에 눌려도 둘 다 동작한다.

import { setStick, pressAttack, releaseAttack, pressMentalAttack } from './input';

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export function setupTouchControls(): void {
  const root = document.getElementById('touch-controls') as HTMLElement | null;
  const stick = document.getElementById('stick') as HTMLElement | null;
  const knob = document.getElementById('stick-knob') as HTMLElement | null;
  const btnAttack = document.getElementById('btn-attack') as HTMLElement | null;
  const btnMental = document.getElementById('btn-mental') as HTMLElement | null;

  if (!root || !stick || !knob || !btnAttack) return;

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
  // 조이스틱과 동시 동작을 위해 자체 touch 만 받고, 다른 손가락 식별자에 영향 X.
  // 누르고 있는 동안 attackHeld=true → 총 보유 중이면 자동 사격 (펀치는 단발).
  const onAttackDown = (e: Event) => {
    e.preventDefault();
    pressAttack();
  };
  const onAttackUp = () => releaseAttack();
  btnAttack.addEventListener('touchstart', onAttackDown, { passive: false });
  btnAttack.addEventListener('touchend', onAttackUp);
  btnAttack.addEventListener('touchcancel', onAttackUp);
  btnAttack.addEventListener('mousedown', onAttackDown);
  window.addEventListener('mouseup', onAttackUp);

  // ===== 멘탈 공격 버튼 (욕 채팅 자동 송신) =====
  if (btnMental) {
    const onMentalDown = (e: Event) => {
      e.preventDefault();
      pressMentalAttack();
    };
    btnMental.addEventListener('touchstart', onMentalDown, { passive: false });
    btnMental.addEventListener('mousedown', onMentalDown);
  }
}
