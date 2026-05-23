// 배경음악 (BGM) — 3곡 플레이리스트가 무한 반복되며 모든 접속자가 같은 곡의 같은 위치를 듣는다.
//
// 동기화 원리:
//   각 곡의 duration 을 모두 합한 totalDuration 을 한 사이클로 본다.
//   현재 사이클 안의 위치 = (Date.now() / 1000) mod totalDuration.
//   모두 같은 epoch 시계를 보므로(약간의 OS 시계 오차 ±수백 ms 무시) 자동으로 동일 곡, 동일 시점 재생.
//
// 브라우저 자동재생 정책: 첫 사용자 제스처 전엔 play() 가 거부될 수 있다.
// 그래서 1) 일단 즉시 시도, 2) 차단되면 첫 클릭/키/터치에 다시 시도.

const TRACK_URLS: readonly string[] = [
  '/audio/Henesys Port Vibes.mp3',
  '/audio/Kerning City Shadows.mp3',
  '/audio/Future Lith.mp3',
] as const;

type Track = { url: string; audio: HTMLAudioElement; duration: number };

let tracks: Track[] = [];
let totalDuration = 0;
let currentIdx = -1;
let userMuted = false;
let advanceTimer: number | null = null;
let setupStarted = false;

async function loadTrack(url: string): Promise<Track> {
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.volume = 0.5;
  audio.loop = false; // 각 곡 끝나면 우리가 직접 다음 곡으로 전환
  await new Promise<void>((resolve, reject) => {
    if (isFinite(audio.duration) && audio.duration > 0) return resolve();
    audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('audio load failed: ' + url)), { once: true });
  });
  return { url, audio, duration: audio.duration };
}

export async function setupBgm(): Promise<void> {
  if (setupStarted) return; // HMR / 중복 호출 안전망
  setupStarted = true;

  try {
    tracks = await Promise.all(TRACK_URLS.map(loadTrack));
  } catch (e) {
    console.warn('[bgm] load failed', e);
    return;
  }

  totalDuration = tracks.reduce((s, t) => s + t.duration, 0);
  if (totalDuration <= 0) return;

  tryPlay();

  const gestureEvents: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'touchstart'];
  const onGesture = (): void => {
    tryPlay();
    for (const ev of gestureEvents) document.removeEventListener(ev, onGesture);
  };
  for (const ev of gestureEvents) document.addEventListener(ev, onGesture);
}

function tryPlay(): void {
  if (userMuted) return;
  if (tracks.length === 0 || totalDuration <= 0) return;
  syncAndPlay();
}

// 현재 epoch 시각 기준 어느 트랙의 어느 위치를 재생해야 하는지 계산해 맞춘다.
function syncAndPlay(): void {
  if (advanceTimer !== null) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }

  const pos = (Date.now() / 1000) % totalDuration;
  let idx = 0;
  let acc = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (pos < acc + tracks[i].duration) { idx = i; break; }
    acc += tracks[i].duration;
  }
  const offset = pos - acc;

  // 다른 트랙들 정지
  for (let i = 0; i < tracks.length; i++) {
    if (i !== idx && !tracks[i].audio.paused) tracks[i].audio.pause();
  }

  currentIdx = idx;
  const t = tracks[idx];
  try { t.audio.currentTime = offset; } catch { /* 일부 브라우저가 seek 직후 throw */ }
  t.audio.play().catch(() => { /* autoplay 차단 — 다음 제스처에서 다시 시도 */ });

  // 현재 곡이 끝나기 직전에 다음 곡으로 재동기화
  const remaining = t.duration - offset;
  if (remaining > 0 && isFinite(remaining)) {
    advanceTimer = window.setTimeout(() => {
      advanceTimer = null;
      if (userMuted) return;
      syncAndPlay();
    }, remaining * 1000 + 50);
  }
}

// BGM 토글 — 재생 중이면 정지, 아니면 동기화 위치부터 재생. 새 재생 상태 반환.
export function toggleBgm(): boolean {
  if (tracks.length === 0) {
    // 아직 metadata 로딩 중 — userMuted 만 뒤집어 둔다.
    userMuted = !userMuted;
    return !userMuted;
  }
  if (isBgmPlaying()) {
    userMuted = true;
    for (const t of tracks) t.audio.pause();
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    return false;
  } else {
    userMuted = false;
    syncAndPlay();
    return true;
  }
}

export function isBgmPlaying(): boolean {
  if (currentIdx < 0) return false;
  const a = tracks[currentIdx]?.audio;
  return !!(a && !a.paused);
}

// 전투장 입장 시 1회 재생되는 보이스. 입장 화면 → 게임 화면 전환 직후 1초 뒤에 호출한다.
// 사용자가 BGM 을 끈 상태(userMuted)여도 명시 트리거이므로 일단 재생 시도.
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
