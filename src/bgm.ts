// 배경음악 — 4트랙 셔플 플레이리스트.
// HTMLAudioElement 한 개만 사용 (BGM 은 동시 재생 필요 X). 한 곡 끝나면
// 다른 곡 무작위 (직전과 다른 곡) 으로 자동 전환.
//
// iOS Safari 정책상 첫 .play() 는 사용자 제스처 안에서 호출돼야 함 →
// 입장 버튼 핸들러에서 startBgm() 호출.

const TRACKS = [
  '/audio/bgm/track1.mp3',
  '/audio/bgm/track2.mp3',
  '/audio/bgm/track3.mp3',
  '/audio/bgm/track4.mp3',
];

const VOLUME = 0.3;
let current: HTMLAudioElement | null = null;
let lastIndex = -1;
let started = false;
let muted = false;

function pickTrack(): string {
  let i = Math.floor(Math.random() * TRACKS.length);
  while (TRACKS.length > 1 && i === lastIndex) {
    i = Math.floor(Math.random() * TRACKS.length);
  }
  lastIndex = i;
  return TRACKS[i];
}

function playNext(): void {
  if (current) {
    try { current.pause(); } catch { /* ignore */ }
    current.src = '';
    current = null;
  }
  const a = new Audio(pickTrack());
  a.volume = VOLUME;
  a.muted = muted;
  a.addEventListener('ended', () => { playNext(); });
  current = a;
  a.play().catch(() => { /* autoplay 차단 — 조용히 무시 */ });
}

export function startBgm(): void {
  if (started) return;
  started = true;
  playNext();
}

export function setBgmMuted(m: boolean): void {
  muted = m;
  if (current) current.muted = m;
}
export function isBgmMuted(): boolean { return muted; }
