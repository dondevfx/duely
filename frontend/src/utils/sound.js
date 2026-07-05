// Lightweight game sound effects synthesised with the Web Audio API.
// No audio files, no dependencies, no licensing — just oscillators.
// Respects a persisted mute toggle (localStorage 'soundMuted').

let audioCtx = null;

function getCtx() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    try { audioCtx = new AC(); } catch { return null; }
  }
  // Browsers start the context "suspended" until a user gesture — resume it.
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Unlock audio on the first user interaction so later programmatic sounds work.
if (typeof window !== 'undefined') {
  const unlock = () => { getCtx(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

let muted = (() => {
  try { return localStorage.getItem('soundMuted') === 'true'; } catch { return false; }
})();

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem('soundMuted', String(muted)); } catch {}
}
export function toggleMuted() { setMuted(!muted); return muted; }

// Play a single tone. start/dur in seconds (relative to now).
function tone(freq, start, dur, { type = 'sine', gain = 0.2, slideTo = null } = {}) {
  const ac = getCtx();
  if (!ac || muted) return;
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  // Quick attack, smooth exponential decay (avoids clicks).
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

// ── Public sound effects ──────────────────────────────────────────────

// Victory: bright ascending C-major arpeggio.
export function playWin() {
  tone(523.25, 0.00, 0.16, { type: 'triangle', gain: 0.26 }); // C5
  tone(659.25, 0.11, 0.16, { type: 'triangle', gain: 0.26 }); // E5
  tone(783.99, 0.22, 0.16, { type: 'triangle', gain: 0.26 }); // G5
  tone(1046.5, 0.33, 0.34, { type: 'triangle', gain: 0.30 }); // C6
}

// Defeat: descending downward glide.
export function playLoss() {
  tone(392, 0.00, 0.28, { type: 'sawtooth', gain: 0.16, slideTo: 174 });
  tone(196, 0.22, 0.38, { type: 'sine',     gain: 0.14 });
}

// Draw: two neutral equal tones.
export function playDraw() {
  tone(440, 0.00, 0.16, { type: 'sine', gain: 0.18 });
  tone(440, 0.18, 0.22, { type: 'sine', gain: 0.15 });
}

// Match found: quick two-note "ready" ping.
export function playMatchFound() {
  tone(659.25, 0.00, 0.10, { type: 'triangle', gain: 0.20 });
  tone(987.77, 0.10, 0.20, { type: 'triangle', gain: 0.22 });
}

// Countdown tick (3, 2, 1).
export function playCountdown() {
  tone(660, 0, 0.09, { type: 'square', gain: 0.11 });
}

// "Go" / start.
export function playGo() {
  tone(880, 0, 0.26, { type: 'triangle', gain: 0.22 });
}

// Subtle coin/chip sound for a placed bet or payout.
export function playCoin() {
  tone(1318, 0.00, 0.07, { type: 'square', gain: 0.12 });
  tone(1760, 0.06, 0.10, { type: 'square', gain: 0.10 });
}
