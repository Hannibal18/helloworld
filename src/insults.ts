// 멘탈 공격 — "욕 채팅" 자동 송신 시 골라서 보낼 문구 풀.
// 사용자가 직접 채워 넣으면 됨. 풀이 비면 폴백 한 줄.

export const INSULTS: readonly string[] = [
  'ㅈ밥 ㅅㄲ ㅋㅋ',
  '니애미',
  '병신',
  '허접년',
  '똥 같은놈',
  '병신 애자년~ ㅋㅋ 손 없냐?',
  '똥싸고 물내리지말고 퍼먹어라~ ㅋㅋ',
  '응 뒤져~',
  '느 금 마 !',
  '븅신 븅신 븅신',
  '똥 똥 똥',
  '줫밥 찌밥년 ㅎ~',
  '씨빠썌꺄',
  '나는 빡빡이다',
  '미역국 먹을 자격도 없어 개쉐기야~!',
  '어머련아',
];

export function pickInsult(): string {
  if (INSULTS.length === 0) return '......';
  return INSULTS[Math.floor(Math.random() * INSULTS.length)];
}
