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

const SPEED = 120;            // px / sec (게임의 이동 속도와 비슷)
const REC_SAMPLE_HZ = 30;     // 키프레임 샘플 레이트

// 키 상태
const keys = new Set<string>();
let lastNow = performance.now();
let lastSample = -1;          // sceneTime 기준 마지막 샘플 시각

// 녹화 중인 캐릭터의 라이브 상태 (sampleTrack 으로 못 얻으니 별도 유지)
let liveX = 0;
let liveY = 0;
let liveDir: Dir = 'down';
let liveWalk = false;

export function initPlayback(): void {
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup',   onKey);
  requestAnimationFrame(loop);
}

function onKey(e: KeyboardEvent): void {
  // 입력 포커스가 input/textarea 면 무시.
  const tgt = e.target as HTMLElement;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;

  const code = e.code;
  if (e.type === 'keydown') {
    if (code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (code === 'KeyR') {
      e.preventDefault();
      toggleRecord();
      return;
    }
    keys.add(code);
  } else {
    keys.delete(code);
  }
}

function loop(now: number): void {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (state.rt.playing || state.rt.recording) {
    advance(dt);
  }
  requestAnimationFrame(loop);
}

function advance(dt: number): void {
  const scene = activeScene();

  // 1) 활성 캐릭터 입력 처리 (녹화 중일 때만)
  if (state.rt.recording && state.rt.armedTrackId) {
    const trk = trackById(scene, state.rt.armedTrackId);
    if (trk) {
      const dx = (keys.has('KeyA') || keys.has('ArrowLeft')  ? -1 : 0)
               + (keys.has('KeyD') || keys.has('ArrowRight') ?  1 : 0);
      const dy = (keys.has('KeyW') || keys.has('ArrowUp')    ? -1 : 0)
               + (keys.has('KeyS') || keys.has('ArrowDown')  ?  1 : 0);
      const mag = Math.hypot(dx, dy);
      liveWalk = mag > 0;
      if (mag > 0) {
        const nx = liveX + (dx / mag) * SPEED * dt;
        const ny = liveY + (dy / mag) * SPEED * dt;
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
  state.rt.playing = !state.rt.playing;
  if (state.rt.playing && state.rt.sceneTime >= activeScene().duration) {
    state.rt.sceneTime = 0;
  }
  lastNow = performance.now();
  notify();
}

export function toggleRecord(): void {
  if (state.rt.recording) stopRecord();
  else startRecord();
}

export function startRecord(): void {
  const scene = activeScene();
  const trk = trackById(scene, state.rt.armedTrackId);
  if (!trk) {
    // 활성 트랙 없으면 아무 동작 X — 트랙 라벨의 ● 점을 눌러 활성화하라는 안내가 필요.
    console.warn('녹화 대상 트랙이 선택되지 않음');
    return;
  }
  // 시작점: 기존 키프레임이 있으면 startX/Y 갱신은 사용자 의도가 아님 → 그대로 두고 keyframes 만 비움.
  // sceneTime 은 0 으로 리셋.
  trk.keyframes = [];
  trk.recorded = false;
  liveX = trk.startX;
  liveY = trk.startY;
  liveDir = trk.startDir;
  liveWalk = false;
  state.rt.sceneTime = 0;
  state.rt.recording = true;
  state.rt.playing = true;
  lastNow = performance.now();
  lastSample = -1;
  notify();
}

export function stopRecord(): void {
  if (!state.rt.recording) return;
  state.rt.recording = false;
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
