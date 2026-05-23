// 부트스트랩: 입장 화면 → 게임 시작.

import { startGame } from './game';
import { setupBgm, toggleBgm, isBgmPlaying } from './audio';
import { setupViewport } from './viewport';

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

  // 모바일에서 입력창 자동 줌 방지를 위해 폰트 크기는 CSS 로 처리
  nick.focus();

  const enter = () => {
    let name = nick.value.trim();
    if (!name) name = `손님${Math.floor(Math.random() * 9000 + 1000)}`;
    name = name.slice(0, 12);
    try {
      startGame(name);
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
