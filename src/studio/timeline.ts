// 하단 타임라인 — 트랙 행 + 클립 + 키프레임 + 플레이헤드.
//
// 트랙 종류:
//   🎥 카메라 (키프레임 다이아몬드)
//   🎵 BGM (씬 전체 폭의 페이드 인/아웃 envelope 표시)
//   👤 캐릭터들 (녹화된 길이만큼 막대, 활성 트랙은 ● 표시)
//   💬 말풍선 (여러 클립, 드래그 가능)

import { state, notify, activeScene, findAsset } from './state';
import type { Bubble, CharTrack, CameraKey } from './state';
import { clamp, startPointerDrag } from './util';
import { seek } from './playback';

const LABEL_W = 160;

let body!: HTMLElement;

export function initTimeline(): void {
  body = document.getElementById('timeline-body')!;
  const zoomIn = document.getElementById('tl-zoom') as HTMLInputElement;
  zoomIn.addEventListener('input', () => {
    state.rt.pxPerSec = parseInt(zoomIn.value, 10);
    notify();
  });
}

export function renderTimeline(): void {
  const scene = activeScene();
  const px = state.rt.pxPerSec;
  body.innerHTML = '';

  // 눈금자
  const ruler = makeRuler(scene.duration, px);
  body.appendChild(ruler);

  // 트랙들
  body.appendChild(makeCameraTrack(scene.camera.keyframes, px));
  body.appendChild(makeBgmTrack(scene.bgm, scene.duration, px));
  for (const trk of scene.tracks) body.appendChild(makeCharTrack(trk, px));
  body.appendChild(makeBubblesTrack(scene.bubbles, px));

  // 플레이헤드 (전체 위에 floating)
  const ph = document.createElement('div');
  ph.className = 'tl-playhead';
  ph.style.left = (LABEL_W + state.rt.sceneTime * px) + 'px';
  body.appendChild(ph);
}

function makeRuler(duration: number, px: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tl-ruler';

  const pad = document.createElement('div');
  pad.className = 'tl-ruler-pad';
  wrap.appendChild(pad);

  const w = Math.max(200, duration * px + 200);
  const c = document.createElement('canvas');
  c.className = 'tl-ruler-canvas';
  c.width = w;
  c.height = 24;
  c.style.width = w + 'px';
  c.style.height = '24px';
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#9aa2ad';
  ctx.font = '10px Galmuri11, system-ui';
  ctx.textBaseline = 'top';
  // 1초 간격, 0.1초 미세 눈금
  for (let t = 0; t <= duration + 1; t += 0.1) {
    const x = Math.round(t * px) + 0.5;
    const major = Math.abs(t - Math.round(t)) < 0.001;
    ctx.strokeStyle = major ? '#bfc6d0' : 'rgba(154, 162, 173, 0.3)';
    ctx.beginPath();
    ctx.moveTo(x, major ? 8 : 14);
    ctx.lineTo(x, 22);
    ctx.stroke();
    if (major) ctx.fillText(t.toFixed(0) + 's', x + 2, 0);
  }
  // 씬 길이 끝 마커
  const endX = Math.round(duration * px) + 0.5;
  ctx.strokeStyle = '#4ea1ff';
  ctx.beginPath();
  ctx.moveTo(endX, 0);
  ctx.lineTo(endX, 24);
  ctx.stroke();
  wrap.appendChild(c);

  // 눈금자 탭/드래그 → seek
  c.style.cursor = 'pointer';
  c.style.touchAction = 'none';
  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    seek((e.clientX - r.left) / px);
    startPointerDrag(e, c, (cx) => {
      const rr = c.getBoundingClientRect();
      seek((cx - rr.left) / px);
    });
  });

  return wrap;
}

function makeLabel(icon: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tl-track-label';
  el.innerHTML = `<span class="ico">${icon}</span><span class="name">${escapeHtml(text)}</span>`;
  return el;
}

function makeCameraTrack(keys: CameraKey[], px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const label = makeLabel('🎥', 'Camera');
  label.addEventListener('click', () => { state.rt.selectedTrackId = '__camera__'; notify(); });
  row.appendChild(label);

  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (activeScene().duration * px + 200) + 'px';
  cont.style.cursor = 'pointer';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const dot = document.createElement('div');
    dot.className = 'tl-key' + (state.rt.selectedCamKey === i ? ' selected' : '');
    dot.style.left = (k.t * px) + 'px';
    dot.title = `t=${k.t.toFixed(2)}s zoom=${k.zoom.toFixed(2)}${k.followTrackId ? ' (follow)' : ''}`;
    dot.style.touchAction = 'none';
    dot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.rt.selectedCamKey = i;
      state.rt.selectedBubbleId = null;
      state.rt.selectedTrackId = '__camera__';
      notify();
      const startLeft = parseFloat(dot.style.left) || 0;
      startPointerDrag(e, dot, (_cx, _cy, _sx, _sy, dx) => {
        k.t = clamp((startLeft + dx) / px, 0, activeScene().duration);
        keys.sort((a, b) => a.t - b.t);
        notify();
      });
    });
    cont.appendChild(dot);
  }
  row.appendChild(cont);
  return row;
}

function makeBgmTrack(bgm: ReturnType<typeof activeScene>['bgm'], duration: number, px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const asset = findAsset(bgm.assetId);
  const label = makeLabel('🎵', asset ? asset.name : '(BGM 없음)');
  label.addEventListener('click', () => { state.rt.selectedTrackId = '__bgm__'; notify(); });
  row.appendChild(label);
  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (duration * px + 200) + 'px';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));
  if (asset) {
    const clip = document.createElement('div');
    clip.className = 'tl-clip tl-clip-bgm';
    clip.style.left = '0px';
    clip.style.width = (duration * px) + 'px';
    clip.textContent = asset.name;
    cont.appendChild(clip);
    // 페이드 envelope (간단히 막대 좌우 그라데이션으로)
    if (bgm.fadeIn > 0) {
      const fade = document.createElement('div');
      fade.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${bgm.fadeIn * px}px;background:linear-gradient(to right, rgba(0,0,0,0.6), transparent);pointer-events:none;`;
      clip.appendChild(fade);
    }
    if (bgm.fadeOut > 0) {
      const fade = document.createElement('div');
      const w = bgm.fadeOut * px;
      fade.style.cssText = `position:absolute;right:0;top:0;bottom:0;width:${w}px;background:linear-gradient(to left, rgba(0,0,0,0.6), transparent);pointer-events:none;`;
      clip.appendChild(fade);
    }
  }
  row.appendChild(cont);
  return row;
}

function makeCharTrack(trk: CharTrack, px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const label = document.createElement('div');
  label.className = 'tl-track-label';
  const dot = document.createElement('span');
  dot.className = 'dot' + (state.rt.armedTrackId === trk.id ? ' armed' : '');
  dot.title = '카메라 ON — 이 트랙을 녹화';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    state.rt.armedTrackId = state.rt.armedTrackId === trk.id ? null : trk.id;
    notify();
  });
  label.appendChild(dot);
  const ico = document.createElement('span');
  ico.className = 'ico'; ico.textContent = '👤';
  label.appendChild(ico);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = trk.name;
  label.appendChild(name);
  const delBtn = document.createElement('button');
  delBtn.className = 'st-btn'; delBtn.textContent = '✕';
  delBtn.title = '트랙 삭제';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const scene = activeScene();
    scene.tracks = scene.tracks.filter((t) => t.id !== trk.id);
    if (state.rt.armedTrackId === trk.id) state.rt.armedTrackId = null;
    notify();
  });
  label.appendChild(delBtn);
  label.addEventListener('click', () => { state.rt.selectedTrackId = trk.id; notify(); });
  row.appendChild(label);

  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (activeScene().duration * px + 200) + 'px';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));

  if (trk.recorded && trk.keyframes.length > 0) {
    const first = trk.keyframes[0].t;
    const last = trk.keyframes[trk.keyframes.length - 1].t;
    const clip = document.createElement('div');
    clip.className = 'tl-clip';
    clip.style.left = (first * px) + 'px';
    clip.style.width = Math.max(8, (last - first) * px) + 'px';
    clip.textContent = `${trk.name} (${trk.keyframes.length}f)`;
    cont.appendChild(clip);
  } else {
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#9aa2ad;font-size:11px;';
    hint.textContent = state.rt.armedTrackId === trk.id ? '⏺ R 누르면 녹화 시작' : '● 점을 눌러 활성화';
    cont.appendChild(hint);
  }
  row.appendChild(cont);
  return row;
}

function makeBubblesTrack(bubbles: Bubble[], px: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-track';
  const label = makeLabel('💬', '말풍선');
  row.appendChild(label);
  const cont = document.createElement('div');
  cont.className = 'tl-track-content';
  cont.style.minWidth = (activeScene().duration * px + 200) + 'px';
  cont.style.touchAction = 'none';
  cont.addEventListener('pointerdown', (e) => seekFromContentPointer(e, cont, px));
  for (const b of bubbles) {
    const clip = document.createElement('div');
    clip.className = 'tl-clip tl-clip-bubble' + (state.rt.selectedBubbleId === b.id ? ' selected' : '');
    clip.style.left = (b.t * px) + 'px';
    clip.style.width = Math.max(20, b.dur * px) + 'px';
    clip.textContent = b.text || '...';
    clip.style.touchAction = 'none';
    clip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.rt.selectedBubbleId = b.id;
      state.rt.selectedCamKey = null;
      state.rt.selectedTrackId = null;
      notify();
      const startLeft = parseFloat(clip.style.left) || 0;
      startPointerDrag(e, clip, (_cx, _cy, _sx, _sy, dx) => {
        b.t = clamp((startLeft + dx) / px, 0, activeScene().duration - b.dur);
        notify();
      });
    });
    cont.appendChild(clip);
  }
  row.appendChild(cont);
  return row;
}

function seekFromContentPointer(e: PointerEvent, cont: HTMLElement, px: number): void {
  e.preventDefault();
  const r = cont.getBoundingClientRect();
  seek((e.clientX - r.left) / px);
  startPointerDrag(e, cont, (cx) => {
    const rr = cont.getBoundingClientRect();
    seek((cx - rr.left) / px);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
