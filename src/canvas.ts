// 캔버스 백버퍼 사이즈 + 사용자 줌 컨트롤 (PC 휠 / 모바일 핀치 / iOS gesture).
// game.ts 에서 분리 — 한 가지 책임: "캐릭터/맵이 그려질 캔버스의 크기를 정하고,
// 사용자가 줌으로 조정할 수 있게 한다."

import { TILE } from './world';
import { isTouchDevice } from './controls';
import { getViewport, onViewportChange } from './viewport';

export interface CanvasSetupOpts {
  canvas: HTMLCanvasElement;
  /** HUD 오버레이 — 이름/HP 등 크리스프 텍스트 전용. 픽셀아트와 다르게 full DPR 로 그림. */
  hudCanvas: HTMLCanvasElement;
  /** 디버그 패널 + 줌 컨트롤이 공유하는 viewTilesWide getter/setter. */
  getViewTiles: () => number;
  setViewTiles: (n: number) => void;
  /** 모바일 세로 모드에서 강제 사용할 가로 타일 수. */
  mobileTilesWide: number;
  zoomMin: number;
  zoomMax: number;
  /** 백버퍼 해상도가 갱신될 때마다 호출 — 카메라 viewW/H 등을 따라가야 함.
   *  displayScale = "백버퍼 1px 당 CSS px 수" (HUD 캔버스의 backbuffer→screen 좌표 변환에 필요). */
  onSized: (logicalW: number, logicalH: number, displayScale: number) => void;
}

export interface CanvasController {
  /** 현재 viewport 정보로 백버퍼 사이즈를 다시 계산해 적용. */
  resize: () => void;
  /** 가로 타일 수를 직접 설정 (디버그 슬라이더와 줌 컨트롤이 같은 함수 사용). */
  setZoom: (tilesWide: number) => void;
}

export function setupCanvas(opts: CanvasSetupOpts): CanvasController {
  const { canvas, hudCanvas, getViewTiles, setViewTiles, mobileTilesWide, zoomMin, zoomMax, onSized } = opts;
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.imageSmoothingEnabled = false;
  const hudCtx = hudCanvas.getContext('2d')!;

  const resize = () => {
    const vp = getViewport();
    const cssW = canvas.clientWidth || vp.width || window.innerWidth;
    const cssH = canvas.clientHeight || vp.height || window.innerHeight;
    const wantTiles = (isTouchDevice() && cssW < cssH) ? mobileTilesWide : getViewTiles();
    const targetLogicalW = wantTiles * TILE;

    // 보일 가로 타일 수 ⇒ 스케일 ⇒ 논리 해상도.
    // image-rendering: pixelated 가 fractional 스케일도 또렷하게 처리한다.
    const scale = Math.max(1, cssW / targetLogicalW);
    canvas.width  = Math.round(cssW / scale);
    canvas.height = Math.round(cssH / scale);
    // CSS 표시 크기를 backbuffer 와 같은 정수 px 로 고정.
    // 부모 컨테이너가 분수 dvh(예: 833.45px) 일 때 image-rendering: pixelated 가
    // backbuffer→display 비정수 스케일 처리하다가 한 줄을 빠뜨려 가로선 생기는 iOS Safari 이슈 회피.
    // (URL 바 collapse 애니메이션 중에 선이 위로 이동하다가 dvh 안정화되면 그 위치에 멈춤)
    const dispW = Math.round(canvas.width * scale);
    const dispH = Math.round(canvas.height * scale);
    canvas.style.width  = `${dispW}px`;
    canvas.style.height = `${dispH}px`;
    ctx2d.imageSmoothingEnabled = false;

    // HUD 캔버스 — 게임 캔버스와 같은 표시 크기, full DPR 백버퍼.
    const dpr = window.devicePixelRatio || 1;
    hudCanvas.width  = Math.round(dispW * dpr);
    hudCanvas.height = Math.round(dispH * dpr);
    hudCanvas.style.width  = `${dispW}px`;
    hudCanvas.style.height = `${dispH}px`;
    hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0); // 이후엔 CSS px 단위로 그림

    onSized(canvas.width, canvas.height, scale);
  };

  onViewportChange(resize);

  const setZoom = (n: number) => {
    n = Math.max(zoomMin, Math.min(zoomMax, Math.round(n)));
    if (n === getViewTiles()) return;
    setViewTiles(n);
    resize();
    // 디버그 패널 슬라이더 DOM 동기화
    const slider = document.getElementById('dbg-view') as HTMLInputElement | null;
    const valEl  = document.getElementById('dbg-view-val');
    if (slider) slider.value = String(n);
    if (valEl)  valEl.textContent = String(n);
  };

  // ===== PC 마우스 휠 =====
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.deltaY > 0 ? 1 : -1;
    setZoom(getViewTiles() + step);
  }, { passive: false });

  // ===== 모바일 핀치 (document 레벨 — 캔버스 target weirdness 회피) =====
  let pinchStartDist = 0;
  let pinchStartView = 0;
  let pinchActive = false;

  const isOnGameUi = (t: Touch): boolean => {
    const target = t.target as HTMLElement | null;
    if (!target) return false;
    return !!(
      target.closest('#stick') ||
      target.closest('#btn-attack') ||
      target.closest('#chat-bar') ||
      target.closest('#debug-panel')
    );
  };
  const gameTouches = (e: TouchEvent): Touch[] => {
    const out: Touch[] = [];
    for (const t of Array.from(e.touches)) if (!isOnGameUi(t)) out.push(t);
    return out;
  };
  const dist2 = (a: Touch, b: Touch) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  document.addEventListener('touchstart', (e) => {
    const ct = gameTouches(e);
    if (ct.length >= 2) {
      pinchStartDist = dist2(ct[0], ct[1]);
      pinchStartView = getViewTiles();
      pinchActive = true;
      e.preventDefault();
    }
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!pinchActive) return;
    const ct = gameTouches(e);
    if (ct.length < 2) { pinchActive = false; return; }
    e.preventDefault();
    const d = dist2(ct[0], ct[1]);
    if (d > 0 && pinchStartDist > 0) setZoom(pinchStartView * (pinchStartDist / d));
  }, { passive: false });
  const endPinch = () => { pinchActive = false; };
  document.addEventListener('touchend', endPinch);
  document.addEventListener('touchcancel', endPinch);

  // ===== iOS Safari fallback — gesture 이벤트 =====
  type GestureEvent = Event & { scale: number };
  let gestureStartView = 0;
  document.addEventListener('gesturestart', (e) => {
    e.preventDefault?.();
    gestureStartView = getViewTiles();
  }, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gesturechange', (e) => {
    const ge = e as GestureEvent;
    ge.preventDefault?.();
    if (ge.scale && ge.scale > 0) setZoom(gestureStartView / ge.scale);
  }, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gestureend', (e) => {
    e.preventDefault?.();
  }, { passive: false } as AddEventListenerOptions);

  resize();
  return { resize, setZoom };
}
