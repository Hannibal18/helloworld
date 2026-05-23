// PC 키보드/마우스 + 모바일 터치 입력이 같은 inputState 로 흘러들어가도록 추상화한다.
// 채팅 입력 포커스 중에는 모든 게임 키 입력이 차단된다.

import type { Dir } from './types';

export interface InputState {
  moveX: number; // -1, 0, 1
  moveY: number; // -1, 0, 1
  // 스틱 raw vector (모바일에서 0~1 부드러운 값, PC는 정수 ±1)
  stickX: number;
  stickY: number;
  attackQueued: boolean; // 다음 게임 틱에서 소비 (edge-trigger: 펀치 단발용)
  attackHeld: boolean;   // 공격 버튼/키 누르고 있는 동안 true (총 자동 사격용)
  mentalAttackQueued: boolean; // 멘탈 공격(욕 채팅) — 다음 틱에서 소비
}

export const input: InputState = {
  moveX: 0, moveY: 0, stickX: 0, stickY: 0,
  attackQueued: false, attackHeld: false,
  mentalAttackQueued: false,
};

let isChatActive: () => boolean = () => false;

const keys = new Set<string>();

function recomputeMoveFromKeys(): void {
  let mx = 0, my = 0;
  if (keys.has('arrowleft') || keys.has('a')) mx -= 1;
  if (keys.has('arrowright') || keys.has('d')) mx += 1;
  if (keys.has('arrowup') || keys.has('w')) my -= 1;
  if (keys.has('arrowdown') || keys.has('s')) my += 1;
  // 키보드는 raw 정수 — 터치가 다른 소스로 덮어쓰지 않는 한 우선.
  input.moveX = mx;
  input.moveY = my;
  input.stickX = mx;
  input.stickY = my;
}

export function setupInput(opts: { isChatActive: () => boolean }): void {
  isChatActive = opts.isChatActive;

  window.addEventListener('keydown', (e) => {
    if (isChatActive()) return;
    const k = e.key.toLowerCase();
    if (['arrowleft','arrowright','arrowup','arrowdown',' ','w','a','s','d','x'].includes(k)) {
      e.preventDefault();
    }
    if (k === ' ') {
      if (!keys.has(' ')) input.attackQueued = true;
      input.attackHeld = true;
      keys.add(' ');
      return;
    }
    if (k === 'x') {
      if (!keys.has('x')) input.mentalAttackQueued = true;
      keys.add('x');
      return;
    }
    keys.add(k);
    recomputeMoveFromKeys();
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    keys.delete(k);
    if (k === ' ') input.attackHeld = false;
    if (isChatActive()) return;
    recomputeMoveFromKeys();
  });

  // 채팅이 활성화되면 진행 중인 키를 비우고 이동을 정지한다.
  window.addEventListener('blur', () => {
    keys.clear();
    input.moveX = 0; input.moveY = 0; input.stickX = 0; input.stickY = 0;
    input.attackHeld = false;
  });

  // 마우스 클릭 = 공격 (캔버스 위에서만). 누르고 있는 동안 총 자동 사격.
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (canvas) {
    canvas.addEventListener('mousedown', (e) => {
      if (isChatActive()) return;
      if (e.button === 0) { input.attackQueued = true; input.attackHeld = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) input.attackHeld = false;
    });
  }
}

// 게임 루프가 공격 트리거를 한 번 소비.
export function consumeAttack(): boolean {
  const v = input.attackQueued;
  input.attackQueued = false;
  return v;
}

// 멘탈 공격 트리거 (욕 채팅 자동 송신) — 한 번 소비.
export function consumeMentalAttack(): boolean {
  const v = input.mentalAttackQueued;
  input.mentalAttackQueued = false;
  return v;
}

// 가상 스틱이 호출 — 부드러운 -1~1 벡터 입력.
export function setStick(sx: number, sy: number): void {
  input.stickX = sx;
  input.stickY = sy;
  // 8방향 의도라도 렌더는 4방향. moveX/moveY 는 부호만 추출.
  const dead = 0.25;
  input.moveX = Math.abs(sx) < dead ? 0 : Math.sign(sx);
  input.moveY = Math.abs(sy) < dead ? 0 : Math.sign(sy);
}

// 가상 공격 버튼이 호출 (touchstart).
export function pressAttack(): void {
  if (isChatActive()) return;
  input.attackQueued = true;
  input.attackHeld = true;
}

// 가상 공격 버튼 touchend — 자동 사격 해제용.
export function releaseAttack(): void {
  input.attackHeld = false;
}

// 가상 멘탈 공격 버튼이 호출.
export function pressMentalAttack(): void {
  if (isChatActive()) return;
  input.mentalAttackQueued = true;
}

// 현재 입력 벡터를 4방향 Dir 로 변환.
//   - 이동 없으면 prev 유지
//   - 사선 입력 시 이전 dir 의 축이 여전히 유효하면 우선 유지 → 캐릭터가 사선 중 시각 방향 안정
//   - 새로 정해야 하면 큰 축 우선 (동률이면 가로)
export function dirFromInput(prev: Dir): Dir {
  const mx = input.moveX, my = input.moveY;
  if (mx === 0 && my === 0) return prev;
  // 이전 방향이 여전히 유효 → 유지
  if (prev === 'left'  && mx < 0) return 'left';
  if (prev === 'right' && mx > 0) return 'right';
  if (prev === 'up'    && my < 0) return 'up';
  if (prev === 'down'  && my > 0) return 'down';
  // 새로 결정
  if (Math.abs(mx) >= Math.abs(my)) {
    return mx < 0 ? 'left' : 'right';
  }
  return my < 0 ? 'up' : 'down';
}
