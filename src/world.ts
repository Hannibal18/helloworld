// 월드 좌표/카메라.
// 타일맵 데이터는 map.ts 의 TileMap 이 담당한다 — 본 파일은 좌표계 상수와 카메라만.

export const TILE = 32; // LPC 표준 32×32 타일

export interface Camera {
  x: number;        // 최종 렌더용 좌표 (smooth + shake 포함)
  y: number;
  smoothX: number;  // 부드럽게 따라오는 위치
  smoothY: number;
  viewW: number;
  viewH: number;
  shakeStrength: number; // 화면 흔들림 강도 (px)
}

export function makeCamera(viewW = 320, viewH = 240): Camera {
  return { x: 0, y: 0, smoothX: 0, smoothY: 0, viewW, viewH, shakeStrength: 0 };
}

// targetX/Y 로 부드럽게 추적하고, 흔들림(shake) 을 더해 최종 cam.x/y 를 계산.
// centerRatioY: 캐릭터를 화면 세로의 어느 비율에 둘지 (0.5 = 정중앙, 0.35 = 위쪽 1/3).
// 채팅바·키보드가 하단을 가릴 때 작게 잡아서 캐릭터가 안 가리게.
export function updateCamera(
  cam: Camera,
  targetX: number,
  targetY: number,
  worldW: number,
  worldH: number,
  dt: number,
  centerRatioY: number = 0.5,
): void {
  let cx = targetX - cam.viewW / 2;
  let cy = targetY - cam.viewH * centerRatioY;
  if (worldW <= cam.viewW) cx = (worldW - cam.viewW) / 2;
  else cx = Math.max(0, Math.min(worldW - cam.viewW, cx));
  if (worldH <= cam.viewH) cy = (worldH - cam.viewH) / 2;
  else cy = Math.max(0, Math.min(worldH - cam.viewH, cy));

  // 부드럽게 따라오기 — 시간 상수 ~100ms.
  // viewH 변화(iOS URL 바 collapse 시 dvh 변동)로 cy 점프가 발생하면 카메라 smooth lerp 가
  // 작동해서 월드가 화면에서 위/아래로 흐르는 시각적 artifact 가 생김. lerp 결과는 round 한 정수 픽셀.
  const k = 1 - Math.exp(-dt / 0.1);
  cam.smoothX += (cx - cam.smoothX) * k;
  cam.smoothY += (cy - cam.smoothY) * k;
  // 작은 잔차 (sub-pixel) 는 강제 snap — 부드러운 lerp 가 거의 끝났을 때 분수 cam.y 가
  // tile round 위치를 미세하게 바꾸면서 가로선 artifact 유발할 수 있음. 0.5px 미만이면 target 으로 lock.
  if (Math.abs(cx - cam.smoothX) < 0.5) cam.smoothX = cx;
  if (Math.abs(cy - cam.smoothY) < 0.5) cam.smoothY = cy;

  // 흔들림 decay — 60ms
  if (cam.shakeStrength > 0) {
    cam.shakeStrength *= Math.exp(-dt / 0.06);
    if (cam.shakeStrength < 0.2) cam.shakeStrength = 0;
  }
  const sx = cam.shakeStrength > 0 ? (Math.random() * 2 - 1) * cam.shakeStrength : 0;
  const sy = cam.shakeStrength > 0 ? (Math.random() * 2 - 1) * cam.shakeStrength : 0;
  cam.x = cam.smoothX + sx;
  cam.y = cam.smoothY + sy;
}

export function triggerShake(cam: Camera, strength: number): void {
  // 누적이 아니라 max — 연속 피격에도 과하게 흔들리지 않음
  if (strength > cam.shakeStrength) cam.shakeStrength = strength;
}
