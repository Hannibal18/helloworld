// 배경음악 (BGM) — 3곡 플레이리스트가 무한 반복되며 모든 접속자가 같은 곡의 같은 위치를 듣는다.
//
// 동기화 원리:
//   각 곡의 duration 을 모두 합한 totalDuration 을 한 사이클로 본다.
//   현재 사이클 안의 위치 = (Date.now() / 1000) mod totalDuration.
//   모두 같은 epoch 시계를 보므로(약간의 OS 시계 오차 ±수백 ms 무시) 자동으로 동일 곡, 동일 시점 재생.
//
// 브라우저 자동재생 정책:
//   - 자동재생은 보통 차단된다. 첫 사용자 제스처에서 재생을 시작한다.
//   - iOS Safari/모바일 Chrome 은 "이 제스처에서 play() 호출된 audio 객체"만 unlock 한다.
//     따라서 다음 곡 전환 시점(setTimeout/'ended' 콜백) 은 user gesture 컨텍스트가 아니라
//     새 audio.play() 가 차단될 수 있다 → 첫 제스처에서 3개 audio 를 모두 한 번씩 unlock 한다.
//
// 곡 전환:
//   - 일차 메커니즘: audio.ended 이벤트 → 다음 곡으로 sync.
//   - 안전망: setTimeout (audio.duration 이 부정확하거나 ended 가 발사 안 되는 경우 대비).
//     +500ms 여유를 둬 ended 가 먼저 발사되도록 한다.

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
let syncTimer: number | null = null;

function durationOf(t: Track): number {
  const d = t.audio.duration;
  return isFinite(d) && d > 0 ? d : 0;
}

function totalDuration(): number {
  let s = 0;
  for (const t of tracks) s += durationOf(t);
  return s;
}

async function loadTrack(url: string): Promise<Track> {
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.volume = VOLUME;
  audio.loop = false; // 우리가 직접 다음 곡으로 전환
  await new Promise<void>((resolve, reject) => {
    if (isFinite(audio.duration) && audio.duration > 0) return resolve();
    audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('audio load failed: ' + url)), { once: true });
  });
  const t: Track = { url, audio };
  audio.addEventListener('ended', () => {
    if (userMuted) return;
    syncAndPlay();
  });
  return t;
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

  if (totalDuration() <= 0) return;

  // 자동재생 시도 (대개 차단됨)
  tryPlay();

  const gestureEvents: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'touchstart'];
  const onGesture = (): void => {
    // user gesture 컨텍스트에서 모든 audio unlock → 이후 콜백에서도 play() 가능
    void unlockAll().then(() => {
      if (!userMuted) syncAndPlay();
    });
    for (const ev of gestureEvents) document.removeEventListener(ev, onGesture);
  };
  for (const ev of gestureEvents) document.addEventListener(ev, onGesture);
}

// 모든 audio 객체를 user-gesture 안에서 한 번 play() → pause() 처리해 unlock 한다.
// 모바일/Safari 에서는 곡 전환 시점(콜백)에 새 audio.play() 가 차단되는 걸 방지.
// volume=0 으로 시작해 잠시 동시 재생되는 소리가 새는 일을 막는다.
async function unlockAll(): Promise<void> {
  if (unlocked) return;
  unlocked = true;
  // 1) user-gesture 컨텍스트가 살아있는 동안 동기 루프로 play() 모두 호출
  const promises: Array<Promise<unknown>> = [];
  for (const t of tracks) {
    t.audio.volume = 0;
    promises.push(t.audio.play().catch(() => { /* ignore */ }));
  }
  // 2) 모두 시작된 뒤 즉시 정지하고 원래 볼륨으로
  await Promise.allSettled(promises);
  for (const t of tracks) {
    t.audio.pause();
    try { t.audio.currentTime = 0; } catch { /* ignore */ }
    t.audio.volume = VOLUME;
  }
}

function tryPlay(): void {
  if (userMuted || tracks.length === 0) return;
  if (totalDuration() <= 0) return;
  syncAndPlay();
}

// 현재 epoch 시각 기준 어느 트랙의 어느 위치를 재생해야 하는지 계산해 맞춘다.
function syncAndPlay(): void {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  const total = totalDuration();
  if (total <= 0) return;

  const pos = (Date.now() / 1000) % total;
  let idx = 0;
  let acc = 0;
  for (let i = 0; i < tracks.length; i++) {
    const d = durationOf(tracks[i]);
    if (pos < acc + d) { idx = i; break; }
    acc += d;
  }
  const offset = pos - acc;

  // 다른 트랙들 정지
  for (let i = 0; i < tracks.length; i++) {
    if (i !== idx && !tracks[i].audio.paused) tracks[i].audio.pause();
  }

  currentIdx = idx;
  const t = tracks[idx];
  try { t.audio.currentTime = offset; } catch { /* 일부 브라우저가 seek 직후 throw */ }
  t.audio.play().catch(() => { /* autoplay 차단 — 다음 제스처에서 재시도 */ });

  // 안전망 setTimeout — ended 이벤트가 안 발사되거나 늦는 경우만 발사되도록 +500ms 여유.
  // 정상 흐름은 audio.ended → syncAndPlay 가 먼저 실행되어 이 타이머를 clear 한다.
  const remaining = durationOf(t) - offset;
  if (remaining > 0 && isFinite(remaining)) {
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      if (userMuted) return;
      syncAndPlay();
    }, remaining * 1000 + 500);
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
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
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
