// 경찰과 도둑 — 대기실 게임 루프.
// 기능: 맵 로드 + 로컬/원격 플레이어 이동 동기화 + 채팅 + 파티 모집 (초대/수락/거절/탈퇴).
// 출발 버튼은 아직 술래잡기 로직 미구현 → 배너만 띄움.
//
// 엄마전쟁(src/game.ts)에서 lobby 모드에 필요한 패턴만 발췌. zombie/gun/weapons/boss/score 는 전부 제외.

import { connect, type Net } from '../net';
import { setupInput, input } from '../input';
import { setupTouchControls } from '../controls';
import { setupCanvas } from '../canvas';
import { colorFromName } from '../colors';
import {
  setRosterCount, showGame, uiHandles, pushChatLog, showBanner,
} from '../ui';
import { makeCamera, TILE, triggerShake, updateCamera } from '../world';
import { prescaleCharacter, randomCharColor } from '../sprites';
import {
  BODY_OFF_Y,
  makeLocalPlayer, MAX_HP, updateLocalPlayer, clampToWorld,
  type UpdateCtx,
} from '../player';
import { attackPhaseFor, renderFrame, type RenderableRemote } from '../render';
import { setBubble, syncBubbles } from '../bubbles';
import {
  setupInvitePopup, setupLobbyChat, setupLobbyTitle, setupPartyPanel, setupTapMenu,
  type InvitePopupHandle, type LobbyChatHandle,
  type PartyMemberInfo, type PartyPanelHandle, type TapMenuHandle,
} from '../lobby';
import { loadMap, type TileMap } from '../map';
import type {
  ChatPayload, PartyAcceptPayload, PartyDeclinePayload, PartyInvitePayload,
  PartyLeavePayload, PosPayload, PresenceMeta, RemotePlayer,
} from '../types';

// 술래잡기 — 원격 캐릭터 움직임 정확도가 핵심. 송신율 ↑ + vx/vy 외삽 + 즉시 송신 트리거.
const POS_SEND_INTERVAL = 1 / 20;       // 이동 중 송신 주기 (50ms = 20Hz)
const POS_HEARTBEAT = 1.0;              // 정지 직후 하트비트
const POS_HEARTBEAT_IDLE = 3.0;         // 오래 정지 시 더 느슨하게
const POS_IDLE_GRACE = 3.0;
const REMOTE_SPEED = 120;               // px/sec, player.ts SPEED 와 동일. dir-만 폴백용.

// 대기실은 작은 맵이라 PC 도 살짝 크게 보이게 한다.
const DEFAULT_VIEW_TILES_PC = 24;
const TARGET_TILES_WIDE_MOBILE = 14;
// 1.0 = 원본 LPC 64px 그대로. 도트 또렷.
const DEFAULT_CHAR_SCALE = 1.0;

const PARTY_MAX = 8;

interface CopsStartOpts {
  name: string;
  charIdx: number;
}

let gameStarted = false;

export function startCopsGame(opts: CopsStartOpts): void {
  if (gameStarted) return;
  gameStarted = true;
  void startCopsGameAsync(opts);
}

const nowSec = () => performance.now() / 1000;

async function startCopsGameAsync(opts: CopsStartOpts): Promise<void> {
  const { name, charIdx } = opts;
  const ui = uiHandles();
  showGame(ui);

  // ===== 맵 로드 =====
  let map: TileMap;
  try {
    map = await loadMap('/maps/cops_lobby.json');
  } catch (err) {
    console.error(err);
    alert(`맵 로드 실패: ${(err as Error).message}`);
    gameStarted = false;
    return;
  }

  // ===== 로컬 플레이어 =====
  const id = crypto.randomUUID();
  const color = randomCharColor();
  const spawn = map.spawns.length > 0
    ? map.spawns[Math.floor(Math.random() * map.spawns.length)]
    : { x: map.pixelW / 2, y: map.pixelH / 2 };
  const local = makeLocalPlayer(id, name, color, charIdx, spawn);

  prescaleCharacter(DEFAULT_CHAR_SCALE);

  // ===== 카메라 + 캔버스 =====
  const camera = makeCamera(320, 240);
  camera.smoothX = local.x - camera.viewW / 2;
  camera.smoothY = local.y - camera.viewH / 2;
  camera.x = camera.smoothX;
  camera.y = camera.smoothY;
  const canvas = ui.canvas;
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.imageSmoothingEnabled = false;

  const hudCanvas = ui.hudCanvas;
  const hudCtx = hudCanvas.getContext('2d')!;
  let displayScale = 1;
  let viewTiles = DEFAULT_VIEW_TILES_PC;

  setupCanvas({
    canvas,
    hudCanvas,
    getViewTiles: () => viewTiles,
    setViewTiles: (n) => { viewTiles = n; },
    mobileTilesWide: TARGET_TILES_WIDE_MOBILE,
    zoomMin: 12,
    zoomMax: 28,
    onSized: (w, h, scale) => { camera.viewW = w; camera.viewH = h; displayScale = scale; },
  });

  // ===== 네트워크 (forward 선언 — 핸들러에서 캡처) =====
  let net!: Net;

  // ===== 입력 — 채팅 포커스 중에는 게임 키 차단 =====
  let lobbyChatFocused = false;
  setupInput({ isChatActive: () => lobbyChatFocused });
  setupTouchControls();

  // ===== 채팅 broadcast =====
  const localChatColor = colorFromName(name);
  const broadcastLocalChat = (text: string) => {
    pushChatLog(ui, local.name, text, localChatColor);
    net.sendChat({ id: local.id, text });
  };

  // ===== 원격 플레이어 맵 =====
  const remotes = new Map<string, RemotePlayer>();
  // 원격 플레이어 속도벡터 — onPos 의 vx/vy 저장. dir-only 폴백.
  const remoteVel = new Map<string, { vx: number; vy: number }>();

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
        kills: 0, deaths: 0,
        attackUntil: 0,
        danceUntil: 0, danceStart: 0,
        gunUntil: 0,
        weaponType: null, weaponUntil: 0,
        score: 0,
      };
      remotes.set(m.id, r);
    } else {
      r.name = m.name;
      r.color = m.color;
      r.charIdx = m.charIdx;
    }
    setRosterCount(ui, remotes.size + 1);
  };

  // ===== 파티 상태 =====
  // partyId = leader id. 솔로 파티 = 자기 자신이 leader.
  let partyLeader = local.id;
  const partyMembers = new Set<string>([local.id]);

  const myPartyId = () => partyLeader;
  const iAmLeader = () => partyLeader === local.id;

  const resetToSoloParty = (): void => {
    partyLeader = local.id;
    partyMembers.clear();
    partyMembers.add(local.id);
  };

  const buildPartyMemberInfos = (): PartyMemberInfo[] => {
    const out: PartyMemberInfo[] = [];
    for (const mid of partyMembers) {
      if (mid === local.id) {
        out.push({ id: local.id, name: local.name, zone: null, isLeader: mid === partyLeader });
      } else {
        const r = remotes.get(mid);
        out.push({
          id: mid,
          name: r?.name ?? '???',
          zone: null,
          isLeader: mid === partyLeader,
        });
      }
    }
    out.sort((a, b) => (a.isLeader ? -1 : b.isLeader ? 1 : 0));
    return out;
  };

  // 출발 조건 — 경찰과도둑은 zone 없음. 파티장이고 2명 이상이면 OK.
  const checkCanStart = (infos: PartyMemberInfo[]): { ok: boolean; reason: string } => {
    if (!iAmLeader()) return { ok: false, reason: '파티장만 출발 가능' };
    if (infos.length < 2) return { ok: false, reason: '2명 이상이어야 출발' };
    return { ok: true, reason: '' };
  };

  // ===== 파티 액션 =====
  const sendLeaveAndReset = (): void => {
    if (partyMembers.size > 1) {
      net.sendPartyLeave({ partyId: myPartyId(), byId: local.id });
    }
    resetToSoloParty();
    refreshPartyUI();
  };

  const acceptInvite = (partyId: string, leaderId: string): void => {
    if (partyMembers.size > 1) {
      net.sendPartyLeave({ partyId: myPartyId(), byId: local.id });
    }
    partyLeader = leaderId;
    partyMembers.clear();
    partyMembers.add(local.id);
    partyMembers.add(leaderId);
    net.sendPartyAccept({ partyId, byId: local.id, byName: local.name });
    refreshPartyUI();
  };

  let partyPanel: PartyPanelHandle | null = null;
  let invitePopup: InvitePopupHandle | null = null;
  let tapMenu: TapMenuHandle | null = null;
  let lobbyChat: LobbyChatHandle | null = null;

  const refreshPartyUI = (): void => {
    if (!partyPanel) return;
    const infos = buildPartyMemberInfos();
    const { ok, reason } = checkCanStart(infos);
    partyPanel.update(infos, ok, reason);
  };

  // ===== 네트워크 파티 이벤트 핸들러 =====
  const applyPartyInvite = (p: PartyInvitePayload): void => {
    if (p.toId !== local.id || !invitePopup) return;
    if (partyLeader === p.partyId && partyMembers.has(local.id)) return;
    invitePopup.show(p.fromName, p.leaderName,
      () => acceptInvite(p.partyId, p.leaderId),
      () => net.sendPartyDecline({ partyId: p.partyId, byId: local.id }),
    );
  };

  const applyPartyAccept = (p: PartyAcceptPayload): void => {
    if (p.partyId !== myPartyId()) return;
    if (partyMembers.size >= PARTY_MAX) return;
    partyMembers.add(p.byId);
    pushChatLog(ui, '🎉 파티', `${p.byName} 합류`, '#ffd84a');
    refreshPartyUI();
  };

  const applyPartyDecline = (p: PartyDeclinePayload): void => {
    if (!iAmLeader() || p.partyId !== myPartyId()) return;
    const r = remotes.get(p.byId);
    pushChatLog(ui, '😔 파티', `${r?.name ?? '???'} 거절`, '#d34a4a');
  };

  const applyPartyLeave = (p: PartyLeavePayload): void => {
    if (p.partyId !== myPartyId()) return;
    if (p.byId === local.id) return;
    if (p.byId === partyLeader) {
      pushChatLog(ui, '👋 파티', `파티장이 해산`, '#c84a4a');
      resetToSoloParty();
    } else {
      partyMembers.delete(p.byId);
      const r = remotes.get(p.byId);
      pushChatLog(ui, '👋 파티', `${r?.name ?? '???'} 탈퇴`, '#9a8060');
    }
    refreshPartyUI();
  };

  // ===== UI 세팅 =====
  setupLobbyTitle();
  lobbyChat = setupLobbyChat((text) => {
    const n = nowSec();
    local.chatText = text;
    local.chatUntil = n + 4;
    broadcastLocalChat(text);
  });
  const inputEl = document.querySelector('#lobby-chat input') as HTMLInputElement | null;
  if (inputEl) {
    inputEl.addEventListener('focus', () => { lobbyChatFocused = true; });
    inputEl.addEventListener('blur', () => { lobbyChatFocused = false; });
  }
  invitePopup = setupInvitePopup();
  tapMenu = setupTapMenu();
  partyPanel = setupPartyPanel(
    () => {
      // 출발 — 술래잡기 로직은 다음 단계. 일단 배너만.
      const infos = buildPartyMemberInfos();
      const { ok } = checkCanStart(infos);
      if (!ok) return;
      showBanner(ui, 'info', '🚓 출발! (게임 로직 개발 중)');
      pushChatLog(ui, '🚓 시스템', '파티가 출발했습니다 — 술래잡기는 다음 업데이트', '#ffd84a');
    },
    () => { sendLeaveAndReset(); },
  );
  // 파티 패널 위치 — 좌측 left-stack 안에 끼워넣어 자연 flex 스택.
  // 결과 순서: (hud-top 의 접속자 pill) → 파티 패널 → 채팅 로그.
  // setupPartyPanel 이 body 에 position:fixed 로 박아둔 걸 reparent + position 해제.
  {
    const panelEl = document.getElementById('party-panel');
    const leftStack = document.querySelector('.left-stack');
    const chatLog = document.getElementById('chat-log');
    if (panelEl && leftStack) {
      panelEl.style.position = 'static';
      panelEl.style.top = 'auto';
      panelEl.style.left = 'auto';
      panelEl.style.right = 'auto';
      // 채팅 로그보다 위로 (chat-log 가 있으면 그 앞에 삽입)
      if (chatLog && chatLog.parentNode === leftStack) {
        leftStack.insertBefore(panelEl, chatLog);
      } else {
        leftStack.appendChild(panelEl);
      }
    }
  }
  refreshPartyUI();
  void lobbyChat;

  // ===== 캐릭터 탭 메뉴 — 클릭/터치 → 가장 가까운 원격 캐릭터 → 초대 메뉴 =====
  {
    const canvasEl = ui.canvas;
    const onTap = (clientX: number, clientY: number) => {
      const rect = canvasEl.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      const sx = cssX * (canvasEl.width / rect.width);
      const sy = cssY * (canvasEl.height / rect.height);
      const worldX = sx + camera.x;
      const worldY = sy + camera.y;
      let best: RemotePlayer | null = null;
      let bestD2 = 24 * 24;
      for (const r of remotes.values()) {
        const dx = r.renderX - worldX;
        const dy = (r.renderY + BODY_OFF_Y) - worldY;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = r; }
      }
      if (!best) return;
      const target = best;
      const alreadyInParty = partyMembers.has(target.id);
      const options: { label: string; onClick: () => void; danger?: boolean }[] = [];
      if (!alreadyInParty) {
        const can = partyMembers.size < PARTY_MAX;
        options.push({
          label: can ? '🎉 파티 초대' : `파티 가득참 (${PARTY_MAX}/${PARTY_MAX})`,
          onClick: () => {
            if (!can) return;
            net.sendPartyInvite({
              fromId: local.id, fromName: local.name,
              toId: target.id,
              partyId: myPartyId(), leaderId: partyLeader,
              leaderName: iAmLeader() ? local.name : (remotes.get(partyLeader)?.name ?? '???'),
            });
            pushChatLog(ui, '📨 파티', `${target.name} 에게 초대 발송`, '#9ad8ff');
          },
        });
      } else {
        options.push({ label: '이미 같은 파티', onClick: () => { /* noop */ } });
      }
      tapMenu!.show(clientX, clientY, target.name, options);
    };
    canvasEl.addEventListener('click', (e) => onTap(e.clientX, e.clientY));
    canvasEl.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (t) onTap(t.clientX, t.clientY);
    }, { passive: true });
  }

  // ===== 게임 update 컨텍스트 — 공격/총알은 no-op (대기실에선 사용 안 함) =====
  const updateCtx = (): UpdateCtx => ({
    dt: 0, now: nowSec(), map, chatActive: lobbyChatFocused,
    sendAttack: () => { /* no attack in lobby */ },
    sendPos: (p) => net.sendPos(p),
    sendHp: () => { /* no damage in lobby */ },
    sendDeath: () => { /* no death in lobby */ },
    fireBullet: () => { /* no guns in lobby */ },
  });

  // ===== 네트워크 connect =====
  const meta: PresenceMeta = { id: local.id, name, color, charIdx };
  net = connect(meta, 'LOBBY', 'cops_lobby', {
    onPos: (p: PosPayload) => {
      const r = remotes.get(p.id);
      if (!r) return;
      r.x = p.x; r.y = p.y;
      r.dir = p.dir;
      const wasMoving = r.moving;
      r.moving = p.moving;
      r.lastSeen = nowSec();
      // vx/vy 저장 — 정확한 외삽용. 없으면 dir-기반 폴백 (REMOTE_SPEED).
      if (typeof p.vx === 'number' && typeof p.vy === 'number') {
        remoteVel.set(p.id, { vx: p.vx, vy: p.vy });
      } else {
        // 폴백: dir 만 있는 경우 (mom-war 호환). 정규 방향벡터 × REMOTE_SPEED.
        let fx = 0, fy = 0;
        switch (p.dir) {
          case 'up':    fy = -REMOTE_SPEED; break;
          case 'down':  fy =  REMOTE_SPEED; break;
          case 'left':  fx = -REMOTE_SPEED; break;
          case 'right': fx =  REMOTE_SPEED; break;
        }
        remoteVel.set(p.id, { vx: p.moving ? fx : 0, vy: p.moving ? fy : 0 });
      }
      // 정지 패킷 도착 시 즉시 snap — 외삽 drift 제거 (술래잡기에선 정지 위치가 중요).
      if (wasMoving && !p.moving) {
        r.renderX = p.x;
        r.renderY = p.y;
      }
    },
    onChat: (c: ChatPayload) => {
      const r = remotes.get(c.id);
      if (!r) return;
      r.chatText = c.text;
      r.chatUntil = nowSec() + 4;
      pushChatLog(ui, r.name, c.text, colorFromName(r.name));
    },
    // 대기실에선 공격/HP/사망/총/무기/좀비 이벤트 무시 (다른 모드와 채널 분리돼 사실상 안 옴)
    onAttack: () => { /* ignored */ },
    onHp: () => { /* ignored */ },
    onDeath: () => { /* ignored */ },
    onGunDrop: () => { /* ignored */ },
    onGunPickup: () => { /* ignored */ },
    onBullet: () => { /* ignored */ },
    onZombieWaveStart: () => { /* ignored */ },
    onWeaponDrop: () => { /* ignored */ },
    onWeaponPickup: () => { /* ignored */ },
    onLobbyReady: () => { /* ignored — 옛 시스템 */ },
    onMatchStart: () => { /* ignored — 술래잡기 매치메이킹은 다음 단계 */ },
    onPartyInvite: (p) => { applyPartyInvite(p); },
    onPartyAccept: (p) => { applyPartyAccept(p); },
    onPartyDecline: (p) => { applyPartyDecline(p); },
    onPartyLeave: (p) => { applyPartyLeave(p); },
    onRevive: () => { /* ignored */ },
    onScore: () => { /* ignored */ },
    onZombieSnapshot: () => { /* ignored */ },
    onZombieHitRequest: () => { /* ignored */ },
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
      // 새 사람이 들어오면 내 현재 위치 즉시 1회 더 broadcast (지각 입장 처리)
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: local.moving });
    },
    onPresenceLeave: (members) => {
      for (const m of members) {
        remotes.delete(m.id);
        remoteVel.delete(m.id);
        // 파티 멤버가 룸 떠나면 정리. leader 였으면 해산.
        if (partyMembers.has(m.id) && m.id !== local.id) {
          if (m.id === partyLeader) {
            pushChatLog(ui, '👋 파티', `파티장 (${m.name}) 접속 끊김 → 해산`, '#c84a4a');
            resetToSoloParty();
          } else {
            partyMembers.delete(m.id);
            pushChatLog(ui, '👋 파티', `${m.name} 접속 끊김`, '#9a8060');
          }
          refreshPartyUI();
        }
      }
      setRosterCount(ui, remotes.size + 1);
    },
    onSubscribed: () => {
      net.sendPos({ id: local.id, x: local.x, y: local.y, dir: local.dir, moving: false });
    },
  });

  window.addEventListener('beforeunload', () => {
    void net.unsubscribe();
  });

  // ===== 미니맵 =====
  const minimapCtx = ui.minimap.getContext('2d')!;
  minimapCtx.imageSmoothingEnabled = false;
  function drawMinimap(): void {
    const mw = ui.minimap.width;
    const mh = ui.minimap.height;
    const sx = mw / map.pixelW;
    const sy = mh / map.pixelH;
    minimapCtx.clearRect(0, 0, mw, mh);
    minimapCtx.fillStyle = 'rgba(40, 60, 30, 0.55)';
    minimapCtx.fillRect(0, 0, mw, mh);
    minimapCtx.fillStyle = 'rgba(120, 80, 40, 0.85)';
    for (const r of map.collisionRects) {
      const x = (r.x0 * sx) | 0;
      const y = (r.y0 * sy) | 0;
      const w = Math.max(1, ((r.x1 - r.x0) * sx) | 0);
      const h = Math.max(1, ((r.y1 - r.y0) * sy) | 0);
      minimapCtx.fillRect(x, y, w, h);
    }
    minimapCtx.fillStyle = '#fff';
    for (const r of remotes.values()) {
      const x = (r.renderX * sx - 1) | 0;
      const y = (r.renderY * sy - 1) | 0;
      minimapCtx.fillRect(x, y, 3, 3);
    }
    const lx = (local.x * sx - 2) | 0;
    const ly = (local.y * sy - 2) | 0;
    minimapCtx.fillStyle = '#1a0e08';
    minimapCtx.fillRect(lx, ly, 5, 5);
    minimapCtx.fillStyle = '#ffd84a';
    minimapCtx.fillRect(lx + 1, ly + 1, 3, 3);
  }

  // ===== 루프 =====
  let lastT = performance.now();
  let posTimer = 0;
  let lastPosMoving = false;
  let lastPosDir = local.dir;
  let heartbeatTimer = 0;
  let idleSec = 0;
  let minimapAccum = 0;

  // 로컬 속도벡터 계산 — input 정규화 × SPEED. 정지면 0.
  const computeLocalVel = (): { vx: number; vy: number } => {
    if (!local.moving) return { vx: 0, vy: 0 };
    const mx = input.moveX;
    const my = input.moveY;
    const len = Math.hypot(mx, my);
    if (len === 0) return { vx: 0, vy: 0 };
    return { vx: (mx / len) * REMOTE_SPEED, vy: (my / len) * REMOTE_SPEED };
  };

  const sendLocalPos = (): void => {
    const v = computeLocalVel();
    net.sendPos({
      id: local.id, x: local.x, y: local.y, dir: local.dir, moving: local.moving,
      vx: v.vx, vy: v.vy,
    });
  };

  // 디버그 상태는 cops 에선 안 씀 — render 가 요구하니 빈 객체만 전달
  const debug = {
    visible: false,
    showCollision: false,
    showGrid: false,
    showHitbox: false,
    charScale: DEFAULT_CHAR_SCALE,
    viewTilesWide: DEFAULT_VIEW_TILES_PC,
  };

  function loop(t: number): void {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    const now = nowSec();

    if (local.shakePending > 0) {
      triggerShake(camera, local.shakePending);
      local.shakePending = 0;
    }

    const ctx = updateCtx();
    ctx.dt = dt;
    updateLocalPlayer(local, ctx);
    clampToWorld(local, map);

    // 원격 플레이어 — 술래잡기 반응성. 클라이언트 예측 + 큰 발산 시 snap.
    //  - r.x/r.y = 마지막 수신 좌표 (authoritative). onPos 에서만 갱신.
    //  - renderX/Y = 화면용 예측 좌표. moving 이면 매 프레임 vx*dt, vy*dt 로 자체 이동.
    //  - 패킷 도착 시 r.x 새 값 → 보정. 발산이 크면(>32px) 즉시 snap, 작으면 빠른 lerp.
    const SOFT_K = 1 - Math.exp(-dt / 0.08);   // 80ms 빠른 보정
    const SNAP_DIST2 = 32 * 32;                // 32px 이상 차이나면 snap
    for (const r of remotes.values()) {
      if (r.moving) {
        const v = remoteVel.get(r.id);
        if (v) {
          r.renderX += v.vx * dt;
          r.renderY += v.vy * dt;
        }
      }
      const dx = r.x - r.renderX;
      const dy = r.y - r.renderY;
      if (dx * dx + dy * dy > SNAP_DIST2) {
        // 멀어졌으면 즉시 snap — 보정 lerp 가 따라잡기 너무 오래 걸림
        r.renderX = r.x;
        r.renderY = r.y;
      } else {
        r.renderX += dx * SOFT_K;
        r.renderY += dy * SOFT_K;
      }
    }

    // ===== 위치 broadcast — 이동 중 throttle / 정지 시 하트비트 =====
    posTimer += dt;
    heartbeatTimer += dt;
    const movingNow = local.moving;
    const movingChanged = movingNow !== lastPosMoving;
    const dirChanged = local.dir !== lastPosDir;
    // 즉시 송신 트리거 — 방향/이동상태 변화는 throttle 무시 (반응성 ↑)
    if (movingChanged || dirChanged) {
      sendLocalPos();
      posTimer = 0;
      heartbeatTimer = 0;
      idleSec = 0;
    } else if (movingNow && posTimer >= POS_SEND_INTERVAL) {
      sendLocalPos();
      posTimer = 0;
      heartbeatTimer = 0;
      idleSec = 0;
    } else {
      if (!movingNow) idleSec += dt;
      const hbInterval = idleSec >= POS_IDLE_GRACE ? POS_HEARTBEAT_IDLE : POS_HEARTBEAT;
      if (heartbeatTimer >= hbInterval) {
        sendLocalPos();
        heartbeatTimer = 0;
      }
    }
    lastPosMoving = movingNow;
    lastPosDir = local.dir;

    // 카메라
    updateCamera(camera, local.x, local.y, map.pixelW, map.pixelH, dt, 0.5);

    // 렌더
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
        chatShow: now < r.chatUntil && r.chatText !== '',
        dead: r.dead,
        kills: r.kills,
        dancing: now < r.danceUntil,
        danceStart: r.danceStart,
      });
    }
    renderFrame(ctx2d, map, camera, local, renderables, now, debug, { ctx: hudCtx, displayScale });

    // ===== 채팅 말풍선 — DOM 으로 띄움 (bubbles.ts) =====
    // 좌표는 viewport 박스 안쪽 CSS px (백버퍼 px * displayScale).
    const visibleBubbleIds = new Set<string>();
    if (now < local.chatUntil && local.chatText) {
      const sx = (local.x - camera.x) * displayScale;
      const sy = (local.y + BODY_OFF_Y - 22 - camera.y) * displayScale;
      setBubble(local.id, local.chatText, sx, sy);
      visibleBubbleIds.add(local.id);
    }
    for (const r of renderables) {
      if (!r.chatShow) continue;
      const sx = (r.x - camera.x) * displayScale;
      const sy = (r.y + BODY_OFF_Y - 22 - camera.y) * displayScale;
      setBubble(r.id, r.chatText, sx, sy);
      visibleBubbleIds.add(r.id);
    }
    syncBubbles(visibleBubbleIds);

    // 미니맵 — 0.1초마다 갱신 (매 프레임 안 그려도 됨)
    minimapAccum += dt;
    if (minimapAccum >= 0.1) {
      minimapAccum = 0;
      drawMinimap();
    }

    void TILE;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
