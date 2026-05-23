// 보이는 뷰포트(visible viewport) 추적 — single source of truth.
// iOS Safari 의 하단 URL 바, 모바일 키보드, 브라우저 창 리사이즈 등을 한 곳에서 관찰하고
// 다른 모듈이 그 결과를 일관되게 쓸 수 있도록 CSS 변수 + JS 구독 API 로 노출한다.

export interface ViewportInfo {
  /** 보이는 뷰포트 폭(CSS px) — visualViewport 또는 innerWidth */
  width: number;
  /** 보이는 뷰포트 높이(CSS px) — visualViewport.height 또는 innerHeight */
  height: number;
  /** 화면 하단 가려진 영역 — URL 바 + 키보드 합산. 채팅바·컨트롤이 이만큼 위로 올라가야 함. */
  bottomOffset: number;
  /** 키보드가 열려 있는지 — bottomOffset 임계치로 추정 */
  keyboardOpen: boolean;
}

type Listener = (info: ViewportInfo) => void;

const KEYBOARD_THRESHOLD_PX = 150;

let current: ViewportInfo = {
  width: 0, height: 0, bottomOffset: 0, keyboardOpen: false,
};
const listeners = new Set<Listener>();
let started = false;

export function getViewport(): ViewportInfo {
  return current;
}

export function onViewportChange(cb: Listener): () => void {
  listeners.add(cb);
  // 구독 즉시 현재 상태 1회 호출 (시작 후라면)
  if (started) cb(current);
  return () => { listeners.delete(cb); };
}

export function setupViewport(): void {
  if (started) return;
  started = true;

  const update = () => {
    const vv = window.visualViewport;
    const width = vv?.width ?? window.innerWidth;
    const height = vv?.height ?? window.innerHeight;
    const offsetTop = vv?.offsetTop ?? 0;
    const bottomOffset = vv
      ? Math.max(0, window.innerHeight - vv.height - offsetTop)
      : 0;
    const keyboardOpen = bottomOffset > KEYBOARD_THRESHOLD_PX;

    const changed =
      width !== current.width ||
      height !== current.height ||
      bottomOffset !== current.bottomOffset ||
      keyboardOpen !== current.keyboardOpen;

    current = { width, height, bottomOffset, keyboardOpen };

    // CSS 변수 노출 — UI 가 직접 var(--vp-bottom) 등을 참조해 위치 조정
    const root = document.documentElement;
    root.style.setProperty('--vp-width', `${width}px`);
    root.style.setProperty('--vp-height', `${height}px`);
    root.style.setProperty('--vp-bottom', `${bottomOffset}px`);
    // 채팅바를 visible viewport 의 BOTTOM 에 정확히 붙이기 위한 anchor.
    // chat-bar 는 position:fixed + top:var(--chat-anchor-top) + translateY(-100%) 로 위치.
    const anchorTop = (vv?.offsetTop ?? 0) + height;
    root.style.setProperty('--chat-anchor-top', `${anchorTop}px`);
    root.classList.toggle('keyboard-open', keyboardOpen);

    if (changed) for (const cb of listeners) cb(current);
  };

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);

  update();
  // iOS Safari 가 첫 페이지 로드 시 visualViewport 늦게 안정화 — 300ms 후 한 번 더
  setTimeout(update, 300);
}
