// 총(AK) 시스템 — 주기 드랍 + 픽업 + 발사 + 총알.
// 네트워크: 호스트(현재 presence 멤버 중 id 가 사전순으로 가장 작은 클라이언트) 가
// 새 드랍을 스폰해 broadcast. 픽업/발사는 누구나 broadcast. 충돌은 피격자 권위
// (총알이 자기 몸통 AABB 에 들어오면 자기 HP 깎고 hp/death broadcast).

import { isBlocked, type TileMap } from './map';

export const GUN_DROP_INTERVAL = 60;     // 호스트가 새 드랍 spawn 주기 (초)
export const GUN_MAX_DROPS = 2;          // 맵 위 동시 존재 가능한 드랍 최대 개수
export const GUN_HOLD_DURATION = 30;     // 픽업 후 보유 시간 (초)
export const GUN_PICKUP_RADIUS = 18;     // 픽업 인식 반경 (월드 px)
export const GUN_FIRE_COOLDOWN = 0.15;   // 사격 간격 (초)
export const BULLET_DAMAGE = 10;
export const BULLET_SPEED = 520;         // px/sec
export const BULLET_LIFE = 0.7;          // sec → 사거리 ~360px ≈ 11타일
export const BULLET_W = 4;               // 그릴 때 픽셀 폭
export const BULLET_H = 4;

export interface GunDrop {
  id: string;
  x: number;
  y: number;
  spawnedAt: number; // 펄스 애니메이션 위상용
}

export interface Bullet {
  bid: string;
  ownerId: string;
  ownerName: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornAt: number;
  hitIds: Set<string>;   // 이미 데미지 적용한 대상(피격자 자기 자신 기준) — 중복 방지
}

export interface GunState {
  drops: Map<string, GunDrop>;
  bullets: Bullet[];
  nextSpawnAt: number;   // 호스트 한정으로 사용
}

export function makeGunState(now: number): GunState {
  return {
    drops: new Map(),
    bullets: [],
    nextSpawnAt: now + GUN_DROP_INTERVAL,
  };
}

export function addBullet(
  state: GunState,
  bid: string, ownerId: string, ownerName: string,
  x: number, y: number, vx: number, vy: number, now: number,
): void {
  state.bullets.push({
    bid, ownerId, ownerName,
    x, y, vx, vy,
    bornAt: now,
    hitIds: new Set(),
  });
}

// 호스트가 새 드랍 위치 산출. 못 찾으면 null.
export function pickSpawnTile(map: TileMap): { x: number; y: number } | null {
  const TILE = map.tileW;
  for (let i = 0; i < 30; i++) {
    const tx = Math.floor(Math.random() * map.widthTiles);
    const ty = Math.floor(Math.random() * map.heightTiles);
    const x = tx * TILE + TILE / 2;
    const y = ty * TILE + TILE / 2;
    // 작은 박스(8×8) 가 막혀 있지 않으면 OK
    if (!isBlocked(map, x, y, 8, 8)) return { x, y };
  }
  return null;
}

// 매 프레임 호출 — 호스트면 주기에 따라 spawn() 호출, 아니면 no-op.
// 맵에 이미 GUN_MAX_DROPS 개 이상 떠 있으면 타이머만 다시 잡고 spawn 은 건너뜀.
export function maybeSpawn(
  state: GunState,
  now: number,
  map: TileMap,
  isHost: boolean,
  spawn: (drop: GunDrop) => void,
): void {
  if (!isHost) return;
  if (now < state.nextSpawnAt) return;
  state.nextSpawnAt = now + GUN_DROP_INTERVAL;
  if (state.drops.size >= GUN_MAX_DROPS) return;
  const pos = pickSpawnTile(map);
  if (!pos) return;
  spawn({ id: cryptoRandom(), x: pos.x, y: pos.y, spawnedAt: now });
}

// 캐릭터 발 좌표(footX, footY) 가 드랍 픽업 반경 안인지. 첫 매칭 반환.
export function findPickup(state: GunState, footX: number, footY: number): GunDrop | null {
  const R2 = GUN_PICKUP_RADIUS * GUN_PICKUP_RADIUS;
  for (const drop of state.drops.values()) {
    const dx = drop.x - footX;
    const dy = drop.y - footY;
    if (dx * dx + dy * dy <= R2) return drop;
  }
  return null;
}

// 총알 위치 갱신 + 만료/벽 충돌 시 제거.
export function stepBullets(state: GunState, dt: number, now: number, map: TileMap): void {
  state.bullets = state.bullets.filter((b) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (now - b.bornAt > BULLET_LIFE) return false;
    if (isBlocked(map, b.x, b.y, 1, 1)) return false;
    return true;
  });
}

// crypto.randomUUID 가 (구형 브라우저에서) 없을 때 폴백.
function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `g${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
