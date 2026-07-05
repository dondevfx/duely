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

// Short filtered white-noise burst — used for realistic "swish/flick" sounds
// (e.g. a card being dealt) that pure oscillators can't reproduce.
function noiseBurst(dur, { gain = 0.14, filter = 'highpass', freq = 2200, q = null, start = 0 } = {}) {
  const ac = getCtx();
  if (!ac || muted) return;
  const t0 = ac.currentTime + start;
  const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const biquad = ac.createBiquadFilter();
  biquad.type = filter;
  biquad.frequency.value = freq;
  if (q != null) biquad.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(biquad); biquad.connect(g); g.connect(ac.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// CSS cubic-bezier(x1,y1,x2,y2) sampled at parameter s → [x(time), y(progress)].
function _bezierXY(x1, y1, x2, y2, s) {
  const mt = 1 - s;
  return [
    3 * mt * mt * s * x1 + 3 * mt * s * s * x2 + s * s * s,
    3 * mt * mt * s * y1 + 3 * mt * s * s * y2 + s * s * s,
  ];
}
// Inverse: given a progress fraction (0..1), return the time fraction (0..1)
// at which the easing curve reaches it. Used to align wheel ticks to the
// wheel's actual deceleration so exactly one tick fires per segment crossing.
function _bezierTimeAtProgress(bez, targetY) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (_bezierXY(bez[0], bez[1], bez[2], bez[3], mid)[1] < targetY) lo = mid;
    else hi = mid;
  }
  const s = (lo + hi) / 2;
  return _bezierXY(bez[0], bez[1], bez[2], bez[3], s)[0];
}

// ── Public sound effects ──────────────────────────────────────────────

// Victory / prize won — cash-register "cha-ching" plus a coin sparkle.
export function playWin() {
  tone(1046.5, 0.00, 0.09, { type: 'square',   gain: 0.15 }); // "cha"
  tone(1568.0, 0.09, 0.30, { type: 'triangle', gain: 0.22 }); // "chinnng" (held)
  tone(2093.0, 0.11, 0.22, { type: 'triangle', gain: 0.11 }); // bright shimmer
  // falling coin tinkles
  tone(2637.0, 0.20, 0.10, { type: 'triangle', gain: 0.09 });
  tone(3136.0, 0.28, 0.12, { type: 'triangle', gain: 0.07 });
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

// Card dealt / drawn — a papery "fwip": band-limited noise around ~1.5 kHz
// with a fast decay (the card sliding), plus a faint low tap as it settles.
export function playCard() {
  noiseBurst(0.05,  { gain: 0.17, filter: 'bandpass', freq: 1500, q: 0.7, start: 0.00 });
  noiseBurst(0.03,  { gain: 0.07, filter: 'bandpass', freq: 2400, q: 1.2, start: 0.02 });
  tone(240, 0.035, 0.05, { type: 'sine', gain: 0.06 }); // soft settle tap
}

// Block Burst: a piece is placed on the board — subtle, satisfying soft tock.
export function playPlace() {
  tone(160, 0.00, 0.06, { type: 'sine',     gain: 0.13 }); // soft low body
  tone(430, 0.00, 0.025, { type: 'triangle', gain: 0.045 }); // faint tick on top
}

// Word VS: a very subtle, satisfying key press when typing a letter.
export function playType() {
  tone(175,  0.00, 0.022, { type: 'sine',   gain: 0.05 });  // soft low body
  tone(2400, 0.00, 0.010, { type: 'square', gain: 0.022 }); // faint click on top
}

// Block Burst: a line/column clears — bright ascending sparkle.
export function playClear() {
  tone(523.25, 0.00, 0.10, { type: 'triangle', gain: 0.18 });
  tone(783.99, 0.06, 0.12, { type: 'triangle', gain: 0.18 });
  tone(1046.5, 0.12, 0.14, { type: 'triangle', gain: 0.20 });
}

// Block Burst: Blast Mode unlocked — rising energy sweep.
export function playBlast() {
  tone(300, 0.00, 0.18, { type: 'sawtooth', gain: 0.20, slideTo: 950 });
}

// Money deposited — bright cash-register cascade.
export function playDeposit() {
  tone(1318.5, 0.00, 0.12, { type: 'triangle', gain: 0.22 });
  tone(1760.0, 0.10, 0.16, { type: 'triangle', gain: 0.24 });
  tone(2093.0, 0.20, 0.22, { type: 'triangle', gain: 0.20 });
}

// Tip received — a friendly two-note coin drop.
export function playTip() {
  tone(987.77,  0.00, 0.08, { type: 'triangle', gain: 0.18 });
  tone(1318.51, 0.07, 0.15, { type: 'triangle', gain: 0.20 });
}

// Fire one tick each time the rotating thing crosses a `stepDegrees` boundary,
// timed to a CSS cubic-bezier deceleration — so ticks slow down exactly as the
// animation does (no bunching at the end). Shared by the wheel and the coin.
function _decelTicks({ duration, totalDegrees, stepDegrees, bezier, freqStart, freqDrop, gain, dur = 0.02, type = 'square' }) {
  if (muted || !getCtx()) return;
  const crossings = Math.floor(totalDegrees / stepDegrees);
  for (let k = 1; k <= crossings; k++) {
    const progress = Math.min(1, (k * stepDegrees) / totalDegrees);
    const tf = _bezierTimeAtProgress(bezier, progress); // time fraction 0..1
    tone(freqStart - freqDrop * tf, tf * duration, dur, { type, gain });
  }
}

// Prize-wheel spin: one tick per segment crossing, matched to the wheel's
// `transition: transform <duration>s cubic-bezier(0.17,0.67,0.12,0.99)`.
export function playWheelSpin({ duration = 4, totalDegrees = 1800, segments = 8 } = {}) {
  _decelTicks({
    duration, totalDegrees, stepDegrees: 360 / segments,
    bezier: [0.17, 0.67, 0.12, 0.99], freqStart: 720, freqDrop: 130, gain: 0.06,
  });
}

// Coin flip: a metallic flutter that ticks on each half-rotation (face flip)
// and decelerates with the coin's easing (cubic-bezier(0,0,0.12,1)) until it
// settles. Call playCoinLand() when it comes to rest.
export function playCoinFlip({ duration = 4.2, totalDegrees = 4320 } = {}) {
  _decelTicks({
    duration, totalDegrees, stepDegrees: 180,
    bezier: [0, 0, 0.12, 1], freqStart: 1000, freqDrop: 320, gain: 0.05,
    dur: 0.016, type: 'triangle',
  });
}

// Coin flip landing — a short metallic "cling".
export function playCoinLand() {
  tone(1568, 0.00, 0.20, { type: 'triangle', gain: 0.18 });
  tone(2093, 0.02, 0.16, { type: 'triangle', gain: 0.10 });
  tone(1046, 0.00, 0.10, { type: 'sine',     gain: 0.08 });
}
