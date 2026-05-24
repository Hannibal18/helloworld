// 가벼운 SFX 시스템 — HTMLAudioElement 기반.
// 동시 재생 위해 매 play 마다 cloneNode 사용 (Web Audio API 대비 단순).
// iOS 는 첫 사용자 제스처 후에야 재생 가능 → 입장 시 unlock 호출 필요.

const bank = new Map<string, HTMLAudioElement>();

export function load(key: string, url: string, volume = 1.0): void {
  if (bank.has(key)) return;
  const a = new Audio(url);
  a.preload = 'auto';
  a.volume = volume;
  bank.set(key, a);
}

// 한 키에 여러 변형 등록 — play 시 랜덤 picking.
const variants = new Map<string, string[]>();
export function loadVariants(key: string, urls: string[], volume = 1.0): void {
  variants.set(key, urls.map((u, i) => {
    const subKey = `${key}:${i}`;
    load(subKey, u, volume);
    return subKey;
  }));
}

export function play(key: string): void {
  let pickKey = key;
  const vlist = variants.get(key);
  if (vlist && vlist.length > 0) pickKey = vlist[Math.floor(Math.random() * vlist.length)];
  const src = bank.get(pickKey);
  if (!src) return;
  // cloneNode 로 동시 재생 가능
  const node = src.cloneNode() as HTMLAudioElement;
  node.volume = src.volume;
  node.play().catch(() => { /* autoplay 차단 등 — 조용히 무시 */ });
}

// iOS Safari 자동 재생 차단 해제 — 첫 사용자 제스처 핸들러에서 호출.
let unlocked = false;
export function unlock(): void {
  if (unlocked) return;
  unlocked = true;
  for (const a of bank.values()) {
    a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => { /* ignore */ });
  }
}
