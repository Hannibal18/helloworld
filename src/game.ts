// 게임 부트 + 메인 루프 + 네트워크/입력/렌더 통합.
// 맵은 Tiled JSON 을 로드해서 가져온다. 캔버스는 저해상도 백버퍼 + 정수배 업스케일.

import { connect, type Net } from './net';
import { setupInput, consumeMentalAttack } from './input';
import { pickInsult } from './insults';
import { BOSS_ENABLED, spawnBoss, type BossSystem } from './boss';
import { colorFromName } from './colors';
import { setupTouchControls } from './controls';
import { setupCanvas } from './canvas';
import {
  setRosterCount, setKills, showGame, uiHandles, pushChatLog, showBanner, updateRanking,
} from './ui';
import { TILE, makeCamera, triggerShake, updateCamera } from './world';
import { randomCharColor, randomCharIdx, prescaleCharacter, CHAR_H } from './sprites';
import {
  ATTACK_SWING_DUR, BODY_HH, BODY_HW, BODY_OFF_Y,
  makeLocalPlayer, MAX_HP, onAttackBroadcast, startDance, updateLocalPlayer, clampToWorld,
  type UpdateCtx,
} from './player';
import { attackPhaseFor, renderFrame, type RenderableRemote } from './render';
import { setBubble, syncBubbles } from './bubbles';
import { spawnHitBurst, updateAndRenderParticles } from './particles';
import { loadMap, type TileMap } from './map';
import { setupDebugPanel, updateDebugInfo, type DebugState } from './debug';
import {
  addBullet,
  BULLET_DAMAGE,
  findPickup,
  GUN_HOLD_DURATION,
  makeGunState,
  maybeSpawn as maybeSpawnGun,
  stepBullets,
  type GunDrop,
  type GunState,
} from './gun';
import { ensureGunSprite, drawGunOverlay } from './render';
import type {
  AttackPayload, BulletPayload, ChatPayload, DeathPayload, GunDropPayload, GunPickupPayload,
  HpPayload, PosPayload, PresenceMeta, RemotePlayer,
} from './types';

const POS_SEND_INTERVAL = 1 / 10;
const POS_HEARTBEAT = 1.0;

// 백버퍼 논리 해상도 — 디버그 패널 슬라이더로 실시간 조정 가능.
// 디폴트: PC 24 타일 폭, 모바일 세로 10 타일. 캐릭터 prescale 0.75 (살짝 작게).
const DEFAULT_VIEW_TILES_PC = 24;
const TARGET_TILES_WIDE_MOBILE = 10;
const DEFAULT_CHAR_SCALE = 0.75;

let gameStarted = false;

export function startGame(name: string, charIdx?: number): void {
  if (gameStarted) return;
  gameStarted = true;
  void startGameAsync(name, charIdx);
}

async function startGameAsync(name: string, charIdxArg?: number): Promise<void> {
  const ui = uiHandles();
  showGame(ui);

  // ===== 맵 로드 =====
  let map: TileMap;
  try {
    map = await loadMap('/assets/maps/town.json');
  } catch (err) {
    console.error(err);
    alert(`${(err as Error).message}\n\nREADME 의 '맵 만들기' 섹션을 참고하세요.`);
    gameStarted = false;
    return;
  }

  // ===== 로컬 플레이어 =====
  const id = crypto.randomUUID();
  const color = randomCharColor();
  const charIdx = charIdxArg ?? randomCharIdx();
  const spawn = map.spawns.length > 0
    ? map.spawns[Math.floor(Math.random() * map.spawns.length)]
    : { x: map.pixelW / 2, y: map.pixelH / 2 };
  const local = makeLocalPlayer(id, name, color, charIdx, spawn);

  // ===== 캐릭터 LPC prescale =====
  prescaleCharacter(DEFAULT_CHAR_SCALE);

  // ===== 디버그 상태 (DOM 패널은 canvasCtrl 정의된 이후에 띄움) =====
  const debug: DebugState = {
    visible: false,
    showCollision: false,
    showGrid: false,
    showHitbox: false,
    charScale: DEFAULT_CHAR_SCALE,
    viewTilesWide: DEFAULT_VIEW_TILES_PC,
  };

  // ===== 카메라 + 캔버스 =====
  const camera = makeCamera(320, 240);
  // 시작 시 캐릭터 위치로 초기화 (안 그러면 첫 프레임에 화면 한쪽 끝에서 보간 시작)
  camera.smoothX = local.x - camera.viewW / 2;
  camera.smoothY = local.y - camera.viewH / 2;
  camera.x = camera.smoothX;
  camera.y = camera.smoothY;
  const canvas = ui.canvas;
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.imageSmoothingEnabled = false;

  // HUD 오버레이 — 이름/HP 등 크리스프 텍스트 전용. game 캔버스와 같은 표시 영역, full DPR.
  const hudCanvas = ui.hudCanvas;
  const hudCtx = hudCanvas.getContext('2d')!;
  let displayScale = 1;  // 백버퍼 1px 당 CSS px — canvas.ts 의 onSized 콜백으로 갱신.

  // 캔버스 리사이즈 + 사용자 줌 (PC 휠 / 모바일 핀치 / iOS gesture) 은 canvas.ts 에 일임.
  const canvasCtrl = setupCanvas({
    canvas,
    hudCanvas,
    getViewTiles: () => debug.viewTilesWide,
    setViewTiles: (n) => { debug.viewTilesWide = n; },
    mobileTilesWide: TARGET_TILES_WIDE_MOBILE,
    zoomMin: 14,
    zoomMax: 40,
    onSized: (w, h, scale) => { camera.viewW = w; camera.viewH = h; displayScale = scale; },
  });

  // 디버그 패널 — 슬라이더에서 viewTilesWide 변경 시 canvasCtrl 가 처리.
  setupDebugPanel(
    debug,
    (newScale) => prescaleCharacter(newScale),
    (newTiles) => canvasCtrl.setZoom(newTiles),
  );

  // 네트워크 핸들 (forward — closure 캡처용)
  let net!: Net;

  // ===== 채팅 broadcast — 멘탈 공격(욕) 자동 송신 전용 =====
  // 직접 타이핑 UI 는 제거됨. 로컬에서 fireMentalAttack 이 텍스트를 만들어
  // local.chatText 에 박고 sendChat 으로 다른 플레이어에게 broadcast.
  const localChatColor = colorFromName(name);
  const broadcastLocalChat = (text: string) => {
    pushChatLog(ui, local.name, text, localChatColor);
    net.sendChat({ id: local.id, text });
  };

  // ===== 입력 =====
  setupInput({ isChatActive: () => false });
  setupTouchControls();

  // ===== 원격 플레이어 맵 =====
  const remotes = new Map<string, RemotePlayer>();

  const upsertRemote = (m: PresenceMeta) => {
    if (m.id === local.id) return;
    let r = remotes.get(m.id);
    if (!r) {
      r = {
        id: m.id, name: m.name, color: m.color, charIdx: m.charIdx,
        x: local.x, y: local.y, renderX: local.x, renderY: local.y,
        dir: 'down', moving: false,
        hp: MAX_HP, maxHp: MAX_HP,
        chatText: '', chatUntil: 0,
        hitFlashUntil: 0,
        dead: false, deadUntil: 0,
        lastSeen: nowSec(),
        kills: 0,
        deaths: 0,
        attackUntil: 0,
        danceUntil: 0, danceStart: 0,
        gunUntil: 0,
      };
      remotes.set(m.id, r);
    } else {
      r.name = m.name;
      r.color = m.color;
      r.charIdx = m.charIdx;
    }
    setRosterCount(ui, remotes.size + 1);
    refreshRanking();
  };

  const refreshRanking = () => updateRanking(ui, local, remotes.values());

  // ===== 총(AK) =====
  const gunState: GunState = makeGunState(nowSec());
  void ensureGunSprite();
  // 호스트 판정: presence 멤버 중 id 가 사전순으로 가장 작은 클라이언트가 호스트.
  // 호스트만 새 드랍 spawn 을 결정하고 broadcast.
  const isLocalHost = (): boolean => {
    let minId = local.id;
    for (const id of remotes.keys()) if (id < minId) minId = id;
    return local.id === minId;
  };
  const applyGunDrop = (p: GunDropPayload, spawnedAt: number) => {
    gunState.drops.set(p.id, { id: p.id, x: p.x, y: p.y, spawnedAt });
    // 화면 중앙 배너 + 좌상단 채팅 로그에 알림
    showBanner(ui, 'kill', '🔫 총이 떨어졌습니다', '맵에서 찾아 주워봐');
    pushChatLog(ui, '📦 시스템', '맵 어딘가에 총이 떨어졌습니다', '#ffd84a');
  };
  const applyGunPickup = (p: GunPickupPayload) => {
    gunState.drops.delete(p.id);
    const now = nowSec();
    if (p.by === local.id) {
      local.gunUntil = now + GUN_HOLD_DURATION;
    } else {
      const r = remotes.get(p.by);
      if (r) r.gunUntil = now + GUN_HOLD_DURATION;
    }
  };
  const applyBullet = (p: BulletPayload) => {
    addBullet(gunState, p.bid, p.ownerId, p.ownerName, p.x, p.y, p.vx, p.vy, nowSec());
  };

  const updateCtx = (): UpdateCtx => ({
    dt: 0, now: nowSec(), map, chatActive: false,
    sendAttack: (p) => {
      net.sendAttack(p);
      // 보스 명중 체크 — boss 가 null 이면 그냥 noop.
      boss?.tryHitFromLocal(p.x, p.y, p.dir, nowSec());
    },
    sendPos: (p) => net.sendPos(p),
    sendHp: (hp) => net.sendHp({ id: local.id, hp }),
    sendDeath: (killerId) => net.sendDeath({ id: local.id, killerId }),
    fireBullet: (x, y, vx, vy) => {
      const now = nowSec();
      const bid = crypto.randomUUID();
      // 로컬에 즉시 추가하고 broadcast
      addBullet(gunState, bid, local.id, local.name, x, y, vx, vy, now);
      net.sendBullet({ bid, ownerId: local.id, ownerName: local.name, x, y, vx, vy });
    },
  });

  // ===== 네트워크 =====
  const meta: PresenceMeta = { id: local.id, name, color, charIdx };
  net = connect(meta, {
    onPos: (p: PosPayload) => {
      const r = remotes.get(p.id);
      if (!r) return;
      r.x = p.x; r.y = p.y;
      r.dir = p.dir;
      r.moving = p.moving;
      r.lastSeen = nowSec();
    },
    onChat: (c: ChatPayload) => {
      const r = remotes.get(c.id);
      if (!r) return;
      r.chatText = c.text;
      r.chatUntil = nowSec() + 4;
      pushChatLog(ui, r.name, c.text, colorFromName(r.name));
    },
    onAttack: (a: AttackPayload) => {
      const r = remotes.get(a.id);
      if (r) {
        r.attackUntil = nowSec() + ATTACK_SWING_DUR;
        r.dir = a.dir;
      }
      const wasAlive = !local.dead;
      onAttackBroadcast(local, a, updateCtx());
      if (wasAlive && local.dead) {
        const killer = remotes.get(a.id);
        const killerName = killer ? killer.name : '???';
        showBanner(ui, 'death', '쓰러졌다…', `${killerName}에게 당함`);
        refreshRanking();
      }
    },
    onHp: (h: HpPayload) => {
      const r = remotes.get(h.id);
      if (!r) return;
      if (h.hp < r.hp) {
        r.hitFlashUntil = nowSec() + 0.2;
        spawnHitBurst(r.renderX, r.renderY + BODY_OFF_Y, nowSec());
      }
      r.hp = h.hp;
      if (r.dead && h.hp > 0) r.dead = false;
    },
    onGunDrop: (p: GunDropPayload) => applyGunDrop(p, nowSec()),
    onGunPickup: (p: GunPickupPayload) => applyGunPickup(p),
    onBullet: (p: BulletPayload) => applyBullet(p),
    onDeath: (d: DeathPayload) => {
      const now = nowSec();
      const r = remotes.get(d.id);
      const victimName = r ? r.name : (d.id === local.id ? local.name : '???');
      if (r) {
        r.dead = true;
        r.hp = 0;
        r.deadUntil = now + 3;
        r.deaths += 1;
        r.gunUntil = 0;
      }
      if (d.killerId) {
        if (d.killerId === local.id) {
          local.kills += 1;
          setKills(ui, local.kills);
          startDance(local, now);
          showBanner(ui, 'kill', 'K.O.!', `${victimName} 처치`);
        } else {
          const killer = remotes.get(d.killerId);
          if (killer) {
            killer.kills += 1;
            startDance(killer, now);
          }
        }
      }
      refreshRanking();
    },
    onPresenceSync: (members) => {
      const ids = new Set(members.map((m) => m.id));
      for (const id of Array.from(remotes.keys())) {
        if (!ids.has(id)) remotes.delete(id);
      }
      for (const m of members) upsertRemote(m);
      setRosterCount(ui, remotes.size + 1);
    },
    onPresenceJoin: (members) => {
      for (const m of members) upsertRemote(m);
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: local.moving });
      net.sendHp({ id: local.id, hp: local.hp });
    },
    onPresenceLeave: (members) => {
      for (const m of members) remotes.delete(m.id);
      setRosterCount(ui, remotes.size + 1);
      refreshRanking();
    },
    onSubscribed: () => {
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: false });
      net.sendHp({ id: local.id, hp: local.hp });
      refreshRanking();
    },
  });

  window.addEventListener('beforeunload', () => {
    void net.unsubscribe();
  });

  // ===== 엄마 보스 (BOSS_ENABLED 가 false 면 boss === null 이라 어떤 보스 로직도 실행 안 됨) =====
  const boss: BossSystem | null = BOSS_ENABLED
    ? spawnBoss(map, nowSec(), {
        sendHp: (hp) => net.sendHp({ id: local.id, hp }),
        sendDeath: (killerId) => net.sendDeath({ id: local.id, killerId }),
      })
    : null;

  // ===== 미니맵 =====
  const minimapCtx = ui.minimap.getContext('2d')!;
  minimapCtx.imageSmoothingEnabled = false;
  let minimapAccum = 0;
  function drawMinimap(): void {
    const mw = ui.minimap.width;
    const mh = ui.minimap.height;
    const sx = mw / map.pixelW;
    const sy = mh / map.pixelH;
    minimapCtx.clearRect(0, 0, mw, mh);
    // 배경
    minimapCtx.fillStyle = 'rgba(40, 60, 30, 0.55)';
    minimapCtx.fillRect(0, 0, mw, mh);
    // 충돌 영역(나무 등) — 옅은 갈색 점
    minimapCtx.fillStyle = 'rgba(120, 80, 40, 0.85)';
    for (const r of map.collisionRects) {
      const x = (r.x0 * sx) | 0;
      const y = (r.y0 * sy) | 0;
      const w = Math.max(1, ((r.x1 - r.x0) * sx) | 0);
      const h = Math.max(1, ((r.y1 - r.y0) * sy) | 0);
      minimapCtx.fillRect(x, y, w, h);
    }
    // 원격 플레이어 — 흰 점
    minimapCtx.fillStyle = '#fff';
    for (const r of remotes.values()) {
      if (r.dead) continue;
      const x = (r.renderX * sx - 1) | 0;
      const y = (r.renderY * sy - 1) | 0;
      minimapCtx.fillRect(x, y, 3, 3);
    }
    // 로컬 — 노란 점 (강조)
    if (!local.dead) {
      const x = (local.x * sx - 2) | 0;
      const y = (local.y * sy - 2) | 0;
      minimapCtx.fillStyle = '#1a0e08';
      minimapCtx.fillRect(x, y, 5, 5);
      minimapCtx.fillStyle = '#ffd84a';
      minimapCtx.fillRect(x + 1, y + 1, 3, 3);
    }
  }

  // ===== 멘탈 공격(욕 자동 채팅) — 짧은 쿨다운으로 연타 가능 =====
  const MENTAL_COOLDOWN = 0.4;
  let mentalCooldownUntil = 0;
  function fireMentalAttack(now: number): void {
    if (local.dead) return;
    if (now < mentalCooldownUntil) return;
    mentalCooldownUntil = now + MENTAL_COOLDOWN;
    const text = pickInsult();
    local.chatText = text;
    local.chatUntil = now + 4;
    broadcastLocalChat(text);
  }

  // ===== 루프 =====
  let lastT = performance.now();
  let posTimer = 0;
  let lastPosMoving = false;
  let heartbeatTimer = 0;

  function loop(t: number): void {
    const realDt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    const now = nowSec();

    // 피격 정지(hit pause) — local.hitPauseUntil 까지 dt 0 으로 (애니메이션 멈춤)
    const dt = now < local.hitPauseUntil ? 0 : realDt;

    // 흔들림 신호 소비
    if (local.shakePending > 0) {
      triggerShake(camera, local.shakePending);
      local.shakePending = 0;
    }

    const ctx = updateCtx();
    ctx.dt = dt;
    updateLocalPlayer(local, ctx);
    clampToWorld(local, map);

    // 보스 — 슬리퍼/AOE 진행 + 로컬에 데미지 적용 (BOSS_ENABLED off 면 boss === null 이라 자동 스킵)
    boss?.update(dt, now, local);

    // 멘탈 공격(욕 채팅) — X 키 또는 멘탈공격 버튼.
    if (consumeMentalAttack()) fireMentalAttack(now);

    // ===== 총(AK) — 스폰/픽업/총알 진행/자기 피격 체크 =====
    // 호스트 클라이언트만 새 드랍 결정 + broadcast (중복 방지)
    maybeSpawnGun(gunState, now, map, isLocalHost(), (drop: GunDrop) => {
      applyGunDrop({ id: drop.id, x: drop.x, y: drop.y }, drop.spawnedAt);
      net.sendGunDrop({ id: drop.id, x: drop.x, y: drop.y });
    });
    // 로컬 발 좌표가 드랍 반경 안이면 픽업
    if (!local.dead) {
      const got = findPickup(gunState, local.x, local.y);
      if (got) {
        gunState.drops.delete(got.id);
        local.gunUntil = now + GUN_HOLD_DURATION;
        net.sendGunPickup({ id: got.id, by: local.id });
      }
    }
    // 총알 위치 갱신 + 만료/벽 충돌 시 제거
    stepBullets(gunState, dt, now, map);
    // 자기 몸통(BODY AABB) 에 들어온 총알(자기 자신이 쏜 것 제외) 처리
    if (!local.dead && now >= local.iFrameUntil) {
      const me = { x0: local.x - BODY_HW, x1: local.x + BODY_HW, y0: local.y + BODY_OFF_Y - BODY_HH, y1: local.y + BODY_OFF_Y + BODY_HH };
      for (const b of gunState.bullets) {
        if (b.ownerId === local.id) continue;
        if (b.hitIds.has(local.id)) continue;
        if (b.x < me.x0 || b.x > me.x1 || b.y < me.y0 || b.y > me.y1) continue;
        b.hitIds.add(local.id);
        local.hp = Math.max(0, local.hp - BULLET_DAMAGE);
        local.iFrameUntil = now + 0.15;
        local.hitFlashUntil = now + 0.2;
        spawnHitBurst(local.x, local.y + BODY_OFF_Y, now);
        net.sendHp({ id: local.id, hp: local.hp });
        if (local.hp <= 0) {
          local.dead = true;
          local.gunUntil = 0;
          local.deadUntil = now + 4;
          local.deaths += 1;
          net.sendDeath({ id: local.id, killerId: b.ownerId });
          const killer = remotes.get(b.ownerId);
          const killerName = killer ? killer.name : (b.ownerId === local.id ? local.name : b.ownerName);
          showBanner(ui, 'death', '쓰러졌다…', `${killerName}에게 사살`);
          refreshRanking();
        }
        break;
      }
    }

    const k = 1 - Math.exp(-dt / 0.08);
    for (const r of remotes.values()) {
      r.renderX += (r.x - r.renderX) * k;
      r.renderY += (r.y - r.renderY) * k;
      if (r.dead && now > r.deadUntil + 0.5 && r.hp > 0) {
        r.dead = false;
      }
    }

    posTimer += dt;
    heartbeatTimer += dt;
    const movingNow = local.moving && !local.dead;
    const movingChanged = movingNow !== lastPosMoving;
    if (movingNow && posTimer >= POS_SEND_INTERVAL) {
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: true });
      posTimer = 0;
      heartbeatTimer = 0;
    } else if (movingChanged) {
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: movingNow });
      posTimer = 0;
      heartbeatTimer = 0;
    } else if (heartbeatTimer >= POS_HEARTBEAT) {
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: movingNow });
      heartbeatTimer = 0;
    }
    lastPosMoving = movingNow;

    // 카메라는 실제 dt 로 항상 갱신 (정지 중에도 흔들림 진행).
    // 키보드가 화면 하단을 가리는 케이스는 더 이상 발생 안 함 (채팅 입력 UI 제거).
    // 단순히 화면 정중앙에 캐릭터.
    updateCamera(camera, local.x, local.y, map.pixelW, map.pixelH, realDt, 0.5);
    updateDebugInfo(debug, local.x, local.y, TILE);

    const renderables: RenderableRemote[] = [];
    for (const r of remotes.values()) {
      renderables.push({
        id: r.id,
        name: r.name,
        color: r.color,
        charIdx: r.charIdx,
        x: r.renderX,
        y: r.renderY,
        dir: r.dir,
        moving: r.moving,
        attackPhase: attackPhaseFor(r.attackUntil, now),
        hitFlash: now < r.hitFlashUntil,
        hp: r.hp,
        maxHp: r.maxHp,
        chatText: r.chatText,
        chatShow: r.chatUntil > now,
        dead: r.dead,
        kills: r.kills,
        dancing: now < r.danceUntil,
        danceStart: r.danceStart,
      });
    }

    // 그리기 — 백버퍼 클리어 후 새 파이프라인.
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    renderFrame(ctx2d, map, camera, local, renderables, now, debug, { ctx: hudCtx, displayScale });

    // 총(AK) — 드랍 + 보유 중 캐릭터 옆 + 총알
    const heldOwners: { x: number; y: number; dir: 'up'|'down'|'left'|'right' }[] = [];
    if (now < local.gunUntil && !local.dead) heldOwners.push({ x: local.x, y: local.y, dir: local.dir });
    for (const r of remotes.values()) {
      if (now < r.gunUntil && !r.dead) heldOwners.push({ x: r.renderX, y: r.renderY, dir: r.dir });
    }
    drawGunOverlay(ctx2d, camera, gunState.drops.values(), gunState.bullets, heldOwners, now);

    updateAndRenderParticles(ctx2d, camera.x, camera.y, realDt, now);

    // 보스 — 게임 캔버스 위에 스프라이트/슬리퍼/AOE, HUD 캔버스 상단에 HP 바 그림.
    boss?.draw(ctx2d, hudCtx, camera, displayScale, now);

    // ===== 말풍선 (DOM 오버레이) =====
    // 좌표 변환: 백버퍼(논리) px → CSS px (정수배 scale)
    const scaleX = canvas.clientWidth / canvas.width;
    const scaleY = canvas.clientHeight / canvas.height;
    // 머리 위 오프셋 — 캐릭터 prescale 따라 동적 (CHAR_H 는 live binding)
    const HEAD_NORMAL = CHAR_H + 6;
    const HEAD_DANCE = 76;
    const visibleBubbles = new Set<string>();
    if (local.chatUntil > now && local.chatText) {
      const off = now < local.danceUntil ? HEAD_DANCE : HEAD_NORMAL;
      const sx = (local.x - camera.x) * scaleX;
      const sy = (local.y - off - camera.y) * scaleY;
      setBubble(local.id, local.chatText, sx, sy);
      visibleBubbles.add(local.id);
    }
    for (const r of remotes.values()) {
      if (r.chatUntil > now && r.chatText) {
        const off = now < r.danceUntil ? HEAD_DANCE : HEAD_NORMAL;
        const sx = (r.renderX - camera.x) * scaleX;
        const sy = (r.renderY - off - camera.y) * scaleY;
        setBubble(r.id, r.chatText, sx, sy);
        visibleBubbles.add(r.id);
      }
    }
    syncBubbles(visibleBubbles);

    // 미니맵 ~10Hz 갱신 — 매 프레임은 과한 부하.
    minimapAccum += realDt;
    if (minimapAccum >= 0.1) {
      minimapAccum = 0;
      drawMinimap();
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function nowSec(): number {
  return performance.now() / 1000;
}
