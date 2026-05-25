// 대기 광장 (lobby) 전용 로직.
// - 3개 난이도 구역 시각화 (EASY/NORMAL/HELL).
// - 광장 채팅 입력 UI 세팅 (배틀룸에는 없음).
//
// Phase 1: 시각/입력만. Ready/매치메이킹은 Phase 2 에서.

import type { Camera } from './world';

export type Difficulty = 'easy' | 'normal' | 'hell';

export interface LobbyZone {
  id: Difficulty;
  label: string;
  color: string;          // ring 색
  fill: string;           // 안쪽 반투명
  x: number;              // 월드 픽셀
  y: number;
  radius: number;         // 픽셀
}

// 맵: 30×20 타일 × 32px = 960×640. 가운데 세 자리에 배치.
// 좌표는 안전한 평지 가정 — 실제 맵에 장애물 있으면 시각만 그려지고 입장은 가능 (구역 진입 = 위치 기준).
export const LOBBY_ZONES: readonly LobbyZone[] = [
  { id: 'easy',   label: 'EASY',   color: '#7dd87d', fill: 'rgba(125,216,125,0.18)', x: 280, y: 320, radius: 56 },
  { id: 'normal', label: 'NORMAL', color: '#ffd84a', fill: 'rgba(255,216,74,0.18)',  x: 480, y: 320, radius: 56 },
  { id: 'hell',   label: 'HELL',   color: '#ff5d5d', fill: 'rgba(255,93,93,0.20)',   x: 680, y: 320, radius: 56 },
];

// 플레이어가 어느 구역 안에 있는지. 없으면 null.
export function getZoneAt(x: number, y: number): Difficulty | null {
  for (const z of LOBBY_ZONES) {
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.radius * z.radius) return z.id;
  }
  return null;
}

// 광장 구역 렌더 — 매 프레임 호출. 펄스 + 라벨.
export function drawLobbyZones(ctx: CanvasRenderingContext2D, camera: Camera, now: number): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const pulse = (Math.sin(now * 2) + 1) / 2;  // 0..1
  for (const z of LOBBY_ZONES) {
    const sx = Math.round(z.x - camera.x);
    const sy = Math.round(z.y - camera.y);
    const r = z.radius + pulse * 3;
    // 안쪽 반투명 채움
    ctx.fillStyle = z.fill;
    ctx.beginPath(); ctx.arc(sx, sy, z.radius, 0, Math.PI * 2); ctx.fill();
    // 두꺼운 외곽 (펄스)
    ctx.strokeStyle = z.color;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    // 라벨 — 구역 위쪽
    ctx.font = '900 13px "Galmuri11", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#1a0e08';
    ctx.strokeText(z.label, sx, sy - z.radius - 12);
    ctx.fillStyle = z.color;
    ctx.fillText(z.label, sx, sy - z.radius - 12);
  }
  ctx.restore();
}

// ===== 광장 채팅 입력 UI =====
// 하단에 input + 보내기. 엔터 또는 버튼 → onSend(text) 호출.
// 모바일 키보드 호환 — 입력란 클릭하면 visualViewport 변경되니 viewport.ts 가 위치 보정.
export interface LobbyChatHandle {
  destroy(): void;
}

// ===== 파티 시스템 UI =====
// (옛 ready 버튼 / 카운트다운 오버레이는 파티 모델로 갈아엎음.)

export interface PartyMemberInfo {
  id: string;
  name: string;
  zone: Difficulty | null;     // 현재 어느 구역 안에 있는지 (없으면 null)
  isLeader: boolean;
}

export interface PartyPanelHandle {
  update(members: PartyMemberInfo[], canStart: boolean, startBlockedReason: string): void;
  destroy(): void;
}

// 좌상단 (roster pill 아래) 에 파티 패널 표시.
// 파티장에게만 "출발" 버튼 — 모든 파티원이 같은 구역에 모여야 활성.
export function setupPartyPanel(onStart: () => void, onLeave: () => void): PartyPanelHandle {
  const root = document.createElement('div');
  root.id = 'party-panel';
  root.style.cssText = [
    'position:fixed',
    'top:calc(env(safe-area-inset-top) + 70px)',
    'left:calc(env(safe-area-inset-left) + 8px)',
    'z-index:6',
    'background:rgba(20,14,8,0.85)',
    'border:1px solid #6a4a2a',
    'border-radius:8px',
    'padding:8px 10px',
    'min-width:140px',
    'font:11px "Galmuri11", "Apple SD Gothic Neo", system-ui, sans-serif',
    'color:#f0e6d0',
    'pointer-events:auto',
  ].join(';');

  const header = document.createElement('div');
  header.style.cssText = 'font-weight:900;color:#ffd84a;letter-spacing:1px;margin-bottom:4px;';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:6px;';
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.textContent = '출발';
  const baseBtn = 'width:100%;padding:6px;font:900 12px "Galmuri11", system-ui, sans-serif;letter-spacing:2px;border:1px solid #1a0e08;border-radius:6px;cursor:pointer;';
  startBtn.addEventListener('click', onStart);
  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.textContent = '탈퇴';
  leaveBtn.style.cssText = baseBtn + 'background:rgba(40,28,18,0.6);color:#c84a4a;border-color:#6a3030;margin-top:4px;font-size:10px;padding:4px;letter-spacing:1px;';
  leaveBtn.addEventListener('click', onLeave);
  const note = document.createElement('div');
  note.style.cssText = 'font-size:10px;color:#9a8060;margin-top:4px;line-height:1.3;';

  root.append(header, list, startBtn, note, leaveBtn);
  document.body.appendChild(root);

  return {
    update: (members, canStart, blockedReason) => {
      const me = members.find((m) => m.isLeader);
      header.textContent = `파티 (${members.length}/8)`;
      list.innerHTML = '';
      for (const m of members) {
        const row = document.createElement('div');
        const zoneIcon = m.zone === 'easy' ? '🟢' : m.zone === 'normal' ? '🟡' : m.zone === 'hell' ? '🔴' : '·';
        row.textContent = `${m.isLeader ? '👑' : ' '} ${m.name} ${zoneIcon}`;
        row.style.cssText = `padding:1px 0; ${m.zone ? 'color:#fff7a8' : 'color:#9a8060'};`;
        list.appendChild(row);
      }
      const iAmLeader = me && me.id && members.find((x) => x.isLeader)?.id === me.id;
      // 출발 버튼 — leader 만 보임
      const showStart = members.length >= 1;
      startBtn.style.display = showStart ? 'block' : 'none';
      if (canStart) {
        startBtn.style.cssText = baseBtn + 'background:linear-gradient(180deg,#5fd06a,#3a8a40);color:#0a1f0a;';
        startBtn.disabled = false;
      } else {
        startBtn.style.cssText = baseBtn + 'background:rgba(40,28,18,0.6);color:#7a6a52;cursor:default;';
        startBtn.disabled = true;
      }
      // 1인 파티면 출발 버튼만 보이고 탈퇴는 숨김
      leaveBtn.style.display = members.length >= 2 ? 'block' : 'none';
      note.textContent = canStart ? '' : (blockedReason || '');
      void iAmLeader;
    },
    destroy: () => { root.remove(); },
  };
}

// ===== 초대 popup (받음) =====

export interface InvitePopupHandle {
  show(fromName: string, leaderName: string, onAccept: () => void, onDecline: () => void): void;
  hide(): void;
  destroy(): void;
}

export function setupInvitePopup(): InvitePopupHandle {
  const el = document.createElement('div');
  el.id = 'party-invite';
  el.style.cssText = [
    'position:fixed',
    'top:30%',
    'left:50%',
    'transform:translate(-50%, -50%)',
    'z-index:11',
    'padding:18px 22px',
    'background:rgba(20,14,8,0.95)',
    'border:2px solid #ffd84a',
    'border-radius:12px',
    'text-align:center',
    'font:14px "Galmuri11", system-ui, sans-serif',
    'color:#f0e6d0',
    'min-width:220px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.6)',
    'display:none',
    'pointer-events:auto',
  ].join(';');
  document.body.appendChild(el);
  return {
    show: (fromName, leaderName, onA, onD) => {
      el.innerHTML = '';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:900;color:#ffd84a;margin-bottom:6px;';
      title.textContent = '🎉 파티 초대';
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:12px;line-height:1.5;margin-bottom:12px;';
      msg.textContent = leaderName === fromName
        ? `${fromName} 님의 파티에 초대받았습니다`
        : `${fromName} 님 (${leaderName} 파티) 이 초대했습니다`;
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;';
      const mk = (label: string, color: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = `flex:1;padding:8px;font:900 13px "Galmuri11", system-ui, sans-serif;letter-spacing:2px;border:1px solid #1a0e08;border-radius:6px;cursor:pointer;background:${color};color:#1a0e08;`;
        b.addEventListener('click', () => { el.style.display = 'none'; onClick(); });
        return b;
      };
      btnRow.append(
        mk('수락', 'linear-gradient(180deg,#5fd06a,#3a8a40)', onA),
        mk('거절', 'linear-gradient(180deg,#d34a4a,#6a2a2a)', onD),
      );
      el.append(title, msg, btnRow);
      el.style.display = 'block';
    },
    hide: () => { el.style.display = 'none'; },
    destroy: () => { el.remove(); },
  };
}

// ===== 캐릭터 탭 메뉴 =====
// 화면 좌표에 작은 popup 띄움. 메뉴 항목 onClick.

export interface TapMenuHandle {
  show(screenX: number, screenY: number, name: string, options: { label: string; onClick: () => void; danger?: boolean }[]): void;
  hide(): void;
  destroy(): void;
}

export function setupTapMenu(): TapMenuHandle {
  const el = document.createElement('div');
  el.id = 'tap-menu';
  el.style.cssText = [
    'position:fixed',
    'z-index:10',
    'background:rgba(20,14,8,0.95)',
    'border:1px solid #ffd84a',
    'border-radius:8px',
    'padding:6px',
    'min-width:120px',
    'font:12px "Galmuri11", "Apple SD Gothic Neo", system-ui, sans-serif',
    'color:#f0e6d0',
    'box-shadow:0 4px 12px rgba(0,0,0,0.6)',
    'display:none',
    'pointer-events:auto',
  ].join(';');
  document.body.appendChild(el);

  // 메뉴 밖 탭하면 닫기
  const closeOnOutside = (e: MouseEvent | TouchEvent) => {
    if (el.style.display === 'none') return;
    if (!el.contains(e.target as Node)) {
      el.style.display = 'none';
    }
  };
  document.addEventListener('mousedown', closeOnOutside);
  document.addEventListener('touchstart', closeOnOutside, { passive: true });

  return {
    show: (sx, sy, name, options) => {
      el.innerHTML = '';
      const title = document.createElement('div');
      title.textContent = name;
      title.style.cssText = 'font-weight:900;color:#ffd84a;padding:4px 8px;letter-spacing:1px;';
      el.appendChild(title);
      for (const opt of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = opt.label;
        b.style.cssText = `display:block;width:100%;text-align:left;padding:8px;background:transparent;border:none;color:${opt.danger ? '#ff7070' : '#fff7a8'};font:inherit;cursor:pointer;border-radius:4px;`;
        b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.06)'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
        b.addEventListener('click', () => { el.style.display = 'none'; opt.onClick(); });
        el.appendChild(b);
      }
      // 화면 안에 들어오도록 위치 보정
      el.style.left = '0px'; el.style.top = '0px';
      el.style.display = 'block';
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(8, Math.min(vw - rect.width - 8, sx - rect.width / 2));
      const top = Math.max(8, Math.min(vh - rect.height - 8, sy - rect.height - 12));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    },
    hide: () => { el.style.display = 'none'; },
    destroy: () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('touchstart', closeOnOutside);
      el.remove();
    },
  };
}

// 화면 정중앙 상단의 "대기실" 라벨 — 광장 진입 시 한 번 띄움.
export interface LobbyTitleHandle { destroy(): void; }
export function setupLobbyTitle(): LobbyTitleHandle {
  const el = document.createElement('div');
  el.id = 'lobby-title';
  el.textContent = '대기실';
  el.style.cssText = [
    'position:fixed',
    'top:calc(env(safe-area-inset-top) + 8px)',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:6',
    'pointer-events:none',
    // 픽셀 폰트 — Galmuri11 (이미 인덱스에 로드됨)
    'font:900 22px "Galmuri11", "NeoDunggeunmo", monospace',
    'letter-spacing:6px',
    'color:#ffe080',
    // 픽셀 룩 살리는 다중 스트로크 + 부드러운 글로우
    'text-shadow:2px 2px 0 #1a0e08, -2px 2px 0 #1a0e08, 2px -2px 0 #1a0e08, -2px -2px 0 #1a0e08, 0 0 12px rgba(255,200,80,0.4)',
    'padding:4px 16px',
    'background:rgba(20,14,8,0.55)',
    'border:2px solid #6a4a2a',
    'border-radius:4px',
  ].join(';');
  document.body.appendChild(el);
  return { destroy: () => { el.remove(); } };
}

export function setupLobbyChat(onSend: (text: string) => void): LobbyChatHandle {
  // <form> 으로 감싸면 iOS 의 "연락처" 자동 채움이 가장 잘 막힘.
  const root = document.createElement('form');
  root.id = 'lobby-chat';
  root.setAttribute('autocomplete', 'off');
  root.addEventListener('submit', (e) => e.preventDefault());
  root.style.cssText = [
    'position:fixed',
    'left:50%',
    'transform:translateX(-50%)',
    'bottom:calc(env(safe-area-inset-bottom) + var(--vp-bottom, 0px) + 12px)',
    'z-index:8',
    'display:flex',
    'gap:6px',
    'width:min(440px, calc(100vw - 24px))',
    'pointer-events:auto',
    // 키보드 올라올 때 부드럽게. viewport.ts 가 --vp-bottom 갱신.
    'transition:bottom 0.22s cubic-bezier(0.22, 0.61, 0.36, 1)',
  ].join(';');

  // type="search" + name 비-신원성 + 다양한 autofill off 속성 조합.
  // iOS Safari 의 "연락처 자동 채우기" 가 가장 잘 차단되는 조합.
  const input = document.createElement('input');
  input.type = 'search';   // text 보다 자동 채우기 덜 적용됨
  input.name = 'lobby-message';
  input.placeholder = '메시지... (Enter 전송)';
  input.maxLength = 80;
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('enterkeyhint', 'send');
  // iOS: 연락처 자동 추천 제거 핵 — data-form-type=other 가 가장 효과적.
  input.setAttribute('data-form-type', 'other');
  input.setAttribute('data-lpignore', 'true');   // 1Password / LastPass 등 무시
  input.setAttribute('data-1p-ignore', 'true');
  input.style.cssText = [
    'flex:1',
    'min-width:0',
    'padding:10px 12px',
    'background:rgba(20,14,8,0.85)',
    'border:1px solid #6a4a2a',
    'color:#f0e6d0',
    'font:14px "Galmuri11", "Apple SD Gothic Neo", system-ui, sans-serif',
    'outline:none',
    'border-radius:8px',
    // type="search" 의 iOS 기본 룩 (돋보기/X) 무력화 — 일반 텍스트 박스처럼 보이게.
    '-webkit-appearance:none',
    'appearance:none',
  ].join(';');

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = '보내기';
  sendBtn.style.cssText = [
    'padding:10px 14px',
    'background:linear-gradient(180deg,#8a6232,#5d4220)',
    'color:#fff7a8',
    'border:1px solid #1a0e08',
    'font:14px "Galmuri11", system-ui, sans-serif',
    'border-radius:8px',
    'cursor:pointer',
  ].join(';');

  const fire = () => {
    const text = input.value.trim().slice(0, 80);
    if (!text) return;
    onSend(text);
    input.value = '';
  };
  sendBtn.addEventListener('click', fire);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fire(); }
  });

  root.append(input, sendBtn);
  document.body.appendChild(root);

  return {
    destroy: () => { root.remove(); },
  };
}
