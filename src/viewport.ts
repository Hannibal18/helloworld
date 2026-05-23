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
    // iOS Safari 자동 스크롤 차단 — input focus 시 페이지를 위로 끌어올려
    // fixed/absolute UI 가 키보드 뒤로 사라지는 케이스를 막는다.
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
    // 키보드 떠 있는 동안에만 .keyboard-open 클래스 토글 → 조이스틱 숨김 등 CSS 가 처리.
    root.classList.toggle('keyboard-open', keyboardOpen);

    // iOS Safari 하단 툴바(주소창)와 키보드가 모두 visualViewport 를 줄인다.
    // 둘 다 챗바를 가리므로, bottomOffset > 0 이면 키보드 여부와 무관하게 챗바·컨트롤을 올려준다.
    // bottomOffset === 0 이면 inline style 비워서 CSS 기본값(desktop 12px 갭 포함) 살린다.
    const chatBar = document.getElementById('chat-bar') as HTMLElement | null;
    const stick = document.getElementById('stick') as HTMLElement | null;
    const touchRight = document.querySelector('.touch-right') as HTMLElement | null;
    if (bottomOffset > 0) {
      if (chatBar) chatBar.style.bottom = `${bottomOffset}px`;
      if (stick) stick.style.bottom = `${64 + bottomOffset}px`;
      if (touchRight) touchRight.style.bottom = `${64 + bottomOffset}px`;
    } else {
      if (chatBar) chatBar.style.bottom = '';
      if (stick) stick.style.bottom = '';
      if (touchRight) touchRight.style.bottom = '';
    }

    if (changed) for (const cb of listeners) cb(current);
  };

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);

  // input focus/blur 안전망 — 일부 iOS Safari 버전에서 visualViewport.resize 이벤트가
  // 늦게 발사되거나 누락되어 키보드 떴는데도 UI 위치 보정이 안 되는 케이스 방어.
  // 키보드 애니메이션 진행 중 여러 시점에 update 를 호출.
  const onFocusChange = () => {
    update();
    setTimeout(update, 100);
    setTimeout(update, 300);
    setTimeout(update, 600);
  };
  window.addEventListener('focusin', onFocusChange);
  window.addEventListener('focusout', onFocusChange);

  update();
  // iOS Safari 가 첫 페이지 로드 시 visualViewport 늦게 안정화 — 300ms 후 한 번 더
  setTimeout(update, 300);
}
