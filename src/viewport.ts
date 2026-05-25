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
// focusin/focusout 으로 직접 추적. document.activeElement 는 focusin 시점에
// 아직 갱신 안 된 경우 있어 신뢰 X (iOS Safari 에서 특히).
let inputFocusedFlag = false;

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

    // 키보드 높이 계산 — innerHeight - vv.height. offsetTop 은 시각적 스크롤 위치라
    // 키보드 높이와 무관 (이전 공식이 offsetTop 빼서 transient 폭주 유발했음).
    // 입력 포커스 없으면 키보드 없음 — 강제 0.
    let bottomOffset = 0;
    if (vv && inputFocusedFlag) {
      bottomOffset = Math.max(0, window.innerHeight - vv.height);
      // 비합리적 값 (창 높이의 80% 이상) 거부 — transient 버그 방어.
      const cap = window.innerHeight * 0.8;
      if (bottomOffset > cap) bottomOffset = 0;
    }

    const changed =
      width !== current.width ||
      height !== current.height ||
      bottomOffset !== current.bottomOffset;

    if (!changed) return;
    current = { width, height, bottomOffset };

    const root = document.documentElement;
    root.style.setProperty('--vp-width', `${width}px`);
    root.style.setProperty('--vp-height', `${height}px`);
    root.style.setProperty('--vp-bottom', `${bottomOffset}px`);

    for (const cb of listeners) cb(current);
  };

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  // focusin/focusout: 입력 포커스 변화 → flag 직접 설정 후 update.
  // (document.activeElement 는 focusin 시점에 아직 갱신 안 된 경우 있어 신뢰 X)
  const isInputLike = (el: EventTarget | null): boolean => {
    const e = el as HTMLElement | null;
    return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable);
  };
  document.addEventListener('focusin', (e) => {
    if (isInputLike(e.target)) {
      inputFocusedFlag = true;
      update();
    }
  });
  document.addEventListener('focusout', (e) => {
    if (isInputLike(e.target)) {
      inputFocusedFlag = false;
      update();
      // 키보드 닫힘 애니메이션 후 한 번 더 — vv 가 늦게 리셋되는 경우 대응
      setTimeout(update, 300);
    }
  });

  update();
}
