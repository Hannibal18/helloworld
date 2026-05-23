// 말풍선을 DOM 오버레이로 그린다. 캔버스의 픽셀 스케일과 독립적이라 선명함.
// 캐릭터의 월드 좌표 → 캔버스 좌표 → CSS 픽셀 좌표 변환을 매 프레임 수행.

interface BubbleEntry {
  el: HTMLDivElement;
  inner: HTMLDivElement;
  text: string;
}

const bubbles = new Map<string, BubbleEntry>();
let layer: HTMLElement | null = null;

function getLayer(): HTMLElement {
  if (!layer) layer = document.getElementById('bubbles')!;
  return layer;
}

function createBubble(): BubbleEntry {
  const el = document.createElement('div');
  el.className = 'maple-bubble';
  const inner = document.createElement('div');
  inner.className = 'maple-bubble-inner';
  const tail = document.createElement('div');
  tail.className = 'maple-bubble-tail';
  el.appendChild(inner);
  el.appendChild(tail);
  getLayer().appendChild(el);
  return { el, inner, text: '' };
}

export function setBubble(id: string, text: string, screenX: number, screenY: number): void {
  let b = bubbles.get(id);
  if (!b) {
    b = createBubble();
    bubbles.set(id, b);
  }
  if (b.text !== text) {
    b.inner.textContent = text;
    b.text = text;
  }
  // 화면 좌표를 round 해서 픽셀 튐 방지
  b.el.style.transform = `translate(${Math.round(screenX)}px, ${Math.round(screenY)}px)`;
}

export function removeBubble(id: string): void {
  const b = bubbles.get(id);
  if (b) {
    b.el.remove();
    bubbles.delete(id);
  }
}

export function syncBubbles(visibleIds: Set<string>): void {
  for (const id of Array.from(bubbles.keys())) {
    if (!visibleIds.has(id)) removeBubble(id);
  }
}
