// 게임 룸 Durable Object — 좀비 모드 봇 (Phase 1: 봇 가입만).
//
// Phase 1 범위:
//   - HTTP /start 받으면 Supabase 채널에 가입 (presence track).
//   - presence 받아서 알람으로 5분 idle 시 잠 (자기 종료).
//   - 좀비 시뮬은 Phase 2 에서.
//
// Phase 2~3 에서 추가될 것:
//   - 좀비 spawn/AI/snapshot broadcast
//   - hit_request 처리
//   - 클라이언트가 봇 존재 감지해서 자기 호스트 안 함

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

// 봇 ID — 사전순 최소가 되어야 클라이언트의 isLocalHost() 가 봇으로 향함.
// UUID 영역(0-9, a-f) 보다 앞서는 '0' * 32 형식.
const BOT_ID = '00000000-0000-0000-0000-000000000000';
const BOT_NAME = '🤖 호스트';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;   // 5분 idle 시 자기 종료

interface PresenceMeta {
  id: string;
  name: string;
  color: string;
  charIdx: number;
}

export class GameRoomDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private roomId: string | null = null;
  private playerCount = 0;
  private lastActivityAt = Date.now();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const roomId = url.searchParams.get('roomId') ?? '';

    if (url.pathname === '/start') {
      await this.ensureConnected(roomId);
      return Response.json({ ok: true, roomId, playerCount: this.playerCount });
    }
    if (url.pathname === '/status') {
      return Response.json({
        roomId: this.roomId,
        playerCount: this.playerCount,
        connected: this.channel !== null,
        lastActivityAt: this.lastActivityAt,
      });
    }
    return new Response('not found', { status: 404 });
  }

  // 알람 — Phase 1 에서는 idle timeout 만 확인. Phase 2 에서 좀비 tick 추가.
  async alarm(): Promise<void> {
    const idleMs = Date.now() - this.lastActivityAt;
    if (this.playerCount === 0 && idleMs > IDLE_TIMEOUT_MS) {
      // 방에 아무도 없고 5분 지남 → 봇 종료 + DO sleep
      await this.disconnect();
      return;
    }
    // 다음 알람 — Phase 2 에서는 sim tick 주기 (50~100ms). Phase 1: 1분.
    await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  private async ensureConnected(roomId: string): Promise<void> {
    if (this.channel) {
      this.lastActivityAt = Date.now();
      return;
    }
    if (!roomId) return;
    this.roomId = roomId;
    this.supabase = createClient(this.env.SUPABASE_URL, this.env.SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 20 } },
      auth: { persistSession: false },
    });

    const channelName = `room-zombie-${roomId.toLowerCase()}`;
    this.channel = this.supabase.channel(channelName, {
      config: {
        broadcast: { self: false },
        presence: { key: BOT_ID },
      },
    });

    const meta: PresenceMeta = { id: BOT_ID, name: BOT_NAME, color: '#888888', charIdx: 0 };

    this.channel
      .on('presence', { event: 'sync' }, () => {
        const state = this.channel!.presenceState() as Record<string, unknown[]>;
        this.playerCount = Math.max(0, Object.keys(state).length - 1);  // 봇 제외
        this.lastActivityAt = Date.now();
      })
      .on('presence', { event: 'join' }, () => {
        this.lastActivityAt = Date.now();
      })
      .on('presence', { event: 'leave' }, () => {
        this.lastActivityAt = Date.now();
      })
      // Phase 2 에서: zombie_hit_request 수신 → 좀비 hp 깎고 snapshot 에 반영.
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.channel!.track(meta);
        }
      });

    // 첫 알람 예약 — 1분 후 idle 체크 시작
    await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  private async disconnect(): Promise<void> {
    if (this.channel) {
      try { await this.channel.untrack(); } catch { /* noop */ }
      try { await this.channel.unsubscribe(); } catch { /* noop */ }
      this.channel = null;
    }
    this.supabase = null;
    this.roomId = null;
    this.playerCount = 0;
    // 알람 취소
    await this.state.storage.deleteAlarm();
  }
}
