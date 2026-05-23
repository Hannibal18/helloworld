// 각 캐릭터 스프라이트시트의 thrust 영역 (rows 4~7, cols 0~7) 에서 비어있는 프레임을 찾는다.
// 펀치 시퀀스가 cols 2/5/6 을 사용하므로 그 셀이 빈 시트가 "몸뚱이 사라짐" 의 범인.

import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = new URL('../public/sprites/characters/', import.meta.url).pathname;
const FRAME = 64;
const THRUST_ROWS = [4, 5, 6, 7];        // up, left, down, right
const PUNCH_COLS = [2, 5, 6];            // 풀 스트레이트 시퀀스가 쓰는 컬럼

function dirName(r) { return ({4:'up',5:'left',6:'down',7:'right'})[r]; }

async function checkSheet(filename) {
  const path = join(DIR, filename);
  const img = sharp(path);
  const { width, height, channels } = await img.metadata();
  if (width !== 832 || height !== 3456) {
    console.log(`[${filename}] ⚠️  unexpected size ${width}x${height}`);
  }
  const raw = await img.raw().toBuffer();
  // raw 는 RGBA. 픽셀 (x,y) 의 alpha = raw[(y*width + x)*channels + 3]
  const issues = [];
  for (const row of THRUST_ROWS) {
    for (const col of PUNCH_COLS) {
      const x0 = col * FRAME, y0 = row * FRAME;
      let nonEmpty = 0;
      // alpha > 0 인 픽셀 개수 카운트
      for (let yy = 0; yy < FRAME; yy++) {
        for (let xx = 0; xx < FRAME; xx++) {
          const off = ((y0 + yy) * width + (x0 + xx)) * channels;
          if (raw[off + 3] > 0) nonEmpty++;
        }
      }
      // 프레임 전체 = 4096 px. 의미있는 캐릭터라면 200+ 픽셀은 채워져야 함.
      if (nonEmpty < 200) {
        issues.push({ row, col, dir: dirName(row), nonEmpty });
      }
    }
  }
  return issues;
}

const files = (await readdir(DIR)).filter(f => f.endsWith('.png')).sort();
let total = 0;
for (const f of files) {
  const issues = await checkSheet(f);
  if (issues.length === 0) {
    console.log(`[${f}] ✓ thrust cells OK`);
  } else {
    total += issues.length;
    console.log(`[${f}] ✗ 빈/거의 빈 thrust 프레임:`);
    for (const i of issues) {
      console.log(`    row=${i.row}(${i.dir}) col=${i.col} → ${i.nonEmpty} px`);
    }
  }
}
console.log(`\n총 문제 프레임: ${total}`);
