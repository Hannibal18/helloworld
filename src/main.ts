// 부트스트랩: 입장 화면 → 게임 시작.

import { startGame } from './game';
import { setupViewport } from './viewport';
import { CHARACTER_COUNT, drawCharacterPreview, randomCharIdx } from './sprites';
import { loadVariants, unlock as unlockSfx } from './sfx';
import { startBgm } from './bgm';
import type { GameMode } from './types';

// SFX 초기 등록 — 라이트닝 발사 음 4종 변형.
loadVariants('lightning_bolt', [
  '/audio/lightning/bolt1.mp3',
  '/audio/lightning/bolt2.mp3',
  '/audio/lightning/bolt3.mp3',
  '/audio/lightning/bolt4.mp3',
], 0.55);

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

  const enter = () => {
    // iOS Safari 자동 재생 차단 해제 — 첫 사용자 제스처에서 SFX/BGM 둘 다 풀어야 함
    unlockSfx();
    startBgm();
    let name = nick.value.trim();
    if (!name) name = `손님${Math.floor(Math.random() * 9000 + 1000)}`;
    name = name.slice(0, 12);
    let gameId = (gameIdInput?.value ?? '').trim().toUpperCase().slice(0, 8);
    if (!gameId) {
      gameId = randomGameId();
      if (gameIdInput) gameIdInput.value = gameId;
    }
    try {
      startGame({ name, charIdx: chosenCharIdx, gameId, mode });
    } catch (err) {
      // Supabase env 미설정 등
      console.error(err);
      alert(`${(err as Error).message}\n\nREADME 의 §1(설정) 단계를 따라 .env 를 채워주세요.`);
    }
  };

  btn.addEventListener('click', enter);
  nick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enter();
  });
});
