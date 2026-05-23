// 배경음악 (BGM) — 입장 화면부터 무한 반복 재생.
//
// 브라우저는 보안상 사용자 상호작용 없이 오디오 자동재생을 막는다.
// 그래서 1) 일단 즉시 play() 시도하고, 2) 차단되면 첫 사용자 제스처(클릭/키/터치)에 다시 시도한다.

const BGM_URL = '/audio/Henesys Port Vibes.mp3';

let audio: HTMLAudioElement | null = null;

export function setupBgm(): void {
  if (audio) return; // HMR / 중복 호출 안전망

  audio = new Audio(BGM_URL);
  audio.loop = true;
  audio.volume = 0.5;
  audio.preload = 'auto';

  const tryPlay = (): void => {
    audio?.play().catch(() => {
      // autoplay 차단 — 다음 사용자 제스처를 기다린다.
    });
  };

  tryPlay();

  const gestureEvents: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'touchstart'];
  const onGesture = (): void => {
    tryPlay();
    for (const ev of gestureEvents) document.removeEventListener(ev, onGesture);
  };
  for (const ev of gestureEvents) document.addEventListener(ev, onGesture);
}
