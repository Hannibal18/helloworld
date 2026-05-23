// 부서진 4개 캐릭터(01, 02, 06, 07)의 정상 자세(idle/walk down)를 보기 좋게 모음.
// 각 캐릭터마다 큰 idle 1장 + 작은 라벨.

import sharp from 'sharp';
import { join } from 'node:path';

const DIR = new URL('../public/sprites/characters/', import.meta.url).pathname;
const OUT = new URL('../broken-chars.png', import.meta.url).pathname;
const FRAME = 64;
const SCALE = 4;                       // 4배 확대해서 또렷이
const TARGETS = ['01', '02', '06', '07'];
const PAD = 24;
const TILE = FRAME * SCALE;            // 256
const GAP = 16;
const W = TARGETS.length * TILE + (TARGETS.length - 1) * GAP + PAD * 2;
const H = TILE + PAD * 2 + 40;         // 라벨 영역

const composites = [];
for (let i = 0; i < TARGETS.length; i++) {
  const path = join(DIR, `${TARGETS[i]}.png`);
  // idle = walk row(=10) col 0
  const cropped = await sharp(path)
    .extract({ left: 0, top: 10 * FRAME, width: FRAME, height: FRAME })
    .resize(TILE, TILE, { kernel: sharp.kernel.nearest })
    .toBuffer();
  composites.push({
    input: cropped,
    left: PAD + i * (TILE + GAP),
    top: PAD,
  });
}

// 캐릭터 인덱스 라벨 — sharp 텍스트 SVG
const labelSvg = `
<svg width="${W}" height="40" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font: bold 20px 'Helvetica Neue', sans-serif; fill: #fff; text-anchor: middle; }
  </style>
  ${TARGETS.map((t, i) => `
    <text x="${PAD + i * (TILE + GAP) + TILE / 2}" y="28">캐릭터 ${t}</text>
  `).join('')}
</svg>
`;
composites.push({
  input: Buffer.from(labelSvg),
  left: 0,
  top: PAD + TILE + 4,
});

// 제목 SVG (상단)
const titleSvg = `
<svg width="${W}" height="40" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font: bold 18px 'Helvetica Neue', sans-serif; fill: #ffb0b0; text-anchor: middle; }
  </style>
  <text x="${W / 2}" y="24">펀치 시 몸이 사라지는 캐릭터 (idle 자세는 정상)</text>
</svg>
`;
// 제목 영역을 위해 H 증가
const finalH = H + 36;
composites.unshift({
  input: Buffer.from(titleSvg),
  left: 0,
  top: 4,
});

await sharp({
  create: { width: W, height: finalH, channels: 4, background: { r: 28, g: 28, b: 32, alpha: 1 } },
})
  .composite(composites.map(c => ({ ...c, top: c.top + 36 })))
  .png()
  .toFile(OUT);

console.log(`출력: ${OUT}`);
