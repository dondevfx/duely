// Self-contained canvas confetti burst — no dependencies.
// Renders a one-shot overlay canvas, animates falling confetti, then removes itself.

export function confettiBurst({ count = 130, duration = 1800, origin = null } = {}) {
  if (typeof document === 'undefined') return;
  // Respect users who prefer reduced motion.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch {}

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const ox = origin?.x ?? W / 2;
  const oy = origin?.y ?? H * 0.38;

  const colors = ['#1E90FF', '#22c55e', '#eab308', '#ec4899', '#a855f7', '#f97316', '#e2e8f0', '#06b6d4'];
  const parts = Array.from({ length: count }, () => ({
    x: ox + (Math.random() - 0.5) * 180,
    y: oy + (Math.random() - 0.5) * 60,
    vx: (Math.random() - 0.5) * 13,
    vy: Math.random() * -15 - 3,
    size: Math.random() * 7 + 3,
    color: colors[(Math.random() * colors.length) | 0],
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.35,
  }));

  const start = performance.now();
  function frame(t) {
    const elapsed = t - start;
    ctx.clearRect(0, 0, W, H);
    const fade = Math.max(0, 1 - elapsed / duration);
    for (const p of parts) {
      p.vy += 0.36;      // gravity
      p.vx *= 0.99;      // air drag
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (elapsed < duration) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}
