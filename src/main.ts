// 부트스트랩: 입장 화면 → 게임 시작.

import { startGame } from './game';
import { setupBgm } from './audio';

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

  // 입장 화면부터 BGM 재생 시작 (브라우저 정책에 따라 첫 클릭/키 입력 직후 시작될 수 있음)
  setupBgm();

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
