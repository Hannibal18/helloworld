// 게임 부트 + 메인 루프 + 네트워크/입력/렌더 통합.
// 맵은 Tiled JSON 을 로드해서 가져온다. 캔버스는 저해상도 백버퍼 + 정수배 업스케일.

import { connect, type Net } from './net';
import { setupInput, consumeMentalAttack } from './input';
import { pickInsult } from './insults';
import { playEnterVoice } from './audio';
import { colorFromName } from './colors';
import { setupTouchControls } from './controls';
import { setupCanvas } from './canvas';
import {
  setupChat, setRosterCount, setKills, showGame, uiHandles, pushChatLog, showBanner, updateRanking, type ChatBinding,
} from './ui';
import { TILE, makeCamera, triggerShake, updateCamera } from './world';
import { getViewport } from './viewport';
import { randomCharColor, randomCharIdx, prescaleCharacter, CHAR_H } from './sprites';
import {
  ATTACK_SWING_DUR, BODY_OFF_Y,
  makeLocalPlayer, MAX_HP, onAttackBroadcast, startDance, updateLocalPlayer, clampToWorld,
  type UpdateCtx,
} from './player';
import { attackPhaseFor, renderFrame, type RenderableRemote } from './render';
import { setBubble, syncBubbles } from './bubbles';
import { spawnHitBurst, updateAndRenderParticles } from './particles';
import { loadMap, type TileMap } from './map';
import { setupDebugPanel, updateDebugInfo, type DebugState } from './debug';
import type {
  AttackPayload, ChatPayload, DeathPayload, HpPayload, PosPayload, PresenceMeta, RemotePlayer,
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

  // 입장 후 1초 뒤 전투장 진입 보이스 1회 재생.
  window.setTimeout(playEnterVoice, 1000);

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

  // 캔버스 리사이즈 + 사용자 줌 (PC 휠 / 모바일 핀치 / iOS gesture) 은 canvas.ts 에 일임.
  const canvasCtrl = setupCanvas({
    canvas,
    getViewTiles: () => debug.viewTilesWide,
    setViewTiles: (n) => { debug.viewTilesWide = n; },
    mobileTilesWide: TARGET_TILES_WIDE_MOBILE,
    zoomMin: 14,
    zoomMax: 40,
    onSized: (w, h) => { camera.viewW = w; camera.viewH = h; },
  });

  // 디버그 패널 — 슬라이더에서 viewTilesWide 변경 시 canvasCtrl 가 처리.
  setupDebugPanel(
    debug,
    (newScale) => prescaleCharacter(newScale),
    (newTiles) => canvasCtrl.setZoom(newTiles),
  );

  // 네트워크 핸들 (forward — closure 캡처용)
  let net!: Net;

  // ===== 채팅 =====
  const localChatColor = colorFromName(name);
  const chat: ChatBinding = setupChat(ui, (text) => {
    local.chatText = text;
    local.chatUntil = nowSec() + 4;
    pushChatLog(ui, local.name, text, localChatColor);
    net.sendChat({ id: local.id, text });
  });

  // ===== 입력 =====
  setupInput({ isChatActive: () => chat.isActive() });
  setupTouchControls();

  // 게임 화면(캔버스) 탭 → 채팅 입력 포커스 해제 → 모바일 키보드 닫힘
  canvas.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.closest('#chat-bar') || target.closest('#btn-bgm'))) return;
    if (document.activeElement === ui.chatInput) ui.chatInput.blur();
  });

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

  const updateCtx = (): UpdateCtx => ({
    dt: 0, now: nowSec(), map, chatActive: chat.isActive(),
    sendAttack: (p) => net.sendAttack(p),
    sendPos: (p) => net.sendPos(p),
    sendHp: (hp) => net.sendHp({ id: local.id, hp }),
    sendDeath: (killerId) => net.sendDeath({ id: local.id, killerId }),
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
    onDeath: (d: DeathPayload) => {
      const now = nowSec();
      const r = remotes.get(d.id);
      const victimName = r ? r.name : (d.id === local.id ? local.name : '???');
      if (r) {
        r.dead = true;
        r.hp = 0;
        r.deadUntil = now + 3;
        r.deaths += 1;
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
    if (chat.isActive() || local.dead) return;
    if (now < mentalCooldownUntil) return;
    mentalCooldownUntil = now + MENTAL_COOLDOWN;
    const text = pickInsult();
    local.chatText = text;
    local.chatUntil = now + 4;
    pushChatLog(ui, local.name, text, localChatColor);
    net.sendChat({ id: local.id, text });
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

    // 멘탈 공격(욕 채팅) — X 키 또는 멘탈공격 버튼.
    if (consumeMentalAttack()) fireMentalAttack(now);

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
    // 키보드/채팅바가 화면 하단을 가리면, "보이는 영역의 정중앙"에 캐릭터가 오도록
    // centerY 를 동적으로 줄임. 가시 비율 = 1 - bottomOffset/cssHeight (대략).
    const vp = getViewport();
    const cssH = canvas.clientHeight || vp.height || window.innerHeight || 1;
    const hiddenRatio = Math.max(0, Math.min(0.6, vp.bottomOffset / cssH));
    // 채팅 활성인데 키보드 감지 못 한 경우 (PC) → 채팅바 높이(~60px)만큼 가려졌다 치고 fallback.
    const fallback = chat.isActive() && hiddenRatio < 0.05 ? Math.min(0.18, 60 / cssH) : 0;
    const effectiveHidden = Math.max(hiddenRatio, fallback);
    const centerY = (1 - effectiveHidden) / 2;  // 가시 영역의 절반
    updateCamera(camera, local.x, local.y, map.pixelW, map.pixelH, realDt, centerY);
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
    renderFrame(ctx2d, map, camera, local, renderables, now, debug);
    updateAndRenderParticles(ctx2d, camera.x, camera.y, realDt, now);

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
