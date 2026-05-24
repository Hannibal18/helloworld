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

// ===== Ready 버튼 + 카운트다운 오버레이 =====

export interface ReadyButtonHandle {
  setActive(active: boolean, zone: Difficulty | null, waitingCount: number): void;
  setMyReady(ready: boolean): void;
  destroy(): void;
}

// 우하단(공격 버튼 위쪽) 에 띄우는 큰 "준비" 버튼.
// 활성 = 내가 구역 안 → 누르면 onPress(true), 다시 누르면 onPress(false).
// 비활성 = 회색 표시 + 클릭 무시.
export function setupReadyButton(onPress: (ready: boolean) => void): ReadyButtonHandle {
  const btn = document.createElement('button');
  btn.id = 'lobby-ready-btn';
  btn.type = 'button';
  btn.textContent = '구역에 들어가세요';
  let active = false;
  let myReady = false;
  let zoneId: Difficulty | null = null;
  let waitingCount = 0;

  const updateStyle = () => {
    const base = [
      'position:fixed',
      'right:calc(env(safe-area-inset-right) + 18px)',
      'bottom:calc(env(safe-area-inset-bottom) + var(--vp-bottom, 0px) + 220px)',
      'z-index:7',
      'width:120px',
      'padding:14px 8px',
      'border-radius:60px',
      'font:900 14px "Galmuri11", system-ui, sans-serif',
      'letter-spacing:2px',
      'cursor:pointer',
      'text-align:center',
      'line-height:1.3',
      'pointer-events:auto',
    ];
    if (!active) {
      base.push('background:rgba(40,28,18,0.7)');
      base.push('color:#7a6a52');
      base.push('border:2px solid #4a3422');
      base.push('cursor:default');
    } else if (myReady) {
      base.push('background:linear-gradient(180deg,#5fd06a,#3a8a40)');
      base.push('color:#0a1f0a');
      base.push('border:2px solid #1a0e08');
    } else {
      base.push('background:linear-gradient(180deg,#ffd84a,#c08a20)');
      base.push('color:#1a0e08');
      base.push('border:2px solid #1a0e08');
    }
    btn.style.cssText = base.join(';');
  };

  const updateLabel = () => {
    if (!active) { btn.textContent = '구역에\n들어가세요'; return; }
    const zoneName = zoneId === 'easy' ? '🟢 EASY' : zoneId === 'normal' ? '🟡 NORMAL' : '🔴 HELL';
    btn.textContent = myReady
      ? `${zoneName}\n대기 ${waitingCount}명\n(취소)`
      : `${zoneName}\n대기 ${waitingCount}명\n준비!`;
  };

  btn.style.whiteSpace = 'pre-line';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!active) return;
    myReady = !myReady;
    onPress(myReady);
    updateStyle(); updateLabel();
  });

  document.body.appendChild(btn);
  updateStyle(); updateLabel();

  return {
    setActive: (a, zone, count) => {
      const changed = a !== active || zone !== zoneId || count !== waitingCount;
      active = a; zoneId = zone; waitingCount = count;
      if (!a && myReady) {
        myReady = false;
        onPress(false);
      }
      if (changed) { updateStyle(); updateLabel(); }
    },
    setMyReady: (r) => {
      if (r !== myReady) {
        myReady = r;
        updateStyle(); updateLabel();
      }
    },
    destroy: () => { btn.remove(); },
  };
}

// 매치 시작 카운트다운 — 화면 중앙에 큰 숫자.
export interface CountdownOverlayHandle {
  show(zone: Difficulty, secondsLeft: number, members: number): void;
  hide(): void;
  destroy(): void;
}

export function setupCountdownOverlay(): CountdownOverlayHandle {
  const el = document.createElement('div');
  el.id = 'lobby-countdown';
  el.style.cssText = [
    'position:fixed',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'z-index:9',
    'padding:18px 28px',
    'background:rgba(20,14,8,0.85)',
    'border:3px solid #ffd84a',
    'border-radius:12px',
    'text-align:center',
    'font:900 32px "Galmuri11", system-ui, sans-serif',
    'color:#ffd84a',
    'letter-spacing:4px',
    'text-shadow:2px 2px 0 #1a0e08',
    'pointer-events:none',
    'display:none',
  ].join(';');
  document.body.appendChild(el);
  return {
    show: (zone, sec, members) => {
      const zoneName = zone === 'easy' ? '🟢 EASY' : zone === 'normal' ? '🟡 NORMAL' : '🔴 HELL';
      el.style.display = 'block';
      el.innerHTML = `<div style="font-size:14px;letter-spacing:2px;margin-bottom:6px;color:#fff7a8">${zoneName} · ${members}명</div>${sec}<div style="font-size:11px;letter-spacing:1px;margin-top:4px;color:#c9b58d">초 후 출발…</div>`;
    },
    hide: () => { el.style.display = 'none'; },
    destroy: () => { el.remove(); },
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
