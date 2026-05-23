// 일회용 도구 — LPC forest 의 preview 이미지를 32×32 블록으로 잘라
// forest_tiles 의 256 타일과 픽셀 비교(SSE)해서 매칭되는 gid 배열을 추출 →
// public/assets/maps/town.json 으로 저장.
//
// 사용법: node scripts/preview-to-map.cjs

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const TILESET_PATH = path.join(__dirname, '..', 'public/assets/tilesets/forest_tiles.png');
const PREVIEW_PATH = path.join(__dirname, '..', '[LPC] Forest tiles _ OpenGameArt.org_files', 'preview_241(1).png');
const OUT_PATH     = path.join(__dirname, '..', 'public/assets/maps/town.json');

const TS = 32;            // tile size
const TILESET_COLS = 16;
const TILESET_ROWS = 16;

async function loadRaw(p) {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

function extractBlock(src, x, y, ch, srcW) {
  const buf = new Uint8Array(TS * TS * ch);
  for (let yy = 0; yy < TS; yy++) {
    const srcRow = (y + yy) * srcW * ch;
    const dstRow = yy * TS * ch;
    for (let xx = 0; xx < TS * ch; xx++) {
      buf[dstRow + xx] = src[srcRow + (x * ch) + xx];
    }
  }
  return buf;
}

// "풀(grass)" 인지 — 녹색 성분이 우세하고 알파 거의 100%면 통과.
function isGrassish(tilePixels, ch) {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let i = 0; i < TS * TS; i++) {
    r += tilePixels[i*ch + 0];
    g += tilePixels[i*ch + 1];
    b += tilePixels[i*ch + 2];
    if (ch === 4) a += tilePixels[i*ch + 3];
    n++;
  }
  r /= n; g /= n; b /= n; a /= n;
  if (ch === 4 && a < 200) return false;       // 반투명/투명 — 오브젝트
  // 녹색 우세 (G > R AND G > B), 너무 어둡거나 너무 밝지 않음
  return g > r + 10 && g > b + 5 && g > 70 && g < 200;
}

(async () => {
  console.log('Loading tileset:', TILESET_PATH);
  const ts = await loadRaw(TILESET_PATH);
  if (ts.w !== TILESET_COLS * TS || ts.h !== TILESET_ROWS * TS) {
    console.warn(`! 타일셋 크기 예상과 다름 — ${ts.w}×${ts.h} (예상 ${TILESET_COLS*TS}×${TILESET_ROWS*TS})`);
  }

  // 각 타일을 메모리에 추출 (256개)
  const tiles = []; // { gid, pixels, grassish }
  for (let row = 0; row < TILESET_ROWS; row++) {
    for (let col = 0; col < TILESET_COLS; col++) {
      const pixels = extractBlock(ts.data, col * TS, row * TS, ts.ch, ts.w);
      const gid = row * TILESET_COLS + col + 1;
      tiles.push({ gid, pixels, grassish: isGrassish(pixels, ts.ch) });
    }
  }
  console.log(`Extracted ${tiles.length} tiles, ${tiles.filter(t => t.grassish).length} grass-ish`);

  console.log('Loading preview:', PREVIEW_PATH);
  const prev = await loadRaw(PREVIEW_PATH);

  // 그리드 정렬 — preview 너비가 정확한 배수가 아닐 수 있어, 좌상단부터 가능한 만큼 자름
  const cols = Math.floor(prev.w / TS);
  const rows = Math.floor(prev.h / TS);
  console.log(`Preview grid: ${cols} × ${rows} tiles (${prev.w}×${prev.h} px, ch=${prev.ch})`);

  const W = cols, H = rows;
  const ground = new Array(W * H).fill(0);
  const blocked = new Array(W * H).fill(false);

  // 매칭 — 각 블록을 SSE 로 256 타일과 비교, 최저 점수 gid 채택
  // 동일 채널수 보장: preview 채널수 ≠ tileset 채널수면 RGB 만 비교
  const matchCh = Math.min(prev.ch, ts.ch, 3); // RGB 만 (alpha 무시 — preview 는 합성됐을 가능성)
  let progress = 0;
  for (let ry = 0; ry < H; ry++) {
    for (let cx = 0; cx < W; cx++) {
      const block = extractBlock(prev.data, cx * TS, ry * TS, prev.ch, prev.w);
      let bestGid = 1, bestScore = Infinity;
      for (const t of tiles) {
        let score = 0;
        for (let py = 0; py < TS; py++) {
          for (let px = 0; px < TS; px++) {
            const bi = (py * TS + px) * prev.ch;
            const ti = (py * TS + px) * ts.ch;
            for (let c = 0; c < matchCh; c++) {
              const d = block[bi + c] - t.pixels[ti + c];
              score += d * d;
            }
            // 조기 종료
            if (score > bestScore) break;
          }
          if (score > bestScore) break;
        }
        if (score < bestScore) { bestScore = score; bestGid = t.gid; }
      }
      const idx = ry * W + cx;
      ground[idx] = bestGid;
      const matched = tiles[bestGid - 1];
      blocked[idx] = !matched.grassish;
      progress++;
    }
    process.stdout.write(`\r  matching: row ${ry+1}/${H}`);
  }
  console.log('\n매칭 완료.');

  // 충돌 영역 — 비-풀 타일을 사각형으로 묶지 않고 그냥 칸별 사각형으로 (단순).
  const collisionObjects = [];
  let oid = 1;
  for (let i = 0; i < ground.length; i++) {
    if (!blocked[i]) continue;
    const tx = i % W, ty = Math.floor(i / W);
    collisionObjects.push({ id: oid++, x: tx * TS, y: ty * TS, width: TS, height: TS, rotation: 0, visible: true });
  }
  // 맵 경계
  collisionObjects.push({ id: oid++, x: 0,            y: 0,             width: W * TS, height: TS,     rotation: 0, visible: true });
  collisionObjects.push({ id: oid++, x: 0,            y: (H - 1) * TS,  width: W * TS, height: TS,     rotation: 0, visible: true });
  collisionObjects.push({ id: oid++, x: 0,            y: 0,             width: TS,     height: H * TS, rotation: 0, visible: true });
  collisionObjects.push({ id: oid++, x: (W - 1) * TS, y: 0,             width: TS,     height: H * TS, rotation: 0, visible: true });

  // 스폰 — 풀 타일 중 4곳
  const spawnPoints = [];
  const grassIndices = [];
  for (let i = 0; i < ground.length; i++) if (!blocked[i]) grassIndices.push(i);
  // 균등하게 4개
  for (let k = 1; k <= 4; k++) {
    const idx = grassIndices[Math.floor(grassIndices.length * k / 5)];
    if (idx == null) continue;
    const tx = idx % W, ty = Math.floor(idx / W);
    spawnPoints.push({ id: 9000 + k, x: tx * TS + TS / 2, y: ty * TS + TS / 2, width: 0, height: 0, point: true, visible: true, type: 'spawn', name: '' });
  }

  const map = {
    compressionlevel: -1,
    width: W, height: H,
    tilewidth: TS, tileheight: TS,
    infinite: false,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.0',
    nextlayerid: 8,
    nextobjectid: 10000,
    tilesets: [{
      firstgid: 1,
      name: 'forest_tiles',
      image: '../tilesets/forest_tiles.png',
      imagewidth: ts.w, imageheight: ts.h,
      columns: TILESET_COLS, tilecount: TILESET_ROWS * TILESET_COLS,
      margin: 0, spacing: 0,
      tilewidth: TS, tileheight: TS,
    }],
    layers: [
      { id: 1, name: 'ground',        type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: ground },
      { id: 2, name: 'decor',         type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: new Array(W * H).fill(0) },
      { id: 3, name: 'objects_below', type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: new Array(W * H).fill(0) },
      { id: 4, name: 'objects_above', type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: new Array(W * H).fill(0) },
      { id: 5, name: 'collision',     type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: collisionObjects },
      { id: 6, name: 'spawns',        type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: spawnPoints },
    ],
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(map, null, 2));
  console.log(`Saved ${OUT_PATH} — ${W}×${H} tiles, ${collisionObjects.length} collision rects, ${spawnPoints.length} spawns`);
})().catch((e) => { console.error(e); process.exit(1); });
