// 로컬 플레이어 — 자기 위치/HP/방향에 대해 권위를 가진다.
// 분산형 전투: 공격 broadcast 가 도착하면 "내가 히트박스 안인지" 스스로 판정하고,
// 맞았으면 내 HP/넉백/i-frame 을 적용한 뒤 hp(/death) broadcast 로 알린다.

import { isBlocked, type TileMap } from './map';
import type { AttackPayload, Dir, PosPayload } from './types';
import { consumeAttack, dirFromInput, input } from './input';

// 공격 사양 (spec §7) — LPC 표준 32px 타일 기준.
export const MAX_HP = 100;
export const SPEED = 120;            // px/sec
export const ATTACK_COOLDOWN = 0.5;
export const ATTACK_DAMAGE = 20;
export const HIT_LEN = 40;           // 히트박스 길이 (앞쪽)
export const HIT_WID = 36;           // 히트박스 폭
export const KNOCKBACK = 24;         // px
export const IFRAME = 0.4;
export const ATTACK_SWING_DUR = 0.18;
export const RESPAWN = 3.0;
export const DANCE_DUR = 3.0;

// 캐릭터 충돌/피격 AABB. (x, y) 는 발 위치 (그림자).
export const FOOT_HW = 7;
export const FOOT_HH = 5;
export const BODY_HW = 8;
export const BODY_HH = 14;
export const BODY_OFF_Y = -14;       // 몸통 중심

// 부유 데미지 텍스트 (피격 시 머리 위로 떠오름)
export interface FloatingText {
  text: string;
  color: string;
  x: number;
  y: number;
  birth: number;
}

export interface LocalPlayer {
  id: string;
  name: string;
  color: string;
  charIdx: number;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  hp: number;
  maxHp: number;
  walkFrame: 0 | 1;
  walkTimer: number;
  attackUntil: number;       // performance.now()/1000 기준 — 이때까지 스윙 모션
  attackCooldownUntil: number;
  iFrameUntil: number;
  hitFlashUntil: number;
  dead: boolean;
  deadUntil: number;
  kills: number;
  chatText: string;
  chatUntil: number;
  floats: FloatingText[];
  // 제로투 댄스
  danceUntil: number;
  danceStart: number;
  // 타격 정지 — onAttackBroadcast 에서 set, game.ts 루프가 읽어서 dt 0 처리.
  hitPauseUntil: number;
  // 화면 흔들림 트리거 — onAttackBroadcast 에서 set, game.ts 가 1회 소비.
  shakePending: number;
}

export function makeLocalPlayer(id: string, name: string, color: string, charIdx: number, spawn: { x: number; y: number }): LocalPlayer {
  return {
    id, name, color, charIdx,
    x: spawn.x, y: spawn.y,
    dir: 'down',
    moving: false,
    hp: MAX_HP, maxHp: MAX_HP,
    walkFrame: 0,
    walkTimer: 0,
    attackUntil: 0, attackCooldownUntil: 0,
    iFrameUntil: 0, hitFlashUntil: 0,
    dead: false, deadUntil: 0,
    kills: 0,
    chatText: '', chatUntil: 0,
    floats: [],
    danceUntil: 0, danceStart: 0,
    hitPauseUntil: 0, shakePending: 0,
  };
}

// 한 축씩 시도하며 충돌이면 막는다(슬라이드 이동).
function tryMove(p: LocalPlayer, dx: number, dy: number, map: TileMap): void {
  if (dx !== 0) {
    const nx = p.x + dx;
    if (!isBlocked(map, nx, p.y - FOOT_HH, FOOT_HW, FOOT_HH)) p.x = nx;
  }
  if (dy !== 0) {
    const ny = p.y + dy;
    if (!isBlocked(map, p.x, ny - FOOT_HH, FOOT_HW, FOOT_HH)) p.y = ny;
  }
}

export interface UpdateCtx {
  dt: number;
  now: number; // seconds
  map: TileMap;
  chatActive: boolean;
  sendAttack: (p: AttackPayload) => void;
  sendPos: (p: PosPayload) => void;     // throttled by caller
  sendHp: (hp: number) => void;
  sendDeath: (killerId: string | null) => void;
}

export function startDance(p: { danceUntil: number; danceStart: number }, now: number): void {
  p.danceUntil = now + DANCE_DUR;
  p.danceStart = now;
}

export function updateLocalPlayer(p: LocalPlayer, ctx: UpdateCtx): void {
  const { dt, now, map, chatActive } = ctx;

  // 댄스 중: 입력 차단, 위치 고정 (도발 모션만 재생)
  if (now < p.danceUntil) {
    p.moving = false;
    p.walkFrame = 0;
    return;
  }

  // 사망 시: 리스폰 타이머만 처리
  if (p.dead) {
    if (now >= p.deadUntil) {
      const spawn = map.spawns.length > 0
        ? map.spawns[Math.floor(Math.random() * map.spawns.length)]
        : { x: map.pixelW / 2, y: map.pixelH / 2 };
      p.x = spawn.x; p.y = spawn.y;
      p.hp = p.maxHp;
      p.dead = false;
      p.iFrameUntil = now + 1.0; // 부활 무적 짧게
      // 즉시 pos + hp 재전송
      ctx.sendPos({ id: p.id, x: p.x, y: p.y, dir: p.dir, moving: false });
      ctx.sendHp(p.hp);
    }
    return;
  }

  // 이동
  let mx = 0, my = 0;
  if (!chatActive) {
    mx = input.moveX;
    my = input.moveY;
  }
  const moving = mx !== 0 || my !== 0;
  if (moving) {
    p.dir = dirFromInput(p.dir);
    // 대각선이면 정규화
    const len = Math.hypot(mx, my) || 1;
    const vx = (mx / len) * SPEED * dt;
    const vy = (my / len) * SPEED * dt;
    tryMove(p, vx, vy, map);
    p.walkTimer += dt;
    if (p.walkTimer > 0.18) {
      p.walkTimer = 0;
      p.walkFrame = (p.walkFrame === 0 ? 1 : 0);
    }
  } else {
    p.walkFrame = 0;
    p.walkTimer = 0;
  }
  p.moving = moving;

  // 공격
  const wantsAttack = consumeAttack();
  if (wantsAttack && !chatActive && now >= p.attackCooldownUntil) {
    p.attackCooldownUntil = now + ATTACK_COOLDOWN;
    p.attackUntil = now + ATTACK_SWING_DUR;
    ctx.sendAttack({ id: p.id, x: p.x, y: p.y, dir: p.dir });
  }

  // 부유 텍스트 정리
  if (p.floats.length > 0) {
    p.floats = p.floats.filter((f) => now - f.birth < 0.9);
  }
}

// 공격자의 히트박스 사각형 (월드 좌표 minX/maxX/minY/maxY)
export function attackerHitbox(a: { x: number; y: number; dir: Dir }): { x0: number; y0: number; x1: number; y1: number } {
  const cx = a.x;
  const cy = a.y + BODY_OFF_Y;
  switch (a.dir) {
    case 'up':    return { x0: cx - HIT_WID / 2, x1: cx + HIT_WID / 2, y0: cy - HIT_LEN,     y1: cy };
    case 'down':  return { x0: cx - HIT_WID / 2, x1: cx + HIT_WID / 2, y0: cy,               y1: cy + HIT_LEN };
    case 'left':  return { x0: cx - HIT_LEN,     x1: cx,               y0: cy - HIT_WID / 2, y1: cy + HIT_WID / 2 };
    case 'right': return { x0: cx,               x1: cx + HIT_LEN,     y0: cy - HIT_WID / 2, y1: cy + HIT_WID / 2 };
  }
}

// 내 몸통 AABB
export function bodyAabb(p: { x: number; y: number }): { x0: number; y0: number; x1: number; y1: number } {
  const cx = p.x;
  const cy = p.y + BODY_OFF_Y;
  return { x0: cx - BODY_HW, x1: cx + BODY_HW, y0: cy - BODY_HH, y1: cy + BODY_HH };
}

function rectIntersect(a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

// "공격 신호를 받으면 내가 맞았는지 판정"하는 핵심 함수.
// 트레이드오프: Realtime 은 중계만 하므로 클라가 자기 권위 — 치팅 가능. 캐주얼 게임이라 수용.
export function onAttackBroadcast(p: LocalPlayer, atk: AttackPayload, ctx: UpdateCtx): void {
  if (p.dead) return;
  if (atk.id === p.id) return; // 자기 메시지는 self:false 라 안 옴 — 방어용
  if (ctx.now < p.iFrameUntil) return;

  const hb = attackerHitbox(atk);
  const me = bodyAabb(p);
  if (!rectIntersect(hb, me)) return;

  // 피격 처리
  p.hp = Math.max(0, p.hp - ATTACK_DAMAGE);
  p.iFrameUntil = ctx.now + IFRAME;
  p.hitFlashUntil = ctx.now + 0.2;
  p.hitPauseUntil = ctx.now + 0.06;   // 60ms 정지 — 타격감
  p.shakePending = 6;                 // 화면 흔들림 강도 (px)

  // 넉백 — 공격 방향으로 24px (충돌 체크)
  let kx = 0, ky = 0;
  switch (atk.dir) {
    case 'up':    ky = -KNOCKBACK; break;
    case 'down':  ky =  KNOCKBACK; break;
    case 'left':  kx = -KNOCKBACK; break;
    case 'right': kx =  KNOCKBACK; break;
  }
  tryMove(p, kx, ky, ctx.map);

  // 부유 데미지 텍스트
  p.floats.push({
    text: `-${ATTACK_DAMAGE}`,
    color: '#ffd9d9',
    x: p.x,
    y: p.y + BODY_OFF_Y - BODY_HH,
    birth: ctx.now,
  });

  ctx.sendHp(p.hp);

  if (p.hp <= 0) {
    p.dead = true;
    p.deadUntil = ctx.now + RESPAWN;
    ctx.sendDeath(atk.id);
  }
}

// 부활 직후 좌표 안전망. map.pixelW/H 안에 가두고 충돌 영역에 박혀있지 않도록 살짝 들어준다.
export function clampToWorld(p: LocalPlayer, map: TileMap): void {
  p.x = Math.max(FOOT_HW, Math.min(map.pixelW - FOOT_HW, p.x));
  p.y = Math.max(FOOT_HH, Math.min(map.pixelH - FOOT_HH, p.y));
}
