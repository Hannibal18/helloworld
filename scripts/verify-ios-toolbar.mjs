// iOS Safari 하단 툴바 시나리오 — 키보드 안 떠도 visualViewport 줄어드는 케이스 검증.
// 툴바 높이 ≈ 80px (키보드 임계치 150 미만이라 이전 코드는 적용 안 됨).

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const TOOLBAR_HEIGHT = 80;
const VIEWPORT = { width: 390, height: 844 };

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.on('console', m => console.log('[b]', m.type(), m.text()));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#nick', 'tester');
await page.click('#enter');
await page.waitForTimeout(1500);

// iOS Safari 하단 툴바 시뮬레이션 — vv.height 만 줄임 (키보드 임계치 150 미만)
await page.evaluate((h) => {
  const vv = window.visualViewport;
  if (!vv) return;
  Object.defineProperty(vv, 'height', { value: vv.height - h, configurable: true });
  vv.dispatchEvent(new Event('resize'));
}, TOOLBAR_HEIGHT);
await page.waitForTimeout(400);

const r = await page.evaluate(() => {
  const cb = document.getElementById('chat-bar');
  const stick = document.getElementById('stick');
  return {
    chatBar: cb?.getBoundingClientRect().toJSON(),
    chatBarBottomStyle: cb?.style.bottom || null,
    stick: stick?.getBoundingClientRect().toJSON(),
    stickBottomStyle: stick?.style.bottom || null,
    vvH: window.visualViewport?.height,
    innerH: window.innerHeight,
    vpBottom: getComputedStyle(document.documentElement).getPropertyValue('--vp-bottom'),
    keyboardOpen: document.documentElement.classList.contains('keyboard-open'),
  };
});
console.log(JSON.stringify(r, null, 2));

const visibleH = VIEWPORT.height - TOOLBAR_HEIGHT;
const cb = r.chatBar;
if (!cb) {
  console.error('FAIL: chat-bar not found'); process.exit(1);
} else if (cb.bottom > visibleH + 1) {
  console.error(`FAIL: chat-bar 가 툴바 뒤에 있음 — bottom=${cb.bottom}, visibleH=${visibleH}`); process.exit(1);
} else if (cb.bottom < visibleH - 50) {
  console.error(`WARN: chat-bar 가 툴바 위 50px+ 떠있음 — bottom=${cb.bottom}, visibleH=${visibleH}`);
} else {
  console.log(`PASS: chat-bar 가 툴바 바로 위 — bottom=${cb.bottom}, visibleH=${visibleH}`);
}

await page.screenshot({ path: '/tmp/verify-ios-toolbar.png' });

// 다시 툴바 collapse (visualViewport 복원) 시나리오
await page.evaluate(() => {
  const vv = window.visualViewport;
  Object.defineProperty(vv, 'height', { value: window.innerHeight, configurable: true });
  vv.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(200);
const r2 = await page.evaluate(() => {
  const cb = document.getElementById('chat-bar');
  return {
    chatBarBottomStyle: cb?.style.bottom || null,
    rect: cb?.getBoundingClientRect().toJSON(),
  };
});
console.log('After toolbar collapse:', JSON.stringify(r2));
if (r2.chatBarBottomStyle !== '') {
  console.error(`WARN: 툴바 닫혔는데 inline style 남음 — ${r2.chatBarBottomStyle}`);
}

await browser.close();
