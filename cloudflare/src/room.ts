// 게임 룸 Durable Object — 좀비 모드 봇 (Phase 2: 전체 시뮬).
//
// 흐름:
//   1) 클라이언트 매치 시작 시 POST /room/:id/start → DO 깨우기.
//   2) DO 가 Supabase 채널에 가입 (presence + 이벤트 구독).
//   3) zombie_wave_start 받으면 좀비 시뮬 시작.
//   4) 100ms 알람 마다 stepWave + (5Hz 마다) snapshot broadcast.
//   5) zombie_hit_request 받으면 applyDamage.
//   6) pos broadcast 받아서 플레이어 위치 추적 (AI 타깃용).
//   7) match_start 받아서 difficulty 캡처.
//   8) 5분 idle (플레이어 0명) 시 disconnect + DO sleep.

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { loadBotMap, isBlockedAt, type BotMapData } from './map-loader.js';
import {
  applyDamage, makeBotWave, makeSnapshot, startWave, stepWave,
  type BotWaveState, type Player,
} from './sim.js';
import { type Difficulty } from './stages.js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  // 맵 JSON URL — 배포 시 클라이언트와 같은 origin (예: https://openmath.kr/maps/zombie_road.json)
  MAP_URL?: string;
}

const BOT_ID = '00000000-0000-0000-0000-000000000000';
const BOT_NAME = '🤖 호스트';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 100;
const SNAPSHOT_INTERVAL_MS = 200;
const DEFAULT_MAP_URL = 'https://openmath.kr/maps/zombie_road.json';

interface PlayerEntry { x: number; y: number; dead: boolean; lastSeenAt: number; }

export class GameRoomDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private roomId: string | null = null;
  private map: BotMapData | null = null;
  private wave: BotWaveState = makeBotWave();
  private players = new Map<string, PlayerEntry>();
  private lastTickAt = 0;
  private lastSnapshotAt = 0;
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
      return Response.json({ ok: true, roomId, players: this.players.size, alive: this.wave.active });
    }
    if (url.pathname === '/status') {
      return Response.json({
        roomId: this.roomId,
        players: this.players.size,
        zombies: this.wave.zombies.length,
        killCount: this.wave.killCount,
        active: this.wave.active,
        difficulty: this.wave.difficulty,
      });
    }
    return new Response('not found', { status: 404 });
  }

  // 알람 = sim tick + snapshot. setAlarm 으로 self-reschedule.
  async alarm(): Promise<void> {
    if (!this.channel) {
      // disconnect 됐는데 알람 남음 — 그냥 끝.
      return;
    }
    const now = Date.now();
    const idleMs = now - this.lastActivityAt;

    // 활성 플레이어 정리 (pos heartbeat 안 오면 timeout 처리)
    const PLAYER_TIMEOUT_MS = 30_000;
    for (const [pid, p] of Array.from(this.players)) {
      if (now - p.lastSeenAt > PLAYER_TIMEOUT_MS) this.players.delete(pid);
    }

    if (this.players.size === 0 && idleMs > IDLE_TIMEOUT_MS) {
      await this.disconnect();
      return;
    }

    // wave 자동 시작 — 플레이어 1명+ 보이고 map 있고 아직 wave 안 시작이면 ON.
    // (클라이언트 isLocalHost() 가 봇 우선 → 클라가 wave_start 안 보냄.
    //  따라서 봇이 자기 wave 를 시작 + zombie_wave_start broadcast 해야 함.)
    if (this.map && !this.wave.active && this.players.size >= 1 && this.channel) {
      startWave(this.wave, now, {
        mapW: this.map.pixelW, mapH: this.map.pixelH,
        isBlocked: (x, y) => isBlockedAt(this.map!, x, y),
      }, this.wave.difficulty);
      void this.channel.send({
        type: 'broadcast',
        event: 'zombie_wave_start',
        payload: { startedAt: now / 1000 },
      });
    }

    // sim tick
    if (this.wave.active && this.map) {
      const dt = this.lastTickAt > 0 ? Math.min(250, now - this.lastTickAt) : TICK_INTERVAL_MS;
      this.wave.playerCount = Math.max(1, this.players.size);
      const playerArr: Player[] = Array.from(this.players, ([id, p]) => ({ id, x: p.x, y: p.y, dead: p.dead }));
      stepWave(this.wave, dt, now, {
        mapW: this.map.pixelW, mapH: this.map.pixelH,
        isBlocked: (x, y) => isBlockedAt(this.map!, x, y),
      }, playerArr);
      this.lastTickAt = now;

      // snapshot 주기적 broadcast
      if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotAt = now;
        const payload = makeSnapshot(this.wave, now / 1000);
        void this.channel.send({ type: 'broadcast', event: 'zombie_snapshot', payload });
      }
    }

    await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
  }

  private async ensureConnected(roomId: string): Promise<void> {
    if (this.channel) {
      this.lastActivityAt = Date.now();
      return;
    }
    if (!roomId) return;
    this.roomId = roomId;

    // 맵 로드 (1회 캐시)
    try {
      this.map = await loadBotMap(this.env.MAP_URL ?? DEFAULT_MAP_URL);
    } catch (e) {
      console.error('[bot] map load failed', e);
      // 맵 없으면 sim 진행 불가 — 종료
      return;
    }

    this.supabase = createClient(this.env.SUPABASE_URL, this.env.SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 30 } },
      auth: { persistSession: false },
    });

    const channelName = `room-zombie-${roomId.toLowerCase()}`;
    this.channel = this.supabase.channel(channelName, {
      config: {
        broadcast: { self: false },
        presence: { key: BOT_ID },
      },
    });

    const meta = { id: BOT_ID, name: BOT_NAME, color: '#888888', charIdx: 0 };

    this.channel
      .on('presence', { event: 'sync' }, () => {
        const stateMap = this.channel!.presenceState() as Record<string, unknown[]>;
        // 봇 자신 제외 카운트
        let count = 0;
        for (const k of Object.keys(stateMap)) if (k !== BOT_ID) count++;
        this.lastActivityAt = Date.now();
        // 존재하지 않는 사람 players 에서 제거
        const presentIds = new Set(Object.keys(stateMap).filter((k) => k !== BOT_ID));
        for (const pid of Array.from(this.players.keys())) {
          if (!presentIds.has(pid)) this.players.delete(pid);
        }
        if (count === 0) {
          // 모든 플레이어 떠남 → wave 정지
          if (this.wave.active) {
            this.wave.active = false;
            this.wave.zombies = [];
          }
        }
      })
      .on('broadcast', { event: 'pos' }, ({ payload }) => {
        const p = payload as { id: string; x: number; y: number };
        if (!p || typeof p.id !== 'string') return;
        const now = Date.now();
        const cur = this.players.get(p.id) ?? { x: 0, y: 0, dead: false, lastSeenAt: now };
        cur.x = p.x; cur.y = p.y; cur.lastSeenAt = now;
        this.players.set(p.id, cur);
        this.lastActivityAt = now;
      })
      .on('broadcast', { event: 'hp' }, ({ payload }) => {
        const p = payload as { id: string; hp: number };
        const cur = this.players.get(p.id);
        if (cur) cur.dead = p.hp <= 0;
      })
      .on('broadcast', { event: 'death' }, ({ payload }) => {
        const p = payload as { id: string };
        const cur = this.players.get(p.id);
        if (cur) cur.dead = true;
      })
      .on('broadcast', { event: 'revive' }, ({ payload }) => {
        const p = payload as { targetId: string };
        const cur = this.players.get(p.targetId);
        if (cur) cur.dead = false;
      })
      .on('broadcast', { event: 'zombie_wave_start' }, () => {
        // 봇이 wave 직접 시작하므로 클라이언트 wave_start 는 무시.
        // (옛 클라이언트 호환 — 봇 미배포 환경에서는 클라가 트리거)
        this.lastActivityAt = Date.now();
      })
      .on('broadcast', { event: 'match_start' }, ({ payload }) => {
        const p = payload as { zone: Difficulty };
        if (p?.zone === 'easy' || p?.zone === 'normal' || p?.zone === 'hell') {
          this.wave.difficulty = p.zone;
        }
      })
      .on('broadcast', { event: 'zombie_hit_request' }, ({ payload }) => {
        const p = payload as { zid: string; dmg: number };
        if (!p) return;
        applyDamage(this.wave, p.zid, p.dmg);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.channel!.track(meta);
        }
      });

    // 첫 알람 — TICK_INTERVAL_MS 후 sim 시작
    await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
  }

  private async disconnect(): Promise<void> {
    if (this.channel) {
      try { await this.channel.untrack(); } catch { /* noop */ }
      try { await this.channel.unsubscribe(); } catch { /* noop */ }
      this.channel = null;
    }
    this.supabase = null;
    this.roomId = null;
    this.players.clear();
    this.wave = makeBotWave();
    await this.state.storage.deleteAlarm();
  }
}
