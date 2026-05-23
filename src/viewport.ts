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
const DEFAULT_KEYBOARD_HEIGHT = 300; // 캐시 없는 첫 오픈용 추정값 (iOS 표준 키보드 ≈ 260~340)

let current: ViewportInfo = {
  width: 0, height: 0, bottomOffset: 0, keyboardOpen: false,
};
const listeners = new Set<Listener>();
let started = false;
// 키보드 열린 동안 관측한 bottomOffset 의 최댓값 — 다음 오픈 시 즉시 그 높이로 점프.
let cachedKeyboardHeight = 0;
// 외부에서 setTarget 호출하도록 후크.
let setBottomTarget: ((b: number) => void) = () => {};
// hintKeyboardOpening 호출 시각 — 이 시점부터 iOS 키보드 애니메이션이 끝날 때까지
// (~600ms) vv.height 가 아직 갱신 안 된 0 값으로 hint 를 덮어쓰는 걸 막는다.
let hintOpenAt = 0;
const HINT_OPEN_WINDOW_MS = 600;

export function getViewport(): ViewportInfo {
  return current;
}

export function onViewportChange(cb: Listener): () => void {
  listeners.add(cb);
  if (started) cb(current);
  return () => { listeners.delete(cb); };
}

// 사용자 제스처로 키보드가 곧 올라온다는 힌트 — vv.resize 기다리지 말고
// 미리 챗바·컨트롤을 올려둠. iOS 키보드 애니메이션 시작과 동시에 움직이는 효과.
export function hintKeyboardOpening(): void {
  const h = cachedKeyboardHeight > 0 ? cachedKeyboardHeight : DEFAULT_KEYBOARD_HEIGHT;
  hintOpenAt = performance.now();
  setBottomTarget(h);
}

// 사용자 제스처로 키보드가 곧 닫힘 — 즉시 target=0 으로 snap.
export function hintKeyboardClosing(): void {
  hintOpenAt = 0; // 가드 해제 — vv 가 0 보고하면 그대로 반영
  setBottomTarget(0);
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
    // 키보드 내려갈 때(target=0)는 보간 없이 즉시 snap.
    if (b === 0) {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      currentBottom = 0;
      applyPositions();
      return;
    }
    if (rafId === 0) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  };
  // 외부 hint 함수가 호출할 수 있도록 노출
  setBottomTarget = setTarget;

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

    // 키보드 열림으로 판정될 때마다 높이 캐시 갱신 — 다음 오픈 시 즉시 그 높이로 점프.
    if (keyboardOpen && bottomOffset > cachedKeyboardHeight) {
      cachedKeyboardHeight = bottomOffset;
    }

    // CSS 변수 — 외부에서 var(--vp-bottom) 참조 가능
    const root = document.documentElement;
    root.style.setProperty('--vp-width', `${width}px`);
    root.style.setProperty('--vp-height', `${height}px`);
    root.style.setProperty('--vp-bottom', `${bottomOffset}px`);
    root.classList.toggle('keyboard-open', keyboardOpen);

    // 새 target 으로 rAF 보간 시작.
    // 단, hintKeyboardOpening 직후 ~600ms 동안 vv 가 아직 0 으로 보고하는
    // (= iOS 키보드 애니메이션이 진행 중인) 구간에는 vv=0 으로 hint 를 덮어쓰지 않는다.
    const inHintOpenWindow =
      hintOpenAt > 0 && performance.now() - hintOpenAt < HINT_OPEN_WINDOW_MS;
    if (!(bottomOffset === 0 && inHintOpenWindow)) {
      setTarget(bottomOffset);
      // 키보드가 실제로 떴음을 vv 가 확인 → 가드 해제
      if (bottomOffset > 0) hintOpenAt = 0;
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

  // input focus/blur 안전망.
  // - focusin: 키보드가 곧 올라옴. visualViewport.resize 이벤트가 늦게 발사돼도
  //   잡히도록 여러 시점에 update.
  // - focusout: iOS Safari 는 vv.resize 를 키보드 다 닫힌 뒤에야 발사해서
  //   챗바가 키보드 닫히는 ~250ms 동안 떠 있다 뚝 내려옴. 그래서 focusout 즉시
  //   target=0 으로 snap → 키보드 사라지는 모션과 같이 챗바도 바로 내려간다.
  //   (게임 화면에 다른 입력이 없어서 focusout 은 항상 키보드 닫힘을 의미)
  window.addEventListener('focusin', () => {
    update();
    setTimeout(update, 120);
    setTimeout(update, 300);
    setTimeout(update, 600);
  });
  window.addEventListener('focusout', () => {
    setTarget(0);
    // 안전망: 뒤늦게 vv 가 다른 값을 보고하면 맞춰 갱신
    setTimeout(update, 300);
  });

  update();
  setTimeout(update, 300);
}
