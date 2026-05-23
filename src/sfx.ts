// 효과음 (SFX) — Web Audio API 로 합성. 외부 파일 의존 없음.
//
// 설계:
//   - 모든 사운드는 onUserGesture() 가 한 번 호출된 후에만 재생. (브라우저 autoplay 정책)
//   - playSfx('name') 한 줄로 호출. 미리 정의된 5종.
//   - 마스터 볼륨 0.4 — BGM(0.5) 보다 살짝 작아 거슬리지 않게.
//
// 진짜 녹음 사운드로 교체하고 싶을 때: useFile() 로 같은 키에 mp3 등록하면 합성 대신 그 파일을 재생.

type SfxName = 'punch_swing' | 'punch_hit' | 'death' | 'ui_click';

const MASTER_VOLUME = 0.4;

let audioCtx: AudioContext | null = null;
let muted = false;
const fileBuffers = new Map<SfxName, AudioBuffer>();

function ctx(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  audioCtx = new AC();
  return audioCtx;
}

// 첫 사용자 제스처(클릭/터치/키) 후 호출 — AudioContext resume + 향후 재생 가능 상태로.
// main.ts 의 기존 gesture 리스너에서 같이 트리거하면 됨.
export function unlockSfx(): void {
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {/* 일부 브라우저 noop */});
}

export function setSfxMuted(m: boolean): void { muted = m; }
export function isSfxMuted(): boolean { return muted; }

// 외부 파일로 합성 사운드를 덮어쓰기 (옵션).
// 예: await useFile('punch_hit', '/audio/sfx/punch.mp3')
export async function useFile(name: SfxName, url: string): Promise<void> {
  const c = ctx();
  if (!c) return;
  try {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await c.decodeAudioData(arr);
    fileBuffers.set(name, buf);
  } catch (e) {
    console.warn('[sfx] useFile failed', name, url, e);
  }
}

export function playSfx(name: SfxName): void {
  if (muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended') return; // 아직 unlock 전 — 조용히 무시

  // 외부 파일이 등록돼 있으면 그걸 재생.
  const buf = fileBuffers.get(name);
  if (buf) {
    const src = c.createBufferSource();
    src.buffer = buf;
    const gain = c.createGain();
    gain.gain.value = MASTER_VOLUME;
    src.connect(gain).connect(c.destination);
    src.start();
    return;
  }

  // 합성 — 사운드별 분기.
  switch (name) {
    case 'punch_swing': return synthSwoosh(c);
    case 'punch_hit':   return synthThud(c);
    case 'death':       return synthDeath(c);
    case 'ui_click':    return synthClick(c);
  }
}

// 짧은 화이트노이즈 + 로우패스 sweep — 펀치 휘두름 "쉭".
function synthSwoosh(c: AudioContext): void {
  const dur = 0.12;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // 시간에 따라 점점 줄어드는 노이즈
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * (1 - t);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2000, c.currentTime);
  filter.frequency.exponentialRampToValueAtTime(400, c.currentTime + dur);
  const gain = c.createGain();
  gain.gain.value = MASTER_VOLUME * 0.5;
  src.connect(filter).connect(gain).connect(c.destination);
  src.start();
}

// 저음 sine + 클릭 노이즈 — 펀치 명중 "퍽".
function synthThud(c: AudioContext): void {
  const now = c.currentTime;
  // 저음 도약
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.12);
  const oscGain = c.createGain();
  oscGain.gain.setValueAtTime(MASTER_VOLUME * 0.9, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
  osc.connect(oscGain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.2);

  // 초기 클릭 (transient)
  const click = c.createBufferSource();
  const clickBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.02), c.sampleRate);
  const cd = clickBuf.getChannelData(0);
  for (let i = 0; i < cd.length; i++) cd[i] = (Math.random() * 2 - 1) * (1 - i / cd.length);
  click.buffer = clickBuf;
  const clickGain = c.createGain();
  clickGain.gain.value = MASTER_VOLUME * 0.4;
  click.connect(clickGain).connect(c.destination);
  click.start(now);
}

// 하강 음계 — 사망 "쿵 ↓↓".
function synthDeath(c: AudioContext): void {
  const now = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(55, now + 0.4);
  const gain = c.createGain();
  gain.gain.setValueAtTime(MASTER_VOLUME * 0.35, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.55);
}

// 짧은 sine 클릭 — UI 버튼.
function synthClick(c: AudioContext): void {
  const now = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(900, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.05);
  const gain = c.createGain();
  gain.gain.setValueAtTime(MASTER_VOLUME * 0.4, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}
