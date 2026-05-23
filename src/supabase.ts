import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// 입장 화면을 띄우려면 env 가 비어도 모듈은 로드돼야 한다.
// 실제로 게임에 입장(=채널 connect)할 때 lazy 하게 초기화한다.
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      '[helloworld] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 비어 있습니다. .env 를 .env.example 기준으로 채워주세요.',
    );
  }
  _client = createClient(url, anon, {
    realtime: { params: { eventsPerSecond: 20 } },
    auth: { persistSession: false },
  });
  return _client;
}
