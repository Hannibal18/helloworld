// 부트스트랩: 입장 화면 → 게임 시작.

import { startGame } from './game';
import { setupBgm, toggleBgm, isBgmPlaying } from './audio';
import { setupViewport } from './viewport';
import { CHARACTER_COUNT, drawCharacterPreview, randomCharIdx } from './sprites';

function ready(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

ready(() => {
  const nick = document.getElementById('nick') as HTMLInputElement;
  const btn = document.getElementById('enter') as HTMLButtonElement;
  if (!nick || !btn) return;

  // viewport(visible viewport) 추적 시작 — 입장 화면부터 CSS 변수 노출
  setupViewport();

  // 입장 화면부터 BGM 재생 시작 (브라우저 정책에 따라 첫 클릭/키 입력 직후 시작될 수 있음)
  setupBgm();

  // 우상단 BGM 토글 버튼
  const bgmBtn = document.getElementById('btn-bgm') as HTMLButtonElement | null;
  if (bgmBtn) {
    const updateLabel = () => {
      bgmBtn.textContent = isBgmPlaying() ? '♪ ON' : '♪ OFF';
      bgmBtn.classList.toggle('off', !isBgmPlaying());
    };
    bgmBtn.addEventListener('click', () => {
      toggleBgm();
      updateLabel();
    });
    // 약간 늦게 한 번 — 자동 재생 결과 반영
    setTimeout(updateLabel, 500);
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
    let name = nick.value.trim();
    if (!name) name = `손님${Math.floor(Math.random() * 9000 + 1000)}`;
    name = name.slice(0, 12);
    try {
      startGame(name, chosenCharIdx);
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
