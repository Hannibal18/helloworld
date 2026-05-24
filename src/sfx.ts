// Web Audio 기반 가벼운 SFX. iOS Safari 호환:
//   - AudioContext 한 개만 생성. 첫 user gesture 에서 resume() (unlock).
//   - mp3 한 번 decode → AudioBuffer 캐시. play 마다 BufferSource 새로 만들어
//     n발 동시 재생 OK.
//   - HTMLAudioElement.cloneNode 방식은 iOS 에서 unlock 상태가 복제되지 않아
//     무음 되는 경우 있어서 폐기.

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = W.AudioContext ?? W.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

const buffers = new Map<string, AudioBuffer>();
const volumes = new Map<string, number>();
const variants = new Map<string, string[]>();

export function load(key: string, url: string, volume = 1.0): void {
  volumes.set(key, volume);
  if (buffers.has(key)) return;
  const c = getCtx();
  if (!c) return;
  fetch(url)
    .then((r) => r.arrayBuffer())
    .then((ab) => c.decodeAudioData(ab))
    .then((buf) => { buffers.set(key, buf); })
    .catch((e) => console.warn('[sfx] load failed', key, url, e));
}

export function loadVariants(key: string, urls: string[], volume = 1.0): void {
  const subs = urls.map((u, i) => {
    const sk = `${key}:${i}`;
    load(sk, u, volume);
    return sk;
  });
  variants.set(key, subs);
}

export function play(key: string): void {
  const c = getCtx();
  if (!c) return;
  // suspended 면 자동 resume 시도 (gesture 안에서 호출됐을 때만 실제로 풀림)
  if (c.state === 'suspended') c.resume().catch(() => {});

  let pickKey = key;
  const vs = variants.get(key);
  if (vs && vs.length > 0) pickKey = vs[Math.floor(Math.random() * vs.length)];

  const buf = buffers.get(pickKey);
  if (!buf) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  gain.gain.value = volumes.get(pickKey) ?? 1.0;
  src.connect(gain).connect(c.destination);
  try { src.start(0); } catch { /* ignore */ }
}

// 첫 사용자 제스처 핸들러 — AudioContext suspended 풀어줌.
export function unlock(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
}

// ===== 합성 효과음 (외부 파일 없이 WebAudio 로 즉석 생성) =====

// 한 음 — type 의 wave 로 freq 헤르츠를 dur 초 재생, 부드러운 envelope.
function tone(freq: number, durSec: number, type: OscillatorType, vol = 0.18, startOffset = 0): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const start = c.currentTime + startOffset;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durSec);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + durSec + 0.02);
}

// 스테이지 전환 — 짧은 3음 상승 차임 (C5-E5-G5).
export function playStageTransition(): void {
  tone(523.25, 0.18, 'triangle', 0.16, 0);
  tone(659.25, 0.18, 'triangle', 0.16, 0.08);
  tone(783.99, 0.30, 'triangle', 0.18, 0.16);
}

// 보스 등장 — 낮은 사이렌 sweep.
export function playBossAlert(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const start = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(180, start);
  osc.frequency.linearRampToValueAtTime(90,  start + 0.4);
  osc.frequency.linearRampToValueAtTime(200, start + 0.8);
  osc.frequency.linearRampToValueAtTime(110, start + 1.2);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.22, start + 0.05);
  gain.gain.setValueAtTime(0.22, start + 1.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.3);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + 1.35);
}
