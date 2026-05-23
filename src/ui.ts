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
  chatInput: HTMLElement;       // contenteditable div — input/textarea 아님
  chatLog: HTMLElement;
  minimap: HTMLCanvasElement;
  banner: HTMLElement;
  ranking: HTMLElement;
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
    chatInput: document.getElementById('chat-input') as HTMLElement,
    chatLog: document.getElementById('chat-log') as HTMLElement,
    minimap: document.getElementById('minimap') as HTMLCanvasElement,
    banner: document.getElementById('banner') as HTMLElement,
    ranking: document.getElementById('ranking') as HTMLElement,
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

// 좌상단 KDA 랭킹 — kills 내림차순, 동률은 deaths 오름차순.
export interface RankEntry { id: string; name: string; kills: number; deaths: number; }
export function updateRanking(ui: UiHandles, local: RankEntry, remotes: Iterable<RankEntry>): void {
  const all: Array<RankEntry & { isLocal: boolean }> = [{ ...local, isLocal: true }];
  for (const r of remotes) all.push({ id: r.id, name: r.name, kills: r.kills, deaths: r.deaths, isLocal: false });
  all.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || a.name.localeCompare(b.name));
  const top = all.slice(0, 5);
  ui.ranking.innerHTML = '';
  top.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'ranking-item' + (p.isLocal ? ' me' : '');
    const rank = document.createElement('span');
    rank.className = 'ranking-rank';
    rank.textContent = `${i + 1}`;
    const name = document.createElement('span');
    name.className = 'ranking-name';
    name.textContent = p.name;
    const kd = document.createElement('span');
    kd.className = 'ranking-kd';
    kd.textContent = `${p.kills}/${p.deaths}`;
    item.appendChild(rank);
    item.appendChild(name);
    item.appendChild(kd);
    ui.ranking.appendChild(item);
  });
}

// 상단 채팅 로그에 메시지 한 줄 추가. 6초 페이드, 최대 8개 유지.
const MAX_CHAT_LOG = 8;
export function pushChatLog(ui: UiHandles, name: string, text: string): void {
  const item = document.createElement('div');
  item.className = 'chat-log-item';
  const n = document.createElement('span');
  n.className = 'chat-log-name';
  n.textContent = name;
  item.appendChild(n);
  item.appendChild(document.createTextNode(text));
  ui.chatLog.appendChild(item);
  while (ui.chatLog.children.length > MAX_CHAT_LOG) {
    ui.chatLog.removeChild(ui.chatLog.firstChild!);
  }
  // 페이드 끝나면 자동 제거 — CSS 애니메이션 길이와 동기.
  window.setTimeout(() => item.remove(), 6200);
}

// 화면 중앙 K.O.! / 사망 배너 — kind 에 따라 색깔 다름.
export function showBanner(ui: UiHandles, kind: 'kill' | 'death', title: string, sub: string): void {
  const el = ui.banner;
  el.className = `banner ${kind}`;
  el.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'banner-title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 'banner-sub';
  s.textContent = sub;
  el.appendChild(t);
  el.appendChild(s);
  // 강제 reflow → 같은 배너 연속으로 띄울 때도 애니메이션 재시작.
  void el.offsetWidth;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2400);
}

export interface ChatBinding {
  isActive: () => boolean;
  focus: () => void;
  blur: () => void;
}

export function setupChat(ui: UiHandles, onSend: (text: string) => void): ChatBinding {
  const MAX_LEN = 100;
  let active = false;
  const sendBtn = document.getElementById('chat-send') as HTMLButtonElement | null;

  // iOS 한글 IME 상태 추적 — 조합 중에 전송 누르면 compositionend 잔여 commit 이 clear 후 입력칸에 글자 남기는 버그 방지
  let composing = false;
  let sendPending = false;
  let recentSendAt = 0;

  const getText = () => (ui.chatInput.textContent ?? '');
  const clear = () => { ui.chatInput.textContent = ''; };

  // 카톡식 — 전송해도 키보드는 유지 (입력칸 비우고 포커스만 유지).
  const send = () => {
    const text = getText().trim();
    if (text.length > 0) onSend(text.slice(0, MAX_LEN));
    clear();
    ui.chatInput.focus();
    recentSendAt = performance.now();
  };

  // 조합 중이면 즉시 보내지 않고 compositionend 까지 대기 — 마지막 자모 commit 후 안전하게 송신.
  const requestSend = () => {
    if (!active) return;
    if (composing) sendPending = true;
    else send();
  };

  ui.chatInput.addEventListener('compositionstart', () => { composing = true; });
  ui.chatInput.addEventListener('compositionend', () => {
    composing = false;
    if (sendPending) {
      sendPending = false;
      send();
    } else if (performance.now() - recentSendAt < 200) {
      // 안전망 — send 직후 들어오는 IME 잔여 commit 차단 (compositionstart 누락 케이스)
      clear();
    }
  });

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

  // 전송 버튼 — pointerdown 으로 잡아서 input blur(키보드 닫힘) 전에 발사.
  if (sendBtn) {
    sendBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      requestSend();
    });
  }

  // contenteditable — paste 시 서식 따라오는 거 막고 plain text 만 삽입.
  ui.chatInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const raw = e.clipboardData?.getData('text/plain') ?? '';
    const text = raw.replace(/[\r\n]+/g, ' ').slice(0, MAX_LEN);
    // execCommand 는 deprecated 지만 contenteditable 에서 caret 위치 자동 처리는 여전히 이게 가장 깔끔.
    document.execCommand('insertText', false, text);
  });

  // 드롭으로 이미지/파일 끌어다 넣는 거 차단.
  ui.chatInput.addEventListener('drop', (e) => e.preventDefault());

  // maxlength 강제 — 100 자 초과하면 자르고 caret 을 끝으로.
  ui.chatInput.addEventListener('input', () => {
    // 줄바꿈 노드(<br>, <div>)가 들어오면 plain text 로 정규화 — 항상 한 줄 유지.
    const text = getText();
    if (text.length > MAX_LEN) {
      ui.chatInput.textContent = text.slice(0, MAX_LEN);
      const range = document.createRange();
      range.selectNodeContents(ui.chatInput);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });

  // Enter 처리 — 모바일은 enterkeyhint="send" 라 송신 키, PC 는 일반 Enter.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // PC 한글 IME 조합 중 Enter 는 조합 완료 전용 — 전송 트리거 X (한 번 더 눌러야 보내짐, 표준 동작)
      if (e.isComposing || (e as KeyboardEvent & { keyCode: number }).keyCode === 229) return;
      if (active) {
        e.preventDefault();
        requestSend();
      } else if (!ui.game.classList.contains('hidden')) {
        e.preventDefault();
        focus();
      }
    } else if (e.key === 'Escape' && active) {
      blur();
    }
  });

  // iOS Safari 소프트 키보드 전송 — keydown 누락하고 beforeinput(insertParagraph/LineBreak) 로 옴.
  // 조합 중일 수도 있으니 requestSend() 로 통일.
  ui.chatInput.addEventListener('beforeinput', (e) => {
    const ev = e as InputEvent;
    if (ev.inputType === 'insertParagraph' || ev.inputType === 'insertLineBreak') {
      ev.preventDefault();
      requestSend();
    }
  });

  // ===== 모바일 키보드 위로 채팅바 끌어올리기 (visualViewport) =====
  // iOS Safari, Android Chrome 둘 다 지원. 키보드가 열리면 visualViewport.height 가 줄어듦.
  // 뷰포트 추적은 viewport.ts 가 담당 — main.ts 에서 setupViewport() 호출됨.
  // 채팅바 위치는 CSS 변수 var(--vp-bottom) 과 .keyboard-open class 로 자동 조정.

  return { isActive: () => active, focus, blur };
}
