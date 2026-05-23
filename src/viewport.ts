// 보이는 뷰포트(visible viewport) 추적.
// iOS Safari 하단 URL 바 / 브라우저 창 리사이즈를 한 곳에서 관찰하고
// CSS 변수와 구독 API 로 노출한다. 채팅 입력 UI 가 제거되어 키보드 관련
// 위치 보정 로직은 제거됨.

export interface ViewportInfo {
  /** 보이는 뷰포트 폭(CSS px) */
  width: number;
  /** 보이는 뷰포트 높이(CSS px) */
  height: number;
  /** 화면 하단 가려진 영역 (URL 바 등). 카메라 보정용. */
  bottomOffset: number;
}

type Listener = (info: ViewportInfo) => void;

let current: ViewportInfo = { width: 0, height: 0, bottomOffset: 0 };
const listeners = new Set<Listener>();
let started = false;

export function getViewport(): ViewportInfo {
  return current;
}

export function onViewportChange(cb: Listener): () => void {
  listeners.add(cb);
  if (started) cb(current);
  return () => { listeners.delete(cb); };
}

export function setupViewport(): void {
  if (started) return;
  started = true;

  const update = () => {
    if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0) {
      window.scrollTo(0, 0);
    }
    const vv = window.visualViewport;
    const width = vv?.width ?? window.innerWidth;
    const height = vv?.height ?? window.innerHeight;
    const offsetTop = vv?.offsetTop ?? 0;
    const bottomOffset = vv
      ? Math.max(0, window.innerHeight - vv.height - offsetTop)
      : 0;

    const changed =
      width !== current.width ||
      height !== current.height ||
      bottomOffset !== current.bottomOffset;

    current = { width, height, bottomOffset };

    const root = document.documentElement;
    root.style.setProperty('--vp-width', `${width}px`);
    root.style.setProperty('--vp-height', `${height}px`);
    root.style.setProperty('--vp-bottom', `${bottomOffset}px`);

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
}
