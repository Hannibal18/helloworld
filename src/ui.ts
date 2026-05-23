// 입장 화면, 채팅 로그, HUD 갱신 등 DOM 조작 모음.
// 채팅 입력 UI 는 제거됨 — 멘탈 공격(욕 자동 송신) 만 채팅 broadcast 사용.

export interface UiHandles {
  intro: HTMLElement;
  game: HTMLElement;
  nick: HTMLInputElement;
  enterBtn: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  hudCanvas: HTMLCanvasElement;
  roster: HTMLElement;
  myKills: HTMLElement;
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
    hudCanvas: document.getElementById('hud-canvas') as HTMLCanvasElement,
    roster: document.getElementById('roster') as HTMLElement,
    myKills: document.getElementById('my-kills') as HTMLElement,
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

// 좌상단 채팅 로그 — 영구 표시, 새 메시지가 아래에 append 되며 오래된 건 위로 밀려 mask 로 페이드.
// 최대 N개 유지 후 그 이상은 오래된 것부터 삭제 (DOM 누적 방지).
// nameColor: 사용자별 고유 색 (colors.ts:colorFromName 으로 닉네임에서 생성).
const MAX_CHAT_LOG = 20;
export function pushChatLog(ui: UiHandles, name: string, text: string, nameColor: string): void {
  const item = document.createElement('div');
  item.className = 'chat-log-item';
  const n = document.createElement('span');
  n.className = 'chat-log-name';
  n.textContent = name;
  n.style.color = nameColor;
  item.appendChild(n);
  item.appendChild(document.createTextNode(text));
  ui.chatLog.appendChild(item);
  while (ui.chatLog.children.length > MAX_CHAT_LOG) {
    ui.chatLog.removeChild(ui.chatLog.firstChild!);
  }
}

// 화면 중앙 K.O.! / 사망 배너 — kind 에 따라 색깔 다름.
// 'info' 는 한 줄짜리 시스템 알림 (작은 폰트, sub 무시).
export function showBanner(
  ui: UiHandles,
  kind: 'kill' | 'death' | 'info',
  title: string,
  sub: string = '',
): void {
  const el = ui.banner;
  el.className = `banner ${kind}`;
  el.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'banner-title';
  t.textContent = title;
  el.appendChild(t);
  if (kind !== 'info' && sub) {
    const s = document.createElement('div');
    s.className = 'banner-sub';
    s.textContent = sub;
    el.appendChild(s);
  }
  // 강제 reflow → 같은 배너 연속으로 띄울 때도 애니메이션 재시작.
  void el.offsetWidth;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2400);
}
