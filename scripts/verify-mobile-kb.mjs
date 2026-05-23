// 모바일 키보드 가상화 검증 — chat-bar / stick / touch-right 위치를 측정.
// iOS Safari 동작 흉내: window.innerHeight 는 그대로, visualViewport.height 만 줄임 + resize/scroll 이벤트.

import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:5173/';
const KB_HEIGHT = 320;
const VIEWPORT = { width: 390, height: 844 };
const ENGINE_NAME = process.argv[2] || 'chromium';
const SIM_OFFSET_TOP = Number(process.argv[3] || 0); // iOS auto-scroll 흉내: vv.offsetTop > 0
const OUT = `/tmp/verify-mobile-kb-${ENGINE_NAME}${SIM_OFFSET_TOP ? '-scroll' : ''}`;
mkdirSync(OUT, { recursive: true });

const engine = ENGINE_NAME === 'webkit' ? webkit : chromium;
console.log(`=== ${ENGINE_NAME.toUpperCase()} (offsetTop=${SIM_OFFSET_TOP}) ===`);
const browser = await engine.launch();
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();

page.on('console', m => console.log('[browser]', m.type(), m.text()));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 닉네임 입력 후 입장
await page.fill('#nick', 'tester');
await page.click('#enter');
// 게임 시작 후 캔버스/스틱 표시까지 잠시
await page.waitForTimeout(1500);

// 입장 후 캐릭터/채팅 UI 확인용 스크린샷
await page.screenshot({ path: `${OUT}/01-after-enter.png` });

// chat-input focus 전 위치
const beforeFocus = await page.evaluate(() => {
  const el = document.getElementById('chat-bar');
  const stick = document.getElementById('stick');
  const tr = document.querySelector('.touch-right');
  return {
    chatBar: el?.getBoundingClientRect().toJSON(),
    stick: stick?.getBoundingClientRect().toJSON(),
    touchRight: tr?.getBoundingClientRect().toJSON(),
    innerH: window.innerHeight,
    innerW: window.innerWidth,
    vvH: window.visualViewport?.height,
    vvOT: window.visualViewport?.offsetTop,
    vpBottom: getComputedStyle(document.documentElement).getPropertyValue('--vp-bottom'),
  };
});
console.log('BEFORE focus:', JSON.stringify(beforeFocus, null, 2));

// 채팅 input focus
await page.click('#chat-input');
await page.waitForTimeout(200);

// 가상 키보드 시뮬레이션 — visualViewport.height 줄이고 resize 이벤트 발사
// iOS Safari 식: window.innerHeight 는 그대로, visualViewport 만 작아짐.
await page.evaluate(([kbH, simOT]) => {
  const vv = window.visualViewport;
  if (!vv) { console.warn('no visualViewport'); return; }
  const newH = vv.height - kbH - simOT;
  Object.defineProperty(vv, 'height', { value: newH, configurable: true });
  Object.defineProperty(vv, 'offsetTop', { value: simOT, configurable: true });
  vv.dispatchEvent(new Event('resize'));
  vv.dispatchEvent(new Event('scroll'));
}, [KB_HEIGHT, SIM_OFFSET_TOP]);
await page.waitForTimeout(400);

const afterKb = await page.evaluate(() => {
  const el = document.getElementById('chat-bar');
  const stick = document.getElementById('stick');
  const tr = document.querySelector('.touch-right');
  const app = document.getElementById('app');
  return {
    chatBar: el?.getBoundingClientRect().toJSON(),
    chatBarBottomStyle: el ? (el.style.bottom || getComputedStyle(el).bottom) : null,
    stick: stick?.getBoundingClientRect().toJSON(),
    stickBottomStyle: stick ? (stick.style.bottom || getComputedStyle(stick).bottom) : null,
    touchRight: tr?.getBoundingClientRect().toJSON(),
    app: app?.getBoundingClientRect().toJSON(),
    innerH: window.innerHeight,
    vvH: window.visualViewport?.height,
    vvOT: window.visualViewport?.offsetTop,
    vpBottom: getComputedStyle(document.documentElement).getPropertyValue('--vp-bottom'),
    keyboardOpenClass: document.documentElement.classList.contains('keyboard-open'),
  };
});
console.log('AFTER keyboard:', JSON.stringify(afterKb, null, 2));

// 시각화: 키보드 영역 표시 + 스크린샷
await page.evaluate((kbH) => {
  const dbg = document.createElement('div');
  dbg.style.cssText = `position: fixed; left: 0; right: 0; bottom: 0; height: ${kbH}px;
    background: rgba(255,0,0,0.35); border-top: 2px solid red; z-index: 99999;
    color: white; font: bold 14px sans-serif; padding: 8px; text-align: center;`;
  dbg.textContent = `(시뮬레이트된 키보드 ${kbH}px)`;
  document.body.appendChild(dbg);
}, KB_HEIGHT);
await page.screenshot({ path: `${OUT}/02-keyboard-open.png` });

// 채팅바 visible (키보드 위) 여부 판정
const visibleH = VIEWPORT.height - KB_HEIGHT;
const cb = afterKb.chatBar;
let verdict = 'UNKNOWN';
const findings = [];
if (!cb) {
  verdict = 'FAIL'; findings.push('chat-bar element not found');
} else {
  if (cb.bottom <= 0 || cb.top >= VIEWPORT.height) {
    verdict = 'FAIL'; findings.push(`chat-bar 화면 밖: top=${cb.top}, bottom=${cb.bottom}`);
  } else if (cb.top >= visibleH) {
    verdict = 'FAIL'; findings.push(`chat-bar 가 키보드 뒤에 가려짐: top=${cb.top} >= visibleH=${visibleH}`);
  } else if (cb.bottom > visibleH + 1) {
    verdict = 'FAIL'; findings.push(`chat-bar bottom 이 키보드 영역 침범: bottom=${cb.bottom} > visibleH=${visibleH}`);
  } else if (cb.bottom < visibleH - 50) {
    verdict = 'WARN'; findings.push(`chat-bar 가 키보드 위에 50px 이상 떠 있음: bottom=${cb.bottom}, visibleH=${visibleH}`);
  } else {
    verdict = 'PASS'; findings.push(`chat-bar 가 키보드 바로 위(보임): bottom=${cb.bottom}, visibleH=${visibleH}`);
  }
}

// 캔버스 위치 (이동 안 했어야 함)
const app = afterKb.app;
if (app) {
  if (app.top !== 0 || app.bottom !== VIEWPORT.height) {
    findings.push(`#app 가 viewport 풀사이즈 아님: top=${app.top}, bottom=${app.bottom}, 기대 0..${VIEWPORT.height}`);
  } else {
    findings.push('#app 풀사이즈 유지');
  }
}

// stick / touch-right 도 키보드 위로?
if (afterKb.stick) {
  const s = afterKb.stick;
  if (s.bottom > visibleH + 1) {
    findings.push(`⚠️ stick 키보드 침범: bottom=${s.bottom} > ${visibleH}`);
  } else {
    findings.push(`stick 위치 OK: bottom=${s.bottom}`);
  }
}
if (afterKb.touchRight) {
  const tr = afterKb.touchRight;
  if (tr.bottom > visibleH + 1) {
    findings.push(`⚠️ touch-right 키보드 침범: bottom=${tr.bottom} > ${visibleH}`);
  } else {
    findings.push(`touch-right 위치 OK: bottom=${tr.bottom}`);
  }
}

console.log('VERDICT:', verdict);
findings.forEach(f => console.log(' -', f));
console.log('screenshots:', OUT);

await browser.close();

if (verdict !== 'PASS') process.exit(1);
