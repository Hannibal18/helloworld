// 경찰과 도둑 — 부트스트랩.
// cops.html 의 인트로 카드에서 닉네임/캐릭터 입력 → startCopsGame() 호출.

// 글로벌 에러 핸들러 (모바일 콘솔 접근 어려운 환경 대응)
function __showFatal(msg: string): void {
  try {
    let banner = document.getElementById('fatal-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fatal-error';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#3a1010;color:#ff9a9a;padding:10px 14px;font:12px monospace;border-bottom:2px solid #a02a2a;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;';
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = `[FATAL] ${msg}`;
  } catch { /* DOM 자체 없을 때 포기 */ }
}
window.addEventListener('error', (e) => {
  __showFatal(`${e.message}\n${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  __showFatal(`unhandled rejection: ${r?.message ?? r}`);
});

import { startCopsGame } from './game';
import { setupViewport } from '../viewport';
import { CHARACTER_COUNT, drawCharacterPreview, randomCharIdx } from '../sprites';
import { load as loadSfx, unlock as unlockSfx } from '../sfx';
import { isBgmMuted, setBgmMuted, startBgm } from '../bgm';

// 대기실은 채팅/이동만 — 펀치 사운드는 (술래잡기 합류 시 사용) 미리 로드.
try {
  loadSfx('punch', '/audio/melee/punch.wav', 0.7);
} catch (e) {
  console.warn('[sfx preload]', e);
}

function ready(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

ready(() => {
  const nick = document.getElementById('nick') as HTMLInputElement;
  const btn = document.getElementById('enter') as HTMLButtonElement;
  if (!nick || !btn) return;

  setupViewport();

  // 캐릭터 미리보기 + 다시 뽑기 — 엄마전쟁과 동일 패턴
  let chosenCharIdx = randomCharIdx();
  const previewCanvas = document.getElementById('char-preview-canvas') as HTMLCanvasElement | null;
  const previewCtx = previewCanvas?.getContext('2d') ?? null;
  const reroll = document.getElementById('reroll') as HTMLButtonElement | null;

  const refreshPreview = (): void => {
    if (previewCtx) void drawCharacterPreview(previewCtx, chosenCharIdx);
  };
  refreshPreview();

  if (reroll) {
    reroll.addEventListener('click', () => {
      if (CHARACTER_COUNT > 1) {
        let next = chosenCharIdx;
        while (next === chosenCharIdx) next = randomCharIdx();
        chosenCharIdx = next;
      }
      refreshPreview();
    });
  }

  nick.focus();

  const introCard = document.querySelector('.intro-card');
  const showIntroError = (msg: string) => {
    if (!introCard) { alert(msg); return; }
    let banner = document.getElementById('intro-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'intro-error';
      banner.style.cssText = 'margin-top:10px;padding:8px;background:#3a1010;color:#ff9a9a;border:1px solid #a02a2a;border-radius:6px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;';
      introCard.appendChild(banner);
    }
    banner.textContent = msg;
  };

  const enter = () => {
    try {
      // iOS Safari 오디오 잠금 해제 (첫 사용자 제스처에서)
      try { unlockSfx(); } catch (e) { console.warn('unlockSfx', e); }
      try { startBgm(); } catch (e) { console.warn('startBgm', e); }
      let name = nick.value.trim();
      if (!name) name = `손님${Math.floor(Math.random() * 9000 + 1000)}`;
      name = name.slice(0, 12);
      startCopsGame({ name, charIdx: chosenCharIdx });
    } catch (err) {
      console.error('[enter] sync error', err);
      showIntroError(`입장 실패: ${(err as Error)?.message ?? err}`);
    }
  };
  window.addEventListener('unhandledrejection', (e) => {
    showIntroError(`비동기 에러: ${e.reason?.message ?? e.reason}`);
  });
  window.addEventListener('error', (e) => {
    showIntroError(`스크립트 에러: ${e.message}`);
  });

  btn.addEventListener('click', enter);
  nick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enter();
  });

  // BGM 토글 버튼 (우상단)
  try {
    if (localStorage.getItem('helloworld:bgmMuted') === '1') setBgmMuted(true);
  } catch { /* noop */ }
  const bgmBtn = document.createElement('button');
  bgmBtn.id = 'bgm-toggle';
  bgmBtn.type = 'button';
  bgmBtn.style.cssText = [
    'position:fixed',
    'top:calc(env(safe-area-inset-top) + 8px)',
    'right:calc(env(safe-area-inset-right) + 8px)',
    'z-index:100',
    'width:36px', 'height:36px',
    'padding:0',
    'background:rgba(20,14,8,0.75)',
    'border:1px solid #6a4a2a',
    'border-radius:50%',
    'color:#ffd84a',
    'font:16px system-ui, sans-serif',
    'cursor:pointer',
    'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';');
  const refreshBgmBtn = () => {
    bgmBtn.textContent = isBgmMuted() ? '🔇' : '🔊';
    bgmBtn.title = isBgmMuted() ? 'BGM 켜기' : 'BGM 끄기';
  };
  refreshBgmBtn();
  bgmBtn.addEventListener('click', () => {
    const next = !isBgmMuted();
    setBgmMuted(next);
    try { localStorage.setItem('helloworld:bgmMuted', next ? '1' : '0'); } catch { /* noop */ }
    refreshBgmBtn();
  });
  document.body.appendChild(bgmBtn);
});
