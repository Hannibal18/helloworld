// 맵 충돌 감사 — 사용된 gid 중 충돌박스 없는 타일 보고.
// 사용:  node scripts/audit-map.mjs public/maps/lost_temple/lost_temple.json
//
// 사람이 "왜 통과되지" 하기 전에 미리 잡으려는 용도. layer 별로 어떤 gid 가
// 충돌 없이 그냥 깔려 있는지 알려준다. 의도(바닥) 인지 실수(벽인데 충돌 빠짐) 인지는
// 사람이 판단. 명백한 floor/decor 이름의 레이어는 결과에서 제외해서 노이즈 ↓.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FLOOR_LIKE = /^(ground|floor|바닥|grass|sand|dirt|땅|spawns?|spawn)$/i;

const [mapPath] = process.argv.slice(2);
if (!mapPath) {
  console.error('Usage: node scripts/audit-map.mjs <map.json>');
  process.exit(1);
}

const mapAbs = resolve(mapPath);
const mapDir = dirname(mapAbs);
const map = JSON.parse(await readFile(mapAbs, 'utf8'));

// 타일셋 로드 — .tsj 만 (이 프로젝트 규약)
const tilesets = [];
for (const ts of map.tilesets) {
  if (!ts.source) continue; // embedded 는 미지원
  const tsjPath = resolve(mapDir, ts.source);
  const tsj = JSON.parse(await readFile(tsjPath, 'utf8'));
  tilesets.push({ firstgid: ts.firstgid, name: tsj.name ?? ts.source, tiles: tsj.tiles ?? [] });
}
tilesets.sort((a, b) => b.firstgid - a.firstgid);

const hasCollision = (gid) => {
  for (const ts of tilesets) {
    if (gid >= ts.firstgid) {
      const localId = gid - ts.firstgid;
      const t = ts.tiles.find((x) => x.id === localId);
      return { ts: ts.name, localId, has: !!(t?.objectgroup?.objects?.length) };
    }
  }
  return null;
};

const collectTL = (layers, out, ancestry = []) => {
  for (const l of layers) {
    const path = [...ancestry, l.name].join(' / ');
    if (l.type === 'tilelayer') out.push({ layer: l, path });
    else if (l.layers) collectTL(l.layers, out, [...ancestry, l.name]);
  }
};

const all = [];
collectTL(map.layers, all);

let warned = 0;
for (const { layer, path } of all) {
  if (FLOOR_LIKE.test(layer.name)) continue;                  // floor-like 레이어 스킵
  const cls = (layer.class ?? '').toLowerCase();
  if (cls === 'collision') continue;                          // 이미 layer-level collision
  let data = layer.data;
  if (typeof data === 'string') data = data.split(',').map((s) => parseInt(s.trim(), 10));
  const noCol = new Map(); // gid → count
  for (const gid of data) {
    if (gid <= 0) continue;
    const info = hasCollision(gid);
    if (info && !info.has) noCol.set(gid, (noCol.get(gid) ?? 0) + 1);
  }
  if (noCol.size === 0) continue;
  warned++;
  console.log(`⚠ [${path}] ${noCol.size}종 gid 가 충돌박스 없음 (총 ${[...noCol.values()].reduce((a, b) => a + b, 0)} 칸)`);
  const top = [...noCol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [gid, count] of top) {
    const info = hasCollision(gid);
    console.log(`    gid ${gid}  (${info.ts}#${info.localId})  × ${count}`);
  }
  if (noCol.size > 10) console.log(`    ... 외 ${noCol.size - 10}종`);
}
if (warned === 0) {
  console.log('✓ 의심 가는 무충돌 타일 없음.');
} else {
  console.log(`\n→ 해당 레이어의 타일이 일부러 통과 가능한 거면 무시. 막혀야 하는 거면:\n  · Tiled 에서 그 레이어 class 를 'collision' 으로 설정 (전체 타일 막힘)\n  · 또는 tileset 의 Tile Collision Editor 에서 타일별 충돌박스 추가`);
}
