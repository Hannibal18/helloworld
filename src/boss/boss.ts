// 엄마 보스 — 협동 PvE.
//
// 설계 요약:
//   - 맵 중앙 스폰. 가만히 서서 주기적으로 가장 가까운 플레이어한테 공격.
//   - 공격 2종: 슬리퍼 투척 (호밍 X, 직선 발사), 잔소리 광역기 (1.5s 텔레그래프 후 폭발).
//   - 모든 플레이어가 자기 펀치로 데미지. 보스 HP = 800 (플레이어 7명이 약 7대씩이면 처치).
//   - v1: 멀티플레이어 상태 동기화 X. 각 클라이언트가 독립 시뮬레이션. 추후 sync 작업 예정.
//   - 보스 사망 후 BOSS_RESPAWN_DELAY 뒤 자동 부활.
//
// 게임 통합 지점:
//   1. game.ts startGameAsync(): spawnBoss(map) 호출 (BOSS_ENABLED 가드 안에서)
//   2. game.ts updateCtx.sendAttack: bossSystem.tryHitFromLocal() 추가
//   3. game.ts game loop: bossSystem.update(dt, now, local)
//   4. render.ts renderFrame: bossSystem.draw(ctx, hudCtx, camera, displayScale)

import type { TileMap } from '../map';
import type { Camera } from '../world';
import type { LocalPlayer } from '../player';
import { BODY_OFF_Y } from '../player';
import type { Dir } from '../types';
import { playSfx } from '../sfx';

// ===== 튜닝 =====
const BOSS_MAX_HP = 800;
const BOSS_RESPAWN_DELAY = 20;        // 사망 후 부활까지 (초)
const BOSS_SIZE = 96;                 // 화면에 그릴 가로/세로 (px). 일반 캐릭터 ~32 보다 3배 크게.
const BOSS_FOOT_Y_OFFSET = 6;         // 그릴 때 발 위치에서 위로 살짝 띄움

const ATTACK_INTERVAL_MIN = 2.5;
const ATTACK_INTERVAL_MAX = 4.5;

// 슬리퍼 투척
const SLIPPER_SPEED = 220;            // px/s
const SLIPPER_DAMAGE = 25;
const SLIPPER_RADIUS = 12;            // 충돌 반지름 (px)
const SLIPPER_LIFETIME = 2.0;

// 잔소리 광역기
const AOE_TELEGRAPH = 1.5;            // 텔레그래프 시간
const AOE_DAMAGE = 20;
const AOE_RADIUS = 110;

// LPC 스프라이트 시트 — 64×64 프레임. boss-mom.png 가 LPC 표준 그리드.
const SOURCE_FRAME = 64;

// LPC row 인덱스 (sprites.ts 와 동일 컨벤션)
const ROW_WALK_DOWN = 10;             // Walk Down — 9 frames, frame 0 = idle
const ROW_THRUST_DOWN = 6;            // Thrust Down — 8 frames (공격 모션)

interface Slipper {
  x: number;
  y: number;
  vx: number;
  vy: number;
  birth: number;
}

interface AoeIndicator {
  x: number;
  y: number;
  triggerAt: number;                  // now 이 시각이 되면 폭발
}

interface BossState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  deadUntil: number;
  spawnTime: number;
  nextAttackTime: number;
  slippers: Slipper[];
  aoe: AoeIndicator | null;
  hitFlashUntil: number;
  attackingUntil: number;             // 공격 모션 표시 (thrust 프레임)
}

export interface BossCallbacks {
  /** 로컬 플레이어 HP 가 보스에 의해 변했을 때 호출 — 멀티플레이 동기화용. */
  sendHp: (hp: number) => void;
  /** 로컬 플레이어가 보스에 의해 사망했을 때 호출. killerId 는 null (보스에 죽음 표기). */
  sendDeath: (killerId: string | null) => void;
}

export interface BossSystem {
  /** 현재 보스 상태 (UI 등 외부 표시용 — write 금지). */
  readonly state: BossState;
  /** 매 프레임 호출. 슬리퍼/AOE 진행 + 플레이어 데미지 적용. */
  update: (dt: number, now: number, local: LocalPlayer) => void;
  /** 게임 캔버스에 보스 + 슬리퍼 + AOE 텔레그래프, HUD 캔버스에 보스 HP 바를 그림. */
  draw: (
    gameCtx: CanvasRenderingContext2D,
    hudCtx: CanvasRenderingContext2D,
    camera: Camera,
    displayScale: number,
    now: number,
  ) => void;
  /** 로컬 플레이어의 공격이 보스를 맞히는지 체크해 데미지 적용. true 면 명중. */
  tryHitFromLocal: (attackerX: number, attackerY: number, dir: Dir, now: number) => boolean;
}

export function spawnBoss(map: TileMap, now: number, callbacks: BossCallbacks): BossSystem {
  const sheet = new Image();
  let sheetReady = false;
  sheet.src = '/sprites/boss-mom.png';
  sheet.onload = () => { sheetReady = true; };

  const spawnX = map.pixelW / 2;
  const spawnY = map.pixelH / 2;

  const state: BossState = {
    x: spawnX,
    y: spawnY,
    hp: BOSS_MAX_HP,
    maxHp: BOSS_MAX_HP,
    dead: false,
    deadUntil: 0,
    spawnTime: now,
    nextAttackTime: now + 3,         // 등장 후 3초 그레이스
    slippers: [],
    aoe: null,
    hitFlashUntil: 0,
    attackingUntil: 0,
  };

  function pickAttack(now: number, local: LocalPlayer): void {
    // 50/50 로 슬리퍼 or 광역기. 멀리 있으면 슬리퍼 선호.
    const dx = local.x - state.x;
    const dy = local.y - state.y;
    const distSq = dx * dx + dy * dy;
    const preferSlipper = distSq > 200 * 200 || Math.random() < 0.5;
    if (preferSlipper) {
      // 슬리퍼 — local 방향으로 발사 (현재 시점 방향. 호밍 X)
      const d = Math.sqrt(distSq) || 1;
      state.slippers.push({
        x: state.x,
        y: state.y - 20,            // 머리 높이쯤에서 던짐
        vx: (dx / d) * SLIPPER_SPEED,
        vy: (dy / d) * SLIPPER_SPEED,
        birth: now,
      });
    } else {
      // 광역기 — local 위치에 텔레그래프 후 폭발
      state.aoe = {
        x: local.x,
        y: local.y,
        triggerAt: now + AOE_TELEGRAPH,
      };
    }
    state.attackingUntil = now + 0.4;
    state.nextAttackTime = now + ATTACK_INTERVAL_MIN + Math.random() * (ATTACK_INTERVAL_MAX - ATTACK_INTERVAL_MIN);
  }

  function damageLocal(local: LocalPlayer, dmg: number, now: number): void {
    if (local.dead) return;
    if (now < local.iFrameUntil) return;
    local.hp = Math.max(0, local.hp - dmg);
    local.hitFlashUntil = now + 0.2;
    local.iFrameUntil = now + 0.3;
    local.floats.push({
      text: `-${dmg}`,
      color: '#ffd9d9',
      x: local.x,
      y: local.y + BODY_OFF_Y - 24,
      birth: now,
    });
    playSfx('punch_hit');
    callbacks.sendHp(local.hp);
    if (local.hp <= 0) {
      local.dead = true;
      local.deadUntil = now + 4;
      local.deaths += 1;
      playSfx('death');
      callbacks.sendDeath(null);     // killer = boss (null 로 표기)
    }
  }

  return {
    state,

    update(dt, now, local) {
      // 사망 상태 — 부활 카운트다운
      if (state.dead) {
        if (now >= state.deadUntil) {
          state.x = spawnX;
          state.y = spawnY;
          state.hp = state.maxHp;
          state.dead = false;
          state.spawnTime = now;
          state.nextAttackTime = now + 3;
          state.slippers.length = 0;
          state.aoe = null;
        }
        return;
      }

      // 공격 트리거
      if (now >= state.nextAttackTime) {
        pickAttack(now, local);
      }

      // 슬리퍼 진행
      for (let i = state.slippers.length - 1; i >= 0; i--) {
        const s = state.slippers[i];
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        // 로컬 플레이어와 충돌
        const dx = s.x - local.x;
        const dy = s.y - (local.y + BODY_OFF_Y);
        if (dx * dx + dy * dy < SLIPPER_RADIUS * SLIPPER_RADIUS) {
          damageLocal(local, SLIPPER_DAMAGE, now);
          state.slippers.splice(i, 1);
          continue;
        }
        if (now - s.birth > SLIPPER_LIFETIME) {
          state.slippers.splice(i, 1);
        }
      }

      // 광역기 폭발 트리거
      if (state.aoe && now >= state.aoe.triggerAt) {
        const dx = state.aoe.x - local.x;
        const dy = state.aoe.y - local.y;
        if (dx * dx + dy * dy < AOE_RADIUS * AOE_RADIUS) {
          damageLocal(local, AOE_DAMAGE, now);
        }
        state.aoe = null;
      }
    },

    draw(gameCtx, hudCtx, camera, displayScale, now) {
      if (state.dead) return;

      // ===== AOE 텔레그래프 (게임 캔버스 — 픽셀 좌표) =====
      if (state.aoe) {
        const aoe = state.aoe;
        const remain = aoe.triggerAt - now;
        const pulse = Math.max(0, Math.min(1, 1 - remain / AOE_TELEGRAPH));
        gameCtx.save();
        gameCtx.globalAlpha = 0.25 + 0.4 * pulse;
        gameCtx.fillStyle = '#d04a4a';
        gameCtx.beginPath();
        gameCtx.arc(
          Math.round(aoe.x - camera.x),
          Math.round(aoe.y - camera.y),
          AOE_RADIUS,
          0, Math.PI * 2,
        );
        gameCtx.fill();
        gameCtx.restore();
      }

      // ===== 보스 스프라이트 =====
      const screenX = Math.round(state.x - camera.x);
      const screenY = Math.round(state.y - camera.y);
      if (sheetReady) {
        // 공격 중이면 thrust 프레임, 아니면 idle (walk row의 frame 0)
        const isAttacking = now < state.attackingUntil;
        const row = isAttacking ? ROW_THRUST_DOWN : ROW_WALK_DOWN;
        const col = 0;
        gameCtx.save();
        // hit flash — 빨갛게 오버레이
        if (now < state.hitFlashUntil) {
          gameCtx.filter = 'brightness(1.6) saturate(2) hue-rotate(-30deg)';
        }
        gameCtx.drawImage(
          sheet,
          col * SOURCE_FRAME, row * SOURCE_FRAME, SOURCE_FRAME, SOURCE_FRAME,
          screenX - BOSS_SIZE / 2,
          screenY - BOSS_SIZE + BOSS_FOOT_Y_OFFSET,
          BOSS_SIZE, BOSS_SIZE,
        );
        gameCtx.restore();
      } else {
        // 로딩 전 폴백 — 검정 사각형
        gameCtx.fillStyle = '#222';
        gameCtx.fillRect(screenX - 20, screenY - 60, 40, 60);
      }

      // ===== 슬리퍼 (작은 갈색 타원) =====
      for (const s of state.slippers) {
        gameCtx.save();
        const ang = Math.atan2(s.vy, s.vx) + now * 6;     // 회전 효과
        gameCtx.translate(Math.round(s.x - camera.x), Math.round(s.y - camera.y));
        gameCtx.rotate(ang);
        gameCtx.fillStyle = '#6b3410';
        gameCtx.beginPath();
        gameCtx.ellipse(0, 0, 10, 5, 0, 0, Math.PI * 2);
        gameCtx.fill();
        gameCtx.fillStyle = '#a85a20';
        gameCtx.beginPath();
        gameCtx.ellipse(-1, -1, 8, 3, 0, 0, Math.PI * 2);
        gameCtx.fill();
        gameCtx.restore();
      }

      // ===== HUD 캔버스: 보스 HP 바 (상단 가로) =====
      drawBossHpBar(hudCtx, state, displayScale);
    },

    tryHitFromLocal(attackerX, attackerY, dir, now) {
      if (state.dead) return false;
      // 보스의 발 위치 기준 박스. 보스가 크니까 hitbox 도 큼.
      const hitbox = { x: state.x, y: state.y - 30, hw: 40, hh: 40 };
      // 공격자 방향의 hitcheck — 플레이어 attack range (40px) 기준 단순 판정
      const ATTACK_RANGE = 50;
      let cx = attackerX, cy = attackerY;
      switch (dir) {
        case 'up':    cy -= ATTACK_RANGE; break;
        case 'down':  cy += ATTACK_RANGE; break;
        case 'left':  cx -= ATTACK_RANGE; break;
        case 'right': cx += ATTACK_RANGE; break;
      }
      const dx = Math.abs(cx - hitbox.x);
      const dy = Math.abs(cy - hitbox.y);
      if (dx > hitbox.hw + 30 || dy > hitbox.hh + 30) return false;

      // 명중
      const dmg = 20;
      state.hp = Math.max(0, state.hp - dmg);
      state.hitFlashUntil = now + 0.15;
      if (state.hp <= 0) {
        state.dead = true;
        state.deadUntil = now + BOSS_RESPAWN_DELAY;
        state.slippers.length = 0;
        state.aoe = null;
      }
      return true;
    },
  };
}

function drawBossHpBar(hudCtx: CanvasRenderingContext2D, state: BossState, displayScale: number): void {
  if (state.dead) return;
  const canvas = hudCtx.canvas;
  const dpr = window.devicePixelRatio || 1;
  // hudCtx 는 setTransform 으로 이미 dpr 스케일이 걸려있음. canvas.width 는 displayPx*dpr.
  const cssW = canvas.width / dpr;
  // 화면 상단 중앙에 가로 60% 폭
  const barW = Math.max(280, cssW * 0.5);
  const barH = 16;
  const bx = Math.round((cssW - barW) / 2);
  const by = 12;

  // 배경
  hudCtx.fillStyle = 'rgba(0,0,0,0.75)';
  hudCtx.fillRect(bx - 4, by - 18, barW + 8, barH + 28);

  // 이름
  hudCtx.font = `bold 14px 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif`;
  hudCtx.fillStyle = '#ffb0b0';
  hudCtx.textAlign = 'center';
  hudCtx.textBaseline = 'alphabetic';
  hudCtx.fillText('보스 — 엄마', bx + barW / 2, by - 4);

  // HP 바
  hudCtx.fillStyle = '#3a1212';
  hudCtx.fillRect(bx, by, barW, barH);
  const pct = Math.max(0, Math.min(1, state.hp / state.maxHp));
  hudCtx.fillStyle = pct > 0.5 ? '#d04a4a' : pct > 0.25 ? '#e0c050' : '#fff';
  hudCtx.fillRect(bx, by, Math.round(barW * pct), barH);
  hudCtx.strokeStyle = '#000';
  hudCtx.lineWidth = 1;
  hudCtx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);

  // 잔여 HP 텍스트
  hudCtx.font = `bold 11px 'Apple SD Gothic Neo', system-ui, sans-serif`;
  hudCtx.fillStyle = '#fff';
  hudCtx.fillText(`${state.hp} / ${state.maxHp}`, bx + barW / 2, by + 12);

  // displayScale 은 사용 안 함 — HUD 는 CSS px 직접. 시그니처 통일성 위해 받음.
  void displayScale;
}
