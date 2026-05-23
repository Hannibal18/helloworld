// 각 캐릭터 스프라이트시트의 halfslash 영역 (rows 50~53, cols 0~5) 에서 비어있는 프레임을 찾는다.
// 공격 시퀀스가 cols 2/4/5 를 사용하므로 그 셀이 빈 시트가 "몸뚱이 사라짐" 의 범인 후보.
// 참고: check-thrust.mjs 와 동일 패턴.

import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = new URL('../public/sprites/characters/', import.meta.url).pathname;
const FRAME = 64;
const HALFSLASH_ROWS = [50, 51, 52, 53]; // up, left, down, right
const USED_COLS = [2, 4, 5];             // 공격 시퀀스가 쓰는 컬럼

function dirName(r) { return ({50:'up',51:'left',52:'down',53:'right'})[r]; }

async function checkSheet(filename) {
  const path = join(DIR, filename);
  const img = sharp(path);
  const { width, height, channels } = await img.metadata();
  if (width !== 832 || height !== 3456) {
    console.log(`[${filename}] ⚠️  unexpected size ${width}x${height}`);
  }
  const raw = await img.raw().toBuffer();
  const issues = [];
  for (const row of HALFSLASH_ROWS) {
    for (const col of USED_COLS) {
      const x0 = col * FRAME, y0 = row * FRAME;
      let nonEmpty = 0;
      for (let yy = 0; yy < FRAME; yy++) {
        for (let xx = 0; xx < FRAME; xx++) {
          const off = ((y0 + yy) * width + (x0 + xx)) * channels;
          if (raw[off + 3] > 0) nonEmpty++;
        }
      }
      if (nonEmpty < 200) {
        issues.push({ row, col, dir: dirName(row), nonEmpty });
      }
    }
  }
  return issues;
}

const files = (await readdir(DIR)).filter(f => /^\d+\.png$/.test(f)).sort();
let total = 0;
for (const f of files) {
  const issues = await checkSheet(f);
  if (issues.length === 0) {
    console.log(`[${f}] ✓ halfslash cells OK`);
  } else {
    total += issues.length;
    console.log(`[${f}] ✗ 빈/거의 빈 halfslash 프레임:`);
    for (const i of issues) {
      console.log(`    row=${i.row}(${i.dir}) col=${i.col} → ${i.nonEmpty} px`);
    }
  }
}
console.log(`\n총 문제 프레임: ${total}`);
