import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import type {
  AttackPayload,
  BulletPayload,
  ChatPayload,
  DeathPayload,
  GameMode,
  GunDropPayload,
  GunPickupPayload,
  HpPayload,
  LobbyReadyPayload,
  MatchStartPayload,
  PartyAcceptPayload,
  PartyDeclinePayload,
  PartyInvitePayload,
  PartyLeavePayload,
  PosPayload,
  RevivePayload,
  ScorePayload,
  ZombieHitRequestPayload,
  ZombieSnapshotPayload,
  PresenceMeta,
  WeaponDropPayload,
  WeaponPickupPayload,
  ZombieWaveStartPayload,
} from './types';

// ===== 타입 가드 =====
// Supabase Realtime 은 임의 페이로드를 전달할 수 있으므로 신뢰 경계에서 검증.
// (분산형 게임이라 클라이언트가 다른 클라이언트를 100% 신뢰하지는 않지만, 최소한
//  형태가 맞는지만 검증해서 undefined 접근 같은 즉시 크래시는 막는다.)

function isPresenceMeta(x: unknown): x is PresenceMeta {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && typeof o.color === 'string'
    && typeof o.charIdx === 'number';
}

function asPresenceList(arr: readonly unknown[]): PresenceMeta[] {
  const out: PresenceMeta[] = [];
  for (const p of arr) if (isPresenceMeta(p)) out.push(p);
  return out;
}

export interface NetHandlers {
  onPos: (p: PosPayload) => void;
  onChat: (p: ChatPayload) => void;
  onAttack: (p: AttackPayload) => void;
  onHp: (p: HpPayload) => void;
  onDeath: (p: DeathPayload) => void;
  onGunDrop: (p: GunDropPayload) => void;
  onGunPickup: (p: GunPickupPayload) => void;
  onBullet: (p: BulletPayload) => void;
  onZombieWaveStart: (p: ZombieWaveStartPayload) => void;
  onWeaponDrop: (p: WeaponDropPayload) => void;
  onWeaponPickup: (p: WeaponPickupPayload) => void;
  onLobbyReady: (p: LobbyReadyPayload) => void;
  onMatchStart: (p: MatchStartPayload) => void;
  onPartyInvite: (p: PartyInvitePayload) => void;
  onPartyAccept: (p: PartyAcceptPayload) => void;
  onPartyDecline: (p: PartyDeclinePayload) => void;
  onPartyLeave: (p: PartyLeavePayload) => void;
  onRevive: (p: RevivePayload) => void;
  onScore: (p: ScorePayload) => void;
  onZombieSnapshot: (p: ZombieSnapshotPayload) => void;
  onZombieHitRequest: (p: ZombieHitRequestPayload) => void;
  onPresenceSync: (members: PresenceMeta[]) => void;
  onPresenceJoin: (members: PresenceMeta[]) => void;
  onPresenceLeave: (members: PresenceMeta[]) => void;
  onSubscribed: () => void;
}

export interface Net {
  channel: RealtimeChannel;
  sendPos: (p: PosPayload) => void;
  sendChat: (p: ChatPayload) => void;
  sendAttack: (p: AttackPayload) => void;
  sendHp: (p: HpPayload) => void;
  sendDeath: (p: DeathPayload) => void;
  sendGunDrop: (p: GunDropPayload) => void;
  sendGunPickup: (p: GunPickupPayload) => void;
  sendBullet: (p: BulletPayload) => void;
  sendZombieWaveStart: (p: ZombieWaveStartPayload) => void;
  sendWeaponDrop: (p: WeaponDropPayload) => void;
  sendWeaponPickup: (p: WeaponPickupPayload) => void;
  sendLobbyReady: (p: LobbyReadyPayload) => void;
  sendMatchStart: (p: MatchStartPayload) => void;
  sendPartyInvite: (p: PartyInvitePayload) => void;
  sendPartyAccept: (p: PartyAcceptPayload) => void;
  sendPartyDecline: (p: PartyDeclinePayload) => void;
  sendPartyLeave: (p: PartyLeavePayload) => void;
  sendRevive: (p: RevivePayload) => void;
  sendScore: (p: ScorePayload) => void;
  sendZombieSnapshot: (p: ZombieSnapshotPayload) => void;
  sendZombieHitRequest: (p: ZombieHitRequestPayload) => void;
  unsubscribe: () => Promise<void>;
}

export function connect(meta: PresenceMeta, gameId: string, mode: GameMode, handlers: NetHandlers): Net {
  const client = getSupabase();
  // 채널명 = room:{mode}:{gameId}. 같은 (mode, gameId) 인 사람끼리만 만남.
  const channelName = `room-${mode}-${(gameId || 'default').toLowerCase()}`;
  // Supabase v2 의 `channel(topic)` 은 같은 토픽의 채널이 이미 있으면 그걸 그대로 돌려준다.
  // HMR 또는 재진입 시 이전 채널이 subscribed 상태로 남아 있으면 .on('presence', ...) 가 throw 하므로,
  // 기존 채널이 있으면 unsubscribe + removeChannel 로 정리한 다음 새로 만든다.
  const existing = client.getChannels().find((c) => c.topic === `realtime:${channelName}`);
  if (existing) {
    void existing.unsubscribe();
    void client.removeChannel(existing);
  }
  const channel = client.channel(channelName, {
    config: {
      broadcast: { self: false },
      presence: { key: meta.id },
    },
  });

  channel
    .on('broadcast', { event: 'pos' },        ({ payload }) => handlers.onPos(payload as PosPayload))
    .on('broadcast', { event: 'chat' },       ({ payload }) => handlers.onChat(payload as ChatPayload))
    .on('broadcast', { event: 'attack' },     ({ payload }) => handlers.onAttack(payload as AttackPayload))
    .on('broadcast', { event: 'hp' },         ({ payload }) => handlers.onHp(payload as HpPayload))
    .on('broadcast', { event: 'death' },      ({ payload }) => handlers.onDeath(payload as DeathPayload))
    .on('broadcast', { event: 'gun_drop' },   ({ payload }) => handlers.onGunDrop(payload as GunDropPayload))
    .on('broadcast', { event: 'gun_pickup' }, ({ payload }) => handlers.onGunPickup(payload as GunPickupPayload))
    .on('broadcast', { event: 'bullet' },     ({ payload }) => handlers.onBullet(payload as BulletPayload))
    .on('broadcast', { event: 'zombie_wave_start' }, ({ payload }) => handlers.onZombieWaveStart(payload as ZombieWaveStartPayload))
    .on('broadcast', { event: 'weapon_drop' },   ({ payload }) => handlers.onWeaponDrop(payload as WeaponDropPayload))
    .on('broadcast', { event: 'weapon_pickup' }, ({ payload }) => handlers.onWeaponPickup(payload as WeaponPickupPayload))
    .on('broadcast', { event: 'lobby_ready' },   ({ payload }) => handlers.onLobbyReady(payload as LobbyReadyPayload))
    .on('broadcast', { event: 'match_start' },   ({ payload }) => handlers.onMatchStart(payload as MatchStartPayload))
    .on('broadcast', { event: 'party_invite' },  ({ payload }) => handlers.onPartyInvite(payload as PartyInvitePayload))
    .on('broadcast', { event: 'party_accept' },  ({ payload }) => handlers.onPartyAccept(payload as PartyAcceptPayload))
    .on('broadcast', { event: 'party_decline' }, ({ payload }) => handlers.onPartyDecline(payload as PartyDeclinePayload))
    .on('broadcast', { event: 'party_leave' },   ({ payload }) => handlers.onPartyLeave(payload as PartyLeavePayload))
    .on('broadcast', { event: 'revive' },        ({ payload }) => handlers.onRevive(payload as RevivePayload))
    .on('broadcast', { event: 'score' },         ({ payload }) => handlers.onScore(payload as ScorePayload))
    .on('broadcast', { event: 'zombie_snapshot' },    ({ payload }) => handlers.onZombieSnapshot(payload as ZombieSnapshotPayload))
    .on('broadcast', { event: 'zombie_hit_request' }, ({ payload }) => handlers.onZombieHitRequest(payload as ZombieHitRequestPayload))
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState() as Record<string, readonly unknown[]>;
      const all: PresenceMeta[] = [];
      for (const arr of Object.values(state)) all.push(...asPresenceList(arr));
      handlers.onPresenceSync(all);
    })
    .on('presence', { event: 'join' }, ({ newPresences }) => {
      handlers.onPresenceJoin(asPresenceList(newPresences as readonly unknown[]));
    })
    .on('presence', { event: 'leave' }, ({ leftPresences }) => {
      handlers.onPresenceLeave(asPresenceList(leftPresences as readonly unknown[]));
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track(meta);
        handlers.onSubscribed();
      }
    });

  const send = <T>(event: string, payload: T) => {
    void channel.send({ type: 'broadcast', event, payload });
  };

  return {
    channel,
    sendPos:       (p) => send('pos', p),
    sendChat:      (p) => send('chat', p),
    sendAttack:    (p) => send('attack', p),
    sendHp:        (p) => send('hp', p),
    sendDeath:     (p) => send('death', p),
    sendGunDrop:        (p) => send('gun_drop', p),
    sendGunPickup:      (p) => send('gun_pickup', p),
    sendBullet:         (p) => send('bullet', p),
    sendZombieWaveStart:(p) => send('zombie_wave_start', p),
    sendWeaponDrop:     (p) => send('weapon_drop', p),
    sendWeaponPickup:   (p) => send('weapon_pickup', p),
    sendLobbyReady:     (p) => send('lobby_ready', p),
    sendMatchStart:     (p) => send('match_start', p),
    sendPartyInvite:    (p) => send('party_invite', p),
    sendPartyAccept:    (p) => send('party_accept', p),
    sendPartyDecline:   (p) => send('party_decline', p),
    sendPartyLeave:     (p) => send('party_leave', p),
    sendRevive:         (p) => send('revive', p),
    sendScore:          (p) => send('score', p),
    sendZombieSnapshot: (p) => send('zombie_snapshot', p),
    sendZombieHitRequest:(p) => send('zombie_hit_request', p),
    unsubscribe: async () => {
      try { await channel.untrack(); } catch { /* ignore */ }
      await channel.unsubscribe();
    },
  };
}
