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

  // ===== rAF 보간 =====
  // 키보드 애니메이션 동안 visualViewport.resize 가 2~3 회만 띄엄띄엄 발사돼서
  // 직접 style.bottom 을 박으면 그 사이에 챗바·컨트롤이 계단식으로 점프한다.
  // CSS transition 은 매 이벤트마다 재시작돼 오히려 더 끊겨 보임.
  // → 별도 currentBottom 을 두고 매 프레임 target 쪽으로 지수 보간해 60fps 로 그린다.
  const HALF_LIFE_MS = 55; // 약 0.16초만에 목표의 ~88% 도달 — iOS 키보드와 비슷한 속도
  let targetBottom = 0;
  let currentBottom = 0;
  let rafId = 0;
  let lastTime = 0;

  const applyPositions = () => {
    const chatBar = document.getElementById('chat-bar') as HTMLElement | null;
    const stick = document.getElementById('stick') as HTMLElement | null;
    const touchRight = document.querySelector('.touch-right') as HTMLElement | null;
    if (currentBottom > 0) {
      if (chatBar) chatBar.style.bottom = `${currentBottom}px`;
      if (stick) stick.style.bottom = `${64 + currentBottom}px`;
      if (touchRight) touchRight.style.bottom = `${64 + currentBottom}px`;
    } else {
      if (chatBar) chatBar.style.bottom = '';
      if (stick) stick.style.bottom = '';
      if (touchRight) touchRight.style.bottom = '';
    }
  };

  const tick = (now: number) => {
    const dt = now - lastTime;
    lastTime = now;
    const factor = 1 - Math.pow(0.5, dt / HALF_LIFE_MS);
    const next = currentBottom + (targetBottom - currentBottom) * factor;
    if (Math.abs(targetBottom - next) < 0.3) {
      currentBottom = targetBottom;
      applyPositions();
      rafId = 0;
      return;
    }
    currentBottom = next;
    applyPositions();
    rafId = requestAnimationFrame(tick);
  };

  const setTarget = (b: number) => {
    if (b === targetBottom) return;
    targetBottom = b;
    if (rafId === 0) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  };

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

    // CSS 변수 — 외부에서 var(--vp-bottom) 참조 가능 (현재 직접 쓰는 곳은 없음)
    const root = document.documentElement;
    root.style.setProperty('--vp-width', `${width}px`);
    root.style.setProperty('--vp-height', `${height}px`);
    root.style.setProperty('--vp-bottom', `${bottomOffset}px`);
    root.classList.toggle('keyboard-open', keyboardOpen);

    // 새 target 으로 rAF 보간 시작 (현재 진행 중인 보간이 있으면 그쪽으로 추적 방향만 바뀜)
    setTarget(bottomOffset);

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
  // 늦게 발사되거나 누락되어 키보드 떴는데도 target 갱신이 안 되는 케이스 방어.
  // 키보드 애니메이션 시작 직후·중간·끝에 update 를 한 번씩.
  const onFocusChange = () => {
    update();
    setTimeout(update, 120);
    setTimeout(update, 300);
    setTimeout(update, 600);
  };
  window.addEventListener('focusin', onFocusChange);
  window.addEventListener('focusout', onFocusChange);

  update();
  setTimeout(update, 300);
}
