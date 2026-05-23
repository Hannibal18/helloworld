// 댄스 시 머리 위로 떠오르는 음표/별/반짝이 파티클.
// 캔버스에 직접 그리지만 글리프(♪♫♬✦) 라서 크기는 캔버스 논리 픽셀 단위로 자연스럽게 보임.

interface Particle {
  kind: 'note' | 'sparkle';
  x: number;     // 월드 좌표
  y: number;
  vx: number;
  vy: number;
  birth: number;
  duration: number;
  glyph: string;
  color: string;
  size: number;  // 폰트 px
}

const particles: Particle[] = [];

const NOTE_GLYPHS = ['♪', '♫', '♬', '♩'];
const NOTE_COLORS = ['#ff9aa8', '#ffd96a', '#9cf0ff', '#c5a4ff', '#a8f0a4', '#ffaee0'];
const SPARKLE_GLYPHS = ['✦', '✧', '✺', '•'];
const SPARKLE_COLORS = ['#fff8a8', '#fff', '#ffd0e0', '#a8e8ff'];

// 피격 임팩트 — 짧고 빠르게 사방으로 흩날리는 흰/노란 스파크.
// worldX/Y 는 충돌 지점 (대략 몸통 중심).
export function spawnHitBurst(worldX: number, worldY: number, now: number): void {
  const count = 6;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const speed = 90 + Math.random() * 50;
    particles.push({
      kind: 'sparkle',
      x: worldX,
      y: worldY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      birth: now,
      duration: 0.22 + Math.random() * 0.08,
      glyph: i % 2 === 0 ? '✦' : '✧',
      color: i % 3 === 0 ? '#fff5a0' : '#ffffff',
      size: 9 + Math.floor(Math.random() * 4),
    });
  }
}

export function spawnDanceParticles(worldX: number, worldY: number, now: number): void {
  // 음표 1~2개
  const noteCount = 1 + (Math.random() < 0.35 ? 1 : 0);
  for (let i = 0; i < noteCount; i++) {
    particles.push({
      kind: 'note',
      x: worldX + (Math.random() - 0.5) * 28,
      y: worldY - 32 + Math.random() * 6,
      vx: (Math.random() - 0.5) * 30,
      vy: -38 - Math.random() * 22,
      birth: now,
      duration: 1.2 + Math.random() * 0.4,
      glyph: NOTE_GLYPHS[Math.floor(Math.random() * NOTE_GLYPHS.length)],
      color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
      size: 11 + Math.floor(Math.random() * 4),
    });
  }
  // 반짝이 (스파클) 1~3개
  const sparkCount = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < sparkCount; i++) {
    particles.push({
      kind: 'sparkle',
      x: worldX + (Math.random() - 0.5) * 48,
      y: worldY - 24 + (Math.random() - 0.5) * 32,
      vx: (Math.random() - 0.5) * 8,
      vy: -8 - Math.random() * 8,
      birth: now,
      duration: 0.5 + Math.random() * 0.4,
      glyph: SPARKLE_GLYPHS[Math.floor(Math.random() * SPARKLE_GLYPHS.length)],
      color: SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)],
      size: 6 + Math.floor(Math.random() * 5),
    });
  }
}

export function updateAndRenderParticles(
  ctx: CanvasRenderingContext2D,
  cameraX: number,
  cameraY: number,
  dt: number,
  now: number,
): void {
  // 파티클 업데이트 + 만료 제거
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const age = now - p.birth;
    if (age >= p.duration) {
      particles.splice(i, 1);
      continue;
    }
    // 음표는 약간 좌우로 흔들리며 떠오름
    if (p.kind === 'note') {
      p.x += (p.vx + Math.sin(age * 6) * 8) * dt;
      p.y += p.vy * dt;
      p.vy *= 0.985; // 천천히 느려짐
    } else {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += dt * 8; // 살짝 처짐
    }
  }

  // 그리기 (한 번에 — 작은 부하)
  for (const p of particles) {
    const age = now - p.birth;
    const t = age / p.duration;
    const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    const sx = Math.round(p.x - cameraX);
    const sy = Math.round(p.y - cameraY);
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `bold ${p.size}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 외곽 (검정으로 한번)
    ctx.fillStyle = '#1a0e08';
    ctx.fillText(p.glyph, sx + 1, sy + 1);
    // 본체
    ctx.fillStyle = p.color;
    ctx.fillText(p.glyph, sx, sy);
    ctx.restore();
  }
}
