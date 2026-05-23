// 엄마 보스 시스템 — 협동 PvE 이벤트.
// 활성화/비활성화는 BOSS_ENABLED 한 줄로 토글. game.ts 는 boss === null 인 경우 어떤 보스 코드도 실행하지 않는다.

export const BOSS_ENABLED = false;

export { spawnBoss, type BossSystem } from './boss';
