// 스튜디오 부트스트랩 — DOM 준비 → 모든 모듈 init → 상태 구독 → 매 프레임 BGM 동기화.

import { state, notify, activeScene, subscribe, uid } from './state';
import { loadBuiltinAssets, initBinUI, renderBin } from './bin';
import { initStage, screenToWorld, currentMap } from './stage';
import { initTimeline, renderTimeline } from './timeline';
import { initProps, renderProps } from './props';
import { initScenes, renderScenes } from './scenes';
import { initPlayback, togglePlay, toggleRecord, seek, setActiveStartPos } from './playback';
import { initExport } from './export';
import { syncBgm } from './audio';
import { initTouch } from './touch';
import { clamp, showToast } from './util';

function ready(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

ready(() => {
  // 글로벌 에러 표시 (모바일 등 콘솔 접근 어려운 환경 대비)
  window.addEventListener('error', (e) => {
    console.error('[studio]', e.error || e.message);
    showToast(`에러: ${e.message}`, 'err', 4000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[studio:unhandled]', e.reason);
    showToast(`비동기 에러: ${e.reason?.message ?? e.reason}`, 'err', 4000);
  });

  loadBuiltinAssets();

  initBinUI();
  initStage();
  initScenes();
  initTimeline();
  initProps();
  initExport();
  initPlayback();
  initTouch();

  // ===== 트랜스포트 컨트롤 =====
  // iOS Safari 는 멀티터치 (조이스틱 + 버튼 동시) 시 click 이벤트를 묵살하므로
  // 트랜스포트 버튼들은 pointerdown 로 즉시 발사한다.
  const bindTap = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  };
  bindTap('tp-play', () => togglePlay());
  bindTap('tp-rec',  () => toggleRecord());
  bindTap('tp-prev', () => seek(0));

  const scrub = document.getElementById('tp-scrub') as HTMLInputElement;
  scrub.addEventListener('input', () => {
    const dur = activeScene().duration;
    seek((parseInt(scrub.value, 10) / 1000) * dur);
  });

  // ===== 프리뷰 줌 슬라이더 (사용자 줌 — 키프레임과 별개) =====
  const zoomSl = document.getElementById('tp-zoom') as HTMLInputElement;
  const zoomVal = document.getElementById('tp-zoom-val')!;
  zoomSl.addEventListener('input', () => {
    const z = parseInt(zoomSl.value, 10) / 100;
    (state.rt as { previewZoom?: number }).previewZoom = z;
    zoomVal.textContent = z.toFixed(2) + 'x';
    notify();
  });

  // ===== 카메라 키프레임 추가 =====
  document.getElementById('tp-cam-key')!.addEventListener('click', () => {
    const sc = activeScene();
    const t = state.rt.sceneTime;
    const map = currentMap();
    const fx = map ? map.pixelW / 2 : 240;
    const fy = map ? map.pixelH / 2 : 135;
    // 기존 키 보간된 현재값을 시작점으로
    const existing = sc.camera.keyframes;
    let x = fx, y = fy, zoom = 1;
    if (existing.length > 0) {
      // sampleCamera 와 동일하지만, 보간 결과만 필요해서 마지막 < t 키 기준으로 단순화.
      for (let i = existing.length - 1; i >= 0; i--) {
        if (existing[i].t <= t) {
          x = existing[i].x; y = existing[i].y; zoom = existing[i].zoom;
          break;
        }
      }
    }
    sc.camera.keyframes.push({ t, x, y, zoom, ease: 'ease-in-out' });
    sc.camera.keyframes.sort((a, b) => a.t - b.t);
    state.rt.selectedCamKey = sc.camera.keyframes.findIndex((k) => k.t === t);
    showToast('🎥 카메라 키프레임 추가');
    notify();
  });

  // ===== 캐릭터 추가 (기존 트랙 선택된 상태로 빈에서 사용 클릭하라 안내) =====
  document.getElementById('btn-add-char')!.addEventListener('click', () => {
    state.rt.binTab = 'chars';
    notify();
    showToast('좌측 빈의 캐릭터 옆 "사용" 클릭');
  });

  // ===== 말풍선 추가 =====
  document.getElementById('btn-add-bubble')!.addEventListener('click', () => {
    const sc = activeScene();
    if (sc.tracks.length === 0) {
      showToast('먼저 캐릭터를 추가하세요', 'err');
      return;
    }
    const trackId = state.rt.selectedTrackId && !state.rt.selectedTrackId.startsWith('__')
      ? state.rt.selectedTrackId
      : sc.tracks[0].id;
    const t = clamp(state.rt.sceneTime, 0, Math.max(0, sc.duration - 2));
    const bub = {
      id: uid('bub'),
      trackId,
      t, dur: 2,
      text: '안녕!',
      typewriter: true,
      cps: 20,
    };
    sc.bubbles.push(bub);
    state.rt.selectedBubbleId = bub.id;
    notify();
  });

  // ===== 캔버스 탭 (녹화 OFF + 트랙 armed) → 시작 위치 지정 =====
  const canvas = document.getElementById('stage-canvas') as HTMLCanvasElement;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    if (state.rt.recording) return;       // 녹화 중엔 비활성
    if (!state.rt.armedTrackId) return;
    if (e.target !== canvas) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    setActiveStartPos(w.x, w.y);
  });

  // ===== 매 프레임: BGM 동기화 + 트랜스포트 HUD 갱신 =====
  const tpTime = document.getElementById('tp-time')!;
  const hudTime = document.getElementById('hud-time')!;
  const hudRec = document.getElementById('hud-record')!;
  const playBtn = document.getElementById('tp-play')!;
  const recBtn = document.getElementById('tp-rec')!;

  function tick(): void {
    const sc = activeScene();
    syncBgm(sc, state.rt.sceneTime, state.rt.playing);
    const t = state.rt.sceneTime, d = sc.duration;
    tpTime.textContent = `${t.toFixed(2)} / ${d.toFixed(2)}`;
    hudTime.textContent = `${t.toFixed(2)}s / ${d.toFixed(2)}s · ${sc.name}`;
    hudRec.classList.toggle('hidden', !state.rt.recording);
    playBtn.textContent = state.rt.playing ? '⏸' : '⏵';
    recBtn.classList.toggle('armed', state.rt.recording);
    // 스크럽 위치 (드래그 중이 아니면 sync)
    if (document.activeElement !== scrub) {
      scrub.value = String(Math.round((t / Math.max(0.001, d)) * 1000));
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ===== 상태 구독 → UI 갱신 =====
  let firstRender = true;
  subscribe(() => {
    renderScenes();
    renderBin();
    renderTimeline();
    renderProps();
    if (firstRender) {
      firstRender = false;
      // 첫 렌더 직후 — 안내 토스트
      showToast('🎬 스튜디오 시작! 맵 → 캐릭터 → 녹화(R) 순서');
    }
  });
  // 초기 렌더 트리거
  notify();
});
