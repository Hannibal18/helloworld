// forest_tiles.png 의 각 타일에 gid 번호를 오버레이한 라벨링 이미지 생성.
// /tmp/forest_tiles_labeled.png 로 저장.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'public/assets/tilesets/forest_tiles.png');
const OUT  = '/tmp/forest_tiles_labeled.png';
const SCALE = 3; // 라벨이 작아서 3배 확대

(async () => {
  const meta = await sharp(SRC).metadata();
  const tw = meta.width;
  const th = meta.height;
  const cols = tw / 32, rows = th / 32;

  // 1) 원본을 SCALE 배 확대 (nearest)
  const enlarged = await sharp(SRC)
    .resize(tw * SCALE, th * SCALE, { kernel: 'nearest' })
    .png()
    .toBuffer();

  // 2) SVG 오버레이 — 그리드 + gid 번호
  let svg = `<svg width="${tw*SCALE}" height="${th*SCALE}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<style>.lbl { font: bold 18px monospace; fill: #ff0; stroke: #000; stroke-width: 2px; paint-order: stroke; }</style>`;
  // 격자
  for (let i = 0; i <= cols; i++) {
    svg += `<line x1="${i*32*SCALE}" y1="0" x2="${i*32*SCALE}" y2="${th*SCALE}" stroke="rgba(255,0,255,0.5)" stroke-width="1"/>`;
  }
  for (let j = 0; j <= rows; j++) {
    svg += `<line x1="0" y1="${j*32*SCALE}" x2="${tw*SCALE}" y2="${j*32*SCALE}" stroke="rgba(255,0,255,0.5)" stroke-width="1"/>`;
  }
  // 번호
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gid = r * cols + c + 1;
      svg += `<text x="${c*32*SCALE + 4}" y="${r*32*SCALE + 22}" class="lbl">${gid}</text>`;
    }
  }
  svg += `</svg>`;

  await sharp(enlarged)
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .png()
    .toFile(OUT);

  console.log('saved:', OUT, `${tw*SCALE}×${th*SCALE}`);
})().catch(e => { console.error(e); process.exit(1); });
