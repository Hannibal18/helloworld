// 재생/녹화 엔진.
//
// 한 개의 rAF 루프가 sceneTime 을 전진시킨다. 모드는 셋:
//  - idle    : 시간 멈춤. 스크럽/편집만.
//  - playing : sceneTime += dt. 씬 끝나면 다음 씬으로 또는 stop.
//  - recording (+playing 동시) : 위 + armedTrack 을 WASD 입력으로 움직이고, 매 ~33ms 키프레임 append.
//
// 녹화 시작 시 armedTrack 의 기존 keyframes 는 비우고, startX/Y/dir 도 현재 위치로 갱신한다.
// 동시에 다른 캐릭터 트랙은 그대로 보간 재생 → 합 맞춤.

import { state, notify, activeScene, trackById } from './state';
import type { Dir } from '../types';
import { isBlocked } from '../map';
import { currentMap } from './stage';
import { clamp } from './util';
import { inputVector, initKeyboard } from './input';

const SPEED = 120;            // px / sec (게임의 이동 속도와 비슷)
const REC_SAMPLE_HZ = 30;     // 키프레임 샘플 레이트
const COUNTDOWN_SEC = 3;      // 녹화 시작 전 카운트다운

let lastNow = performance.now();
let lastSample = -1;          // sceneTime 기준 마지막 샘플 시각
let countdownStart = 0;       // performance.now() 기준
let lastArmedId: string | null = null;   // armed 트랙 바뀔 때 liveX/Y 재동기화

// 녹화 중인 캐릭터의 라이브 상태 (sampleTrack 으로 못 얻으니 별도 유지)
let liveX = 0;
let liveY = 0;
let liveDir: Dir = 'down';
let liveWalk = false;

export function initPlayback(): void {
  initKeyboard();
  // 트랜스포트 핫키 (Space=재생, R=녹화) — input.ts 의 일반 키 캡처와 별도.
  window.addEventListener('keydown', (e) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'KeyR') { e.preventDefault(); toggleRecord(); }
  });
  requestAnimationFrame(loop);
}

function loop(now: number): void {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;

  // 카운트다운 진행 — 끝나면 자동으로 실제 녹화 시작.
  if (state.rt.countingDown) {
    const elapsed = (now - countdownStart) / 1000;
    state.rt.countdownT = Math.max(0, COUNTDOWN_SEC - elapsed);
    if (state.rt.countdownT <= 0) {
      state.rt.countingDown = false;
      doStartRecord();
      notify();   // 한 번만 — recording 상태 UI 동기화
    }
  }

  if (state.rt.playing || state.rt.recording) {
    advance(dt);
  } else if (state.rt.armedTrackId && !state.rt.countingDown) {
    // 자유 이동 모드 — 녹화 안 해도 조이스틱으로 캐릭터 위치 잡기.
    // 시간은 안 흐르고, 키프레임도 안 쌓고, startX/Y 만 갱신됨.
    freeMove(dt);
  }
  requestAnimationFrame(loop);
}

function freeMove(dt: number): void {
  const scene = activeScene();
  const trk = trackById(scene, state.rt.armedTrackId);
  if (!trk) return;
  // 활성 트랙이 바뀌면 liveX/Y 를 그 트랙의 startX/Y 로 재동기화 (기존엔 옛 좌표 남아 있음).
  if (state.rt.armedTrackId !== lastArmedId) {
    lastArmedId = state.rt.armedTrackId;
    liveX = trk.startX; liveY = trk.startY; liveDir = trk.startDir; liveWalk = false;
  }
  const v = inputVector();
  const mag = Math.hypot(v.x, v.y);
  liveWalk = mag > 0.05;
  if (mag <= 0.05) return;
  const norm = mag > 1 ? mag : 1;
  const ux = v.x / norm, uy = v.y / norm;
  const speed = SPEED * Math.min(1, mag);
  const map = currentMap();
  const nx = liveX + ux * speed * dt;
  const ny = liveY + uy * speed * dt;
  if (!map || !isBlocked(map, nx, liveY, 8, 4)) liveX = nx;
  if (!map || !isBlocked(map, liveX, ny, 8, 4)) liveY = ny;
  if (Math.abs(v.x) > Math.abs(v.y)) liveDir = v.x > 0 ? 'right' : 'left';
  else                                liveDir = v.y > 0 ? 'down'  : 'up';
  // startX/Y 도 같이 갱신 — 다음 녹화의 시작점이 됨
  trk.startX = Math.round(liveX);
  trk.startY = Math.round(liveY);
  trk.startDir = liveDir;
  notify();
}

function advance(dt: number): void {
  const scene = activeScene();

  // 1) 활성 캐릭터 입력 처리 (녹화 중일 때만) — 키보드 + 조이스틱 합산
  if (state.rt.recording && state.rt.armedTrackId) {
    const trk = trackById(scene, state.rt.armedTrackId);
    if (trk) {
      const v = inputVector();
      const dx = v.x, dy = v.y;
      const mag = Math.hypot(dx, dy);
      liveWalk = mag > 0.05;
      if (mag > 0.05) {
        const norm = mag > 1 ? mag : 1; // 조이스틱은 이미 단위벡터 — 합산 시 1 초과만 정규화
        const ux = dx / norm, uy = dy / norm;
        const speed = SPEED * Math.min(1, mag); // 아날로그: 적게 밀면 천천히
        const nx = liveX + ux * speed * dt;
        const ny = liveY + uy * speed * dt;
        // 충돌 (옵션) — 발박스 16x8 정도.
        const map = currentMap();
        const blocked = !!map && isBlocked(map, nx, ny, 8, 4);
        if (!blocked) {
          // X / Y 분리 슬라이드.
          if (!map || !isBlocked(map, nx, liveY, 8, 4)) liveX = nx;
          if (!map || !isBlocked(map, liveX, ny, 8, 4)) liveY = ny;
        }
        // 방향
        if (Math.abs(dx) > Math.abs(dy)) liveDir = dx > 0 ? 'right' : 'left';
        else                              liveDir = dy > 0 ? 'down'  : 'up';
      }
    }
  }

  // 2) 시간 전진
  state.rt.sceneTime += dt;

  // 3) 녹화 중이면 ~30Hz 로 키프레임 append
  if (state.rt.recording && state.rt.armedTrackId) {
    const t = state.rt.sceneTime;
    if (lastSample < 0 || t - lastSample > 1 / REC_SAMPLE_HZ) {
      const trk = trackById(scene, state.rt.armedTrackId);
      if (trk) {
        trk.keyframes.push({ t, x: liveX, y: liveY, dir: liveDir, walk: liveWalk });
        trk.recorded = true;
      }
      lastSample = t;
    }
  }

  // 4) 씬 끝 도달
  if (state.rt.sceneTime >= scene.duration) {
    if (state.rt.recording) {
      // 녹화는 씬 끝에서 자동 stop.
      stopRecord();
      state.rt.playing = false;
      state.rt.sceneTime = scene.duration;
    } else {
      // 다음 씬으로 (있으면) — MVP 에선 우선 정지.
      state.rt.playing = false;
      state.rt.sceneTime = scene.duration;
    }
  }

  notify();
}

// ===== 외부 API =====

export function togglePlay(): void {
  if (state.rt.recording) {
    // 녹화 중 Space → 녹화 중단, 재생만 계속? UX 결정: 녹화도 멈춤.
    stopRecord();
  }
  if (state.rt.countingDown) {
    cancelCountdown();
    return;
  }
  state.rt.playing = !state.rt.playing;
  if (state.rt.playing && state.rt.sceneTime >= activeScene().duration) {
    state.rt.sceneTime = 0;
  }
  lastNow = performance.now();
  notify();
}

// ⏺ 또는 R: 카운트다운 시작 → 끝나면 자동 녹화. 진행 중 다시 누르면 취소.
export function toggleRecord(): void {
  if (state.rt.recording) { stopRecord(); return; }
  if (state.rt.countingDown) { cancelCountdown(); return; }
  startRecord();
}

// 외부에서 호출하는 record 시작 — 사용자 입장에선 '⏺ 누름'.
// 실제로는 카운트다운을 켜고, 끝나면 doStartRecord() 가 진짜 녹화 시작.
export function startRecord(): void {
  const scene = activeScene();
  const trk = trackById(scene, state.rt.armedTrackId);
  if (!trk) {
    console.warn('녹화 대상 트랙이 선택되지 않음');
    return;
  }
  // 카운트다운 동안 캐릭터가 startX/Y 에 정지해 보이도록 기존 키프레임 비움.
  trk.keyframes = [];
  trk.recorded = false;
  liveX = trk.startX;
  liveY = trk.startY;
  liveDir = trk.startDir;
  liveWalk = false;
  state.rt.sceneTime = 0;
  state.rt.recording = false;
  state.rt.playing = false;
  state.rt.countingDown = true;
  state.rt.countdownT = COUNTDOWN_SEC;
  countdownStart = performance.now();
  lastNow = performance.now();
  lastSample = -1;
  notify();
}

function doStartRecord(): void {
  state.rt.recording = true;
  state.rt.playing = true;
  state.rt.sceneTime = 0;
  lastNow = performance.now();
  lastSample = -1;
  // liveX/Y/Dir 는 startRecord 에서 이미 설정됨 — 카운트다운 동안 변경되지 않으니 그대로 사용.
}

function cancelCountdown(): void {
  state.rt.countingDown = false;
  state.rt.countdownT = 0;
  notify();
}

export function stopRecord(): void {
  if (!state.rt.recording) return;
  state.rt.recording = false;
  state.rt.playing = false;     // 녹화 중단 시 재생도 멈춤 — 사용자 멘탈모델 일치
  // 마지막 위치 한 번 더 저장
  const trk = trackById(activeScene(), state.rt.armedTrackId);
  if (trk) {
    trk.keyframes.push({ t: state.rt.sceneTime, x: liveX, y: liveY, dir: liveDir, walk: false });
  }
  notify();
}

export function seek(sec: number): void {
  const scene = activeScene();
  state.rt.sceneTime = clamp(sec, 0, scene.duration);
  notify();
}

// 활성 트랙의 시작 위치를 현재 라이브 위치로 — 사용자가 수동 위치 잡을 때.
export function setActiveStartPos(x: number, y: number): void {
  const trk = trackById(activeScene(), state.rt.armedTrackId);
  if (!trk) return;
  trk.startX = x;
  trk.startY = y;
  liveX = x; liveY = y;
  notify();
}
