// 게임 부트 + 메인 루프 + 네트워크/입력/렌더 통합.
// 맵은 Tiled JSON 을 로드해서 가져온다. 캔버스는 저해상도 백버퍼 + 정수배 업스케일.

import { connect, type Net } from './net';
import { setupInput } from './input';
import { setupTouchControls, isTouchDevice } from './controls';
import {
  setupChat, setRosterCount, setKills, showGame, uiHandles, type ChatBinding,
} from './ui';
import { TILE, makeCamera, triggerShake, updateCamera } from './world';
import { randomCharColor, prescaleCharacter, CHAR_H } from './sprites';
import {
  ATTACK_SWING_DUR,
  makeLocalPlayer, MAX_HP, onAttackBroadcast, startDance, updateLocalPlayer, clampToWorld,
  type UpdateCtx,
} from './player';
import { attackPhaseFor, renderFrame, type RenderableRemote } from './render';
import { setBubble, syncBubbles } from './bubbles';
import { loadMap, type TileMap } from './map';
import { setupDebugPanel, updateDebugInfo, type DebugState } from './debug';
import type {
  AttackPayload, ChatPayload, DeathPayload, HpPayload, PosPayload, PresenceMeta, RemotePlayer,
} from './types';

const POS_SEND_INTERVAL = 1 / 10;
const POS_HEARTBEAT = 1.0;

// 백버퍼 논리 해상도 — 디버그 패널 슬라이더로 실시간 조정 가능.
// 디폴트: PC 24 타일 폭, 모바일 세로 14 타일. 캐릭터 prescale 0.75 (살짝 작게).
const DEFAULT_VIEW_TILES_PC = 24;
const TARGET_TILES_WIDE_MOBILE = 14;
const DEFAULT_CHAR_SCALE = 0.75;

let gameStarted = false;

export function startGame(name: string): void {
  if (gameStarted) return;
  gameStarted = true;
  void startGameAsync(name);
}

async function startGameAsync(name: string): Promise<void> {
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
  const spawn = map.spawns.length > 0
    ? map.spawns[Math.floor(Math.random() * map.spawns.length)]
    : { x: map.pixelW / 2, y: map.pixelH / 2 };
  const local = makeLocalPlayer(id, name, color, spawn);

  // ===== 캐릭터 LPC prescale =====
  prescaleCharacter(DEFAULT_CHAR_SCALE);

  // ===== 디버그 상태 =====
  const debug: DebugState = {
    visible: false,
    showCollision: false,
    showGrid: false,
    showHitbox: false,
    charScale: DEFAULT_CHAR_SCALE,
    viewTilesWide: DEFAULT_VIEW_TILES_PC,
  };
  setupDebugPanel(
    debug,
    (newScale) => prescaleCharacter(newScale),
    () => resizeCanvas(),
  );

  // ===== 카메라 + 캔버스 =====
  const camera = makeCamera(320, 240);
  // 시작 시 캐릭터 위치로 초기화 (안 그러면 첫 프레임에 화면 한쪽 끝에서 보간 시작)
  camera.smoothX = local.x - camera.viewW / 2;
  camera.smoothY = local.y - camera.viewH / 2;
  camera.x = camera.smoothX;
  camera.y = camera.smoothY;
  const viewport = document.getElementById('viewport') as HTMLElement | null;
  const canvas = ui.canvas;
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.imageSmoothingEnabled = false;

  // 백버퍼는 가변 해상도, CSS 는 viewport 100% — 화면 꽉 차게.
  // image-rendering: pixelated 가 fractional 스케일도 또렷하게 처리.
  const resizeCanvas = () => {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const wantTiles = (isTouchDevice() && cssW < cssH) ? TARGET_TILES_WIDE_MOBILE : debug.viewTilesWide;
    const targetLogicalW = wantTiles * TILE;

    // 보일 가로 타일 수 ⇒ 스케일 ⇒ 논리 해상도. logicalH 는 화면 비율 따라감.
    const scale = Math.max(1, cssW / targetLogicalW);
    const logicalW = Math.round(cssW / scale);
    const logicalH = Math.round(cssH / scale);

    canvas.width  = logicalW;
    canvas.height = logicalH;
    if (viewport) {
      viewport.style.width  = `${cssW}px`;
      viewport.style.height = `${cssH}px`;
    }
    canvas.style.width  = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    camera.viewW = logicalW;
    camera.viewH = logicalH;
    ctx2d.imageSmoothingEnabled = false;
  };
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);

  // ===== 네트워크 핸들 (closure 캡처용 forward 선언) =====
  let net!: Net;

  // ===== 채팅 =====
  const chat: ChatBinding = setupChat(ui, (text) => {
    local.chatText = text;
    local.chatUntil = nowSec() + 4;
    net.sendChat({ id: local.id, text });
  });

  // ===== 입력 =====
  setupInput({ isChatActive: () => chat.isActive() });
  setupTouchControls();

  // 게임 화면(캔버스) 탭 → 채팅 입력 포커스 해제 → 모바일 키보드 닫힘
  // (단, 채팅바 위 탭은 별도 — 카톡식 UX)
  const closeKeyboardOnTap = (e: Event) => {
    const target = e.target as HTMLElement | null;
    // 채팅바/입력칸/전송 버튼 위에서 탭한 경우는 통과
    if (target && (target.closest('#chat-bar') || target.closest('#btn-bgm'))) return;
    if (document.activeElement === ui.chatInput) ui.chatInput.blur();
  };
  canvas.addEventListener('pointerdown', closeKeyboardOnTap);

  // ===== 사용자 줌 컨트롤 (PC 휠 + 모바일 핀치) =====
  const ZOOM_MIN = 14, ZOOM_MAX = 40;
  const setZoom = (n: number): void => {
    n = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(n)));
    if (n === debug.viewTilesWide) return;
    debug.viewTilesWide = n;
    resizeCanvas();
    // 디버그 패널 슬라이더 DOM 동기화
    const slider = document.getElementById('dbg-view') as HTMLInputElement | null;
    const valEl  = document.getElementById('dbg-view-val');
    if (slider) slider.value = String(n);
    if (valEl)  valEl.textContent = String(n);
  };

  // PC: 마우스 휠
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.deltaY > 0 ? 1 : -1; // 휠 아래 = 줌 아웃 (더 많은 타일)
    setZoom(debug.viewTilesWide + step);
  }, { passive: false });

  // 모바일: 두 손가락 핀치 (document 레벨에서 듣고 UI 버튼 위 터치만 제외)
  let pinchStartDist = 0;
  let pinchStartView = 0;
  let pinchActive = false;

  // 가상 조이스틱/공격/채팅 버튼 위에서 시작된 터치는 제외 (그것들은 자기 핸들러가 처리).
  const isOnGameUi = (t: Touch): boolean => {
    const target = t.target as HTMLElement | null;
    if (!target) return false;
    return !!(
      target.closest('#stick') ||
      target.closest('#btn-attack') ||
      target.closest('#btn-chat') ||
      target.closest('#chat-bar') ||
      target.closest('#debug-panel')
    );
  };
  const gameTouches = (e: TouchEvent): Touch[] => {
    const out: Touch[] = [];
    for (const t of Array.from(e.touches)) {
      if (!isOnGameUi(t)) out.push(t);
    }
    return out;
  };
  const dist2 = (a: Touch, b: Touch) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  document.addEventListener('touchstart', (e) => {
    const ct = gameTouches(e);
    if (ct.length >= 2) {
      pinchStartDist = dist2(ct[0], ct[1]);
      pinchStartView = debug.viewTilesWide;
      pinchActive = true;
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!pinchActive) return;
    const ct = gameTouches(e);
    if (ct.length < 2) { pinchActive = false; return; }
    e.preventDefault();
    const d = dist2(ct[0], ct[1]);
    if (d > 0 && pinchStartDist > 0) {
      // 손가락 멀어지면 줌 인 (타일 수 감소), 가까워지면 줌 아웃.
      const ratio = pinchStartDist / d;
      setZoom(pinchStartView * ratio);
    }
  }, { passive: false });

  const endPinch = () => { pinchActive = false; };
  document.addEventListener('touchend', endPinch);
  document.addEventListener('touchcancel', endPinch);

  // iOS Safari fallback — multi-touch 를 native gesture 이벤트로 가로챔.
  // standard touch event 가 multi-touch 에서 안정적이지 않을 때 이게 작동.
  type GestureEvent = Event & { scale: number; clientX?: number; clientY?: number };
  let gestureStartView = 0;
  document.addEventListener('gesturestart', (e) => {
    const ge = e as GestureEvent;
    ge.preventDefault?.();
    gestureStartView = debug.viewTilesWide;
  }, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gesturechange', (e) => {
    const ge = e as GestureEvent;
    ge.preventDefault?.();
    // scale: 1 = 시작, >1 = 벌리는 중(줌인), <1 = 오므리는 중(줌아웃)
    if (ge.scale && ge.scale > 0) {
      setZoom(gestureStartView / ge.scale);
    }
  }, { passive: false } as AddEventListenerOptions);
  document.addEventListener('gestureend', (e) => {
    const ge = e as GestureEvent;
    ge.preventDefault?.();
  }, { passive: false } as AddEventListenerOptions);

  // ===== 원격 플레이어 맵 =====
  const remotes = new Map<string, RemotePlayer>();

  const upsertRemote = (m: PresenceMeta) => {
    if (m.id === local.id) return;
    let r = remotes.get(m.id);
    if (!r) {
      r = {
        id: m.id, name: m.name, color: m.color,
        x: local.x, y: local.y, renderX: local.x, renderY: local.y,
        dir: 'down', moving: false,
        hp: MAX_HP, maxHp: MAX_HP,
        chatText: '', chatUntil: 0,
        hitFlashUntil: 0,
        dead: false, deadUntil: 0,
        lastSeen: nowSec(),
        kills: 0,
        attackUntil: 0,
        danceUntil: 0, danceStart: 0,
      };
      remotes.set(m.id, r);
    } else {
      r.name = m.name;
      r.color = m.color;
    }
    setRosterCount(ui, remotes.size + 1);
  };

  const updateCtx = (): UpdateCtx => ({
    dt: 0, now: nowSec(), map, chatActive: chat.isActive(),
    sendAttack: (p) => net.sendAttack(p),
    sendPos: (p) => net.sendPos(p),
    sendHp: (hp) => net.sendHp({ id: local.id, hp }),
    sendDeath: (killerId) => net.sendDeath({ id: local.id, killerId }),
  });

  // ===== 네트워크 =====
  const meta: PresenceMeta = { id: local.id, name, color };
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
    },
    onAttack: (a: AttackPayload) => {
      const r = remotes.get(a.id);
      if (r) {
        r.attackUntil = nowSec() + ATTACK_SWING_DUR;
        r.dir = a.dir;
      }
      onAttackBroadcast(local, a, updateCtx());
    },
    onHp: (h: HpPayload) => {
      const r = remotes.get(h.id);
      if (!r) return;
      if (h.hp < r.hp) r.hitFlashUntil = nowSec() + 0.2;
      r.hp = h.hp;
      if (r.dead && h.hp > 0) r.dead = false;
    },
    onDeath: (d: DeathPayload) => {
      const now = nowSec();
      const r = remotes.get(d.id);
      if (r) {
        r.dead = true;
        r.hp = 0;
        r.deadUntil = now + 3;
      }
      if (d.killerId) {
        if (d.killerId === local.id) {
          local.kills += 1;
          setKills(ui, local.kills);
          startDance(local, now);
        } else {
          const killer = remotes.get(d.killerId);
          if (killer) {
            killer.kills += 1;
            startDance(killer, now);
          }
        }
      }
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
    },
    onSubscribed: () => {
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: false });
      net.sendHp({ id: local.id, hp: local.hp });
    },
  });

  window.addEventListener('beforeunload', () => {
    void net.unsubscribe();
  });

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

    // 카메라는 실제 dt 로 항상 갱신 (정지 중에도 흔들림 진행)
    updateCamera(camera, local.x, local.y, map.pixelW, map.pixelH, realDt);
    updateDebugInfo(debug, local.x, local.y, TILE);

    const renderables: RenderableRemote[] = [];
    for (const r of remotes.values()) {
      renderables.push({
        id: r.id,
        name: r.name,
        color: r.color,
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

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function nowSec(): number {
  return performance.now() / 1000;
}
