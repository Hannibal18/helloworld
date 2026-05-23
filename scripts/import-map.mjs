// Tiled 에서 export 한 맵을 helloworld 가 바로 쓸 수 있는 형태로 변환.
//
// 처리:
//   1. 외부 .tsx 참조 → inline tileset 으로 인라인
//   2. 레이어 이름 정규화: "타일 레이어 1" → ground, "나무" → objects_below, "나무2" → objects_above
//   3. objects_below 의 비제로 타일 → collision objectgroup 자동 합성
//
// 사용:
//   node scripts/import-map.mjs               (기본: Tiled/output/File.json → public/assets/maps/town.json)
//   node scripts/import-map.mjs <src> <dst>

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const DEFAULT_SRC = "/Users/han/Developer/Tiled/output/File.json";
const DEFAULT_DST = resolve(REPO_ROOT, "public/assets/maps/town.json");

const [srcArg, dstArg] = process.argv.slice(2);
const SRC = srcArg ? resolve(srcArg) : DEFAULT_SRC;
const DST = dstArg ? resolve(dstArg) : DEFAULT_DST;

// 레이어 이름 매핑 — Tiled 한국어 기본 이름 + 자주 쓰는 이름들을 표준 역할로.
const LAYER_RENAME = new Map([
  ["타일 레이어 1", "ground"],
  ["타일 레이어 2", "decor"],
  ["바닥", "ground"],
  ["땅", "ground"],
  ["장식", "decor"],
  ["나무", "decor"],
  ["나무2", "objects_below"],
  ["나무3", "objects_above"],
  ["오브젝트", "objects_below"],
  ["충돌", "collision"],
  ["스폰", "spawns"],
]);

function renameLayer(name) {
  return LAYER_RENAME.get(name) ?? name;
}

// 외부 .tsx 파일을 inline tileset 객체로 변환.
// Tiled .tsx 형식 (XML, 매우 단순):
//   <tileset name=".." tilewidth=".." tileheight=".." tilecount=".." columns="..">
//     <image source=".." width=".." height=".."/>
//   </tileset>
async function loadExternalTileset(tsxPath, firstgid) {
  const xml = await readFile(tsxPath, "utf8");
  const attr = (re) => {
    const m = xml.match(re);
    return m ? m[1] : null;
  };
  const name = attr(/<tileset[^>]*\sname="([^"]+)"/);
  const tilewidth = parseInt(attr(/<tileset[^>]*\stilewidth="(\d+)"/) ?? "32", 10);
  const tileheight = parseInt(attr(/<tileset[^>]*\stileheight="(\d+)"/) ?? "32", 10);
  const tilecount = parseInt(attr(/<tileset[^>]*\stilecount="(\d+)"/) ?? "0", 10);
  const columns = parseInt(attr(/<tileset[^>]*\scolumns="(\d+)"/) ?? "0", 10);
  const imageSrc = attr(/<image[^>]*\ssource="([^"]+)"/);
  const imageWidth = parseInt(attr(/<image[^>]*\swidth="(\d+)"/) ?? "0", 10);
  const imageHeight = parseInt(attr(/<image[^>]*\sheight="(\d+)"/) ?? "0", 10);

  // 게임 안에서 이미지는 public/assets/tilesets/ 에 있는 같은 파일명 PNG 를 가리킨다.
  // (.tsx 의 ../01 tilesets/LPC_forest/forest_tiles.png 같은 상대경로는 무시.)
  const imageFile = imageSrc ? basename(imageSrc) : `${name}.png`;
  const targetImage = `../tilesets/${imageFile}`;

  return {
    firstgid,
    name,
    image: targetImage,
    imagewidth: imageWidth,
    imageheight: imageHeight,
    columns,
    tilecount,
    margin: 0,
    spacing: 0,
    tilewidth,
    tileheight,
  };
}

function normalizeLayerData(layer) {
  if (layer.type !== "tilelayer") return layer;
  let data = layer.data;
  if (typeof data === "string") {
    data = data.split(",").map((s) => parseInt(s.trim(), 10));
  }
  return { ...layer, data };
}

// objects_below 레이어의 비제로 타일들을 사각형 collision objectgroup 으로 변환.
// 단순화: 타일 하나 = 사각형 하나. (인접 타일 머징 같은 최적화는 생략.)
function buildCollisionLayer(objectsBelow, tileW, tileH) {
  if (!objectsBelow || objectsBelow.type !== "tilelayer") return null;
  const width = objectsBelow.width;
  const data = objectsBelow.data;
  const objects = [];
  let nextId = 100000;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) {
      const tx = i % width;
      const ty = Math.floor(i / width);
      objects.push({
        id: nextId++,
        name: "",
        type: "",
        x: tx * tileW,
        y: ty * tileH,
        width: tileW,
        height: tileH,
        rotation: 0,
        visible: true,
      });
    }
  }
  return {
    id: 90000,
    name: "collision",
    type: "objectgroup",
    visible: false,
    opacity: 1,
    objects,
    x: 0,
    y: 0,
    draworder: "topdown",
  };
}

// ===== main =====
console.log(`reading  ${SRC}`);
const raw = JSON.parse(await readFile(SRC, "utf8"));

// 1. 타일셋 인라인 처리
const srcDir = dirname(SRC);
const newTilesets = [];
for (const ts of raw.tilesets) {
  if (ts.source) {
    const tsxPath = resolve(srcDir, ts.source);
    console.log(`  inline tileset ${ts.source}`);
    newTilesets.push(await loadExternalTileset(tsxPath, ts.firstgid));
  } else {
    newTilesets.push(ts);
  }
}

// 2. 레이어 이름 정규화 + 데이터 정규화
const renamedLayers = raw.layers.map((l) => {
  const newName = renameLayer(l.name);
  if (newName !== l.name) console.log(`  rename layer "${l.name}" -> "${newName}"`);
  return normalizeLayerData({ ...l, name: newName });
});

// 3. collision 자동 합성 — objects_below 에서 유래.
const objectsBelow = renamedLayers.find((l) => l.name === "objects_below");
const hasCollision = renamedLayers.some((l) => l.name === "collision");
let finalLayers = renamedLayers;
if (!hasCollision && objectsBelow) {
  const col = buildCollisionLayer(objectsBelow, raw.tilewidth, raw.tileheight);
  if (col) {
    console.log(`  generated collision layer (${col.objects.length} rects from objects_below)`);
    finalLayers = [...renamedLayers, col];
  }
}

const out = {
  ...raw,
  tilesets: newTilesets,
  layers: finalLayers,
};

await writeFile(DST, JSON.stringify(out, null, 2));
console.log(`wrote    ${DST}`);
