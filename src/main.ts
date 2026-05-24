// 부트스트랩: 입장 화면 → 게임 시작.

// ===== 최상단 글로벌 에러 핸들러 =====
// 모듈 로드 단계 실패도 잡으려면 import 보다 먼저 attach 되어야 함.
// 모바일은 콘솔 접근 불가 → 화면에 직접 띄워야 디버깅 가능.
function __showFatal(msg: string): void {
  try {
    let banner = document.getElementById('fatal-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fatal-error';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#3a1010;color:#ff9a9a;padding:10px 14px;font:12px monospace;border-bottom:2px solid #a02a2a;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;';
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = `[FATAL] ${msg}`;
  } catch { /* DOM 자체가 없을 때는 포기 */ }
}
window.addEventListener('error', (e) => {
  __showFatal(`${e.message}\n${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  __showFatal(`unhandled rejection: ${r?.message ?? r}`);
});

import { startGame } from './game';
import { setupViewport } from './viewport';
import { CHARACTER_COUNT, drawCharacterPreview, randomCharIdx } from './sprites';
import { load as loadSfx, loadVariants, unlock as unlockSfx } from './sfx';
import { startBgm } from './bgm';
import type { GameMode } from './types';

// SFX 초기 등록 — 라이트닝 발사 음 4종 변형.
// 동기 throw 가능성 (예: AudioContext 생성 실패) 차단.
try {
  loadVariants('lightning_bolt', [
    '/audio/lightning/bolt1.mp3',
    '/audio/lightning/bolt2.mp3',
    '/audio/lightning/bolt3.mp3',
    '/audio/lightning/bolt4.mp3',
  ], 0.55);
  // 저주 — 차지 시작 시 늑대 울음, 데미지 입힐 때 타격음.
  // GainNode 는 1.0 위로도 증폭 가능 (>1 은 디지털 게인). 원본 파일이 작아
  // 사용자 체감이 작으면 여기서 더 올림. 클리핑 발생 시 이 값을 다시 낮출 것.
  loadSfx('curse_charge', '/audio/curse/charge.mp3', 2.5);
  // hit 은 위치별 순차로 여러 번 재생됨 — 한 발씩 임팩트 있게 크게.
  loadSfx('curse_hit', '/audio/curse/hit.mp3', 6.0);
} catch (e) {
  console.warn('[sfx preload]', e);
}

// 랜덤 방코드 — 친구한테 공유하기 좋은 짧은 영문/숫자.
function randomGameId(len = 5): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자 제외 (O0I1L)
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function ready(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

ready(() => {
  const nick = document.getElementById('nick') as HTMLInputElement;
  const gameIdInput = document.getElementById('game-id') as HTMLInputElement;
  const btn = document.getElementById('enter') as HTMLButtonElement;
  if (!nick || !btn) return;

  // viewport(visible viewport) 추적 시작 — 입장 화면부터 CSS 변수 노출
  setupViewport();

  // ===== 모드 토글 =====
  // 현재 UI 에서 토글/방코드 모두 .hidden 처리됨 — 좀비 모드 단독 운영.
  // 추후 부활하려면 index.html 의 .hidden 제거.
  let mode: GameMode = 'zombie';
  const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-btn'));
  for (const b of modeButtons) {
    b.addEventListener('click', () => {
      const v = (b.dataset.mode === 'zombie' ? 'zombie' : 'pk') as GameMode;
      mode = v;
      for (const x of modeButtons) x.classList.toggle('active', x === b);
    });
  }

  // ===== 방 코드 자동 생성 (placeholder 보조) =====
  if (gameIdInput && !gameIdInput.value) {
    // 입력 안 했으면 비워두기 — 입장 시 자동 채움
  }

  // ===== 캐릭터 미리보기 + 다시 뽑기 =====
  // 입장 전 캐릭터를 골라본다. "다시 뽑기" 클릭마다 다른 시트로 교체.
  let chosenCharIdx = randomCharIdx();
  const previewCanvas = document.getElementById('char-preview-canvas') as HTMLCanvasElement | null;
  const previewCtx = previewCanvas?.getContext('2d') ?? null;
  const reroll = document.getElementById('reroll') as HTMLButtonElement | null;

  const refreshPreview = (): void => {
    if (previewCtx) void drawCharacterPreview(previewCtx, chosenCharIdx);
  };
  refreshPreview();

  if (reroll) {
    reroll.addEventListener('click', () => {
      // 현재와 다른 인덱스가 나오도록 — 작은 시트 개수에서 같은 게 연속으로 뽑히면 변화 없는 듯 보이므로.
      if (CHARACTER_COUNT > 1) {
        let next = chosenCharIdx;
        while (next === chosenCharIdx) next = randomCharIdx();
        chosenCharIdx = next;
      }
      refreshPreview();
    });
  }

  // 모바일에서 입력창 자동 줌 방지를 위해 폰트 크기는 CSS 로 처리
  nick.focus();

  // 입장 시 발생한 마지막 에러 메시지를 모바일에서도 볼 수 있게 인트로에 표시.
  // (콘솔 접근이 어려운 모바일 디버깅용 — 한 줄 추가에 큰 도움)
  const introCard = document.querySelector('.intro-card');
  const showIntroError = (msg: string) => {
    if (!introCard) { alert(msg); return; }
    let banner = document.getElementById('intro-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'intro-error';
      banner.style.cssText = 'margin-top:10px;padding:8px;background:#3a1010;color:#ff9a9a;border:1px solid #a02a2a;border-radius:6px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;';
      introCard.appendChild(banner);
    }
    banner.textContent = msg;
  };

  const enter = () => {
    try {
      // iOS Safari 자동 재생 차단 해제 — 첫 사용자 제스처에서 SFX/BGM 둘 다 풀어야 함
      try { unlockSfx(); } catch (e) { console.warn('unlockSfx', e); }
      try { startBgm(); } catch (e) { console.warn('startBgm', e); }
      let name = nick.value.trim();
      if (!name) name = `손님${Math.floor(Math.random() * 9000 + 1000)}`;
      name = name.slice(0, 12);
      // 좀비 모드 단독 운영: 모든 접속자가 'default' 한 방에 모임.
      let gameId = (gameIdInput?.value ?? '').trim().toUpperCase().slice(0, 8);
      if (!gameId) {
        gameId = mode === 'zombie' ? 'DEFAULT' : randomGameId();
        if (gameIdInput) gameIdInput.value = gameId;
      }
      startGame({ name, charIdx: chosenCharIdx, gameId, mode });
    } catch (err) {
      console.error('[enter] sync error', err);
      showIntroError(`입장 실패: ${(err as Error)?.message ?? err}`);
    }
  };
  // startGame 안의 비동기 에러도 알림
  window.addEventListener('unhandledrejection', (e) => {
    showIntroError(`비동기 에러: ${e.reason?.message ?? e.reason}`);
  });
  window.addEventListener('error', (e) => {
    showIntroError(`스크립트 에러: ${e.message}`);
  });

  btn.addEventListener('click', enter);
  nick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enter();
  });
});
