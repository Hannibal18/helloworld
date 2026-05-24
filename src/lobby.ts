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

export function setupLobbyChat(onSend: (text: string) => void): LobbyChatHandle {
  const root = document.createElement('div');
  root.id = 'lobby-chat';
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

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '메시지... (Enter 전송)';
  input.maxLength = 80;
  input.autocomplete = 'off';
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
