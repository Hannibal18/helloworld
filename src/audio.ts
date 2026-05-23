// 배경음악 (BGM) — 3곡을 자연 순서로 무한 반복.
//
// 설계: 동기화 안 함. 각 클라이언트가 자기 페이스로 재생.
//   - 시작 트랙만 랜덤 (매번 같은 곡으로 시작하지 않도록)
//   - 곡이 자연 종료(audio.ended)되면 다음 트랙 처음부터
//   - currentTime 시크 안 함 → seek/buffering 관련 버그 없음
//   - audio.duration 의존 안 함 → 부정확한 metadata 영향 없음
//
// 자동재생 정책: 브라우저는 첫 사용자 제스처 전엔 play() 를 차단할 수 있다.
//   첫 클릭/키/터치에 모든 audio 를 한 번씩 unlock 한다 (모바일/Safari 대응).

const TRACK_URLS: readonly string[] = [
  '/audio/Henesys Port Vibes.mp3',
  '/audio/Kerning City Shadows.mp3',
  '/audio/Future Lith.mp3',
] as const;

const VOLUME = 0.5;

type Track = { url: string; audio: HTMLAudioElement };

let tracks: Track[] = [];
let currentIdx = -1;
let userMuted = false;
let setupStarted = false;
let unlocked = false;

async function loadTrack(url: string): Promise<Track> {
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.volume = VOLUME;
  audio.loop = false; // 각 곡 끝나면 다음 곡으로 전환
  await new Promise<void>((resolve, reject) => {
    if (audio.readyState >= 1) return resolve();
    audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('audio load failed: ' + url)), { once: true });
  });
  const t: Track = { url, audio };
  audio.addEventListener('ended', () => {
    if (userMuted) return;
    advance();
  });
  return t;
}

// 현재 트랙 정지 → 다음 트랙 처음부터 재생.
function advance(): void {
  if (tracks.length === 0 || userMuted) return;
  if (currentIdx >= 0) {
    const prev = tracks[currentIdx].audio;
    try { prev.pause(); prev.currentTime = 0; } catch { /* ignore */ }
  }
  currentIdx = (currentIdx + 1) % tracks.length;
  tracks[currentIdx].audio.play().catch(() => { /* autoplay 차단 — 다음 제스처에서 재시도 */ });
}

// 첫 재생 — 시작 트랙은 랜덤.
function playFromStart(): void {
  if (tracks.length === 0 || userMuted) return;
  if (currentIdx < 0) currentIdx = Math.floor(Math.random() * tracks.length);
  const a = tracks[currentIdx].audio;
  try { a.currentTime = 0; } catch { /* ignore */ }
  a.play().catch(() => { /* autoplay 차단 — 다음 제스처에서 재시도 */ });
}

export async function setupBgm(): Promise<void> {
  if (setupStarted) return; // 중복 호출 안전망
  setupStarted = true;

  try {
    tracks = await Promise.all(TRACK_URLS.map(loadTrack));
  } catch (e) {
    console.warn('[bgm] load failed', e);
    return;
  }

  // 자동재생 시도 (대개 차단됨)
  playFromStart();

  const gestureEvents: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'touchstart'];
  const onGesture = (): void => {
    void unlockAll().then(() => {
      if (userMuted) return;
      // 첫 트랙이 unlock 으로 인해 잠시 paused 됐을 수 있으므로 다시 play
      if (currentIdx >= 0 && tracks[currentIdx].audio.paused) {
        tracks[currentIdx].audio.play().catch(() => { /* ignore */ });
      } else {
        playFromStart();
      }
    });
    for (const ev of gestureEvents) document.removeEventListener(ev, onGesture);
  };
  for (const ev of gestureEvents) document.addEventListener(ev, onGesture);
}

// 모든 audio 를 user-gesture 안에서 한 번 play() → pause() 처리해 unlock.
// 모바일/Safari 에서 'ended' 콜백 등 비제스처 컨텍스트의 play() 가 차단되는 걸 막는다.
async function unlockAll(): Promise<void> {
  if (unlocked) return;
  unlocked = true;
  const promises: Array<Promise<unknown>> = [];
  for (const t of tracks) {
    t.audio.volume = 0;
    promises.push(t.audio.play().catch(() => { /* ignore */ }));
  }
  await Promise.allSettled(promises);
  for (const t of tracks) {
    t.audio.pause();
    try { t.audio.currentTime = 0; } catch { /* ignore */ }
    t.audio.volume = VOLUME;
  }
}

// BGM 토글 — 재생 중이면 정지, 아니면 (현재 트랙이 있으면) 이어서 / 없으면 처음부터.
export function toggleBgm(): boolean {
  if (tracks.length === 0) {
    userMuted = !userMuted;
    return !userMuted;
  }
  if (isBgmPlaying()) {
    userMuted = true;
    tracks[currentIdx].audio.pause();
    return false;
  } else {
    userMuted = false;
    if (currentIdx >= 0) {
      tracks[currentIdx].audio.play().catch(() => { /* ignore */ });
    } else {
      playFromStart();
    }
    return true;
  }
}

export function isBgmPlaying(): boolean {
  if (currentIdx < 0) return false;
  const a = tracks[currentIdx]?.audio;
  return !!(a && !a.paused);
}

// Vite HMR — 모듈 재로드 시 기존 audio 객체를 정리해 좀비 audio 가 중첩 재생되는 걸 막는다.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const t of tracks) {
      try { t.audio.pause(); } catch { /* ignore */ }
      t.audio.src = '';
    }
    tracks = [];
    if (enterVoice) { try { enterVoice.pause(); } catch { /* ignore */ } enterVoice.src = ''; enterVoice = null; }
  });
}

// 전투장 입장 시 1회 재생되는 보이스. 입장 화면 → 게임 화면 전환 직후 1초 뒤에 호출한다.
let enterVoice: HTMLAudioElement | null = null;
export function playEnterVoice(): void {
  if (!enterVoice) {
    enterVoice = new Audio('/audio/enter-voice.mp3');
    enterVoice.volume = 1.0;
  }
  enterVoice.currentTime = 0;
  enterVoice.play().catch(() => {
    // autoplay 차단되면 (입장 버튼 클릭 직후라 거의 풀려 있음) 조용히 무시.
  });
}
