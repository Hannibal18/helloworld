// 공유 타입 + 네트워크 페이로드 정의.
// 모든 broadcast 페이로드는 발신자 id를 포함한다.

export type Dir = 'up' | 'down' | 'left' | 'right';

// presence track payload — 누가 방에 있는지 (신원만)
export interface PresenceMeta {
  id: string;
  name: string;
  color: string; // hex like '#aabbcc'
}

// 이동 위치 broadcast
export interface PosPayload {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
}

// 채팅 broadcast
export interface ChatPayload {
  id: string;
  text: string;
}

// 공격 broadcast — 공격자가 자기 위치/방향을 알린다.
// 각 클라이언트가 자기 캐릭터가 히트박스 안인지 스스로 판정한다.
export interface AttackPayload {
  id: string;
  x: number;
  y: number;
  dir: Dir;
}

// HP 변화 broadcast — 피격당한 본인이 자기 HP를 알린다.
export interface HpPayload {
  id: string;
  hp: number;
}

// 사망 broadcast — 본인이 죽었다고 알린다. killerId 포함.
export interface DeathPayload {
  id: string;
  killerId: string | null;
}

// 원격 플레이어의 시각용 상태 (수신 측에서 유지)
export interface RemotePlayer {
  id: string;
  name: string;
  color: string;
  x: number;          // 보간 목표
  y: number;
  renderX: number;    // 실제 그려지는 위치 (lerp)
  renderY: number;
  dir: Dir;
  moving: boolean;
  hp: number;
  maxHp: number;
  // 말풍선 (시간 단위: 초 — performance.now()/1000 기준)
  chatText: string;
  chatUntil: number;
  // 피격 깜빡임
  hitFlashUntil: number;
  // 사망 연출
  dead: boolean;
  deadUntil: number;
  // 마지막 pos 수신 시각 (heartbeat 누락 감지용; 현재는 사용 안 함)
  lastSeen: number;
  // 킬 카운트 (수신측에서 death broadcast로 집계)
  kills: number;
  // 공격 모션 (스윙)
  attackUntil: number;
  // 제로투 댄스 (킬 후 도발 — 3초)
  danceUntil: number;
  danceStart: number; // 댄스 시작 시각 (애니메이션 위상 계산용)
}
