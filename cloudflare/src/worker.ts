// Cloudflare Worker 진입점.
// 클라이언트가 매치 시작 직후 POST /room/:roomId/start 호출 →
// 그 roomId 에 해당하는 Durable Object 가 깨어나 Supabase 룸에 봇으로 가입.

export { GameRoomDO } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS — 브라우저에서 호출
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        },
      });
    }

    // /room/:roomId/start — 그 룸 봇 깨우기
    const startMatch = url.pathname.match(/^\/room\/([A-Z0-9]{1,12})\/start$/);
    if (startMatch && req.method === 'POST') {
      const roomId = startMatch[1];
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      const res = await stub.fetch(new Request(`https://internal/start?roomId=${roomId}`));
      return withCors(res);
    }

    // /room/:roomId/status — 봇 상태 (디버그)
    const statusMatch = url.pathname.match(/^\/room\/([A-Z0-9]{1,12})\/status$/);
    if (statusMatch && req.method === 'GET') {
      const roomId = statusMatch[1];
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      const res = await stub.fetch(new Request(`https://internal/status?roomId=${roomId}`));
      return withCors(res);
    }

    return withCors(new Response('helloworld-server\n', { status: 200 }));
  },
};

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers: h });
}
