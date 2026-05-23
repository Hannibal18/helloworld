// 각 캐릭터의 "thrust down 임팩트" 프레임 (row 6, col 5) 을 한 장에 가로로 합쳐 시각 비교.
// 발 위치 라인(y=58, 게임이 발 기준으로 그림)도 빨강 줄로 표시.

import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = new URL('../public/sprites/characters/', import.meta.url).pathname;
const OUT = new URL('../impact-frames.png', import.meta.url).pathname;
const FRAME = 64;
const ROW = 6;   // thrust down
const COL = 5;   // 임팩트 hold
const FOOT_Y = 58;

const files = (await readdir(DIR)).filter(f => f.endsWith('.png')).sort();
const slices = [];
for (const f of files) {
  const path = join(DIR, f);
  const buf = await sharp(path)
    .extract({ left: COL * FRAME, top: ROW * FRAME, width: FRAME, height: FRAME })
    .toBuffer();
  slices.push({ name: f, buf });
}

// 가로로 합치기 + 발 라인 그리기
const composites = slices.map((s, i) => ({
  input: s.buf,
  left: i * (FRAME + 2),
  top: 0,
}));
const W = files.length * (FRAME + 2) - 2;
const H = FRAME;

// 빨강 줄 (발 위치) — 가로 한 줄짜리 sharp 이미지
const footLine = await sharp({
  create: { width: W, height: 1, channels: 4, background: { r: 255, g: 50, b: 50, alpha: 1 } },
}).png().toBuffer();

await sharp({
  create: { width: W, height: H, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } },
})
  .composite([...composites, { input: footLine, top: FOOT_Y, left: 0 }])
  .png()
  .toFile(OUT);

console.log(`출력: ${OUT}`);
console.log(`순서: ${files.join(' | ')}`);
console.log(`(빨강 가로줄 = y=58, 게임이 발로 인식하는 위치)`);
