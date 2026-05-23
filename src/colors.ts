// 닉네임 → 고유한 색 (HSL 기반). 같은 닉이면 모든 클라이언트에서 같은 색.
// 어두운 배경(채팅 로그, 이름 라벨)에서 잘 보이도록 lightness 65~70% 고정.

export function colorFromName(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
  }
  const hue = Math.abs(hash) % 360;
  // 채도 70%, 명도 68% — 어두운 배경에서 또렷, 너무 형광 아님.
  return hslToHex(hue, 70, 68);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
