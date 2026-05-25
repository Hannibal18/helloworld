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
    // 입력 요소가 포커스 안 되어 있으면 키보드 없음 — bottomOffset 0 으로 강제.
    // iOS 26 Safari 의 visualViewport.offsetTop 가 키보드 닫혀도 0 으로 리셋 안 되는 버그 우회.
    const ae = document.activeElement;
    const inputFocused = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || (ae as HTMLElement).isContentEditable);
    const bottomOffset = vv && inputFocused
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
  // focusin/focusout: 입력 포커스 변화 → 즉시 재계산.
  // (vv 이벤트만으론 iOS 의 키보드 닫힘 직후 offsetTop 가 안 리셋되는 케이스 대응 어려움)
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => {
    // 키보드 닫힘 애니메이션 후 한 번 더 (offsetTop reset 늦게 일어나는 경우 대비)
    update();
    setTimeout(update, 250);
  });

  update();
}
