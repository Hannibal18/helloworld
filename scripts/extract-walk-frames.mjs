// idle/walk down frame 0 (row 10, col 0) vs 임팩트 (row 6, col 5) 비교.
// 같은 캐릭터의 두 프레임을 위아래로 묶고 캐릭터별로 가로로 합침.

import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = new URL('../public/sprites/characters/', import.meta.url).pathname;
const OUT = new URL('../walk-vs-thrust.png', import.meta.url).pathname;
const FRAME = 64;

const files = (await readdir(DIR)).filter(f => f.endsWith('.png')).sort();
const composites = [];
const W = files.length * (FRAME + 2) - 2;
const H = FRAME * 2 + 2;

for (let i = 0; i < files.length; i++) {
  const path = join(DIR, files[i]);
  const idle = await sharp(path).extract({ left: 0, top: 10 * FRAME, width: FRAME, height: FRAME }).toBuffer();
  const thrust = await sharp(path).extract({ left: 5 * FRAME, top: 6 * FRAME, width: FRAME, height: FRAME }).toBuffer();
  composites.push({ input: idle,   left: i * (FRAME + 2), top: 0 });
  composites.push({ input: thrust, left: i * (FRAME + 2), top: FRAME + 2 });
}

// 발 위치 라인 (y=58, idle/thrust 각각)
const footLine = await sharp({
  create: { width: W, height: 1, channels: 4, background: { r: 255, g: 50, b: 50, alpha: 0.6 } },
}).png().toBuffer();

await sharp({
  create: { width: W, height: H, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } },
})
  .composite([
    ...composites,
    { input: footLine, top: 58, left: 0 },
    { input: footLine, top: FRAME + 2 + 58, left: 0 },
  ])
  .png()
  .toFile(OUT);

console.log(`출력: ${OUT}`);
console.log(`순서: ${files.join(' | ')}`);
console.log(`윗줄 = idle (walk row 0), 아랫줄 = thrust col 5 (임팩트)`);
