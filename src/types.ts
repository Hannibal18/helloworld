// 공유 타입 + 네트워크 페이로드 정의.
// 모든 broadcast 페이로드는 발신자 id를 포함한다.

export type Dir = 'up' | 'down' | 'left' | 'right';

// 게임 모드 — 입장 시 선택. 채널 키에 포함돼 다른 모드끼리 격리됨.
// 'lobby'      = 엄마전쟁 대기 광장 (좀비 X, 무기 X, 채팅 가능). 모두 1 룸.
// 'zombie'     = 엄마전쟁 실제 배틀. 매치메이킹으로 동적 룸 ID 부여.
// 'pk'         = 옛 PvP 모드 (현재 UI 비활성).
// 'cops_lobby' = 경찰과도둑 대기실. 별개 게임이라 채널 분리.
export type GameMode = 'pk' | 'zombie' | 'lobby' | 'cops_lobby';

// presence track payload — 누가 방에 있는지 (신원만)
export interface PresenceMeta {
  id: string;
  name: string;
  color: string; // hex like '#aabbcc'
  charIdx: number; // 0..CHARACTER_COUNT-1 — 입장 시 랜덤 배정된 LPC 캐릭터 인덱스
}

// 이동 위치 broadcast
// vx/vy 는 cops 처럼 정밀 외삽이 필요한 모드용 optional 필드 — 정규화된 방향벡터 × SPEED (px/sec).
// dir 만 보내면 대각선 정보가 손실되므로 vx/vy 도 함께 보내면 수신측이 정확히 외삽 가능.
// mom-war 는 이 필드 안 써도 정상 동작 (단순 lerp 만).
export interface PosPayload {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  vx?: number;
  vy?: number;
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

// 점수 broadcast — 좀비 모드에서 주기적으로 자기 totalScore 송신.
// 다른 클라가 ranking 에 표시. 3초 주기 + 큰 변화 시 즉시.
export interface ScorePayload {
  id: string;
  score: number;
  kills: number;
}

// 사망 broadcast — 본인이 죽었다고 알린다. killerId 포함.
// zombie 모드: 비석 위치(tx, ty) 도 보냄. 동료들이 같은 위치에서 부활 인터랙션 가능.
export interface DeathPayload {
  id: string;
  killerId: string | null;
  tx?: number;
  ty?: number;
}

// ===== 총(AK) =====

// 호스트가 새 총 드랍을 알림.
export interface GunDropPayload {
  id: string;   // drop instance id (uuid)
  x: number;
  y: number;
}

// 누군가 드랍을 주움.
export interface GunPickupPayload {
  id: string;   // drop id
  by: string;   // player id
}

// 누군가 총알을 발사. 8방향 (대각선 포함) 지원을 위해 dir 대신 vx/vy 정규화 후 전송.
// 각 클라이언트가 동일 vx/vy 로 deterministic 시뮬레이션.
export interface BulletPayload {
  bid: string;      // bullet id
  ownerId: string;
  ownerName: string;
  x: number;
  y: number;
  vx: number;       // px/sec
  vy: number;       // px/sec
}

// 좀비 웨이브 시작 — 호스트가 broadcast. 받는 즉시 각 클라이언트가 자기 좀비 시뮬 시작.
export interface ZombieWaveStartPayload {
  startedAt: number; // 호스트 기준 sec (참고용 — 실제 클라이언트는 자기 now 사용)
}

// ===== 호스트 권위 좀비 동기화 =====
// 호스트가 매 SNAPSHOT_INTERVAL 마다 좀비 전체 상태 broadcast → 모든 클라이언트
// 같은 좀비를 봄. 데미지는 비-호스트가 ZombieHitRequest 로 호스트에 요청.
export interface ZombieSnapshotItem {
  id: string;
  type: 'normal' | 'fast' | 'tank' | 'gold' | 'boss' | 'frank';
  x: number;
  y: number;
  dir: Dir;
  hp: number;
  maxHp: number;
  attackingUntil?: number;  // 호스트 시각 기준 (수신측이 자기 now 로 보정)
}
export interface ZombieSnapshotPayload {
  hostNow: number;          // 호스트 시각 (시각 보정용)
  zombies: ZombieSnapshotItem[];
  killCount: number;
  newKillPoints: number[];  // 직전 snapshot 이후 새 처치 점수 (모두 추가)
}
// 비-호스트가 데미지 시도 → 호스트가 적용 → 다음 snapshot 에 반영.
export interface ZombieHitRequestPayload {
  zid: string;
  dmg: number;
  byId: string;
}

// 보조 무기 드랍 (Lightning/Ice/Curse — 모두 차지/방출 방식).
export type WeaponTypePayload = 'lightning' | 'ice' | 'curse';
export interface WeaponDropPayload {
  id: string;
  type: WeaponTypePayload;
  x: number;
  y: number;
}
export interface WeaponPickupPayload {
  id: string;       // drop id
  by: string;       // player id
  type: WeaponTypePayload;
}

// ===== 대기 광장 매치메이킹 =====
export type LobbyDifficulty = 'easy' | 'normal' | 'hell';

// (옛 zone-ready 시스템 제거됨 — 파티 모델로 대체. 호환 위해 LobbyReadyPayload 만 유지)
export interface LobbyReadyPayload {
  id: string;
  zone: LobbyDifficulty | null;
}

// 매치 시작 — 파티장이 출발 누르면 broadcast. 멤버 전원이 새 roomId 로.
export interface MatchStartPayload {
  zone: LobbyDifficulty;
  roomId: string;
  members: string[];
}

// ===== 파티 시스템 =====
// 파티는 leader id 를 partyId 로 사용. 다른 사람 캐릭터 탭 → 초대 → 수락/거절.
//
// 누군가 → 누군가에게 초대. 받는 사람이 popup 으로 응답.
export interface PartyInvitePayload {
  fromId: string;
  fromName: string;
  toId: string;
  partyId: string;
  leaderId: string;
  leaderName: string;
}
// 누군가 수락 — 그 파티 모두에게 broadcast.
export interface PartyAcceptPayload {
  partyId: string;
  byId: string;
  byName: string;
}
// 누군가 거절 — 보낸 사람에게 표시. 모두 받음 (filter 으로 self 처리).
export interface PartyDeclinePayload {
  partyId: string;
  byId: string;
}
// 누군가 탈퇴 또는 leader 가 disband — 파티 멤버 전원에게 영향.
export interface PartyLeavePayload {
  partyId: string;
  byId: string;
}

// ===== 비석 부활 (zombie 모드) =====
// 죽은 사람 옆에 살아있는 동료가 3초 머무르면 부활.
export interface RevivePayload {
  targetId: string;     // 부활 대상
  byId: string;         // 부활시킨 사람
}

// 원격 플레이어의 시각용 상태 (수신 측에서 유지)
export interface RemotePlayer {
  id: string;
  name: string;
  color: string;
  charIdx: number;
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
  // 죽은 횟수 (death broadcast 받을 때마다 +1)
  deaths: number;
  // 공격 모션 (스윙)
  attackUntil: number;
  // 제로투 댄스 (킬 후 도발 — 3초)
  danceUntil: number;
  danceStart: number; // 댄스 시작 시각 (애니메이션 위상 계산용)
  // AK 보유 만료 (gun_pickup broadcast 받으면 set). 보유 중이면 옆에 총 그림.
  gunUntil: number;
  // 보조 무기 보유 (weapon_pickup broadcast 받으면 set). 머리 위 아이콘 표시.
  weaponType: WeaponTypePayload | null;
  weaponUntil: number;
  // 좀비 모드 totalScore (score_update broadcast 로 갱신).
  score: number;
}
