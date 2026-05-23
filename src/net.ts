import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import type {
  AttackPayload,
  ChatPayload,
  DeathPayload,
  HpPayload,
  PosPayload,
  PresenceMeta,
} from './types';

export interface NetHandlers {
  onPos: (p: PosPayload) => void;
  onChat: (p: ChatPayload) => void;
  onAttack: (p: AttackPayload) => void;
  onHp: (p: HpPayload) => void;
  onDeath: (p: DeathPayload) => void;
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
  unsubscribe: () => Promise<void>;
}

export function connect(meta: PresenceMeta, handlers: NetHandlers): Net {
  const client = getSupabase();
  // Supabase v2 의 `channel(topic)` 은 같은 토픽의 채널이 이미 있으면 그걸 그대로 돌려준다.
  // HMR 또는 재진입 시 이전 채널이 subscribed 상태로 남아 있으면 .on('presence', ...) 가 throw 하므로,
  // 기존 채널이 있으면 unsubscribe + removeChannel 로 정리한 다음 새로 만든다.
  const existing = client.getChannels().find((c) => c.topic === 'realtime:baram-room');
  if (existing) {
    void existing.unsubscribe();
    void client.removeChannel(existing);
  }
  const channel = client.channel('baram-room', {
    config: {
      broadcast: { self: false },
      presence: { key: meta.id },
    },
  });

  const flatten = (state: Record<string, unknown[]>): PresenceMeta[] => {
    const out: PresenceMeta[] = [];
    for (const arr of Object.values(state)) {
      for (const p of arr) out.push(p as unknown as PresenceMeta);
    }
    return out;
  };

  channel
    .on('broadcast', { event: 'pos' },    ({ payload }) => handlers.onPos(payload as PosPayload))
    .on('broadcast', { event: 'chat' },   ({ payload }) => handlers.onChat(payload as ChatPayload))
    .on('broadcast', { event: 'attack' }, ({ payload }) => handlers.onAttack(payload as AttackPayload))
    .on('broadcast', { event: 'hp' },     ({ payload }) => handlers.onHp(payload as HpPayload))
    .on('broadcast', { event: 'death' },  ({ payload }) => handlers.onDeath(payload as DeathPayload))
    .on('presence', { event: 'sync' }, () => {
      handlers.onPresenceSync(flatten(channel.presenceState() as Record<string, unknown[]>));
    })
    .on('presence', { event: 'join' }, ({ newPresences }) => {
      handlers.onPresenceJoin(newPresences as unknown as PresenceMeta[]);
    })
    .on('presence', { event: 'leave' }, ({ leftPresences }) => {
      handlers.onPresenceLeave(leftPresences as unknown as PresenceMeta[]);
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
    sendPos: (p) => send('pos', p),
    sendChat: (p) => send('chat', p),
    sendAttack: (p) => send('attack', p),
    sendHp: (p) => send('hp', p),
    sendDeath: (p) => send('death', p),
    unsubscribe: async () => {
      try { await channel.untrack(); } catch { /* ignore */ }
      await channel.unsubscribe();
    },
  };
}
