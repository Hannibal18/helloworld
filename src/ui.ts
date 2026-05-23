// 입장 화면, 채팅 입력창, HUD 갱신 등 DOM 조작 모음.

export interface UiHandles {
  intro: HTMLElement;
  game: HTMLElement;
  nick: HTMLInputElement;
  enterBtn: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  roster: HTMLElement;
  myKills: HTMLElement;
  chatBar: HTMLElement;
  chatInput: HTMLInputElement;
}

export function uiHandles(): UiHandles {
  return {
    intro: document.getElementById('intro') as HTMLElement,
    game: document.getElementById('game') as HTMLElement,
    nick: document.getElementById('nick') as HTMLInputElement,
    enterBtn: document.getElementById('enter') as HTMLButtonElement,
    canvas: document.getElementById('canvas') as HTMLCanvasElement,
    roster: document.getElementById('roster') as HTMLElement,
    myKills: document.getElementById('my-kills') as HTMLElement,
    chatBar: document.getElementById('chat-bar') as HTMLElement,
    chatInput: document.getElementById('chat-input') as HTMLInputElement,
  };
}

export function showGame(ui: UiHandles): void {
  ui.intro.classList.add('hidden');
  ui.game.classList.remove('hidden');
}

export function setRosterCount(ui: UiHandles, n: number): void {
  ui.roster.textContent = `접속자 ${n}`;
}

export function setKills(ui: UiHandles, n: number): void {
  ui.myKills.textContent = `킬 ${n}`;
}

export interface ChatBinding {
  isActive: () => boolean;
  focus: () => void;
  blur: () => void;
}

export function setupChat(ui: UiHandles, onSend: (text: string) => void): ChatBinding {
  let active = false;

  // 카톡식 — 전송해도 키보드는 유지 (입력칸 비우고 포커스만 유지).
  const send = () => {
    const text = ui.chatInput.value.trim();
    if (text.length > 0) onSend(text.slice(0, 100));
    ui.chatInput.value = '';
    ui.chatInput.focus();
  };

  const focus = () => {
    active = true;
    ui.chatBar.classList.add('active');
    ui.chatInput.focus();
  };
  const blur = () => {
    active = false;
    ui.chatBar.classList.remove('active');
    ui.chatInput.blur();
  };

  ui.chatInput.addEventListener('focus', () => { active = true; ui.chatBar.classList.add('active'); });
  ui.chatInput.addEventListener('blur', () => { active = false; ui.chatBar.classList.remove('active'); });

  // 전송 버튼 (카카오톡식)
  const sendBtn = document.getElementById('chat-send');
  if (sendBtn) {
    // pointerdown 으로 즉시 — touchstart/click 보다 빠르고 OS 키보드 닫힘 전에 동작
    sendBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (active) send();
    });
  }

  // Enter 처리 — 모바일은 enterkeyhint="send" 라 송신 키, PC 는 일반 Enter.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // 한글 IME 조합 중 Enter 는 조합 완료 — 전송 트리거 X
      if (e.isComposing || (e as KeyboardEvent & { keyCode: number }).keyCode === 229) return;
      if (active) {
        e.preventDefault();
        send();
      } else if (!ui.game.classList.contains('hidden')) {
        e.preventDefault();
        focus();
      }
    } else if (e.key === 'Escape' && active) {
      blur();
    }
  });

  // ===== 모바일 키보드 위로 채팅바 끌어올리기 (visualViewport) =====
  // iOS Safari, Android Chrome 둘 다 지원. 키보드가 열리면 visualViewport.height 가 줄어듦.
  // iOS Safari URL 바 / Android Chrome URL 바 / 키보드 모두 visualViewport.height 를 줄이므로
  // 그 차이만큼 CSS 변수로 푸시. 채팅바·조이스틱·공격버튼이 같은 변수를 참조 → 함께 위로 이동.
  const vv = window.visualViewport;
  const touchControls = document.getElementById('touch-controls') as HTMLElement | null;
  const adjust = () => {
    const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--vp-bottom', `${offset}px`);
    // 키보드 열림 — 조이스틱/공격버튼 임시 숨김 (사용자는 타이핑 중)
    if (touchControls) {
      const keyboardOpen = offset > 150;
      touchControls.classList.toggle('typing', keyboardOpen);
    }
  };
  if (vv) {
    vv.addEventListener('resize', adjust);
    vv.addEventListener('scroll', adjust);
  }
  adjust();
  setTimeout(adjust, 300); // iOS 가 visualViewport 안정화에 약간 걸릴 수 있음

  return { isActive: () => active, focus, blur };
}
