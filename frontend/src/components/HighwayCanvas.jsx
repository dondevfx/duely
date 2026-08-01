import { useEffect, useRef } from 'react';
import { isMuted } from '../utils/sound';


/**
 * HIGHWAY DASH — gameplay canvas. Complete rebuild.
 *
 * Premium arcade lane-weaver. Near top-down camera, close to the action.
 * One responsive game: identical world units, hitboxes, spawning and scoring on
 * every device — only pixel scale differs.
 *
 * Art system: every vehicle and road tile is BAKED to an offscreen sprite once
 * (high detail: panel lines, glass with reflections, baked bloom on emissives),
 * then the frame loop is pure drawImage + gradients. No shadowBlur per frame.
 *
 * Fairness: traffic comes from the shared server seed via a "snaking corridor"
 * spawner — the guaranteed-free lane random-walks one lane per wave, so a
 * survivable path always exists and BOTH players face identical traffic.
 * AI lane changes fire on deterministic thresholds (never conditioned on the
 * local player), keeping the two simulations in lockstep.
 *
 * Integration (unchanged): props { seed, onProgress(score,ms), onCrash(score,ms) }.
 * In-canvas UI only: score, time, GO flash, small pause button, game-over overlay.
 */

// ── World tuning (units: 1 lane = 100u, sedan ≈ 95u long) ───────────────────
const LANES        = 4;
const LANE_U       = 100;
const VIEW_AHEAD   = 700;    // world units visible above the player — fixed on all devices
const PLAYER_YF    = 0.78;   // player screen position (fraction of height)
const SPAWN_Y      = 880;    // > VIEW_AHEAD + longest vehicle, so nothing pops in
const DESPAWN_Y    = -280;

const SPD_START    = 585;    // u/s
const SPD_MAX      = 1150;
const RAMP_S       = 48;     // seconds to reach max speed
// Past RAMP_S the run keeps escalating instead of flat-lining.
const OD_S         = 70;     // seconds per unit of "overdrive"
const OD_MAX       = 1.8;
const OD_SPEED     = 300;    // extra u/s at full overdrive
const OD_CLOSE     = 170;    // extra closing speed at full overdrive
const CLOSE_MIN    = 225;    // closing speed floor (u/s)
const CLOSE_MAX    = 565;    // closing speed at full difficulty
const VISUAL_SCROLL = 1.0;   // road MUST scroll with the world or it slides under the cars

const PTS_DIST     = 0.06;
const PTS_TIME     = 8;
const PTS_NEAR     = 75;

const FREEZE_S     = 0.15;
const REPORT_S     = 0.55;   // report as soon as the crash FX has read
const OVERLAY_S    = 1.05;   // only show GAME OVER if we're still here (i.e. waiting)

const HIT_FORGIVE  = 0.88;   // hitbox forgiveness factor

// Duely palette
const CYAN  = '#00BFFF';

// ── Night-highway pixel palette ─────────────────────────────────────────────
// Tight on purpose. A small, fixed palette is most of what separates pixel art
// from "a low-resolution picture", and it keeps the whole screen coherent.
const PAL = {
  void0:  '#05070E', void1:  '#0A0F1A',
  road0:  '#12192A', road1:  '#171F33', road2:  '#1D2740',
  line:   '#E6F2FF', lineDim:'#5C7CA8',
  kerb:   '#00BFFF', kerbDim:'#0B5C8C',
  shadow: '#080B14',
  glass:  '#16233C', glassLit:'#31527F',
  tyre:   '#07090F',
  lampW:  '#FFF6D8', lampR:'#FF3B4E', lampC:'#8CF2FF',
};
const BLUE  = '#1250B4';

// ── Lane marking cadence ────────────────────────────────────────────────────
// Chosen from the frame budget, not by eye. Top speed is SPD_MAX + OD_SPEED =
// 1450 u/s, i.e. ~24.2u of travel per frame at 60fps. A marking cycle shorter
// than ~6 frames beats against the refresh rate and the road appears to blink
// out, which is exactly what the previous art did. 70 + 80 = 150u gives 6.2
// frames per cycle at maximum speed, with margin.
const MARK_LEN = 70;
const MARK_GAP = 80;
const MARK_CYCLE = MARK_LEN + MARK_GAP;
const ICE   = '#9FDCFF';

// Sizes are in world units and drive BOTH the sprite and the hitbox, so art and
// collision can never drift apart.
const VEHICLES = {
  sedan:  { len: 81,  wid: 53, close: 1.00, weight: 26 },
  suv:    { len: 90,  wid: 58, close: 1.05, weight: 20 },
  pickup: { len: 95,  wid: 56, close: 1.05, weight: 14 },
  sports: { len: 75,  wid: 51, close: 0.78, weight: 14 },
  van:    { len: 107, wid: 60, close: 1.12, weight: 14 },
  semi:   { len: 174, wid: 66, close: 1.22, weight: 8  },
};
const PLAYER_W_U = 56;   // player world width  (sprite + hitbox)
const PLAYER_L_U = 117;  // player world length (sprite + hitbox)
const VKEYS = Object.keys(VEHICLES);
const VTOTAL = VKEYS.reduce((a, k) => a + VEHICLES[k].weight, 0);

// Traffic paints. Chosen to sit with the road rather than fight it: cool
// steels and midnight blues carry the night, with a few warm bodies so the
// screen never goes monochrome. No blue this saturated appears here — that
// belongs to the player alone.
const PAINTS = [
  '#C43B3B', '#D9762B', '#E0B23A', '#3E9E63', '#2E8C8C',
  '#7B5BD6', '#C2496F', '#D6DEEA', '#8E99AB', '#40506B',
];


const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = (t) => t * t * (3 - 2 * t);

function makePRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SPRITE BAKERY — draw once, blit forever
// ─────────────────────────────────────────────────────────────────────────────
function bake(w, h, fn) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.ceil(w));
  c.height = Math.max(2, Math.ceil(h));
  const g = c.getContext('2d');
  fn(g, c.width, c.height);
  return c;
}

function rr(g, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
  return `rgb(${c(((n >> 16) & 255) + amt)},${c(((n >> 8) & 255) + amt)},${c((n & 255) + amt)})`;
}

// Baked glow disc (runtime bloom without shadowBlur)
function bakeGlow(hex, r) {
  const n = parseInt(hex.slice(1), 16);
  const rc = (n >> 16) & 255, gc = (n >> 8) & 255, bc = n & 255;
  // Stepped rings, not a radial gradient. A smooth blur sitting on top of
  // pixel art reads as a mistake — the glow has to live on the same grid as
  // everything else, so it falls off in a few discrete bands instead.
  const STEPS = 4;
  return bake(r * 2, r * 2, (g, w, h) => {
    for (let i = STEPS; i >= 1; i--) {
      const t = i / STEPS;
      const rad = Math.round((w / 2) * t);
      g.fillStyle = `rgba(${rc},${gc},${bc},${(0.42 * (1 - t) + 0.10).toFixed(3)})`;
      g.fillRect(Math.round(w / 2 - rad), Math.round(h / 2 - rad), rad * 2, rad * 2);
    }
  });
}

function bakeSoftShadow(w, h) {
  return bake(w, h, (g, W, H) => {
    const gr = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)');
    gr.addColorStop(0.7, 'rgba(0,0,0,0.28)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(1, H / W);
    g.translate(-W / 2, -W / 2);
    g.fillStyle = gr;
    g.fillRect(0, H / 2 - W / 2, W, W);
    g.restore();
  });
}

// -- Traffic vehicle sprite ------------------------------------------------
// House style: graphite hulls with hard chamfered geometry and a single bold
// livery wrap, lit by the road's neon (cool rim on the left, warm bounce on the
// right). Colour identifies a vehicle at a glance without turning the highway
// into a rainbow -- they read as one fleet, clearly distinct from the player's
// glowing blue Interceptor.
// ─────────────────────────────────────────────────────────────────────────────
//  PIXEL VEHICLE ART
//
//  Sprites are generated at exactly the size they appear on the virtual grid —
//  roughly 23x36 pixels for a car — rather than authored large and scaled down.
//  Scaling pixel art by a fraction is what produces uneven, crawling edges, so
//  every shape here is laid out in whole pixels at the final size.
//
//  Each vehicle is built from the same five ideas: a dark outline, a body with
//  a lit left edge and a shaded right edge, a dark cabin, lamps at both ends,
//  and tyres breaking the silhouette. At this resolution that is all that fits,
//  and all that is needed.
// ─────────────────────────────────────────────────────────────────────────────

// Whole-pixel rect. Everything goes through here, so nothing can land on a
// half pixel and blur.
function px(g, x, y, w, h, c) {
  const x0 = Math.round(x), y0 = Math.round(y);
  const x1 = Math.round(x + w), y1 = Math.round(y + h);
  if (x1 <= x0 || y1 <= y0) return;
  g.fillStyle = c;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
}

// Per-class proportions, as fractions of the sprite. `cab` is where the dark
// glasshouse sits along the length; `nose`/`tail` set how far the body insets
// at each end, which is what makes a van read differently from a sports car.
const SHAPE = {
  sedan:  { nose: 0.14, tail: 0.10, cab: [0.30, 0.66], bonnet: 0.26 },
  sports: { nose: 0.20, tail: 0.14, cab: [0.40, 0.70], bonnet: 0.34 },
  suv:    { nose: 0.09, tail: 0.07, cab: [0.22, 0.70], bonnet: 0.18 },
  pickup: { nose: 0.11, tail: 0.06, cab: [0.20, 0.48], bonnet: 0.16 },
  van:    { nose: 0.07, tail: 0.05, cab: [0.12, 0.40], bonnet: 0.10 },
  semi:   { nose: 0.05, tail: 0.03, cab: [0.06, 0.24], bonnet: 0.04 },
};

function shadeHex(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  const r = c(n >> 16), g2 = c((n >> 8) & 255), b = c(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g2 << 8) | b).toString(16).slice(1);
}

function paintPixelVehicle(g, w, l, body, S2, opts = {}) {
  const lit = shadeHex(body, 34);
  const dim = shadeHex(body, -42);
  const out = shadeHex(body, -86);
  const inset = Math.max(1, Math.round(w * 0.09));

  // silhouette: full width through the middle, inset at nose and tail
  const noseL = Math.max(1, Math.round(l * S2.nose));
  const tailL = Math.max(1, Math.round(l * S2.tail));
  px(g, inset, 0, w - inset * 2, l, out);              // outline pass
  px(g, inset + 1, noseL, w - inset * 2 - 2, l - noseL - tailL, body);
  px(g, inset + 2, 1, w - inset * 4, l - 2, body);

  // key light down the left flank, shadow down the right
  px(g, inset + 1, noseL, 1, l - noseL - tailL, lit);
  px(g, inset + 2, 1, 1, l - 2, lit);
  px(g, w - inset - 2, noseL, 1, l - noseL - tailL, dim);
  px(g, w - inset - 3, 1, 1, l - 2, dim);

  // tyres break the silhouette so the shape never reads as a plain block
  const tyreL = Math.max(2, Math.round(l * 0.13));
  for (const ty of [Math.round(l * 0.16), Math.round(l * 0.68)]) {
    px(g, 0, ty, inset + 1, tyreL, PAL.tyre);
    px(g, w - inset - 1, ty, inset + 1, tyreL, PAL.tyre);
  }

  // glasshouse
  const c0 = Math.round(l * S2.cab[0]), c1 = Math.round(l * S2.cab[1]);
  px(g, inset + 2, c0, w - inset * 2 - 4, c1 - c0, PAL.glass);
  px(g, inset + 2, c0, 1, c1 - c0, PAL.glassLit);
  px(g, inset + 2, c0, w - inset * 2 - 4, 1, PAL.glassLit);

  // bonnet crease
  px(g, Math.round(w / 2), Math.round(l * 0.05), 1, Math.round(l * S2.bonnet), dim);

  // lamps
  const lw = Math.max(2, Math.round(w * 0.2));
  px(g, inset + 2, 0, lw, 1, opts.head || PAL.lampW);
  px(g, w - inset - 2 - lw, 0, lw, 1, opts.head || PAL.lampW);
  px(g, inset + 2, l - 1, lw, 1, PAL.lampR);
  px(g, w - inset - 2 - lw, l - 1, lw, 1, PAL.lampR);
}

function bakeVehicle(kind, paint, wpx, lpx) {
  const w = Math.max(6, Math.round(wpx)), l = Math.max(10, Math.round(lpx));
  return bake(w, l, (g) => {
    paintPixelVehicle(g, w, l, paint, SHAPE[kind] || SHAPE.sedan);
    if (kind === 'semi') {
      // trailer gets a livery band so the longest vehicle is unmistakable
      px(g, Math.round(w * 0.14), Math.round(l * 0.34), Math.round(w * 0.72), 2, shadeHex(paint, 60));
      px(g, Math.round(w * 0.14), Math.round(l * 0.62), Math.round(w * 0.72), 2, shadeHex(paint, 60));
    }
  });
}

// ── Player car — the Interceptor ────────────────────────────────────────────
// Built scanline by scanline rather than from stacked rectangles. At roughly
// 25x51 pixels a car's identity is almost entirely its outline, so the
// silhouette is defined as a half-width curve down the length: a drawn-in nose,
// wide shoulders over the front wheels, a waisted middle, flared rear haunches
// and a wing that overhangs the body. Nothing in traffic has that outline, so
// the player is identifiable at a glance even with the screen full of cars.
function bakePlayer(wpx, lpx) {
  const w = Math.max(10, Math.round(wpx));
  const l = Math.max(16, Math.round(lpx));
  const cx = Math.floor(w / 2);

  const BLUE = '#1668FF';
  const BLUE_HI = '#68B4FF';
  const BLUE_LO = '#0B3A96';
  const EDGE = '#04102A';

  // Half-width of the bodywork at a given fraction along the car. Hand-tuned
  // control points, linearly interpolated, so the shape holds at any size.
  // A wedge, not a bullet: the nose starts genuinely narrow and the flanks run
  // straight out to the shoulders. The body is pinched back in at both axles so
  // the tyres break the outline instead of hiding under it.
  // A wedge, not a bullet and not a spike. The nose is genuinely narrower than
  // the shoulders but still a real face — taken much below half width it stops
  // reading as a car and starts reading as an antenna. The body is pinched at
  // both axles so the tyres break the outline instead of hiding under it.
  const KEYS = [
    [0.00, 0.50], [0.05, 0.58], [0.12, 0.70], [0.18, 0.74],
    [0.24, 0.68], [0.34, 0.68], [0.40, 0.76], [0.56, 0.76],
    [0.64, 0.82], [0.70, 0.72], [0.80, 0.72], [0.86, 0.84],
    [0.94, 0.82], [1.00, 0.72],
  ];
  const halfAtF = (f) => {
    for (let i = 1; i < KEYS.length; i++) {
      if (f <= KEYS[i][0]) {
        const [f0, v0] = KEYS[i - 1], [f1, v1] = KEYS[i];
        const t = (f - f0) / (f1 - f0 || 1);
        return v0 + (v1 - v0) * t;
      }
    }
    return KEYS[KEYS.length - 1][1];
  };

  return bake(w, l, (g) => {
    const halfPx = [];
    for (let y = 0; y < l; y++) {
      halfPx[y] = Math.max(1, Math.round(halfAtF(y / (l - 1)) * (w / 2)));
    }

    // Wheels first so the body sits over them and only the shoulders show.
    // Aligned with the waists in KEYS — offset from them, the pinch reads as a
    // dent in the bodywork rather than as a wheel arch.
    const tyreL = Math.max(2, Math.round(l * 0.11));
    for (const ty of [Math.round(l * 0.23), Math.round(l * 0.70)]) {
      for (let y = ty; y < Math.min(l, ty + tyreL); y++) {
        px(g, cx - halfPx[y] - 1, y, 2, 1, PAL.tyre);
        px(g, cx + halfPx[y] - 1, y, 2, 1, PAL.tyre);
      }
    }

    // Body: outline pass, then fill, then the lit and shaded flanks.
    for (let y = 0; y < l; y++) {
      const h = halfPx[y];
      px(g, cx - h, y, h * 2, 1, EDGE);
      if (h > 1) px(g, cx - h + 1, y, (h - 1) * 2, 1, BLUE);
      if (h > 2) {
        px(g, cx - h + 1, y, 1, 1, BLUE_HI);          // key light, left flank
        px(g, cx + h - 2, y, 1, 1, BLUE_LO);          // shade, right flank
        if (h > 4) px(g, cx + h - 3, y, 1, 1, '#0F4FC4'); // second shade step
      }
    }

    // Centre spine — the one continuous bright line, and most of what makes
    // the nose read as pointed rather than blunt.
    // Racing stripe over the bonnet — two pixels wide so it reads as a stripe
    // rather than a scratch, and stopping at the canopy.
    const stW = Math.max(1, Math.round(w * 0.09));
    px(g, cx - Math.floor(stW / 2), Math.round(l * 0.04), stW, Math.round(l * 0.32), '#EAF6FF');
    px(g, cx - Math.floor(stW / 2), Math.round(l * 0.04), 1, Math.round(l * 0.32), BLUE_HI);

    // Front splitter: a dark bar across the nose, which stops the wedge from
    // reading as a plain point.
    const spY = Math.round(l * 0.13);
    px(g, cx - halfPx[spY] + 1, spY, (halfPx[spY] - 1) * 2, 1, EDGE);

    // Headlights, tucked inside the nose taper.
    const hl = Math.max(2, Math.round(l * 0.07));
    const hw = Math.max(2, Math.round(w * 0.15));
    px(g, cx - halfPx[hl] + 1, hl, hw, 1, PAL.lampC);
    px(g, cx + halfPx[hl] - 1 - hw, hl, hw, 1, PAL.lampC);

    // Canopy: a trapezoid that narrows toward the tail, not a round bubble.
    const c0 = Math.round(l * 0.38), c1 = Math.round(l * 0.58);
    for (let y = c0; y < c1; y++) {
      const t = (y - c0) / Math.max(1, c1 - c0 - 1);
      const gh = Math.max(1, Math.round(halfPx[y] * (0.66 - 0.16 * t)));
      px(g, cx - gh, y, gh * 2, 1, PAL.glass);
      if (y === c0) px(g, cx - gh, y, gh * 2, 1, PAL.glassLit);
      if (t > 0.2 && t < 0.6) px(g, cx - gh + 1, y, 1, 1, PAL.glassLit);
    }

    // Bonnet vents either side of the stripe, and a shut line at the tail —
    // without them the panels read as empty blue.
    const vY = Math.round(l * 0.17), vH = Math.max(1, Math.round(l * 0.05));
    const vW = Math.max(1, Math.round(w * 0.11));
    px(g, cx - Math.round(w * 0.26), vY, vW, vH, BLUE_LO);
    px(g, cx + Math.round(w * 0.26) - vW, vY, vW, vH, BLUE_LO);
    const dY = Math.round(l * 0.78);
    px(g, cx - halfPx[dY] + 2, dY, (halfPx[dY] - 2) * 2, 1, BLUE_LO);

    // Two SHORT strakes over the rear haunches. Running them the full length
    // made them merge with the outline and the car read as a box.
    const s0 = Math.round(l * 0.62), s1 = Math.round(l * 0.74);
    for (let y = s0; y < s1; y++) {
      px(g, cx - halfPx[y] + 1, y, 1, 1, PAL.lampC);
      px(g, cx + halfPx[y] - 2, y, 1, 1, PAL.lampC);
    }

    // Rear wing, standing clear of the bodywork with a visible gap beneath it
    // and cyan only at the tips. No traffic vehicle is wider at the tail, so
    // this is the strongest silhouette cue the car has.
    const wy = Math.round(l * 0.84);
    const wingH = Math.max(2, Math.round(l * 0.045));
    const wingW = Math.min(w, halfPx[wy] * 2 + Math.max(2, Math.round(w * 0.12)));
    const wx = cx - Math.floor(wingW / 2);
    px(g, wx, wy, wingW, wingH, EDGE);
    const tip = Math.max(1, Math.round(wingW * 0.22));
    px(g, wx, wy, tip, 1, PAL.lampC);
    px(g, wx + wingW - tip, wy, tip, 1, PAL.lampC);

    // Tail: red clusters either side of a cyan bar.
    const ty2 = l - Math.max(2, Math.round(l * 0.055));
    const tw = Math.max(2, Math.round(w * 0.22));
    px(g, cx - halfPx[l - 2] + 1, ty2, tw, 1, PAL.lampR);
    px(g, cx + halfPx[l - 2] - 1 - tw, ty2, tw, 1, PAL.lampR);
    px(g, cx - Math.round(w * 0.14), l - 1, Math.max(2, Math.round(w * 0.28)), 1, PAL.lampC);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUDIO — engine, wind, whoosh, crash (Web Audio synth; respects site mute)
// ─────────────────────────────────────────────────────────────────────────────
function createAudio() {
  if (isMuted()) return null;
  let actx;
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  if (!actx) return null;
  const master = actx.createGain(); master.gain.value = 0.5; master.connect(actx.destination);

  const eg = actx.createGain(); eg.gain.value = 0;
  const ef = actx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 480;
  const o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 58;
  const o2 = actx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 89;
  o1.connect(ef); o2.connect(ef); ef.connect(eg); eg.connect(master);
  o1.start(); o2.start();

  const nBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const wind = actx.createBufferSource(); wind.buffer = nBuf; wind.loop = true;
  const wf = actx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 850; wf.Q.value = 0.7;
  const wg = actx.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); wg.connect(master);
  wind.start();

  return {
    resume() { if (actx.state === 'suspended') actx.resume().catch(() => {}); },
    setSpeed(t) {
      const now = actx.currentTime;
      eg.gain.setTargetAtTime(0.05 + t * 0.055, now, 0.15);
      o1.frequency.setTargetAtTime(56 + t * 78, now, 0.2);
      o2.frequency.setTargetAtTime(86 + t * 116, now, 0.2);
      ef.frequency.setTargetAtTime(420 + t * 1600, now, 0.25);
      wg.gain.setTargetAtTime(0.012 + t * 0.08, now, 0.2);
      wf.frequency.setTargetAtTime(720 + t * 1200, now, 0.25);
    },
    duck() {
      eg.gain.setTargetAtTime(0, actx.currentTime, 0.06);
      wg.gain.setTargetAtTime(0, actx.currentTime, 0.06);
    },
    whoosh() {
      const t0 = actx.currentTime;
      const s = actx.createBufferSource(); s.buffer = nBuf;
      const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.7;
      f.frequency.setValueAtTime(1600, t0);
      f.frequency.exponentialRampToValueAtTime(300, t0 + 0.24);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.26, t0 + 0.035);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0); s.stop(t0 + 0.3);
    },
    crash() {
      const t0 = actx.currentTime;
      const s = actx.createBufferSource(); s.buffer = nBuf;
      const f = actx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(2800, t0);
      f.frequency.exponentialRampToValueAtTime(150, t0 + 0.5);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.75, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0); s.stop(t0 + 0.7);
      const th = actx.createOscillator(); th.type = 'sine';
      const tg = actx.createGain();
      th.frequency.setValueAtTime(140, t0);
      th.frequency.exponentialRampToValueAtTime(34, t0 + 0.44);
      tg.gain.setValueAtTime(0.7, t0);
      tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.52);
      th.connect(tg); tg.connect(master);
      th.start(t0); th.stop(t0 + 0.55);
      this.duck();
    },
    stop() { try { o1.stop(); o2.stop(); wind.stop(); actx.close(); } catch { /* noop */ } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function HighwayCanvas({ seed, onProgress, onCrash }) {
  const canvasRef = useRef(null);
  const cbRef = useRef({ onProgress, onCrash });
  useEffect(() => { cbRef.current = { onProgress, onCrash }; }, [onProgress, onCrash]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || seed == null) return;
    // `dctx` is the real canvas — HUD only. `ctx` is the low-resolution world
    // buffer that every gameplay draw call writes into.
    const dctx = canvas.getContext('2d', { alpha: false });
    const world = document.createElement('canvas');
    const ctx = world.getContext('2d', { alpha: false });
    const rand = makePRNG(seed);        // gameplay randomness — identical for both players
    const frand = Math.random;          // FX-only randomness
    const audio = createAudio();

    // ── Layout (fixed view distance in units ⇒ identical gameplay everywhere) ──
    let W = 0, H = 0, u2p = 1, roadW = 0, laneW = 0, roadX = 0, playerY = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let sprites = null;

    // ── Pixel grid ──────────────────────────────────────────────────────────
    // The world is drawn at PIX_W virtual pixels across and blown up by a whole
    // number. Integer scaling is not optional: at a fractional factor some
    // source pixels land on two screen pixels and some on one, so edges crawl
    // as things move. That shimmer is the signature glitch of fake pixel art.
    const PIX_W = 180;
    let pix = 1;

    function layout() {
      W = canvas.clientWidth || 360;
      H = canvas.clientHeight || 640;
      const devW = Math.floor(W * dpr), devH = Math.floor(H * dpr);
      pix = Math.max(1, Math.round(devW / PIX_W));
      // Virtual size follows from the integer factor, so the buffer always maps
      // exactly onto the display with no half-pixel remainder.
      const vw = Math.ceil(devW / pix), vh = Math.ceil(devH / pix);
      world.width = vw; world.height = vh;
      canvas.width = vw * pix; canvas.height = vh * pix;
      // Pin the CSS size to match the backing store exactly. Without this the
      // buffer is an integer multiple internally but the browser then rescales
      // the element by a fraction to fit its box, which reintroduces exactly
      // the crawling edges the integer factor was there to prevent.
      canvas.style.width = (vw * pix / dpr) + 'px';
      canvas.style.height = (vh * pix / dpr) + 'px';
      canvas.style.imageRendering = 'pixelated';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      dctx.imageSmoothingEnabled = false;
      W = vw; H = vh;
      playerY = Math.round(H * PLAYER_YF);
      // Snap the lane width to a whole pixel so lane lines and cars never sit
      // on a half pixel — the other half of keeping the grid honest.
      laneW = Math.max(8, Math.floor(Math.min(
        ((playerY - H * 0.02) / VIEW_AHEAD) * LANE_U,
        (W * 0.965) / LANES)));
      u2p = laneW / LANE_U;
      roadW = laneW * LANES;
      roadX = Math.round((W - roadW) / 2);
      bakeAll();
    }

    // Site theme — the off-road surround must match the page behind it.
    // Checked per frame so switching theme applies without a re-bake.
    const isLight = () => document.documentElement.classList.contains('light');

    function bakeAll() {
      const vs = {};
      const playerW = PLAYER_W_U * u2p, playerL = PLAYER_L_U * u2p;
      sprites = {
        vs,
        vkey(kind, paint) {
          const wpx = VEHICLES[kind].wid * u2p, lpx = VEHICLES[kind].len * u2p;
          const k = kind + '|' + paint;
          if (!vs[k]) vs[k] = bakeVehicle(kind, paint, wpx, lpx);
          return vs[k];
        },
        player: bakePlayer(playerW, playerL),
        playerW, playerL,
        shadow: bakeSoftShadow(140, 210),
        glowCyan: bakeGlow(CYAN, 60),
        glowRed: bakeGlow('#FF3B30', 34),
        glowAmber: bakeGlow('#FFB020', 26),
        glowWhite: bakeGlow('#FFF6D8', 40),
        smokePuff: bake(48, 48, (g, w, h) => {
          const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
          gr.addColorStop(0, 'rgba(176,190,210,0.5)');
          gr.addColorStop(1, 'rgba(176,190,210,0)');
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
        }),
        vignette: bake(W, H, (g) => {
          const v = g.createRadialGradient(W / 2, H * 0.62, Math.min(W, H) * 0.34, W / 2, H * 0.62, Math.max(W, H) * 0.82);
          v.addColorStop(0, 'rgba(0,0,0,0)');
          v.addColorStop(1, 'rgba(0,0,0,0.62)');
          g.fillStyle = v; g.fillRect(0, 0, W, H);
        }),
        edgeFlash: bake(W, H, (g) => {
          const v = g.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.3, W / 2, H * 0.55, Math.max(W, H) * 0.72);
          v.addColorStop(0, 'rgba(0,191,255,0)');
          v.addColorStop(1, 'rgba(0,191,255,0.5)');
          g.fillStyle = v; g.fillRect(0, 0, W, H);
        }),

      };
    }
    layout();
    let resizeT = 0;
    const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(layout, 120); };
    window.addEventListener('resize', onResize);

    // ── Pools ──
    const cars = Array.from({ length: 34 }, () => ({
      on: false, kind: 'sedan', paint: PAINTS[0], y: 0, lane: 0, laneF: 0,
      spd: 0, near: false, sig: 0, sigDir: 0, changeAt: -1, changing: 0, brake: false,
    }));
    const parts = Array.from({ length: 200 }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, age: 0, s: 2, kind: 0, c: '' }));
    const floats = Array.from({ length: 12 }, () => ({ on: false, x: 0, y: 0, age: 0, life: 0, txt: '' }));
    const puffs = Array.from({ length: 48 }, () => ({ on: false, x: 0, y: 0, age: 0, life: 0, s: 1 }));
    const take = (pool) => { for (let i = 0; i < pool.length; i++) if (!pool[i].on) return pool[i]; return null; };

    // ── State (sim-clock: pausing stops score AND reported time) ──
    const S = {
      simT: 0, dist: 0, speed: SPD_START, score: 0,
      laneX: LANE_U * 1.5, laneVel: 0, targetLane: 1,
      corridor: 2,
      waveIn: 0.55, waveN: 0,
      changeCooldown: 0,
      combo: 0, comboT: -9,
      flash: 0, shake: 0, scorePop: 0,
      dead: false, deadT: 0, reported: false,
      lastPing: 0,
      goT: 0, hintT: 0,
      event: null, eventY: 0, nextEventAt: 6 + rand() * 4, tunnelUntil: -1, tunnelA: 0,
      poles: Array.from({ length: 5 }, (_, i) => ({ y: i * 300, side: i % 2 ? 1 : -1 })),
    };

    const diff = () => smooth(clamp(S.simT / RAMP_S, 0, 1));
    // Overdrive keeps speed, density and aggression climbing after the ramp.
    const over = () => clamp((S.simT - RAMP_S) / OD_S, 0, OD_MAX);
    const laneCenter = (l) => (l + 0.5) * LANE_U;

    // ── Input ──
    // Every input retargets immediately. Nothing is ever queued or ignored, so
    // reversing mid-change (left then instantly right) responds on the frame it
    // was pressed rather than finishing the previous move first.
    function move(dir) {
      if (S.dead) return;
      const nxt = clamp(S.targetLane + dir, 0, LANES - 1);
      if (nxt === S.targetLane) return;
      S.targetLane = nxt;
    }
    const onKey = (e) => {
      if (e.repeat) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { audio?.resume(); move(-1); e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { audio?.resume(); move(1); e.preventDefault(); }
    };
    // Touch = swipe. You go the way you swipe, and a long swipe can cross more
    // than one lane. The gesture fires as soon as it passes the threshold rather
    // than waiting for release, so it feels immediate.
    const sw = { active: false, id: null, startX: 0, fired: false };
    const swipeMin = () => Math.max(26, canvas.clientWidth * 0.055);

    const onPointerDown = (e) => {
      audio?.resume();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      sw.active = true; sw.id = e.pointerId;
      sw.startX = x; sw.fired = false;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ } }
    };
    const onPointerMove = (e) => {
      if (!sw.active || sw.fired || e.pointerId !== sw.id) return;
      const r = canvas.getBoundingClientRect();
      const dx = (e.clientX - r.left) - sw.startX;
      // Exactly ONE lane per swipe, however far the finger travels. Lift and
      // swipe again to move another lane.
      if (Math.abs(dx) >= swipeMin()) { move(dx > 0 ? 1 : -1); sw.fired = true; }
    };
    const onPointerUp = (e) => {
      if (!sw.active || e.pointerId !== sw.id) return;
      // No swipe registered => treat it as a tap on that half of the screen.
      if (!sw.fired) {
        const r = canvas.getBoundingClientRect();
        move((e.clientX - r.left) < r.width / 2 ? -1 : 1);
      }
      sw.active = false; sw.id = null;
      if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ } }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // ── Spawning: snaking corridor — deterministic AND always survivable ──
    function pick() {
      let r = rand() * VTOTAL;
      for (const k of VKEYS) { r -= VEHICLES[k].weight; if (r <= 0) return k; }
      return 'sedan';
    }
    function laneHeadway(l) {
      let min = 1e9;
      for (const c of cars) if (c.on && Math.round(c.laneF) === l && c.y > 300) min = Math.min(min, SPAWN_Y - c.y);
      return min;
    }
    function spawnWave() {
      const d = diff();
      S.waveN++;
      // The free lane random-walks ±1 → a weaveable path always exists.
      const step = rand();
      S.corridor = clamp(S.corridor + (step < 0.36 ? -1 : step < 0.72 ? 1 : 0), 0, LANES - 1);

      const maxBlock = S.simT < 9 ? 1 : S.simT < 24 ? 2 : 3;
      let n = 1 + Math.floor(rand() * maxBlock);
      if (S.waveN % 6 === 0) n = Math.max(1, n - 1); // breathing pocket

      const lanes = [];
      for (let l = 0; l < LANES; l++) if (l !== S.corridor) lanes.push(l);
      for (let i = lanes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      }
      const closing = CLOSE_MIN + (CLOSE_MAX - CLOSE_MIN) * d + over() * OD_CLOSE;
      for (const l of lanes.slice(0, n)) {
        if (laneHeadway(l) < closing * 0.95 + 190) continue; // deterministic headway guard
        const c = take(cars); if (!c) continue;
        const kind = pick();
        c.on = true; c.kind = kind;
        c.paint = PAINTS[Math.floor(rand() * PAINTS.length)];
        c.y = SPAWN_Y + rand() * 70;
        c.laneF = l; c.lane = l;
        c.spd = S.speed - closing * VEHICLES[kind].close * (0.86 + rand() * 0.28);
        c.near = false; c.brake = rand() < 0.16;
        c.sig = 0; c.sigDir = 0; c.changing = 0;
        // pre-rolled lane change — deterministic, fires only well ahead of the player
        c.changeAt = (S.simT > 11 && kind !== 'semi' && rand() < 0.18 + d * 0.22 + over() * 0.12) ? S.simT + 0.8 + rand() * 2.0 : -1;
      }
      S.waveIn = Math.max(0.28, (1.16 - d * 0.72 - over() * 0.16) + rand() * Math.max(0.14, 0.6 - d * 0.28 - over() * 0.1));
    }

    // ── FX helpers ──
    function addFloat(x, y, txt) {
      const f = take(floats); if (!f) return;
      f.on = true; f.x = x; f.y = y; f.age = 0; f.life = 0.85; f.txt = txt;
    }
    function puffAt(x, y, s) {
      const p = take(puffs); if (!p) return;
      p.on = true; p.x = x; p.y = y; p.age = 0; p.life = 0.4 + frand() * 0.2; p.s = s;
    }
    function crashBurst(x, y) {
      for (let i = 0; i < 54; i++) {
        const p = take(parts); if (!p) break;
        const ang = frand() * 6.283, sp = 60 + frand() * 460;
        p.on = true; p.x = x; p.y = y;
        p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp - 100;
        p.age = 0;
        if (i < 20)      { p.kind = 0; p.c = frand() < 0.5 ? '#FFD84D' : '#FF8A3D'; p.s = 2 + frand() * 2.4; p.life = 0.4 + frand() * 0.5; }
        else if (i < 40) { p.kind = 1; p.c = '#CFE9FF'; p.s = 2 + frand() * 3;     p.life = 0.5 + frand() * 0.6; }
        else             { p.kind = 2; p.c = '#5A5F68'; p.s = 8 + frand() * 12;    p.life = 0.7 + frand() * 0.6; }
      }
    }
    function sparkTrail(x, y, n) {
      for (let i = 0; i < n; i++) {
        const p = take(parts); if (!p) break;
        p.on = true; p.kind = 0; p.x = x + (frand() - 0.5) * 8; p.y = y;
        p.vx = (frand() - 0.5) * 90; p.vy = 120 + frand() * 120;
        p.c = frand() < 0.6 ? ICE : '#FFFFFF'; p.s = 1.6 + frand() * 1.4;
        p.age = 0; p.life = 0.25 + frand() * 0.2;
      }
    }

    // ── Simulation ──
    function update(dt) {
      S.simT += dt;
      const d = diff();
      S.speed = SPD_START + (SPD_MAX - SPD_START) * d + over() * OD_SPEED;
      S.dist += S.speed * dt;
      S.score += S.speed * dt * PTS_DIST + dt * PTS_TIME;
      S.goT += dt; S.hintT += dt;
      audio?.setSpeed(d);

      // player lane spring — snappy with a hint of overshoot
      const targetX = laneCenter(S.targetLane);
      // Snappy, near-critically-damped steering: ~133ms to cross a lane and
      // ~233ms fully settled, with almost no overshoot. Responsiveness is
      // deliberately favoured over a long, pretty animation.
      S.laneVel += (targetX - S.laneX) * 600 * dt;
      S.laneVel *= Math.exp(-34 * dt);
      S.laneX += S.laneVel * dt;
      // tyre smoke while sliding
      if (Math.abs(S.laneVel) > 240) {
        const px = roadX + S.laneX * u2p;
        puffAt(px - sprites.playerW * 0.34, playerY + sprites.playerL * 0.42, 0.8 + frand() * 0.4);
        puffAt(px + sprites.playerW * 0.34, playerY + sprites.playerL * 0.42, 0.8 + frand() * 0.4);
      }

      // roadside poles
      for (const p of S.poles) {
        p.y -= S.speed * dt;
        if (p.y < -160) { p.y += 300 * S.poles.length; p.side = -p.side; }
      }

      // living-road events
      if (!S.event && S.simT > S.nextEventAt) {
        const r = rand();
        if (r < 0.42) { S.event = 'gantry'; S.eventY = SPAWN_Y + 100; }
        else if (r < 0.72) { S.event = 'overpass'; S.eventY = SPAWN_Y + 160; }
        else { S.event = 'tunnel'; S.tunnelUntil = S.simT + 6 + rand() * 3; }
        S.nextEventAt = S.simT + 9 + rand() * 7;
      }
      if (S.event === 'gantry' || S.event === 'overpass') {
        S.eventY -= S.speed * dt;
        if (S.eventY < -400) S.event = null;
      } else if (S.event === 'tunnel') {
        S.tunnelA = clamp(S.tunnelA + dt * 2, 0, 1);
        if (S.simT > S.tunnelUntil) S.event = null;
      }
      if (S.event !== 'tunnel') S.tunnelA = clamp(S.tunnelA - dt * 2, 0, 1);

      // waves — and never a long empty road
      S.waveIn -= dt;
      if (S.waveIn <= 0) spawnWave();
      let ahead = 0;
      for (const c of cars) if (c.on && c.y > 0) ahead++;
      if (ahead < 2) S.waveIn = Math.min(S.waveIn, 0.15);

      // traffic
      S.changeCooldown -= dt;
      const pw = PLAYER_W_U * HIT_FORGIVE, pl = PLAYER_L_U * HIT_FORGIVE;
      for (const c of cars) {
        if (!c.on) continue;
        c.y -= (S.speed - c.spd) * dt;
        if (c.y < DESPAWN_Y) { c.on = false; continue; }

        // deterministic AI lane change (only far ahead of the player line)
        if (c.changeAt > 0 && S.simT >= c.changeAt && c.changing === 0 && c.y > 330 && S.changeCooldown <= 0) {
          const dir = c.lane === 0 ? 1 : c.lane === LANES - 1 ? -1 : (rand() < 0.5 ? -1 : 1);
          const target = c.lane + dir;
          let ok = true;
          for (const o of cars) {
            if (!o.on || o === c) continue;
            if (Math.round(o.laneF) === target && Math.abs(o.y - c.y) < 240) { ok = false; break; }
          }
          if (ok) { c.sig = 0.42; c.sigDir = dir; c.changing = -1; S.changeCooldown = Math.max(0.45, 1.1 - over() * 0.35); }
          c.changeAt = -1;
        }
        if (c.changing === -1) {
          c.sig -= dt;
          if (c.sig <= 0) { c.changing = 1; c.lane = clamp(c.lane + c.sigDir, 0, LANES - 1); }
        } else if (c.changing === 1) {
          c.laneF += (c.lane - c.laneF) * Math.min(1, dt * 5);
          if (Math.abs(c.laneF - c.lane) < 0.02) { c.laneF = c.lane; c.changing = 0; }
        }

        const cx = laneCenter(c.laneF), px = S.laneX;
        const v = VEHICLES[c.kind];
        const dx = Math.abs(cx - px);
        const sumW = (v.wid * HIT_FORGIVE + pw) / 2;
        const overlapY = Math.abs(c.y) < (v.len * HIT_FORGIVE + pl) / 2;

        if (!S.dead && overlapY && dx < sumW) {
          // ── CRASH ──
          S.dead = true; S.deadT = 0; S.shake = 1; S.flash = 1;
          crashBurst(roadX + px * u2p, playerY);
          audio?.crash();
          break;
        }
        // near miss — longitudinally overlapping, laterally just clear
        if (!c.near && !S.dead && overlapY && dx >= sumW && dx < sumW + 44) {
          c.near = true;
          S.combo = (S.simT - S.comboT < 1.5) ? Math.min(S.combo + 1, 4) : 1;
          S.comboT = S.simT;
          const pts = PTS_NEAR * S.combo;
          S.score += pts;
          S.flash = Math.max(S.flash, 0.34);
          S.scorePop = 1;
          addFloat(roadX + cx * u2p, playerY - c.y * u2p - 20, `+${pts}${S.combo > 1 ? ' ×' + S.combo : ''}`);
          sparkTrail(roadX + ((cx + px) / 2) * u2p, playerY - c.y * u2p, 5);
          audio?.whoosh();
        }
      }

      if (S.simT - S.lastPing > 0.35) {
        S.lastPing = S.simT;
        cbRef.current.onProgress?.(Math.floor(S.score), Math.floor(S.simT * 1000));
      }
    }

    function updateFX(dt) {
      S.flash = Math.max(0, S.flash - dt * 3);
      S.shake = Math.max(0, S.shake - dt * 2.2);
      S.scorePop = Math.max(0, S.scorePop - dt * 4);
      for (const p of parts) {
        if (!p.on) continue;
        p.age += dt;
        if (p.age >= p.life) { p.on = false; continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vy += (p.kind === 2 ? -50 : 900) * dt;
      }
      for (const f of floats) { if (f.on) { f.age += dt; f.y -= 44 * dt; if (f.age >= f.life) f.on = false; } }
      for (const p of puffs) { if (p.on) { p.age += dt; p.y += 60 * dt; if (p.age >= p.life) p.on = false; } }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  RENDER
    // ─────────────────────────────────────────────────────────────────────────
    const wy2sy = (wy) => playerY - wy * u2p;

    function render(nowMs) {
      const sp = sprites;
      // Off-road surround = the site background behind the canvas.
      const light = isLight();
      drawVoid(light);

      const shx = S.shake ? (frand() - 0.5) * 16 * S.shake : 0;
      const shy = S.shake ? (frand() - 0.5) * 12 * S.shake : 0;
      const tilt = clamp(S.laneVel * 0.0000075, -0.009, 0.009);
      const camX = -(S.laneX - LANE_U * LANES / 2) * u2p * 0.022;

      ctx.save();
      ctx.translate(W / 2 + shx + camX, H + shy);
      ctx.rotate(tilt);
      ctx.translate(-W / 2, -H);

      drawRoad(light);
      drawTraffic(nowMs);
      if (!S.dead) drawPlayer(nowMs);
      drawPuffs();
      drawParticles();
      drawFloats();
      ctx.restore();

      if (S.flash > 0.01) {
        ctx.globalAlpha = S.flash;
        ctx.drawImage(sp.edgeFlash, 0, 0);
        ctx.globalAlpha = 1;
      }
      const d = diff();
      if (d > 0.35 && !S.dead) {
        ctx.strokeStyle = `rgba(159,220,255,${(d - 0.35) * 0.3})`;
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 8; i++) {
          const t = ((nowMs * (0.9 + d) * 0.001) + i * 0.37) % 1;
          const y = t * t * H;
          const side = i % 2 ? 1 : -1;
          const x = W / 2 + side * (roadW / 2 + 14 + t * 30);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 30 + t * 90); ctx.stroke();
        }
      }
      if (!light) ctx.drawImage(sp.vignette, 0, 0); // a dark vignette would muddy light mode

      // Blow the world buffer up onto the real canvas. Nearest-neighbour, whole
      // factor: every virtual pixel becomes an exact pix x pix block.
      dctx.imageSmoothingEnabled = false;
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.drawImage(world, 0, 0, W, H, 0, 0, W * pix, H * pix);

      // HUD is drawn after the upscale, at full resolution, so the score and
      // timer stay crisp rather than becoming chunky along with the art.
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawHUD(nowMs);
      dctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── The void either side of the road ────────────────────────────────────
    // Not decoration. The road is the only lit thing in frame, so everything
    // around it has to fall away rather than compete.
    function drawVoid(light) {
      if (light) { ctx.fillStyle = '#e9edf3'; ctx.fillRect(0, 0, W, H); return; }
      ctx.fillStyle = PAL.void0;
      ctx.fillRect(0, 0, W, H);
      // two flat bands rather than a gradient — a gradient at this resolution
      // just produces visible banding, which reads as a rendering fault
      ctx.fillStyle = PAL.void1;
      ctx.fillRect(0, Math.round(H * 0.34), W, H);
    }

    // ── Road ────────────────────────────────────────────────────────────────
    // Night highway, drawn entirely in whole pixels. Three tones of asphalt, a
    // dithered crown, bright lane dashes, and neon kerbs that are the only
    // saturated colour in the frame.
    function drawRoad(light) {
      const x0 = roadX, x1 = roadX + roadW;
      if (light) {
        ctx.fillStyle = '#c9d2de'; ctx.fillRect(x0, 0, roadW, H);
      } else {
        ctx.fillStyle = PAL.road0; ctx.fillRect(x0, 0, roadW, H);
        // crown: a lighter band down the centre of the carriageway
        ctx.fillStyle = PAL.road1;
        ctx.fillRect(x0 + Math.round(roadW * 0.12), 0, Math.round(roadW * 0.76), H);
        ctx.fillStyle = PAL.road2;
        ctx.fillRect(x0 + Math.round(roadW * 0.30), 0, Math.round(roadW * 0.40), H);
        // ordered dither along the tone boundaries, so the bands read as a
        // gradient without ever showing a hard edge
        const scroll = Math.round(S.dist * VISUAL_SCROLL * u2p);
        for (const bx of [x0 + Math.round(roadW * 0.12), x0 + Math.round(roadW * 0.30),
                          x0 + Math.round(roadW * 0.70), x0 + Math.round(roadW * 0.88)]) {
          ctx.fillStyle = PAL.road1;
          for (let y = -((scroll % 2) + 2); y < H; y += 2) ctx.fillRect(bx - 1, y, 1, 1);
        }
      }

      // ── lane markings ─────────────────────────────────────────────────────
      // Same two-layer rule as before, now on the pixel grid: a dim continuous
      // rail so a lane line exists in every frame at any speed, plus bright
      // dashes on the cadence that keeps them clear of the frame rate.
      const stepPx = Math.max(4, Math.round(MARK_CYCLE * u2p));
      const dashPx = Math.max(2, Math.round(MARK_LEN * u2p));
      const off = Math.round(S.dist * VISUAL_SCROLL * u2p) % stepPx;
      const lw = Math.max(1, Math.round(roadW * 0.008));
      for (let i = 1; i < LANES; i++) {
        const x = x0 + laneW * i - Math.floor(lw / 2);
        ctx.fillStyle = light ? '#ffffff' : PAL.lineDim;
        ctx.fillRect(x, 0, lw, H);
        ctx.fillStyle = light ? '#ffffff' : PAL.line;
        for (let y = off - stepPx; y < H + stepPx; y += stepPx) {
          ctx.fillRect(x, y, lw, dashPx);
        }
      }

      // ── kerbs ─────────────────────────────────────────────────────────────
      if (!light) {
        const glow = Math.max(2, Math.round(roadW * 0.035));
        ctx.fillStyle = PAL.kerbDim;
        ctx.fillRect(x0, 0, glow, H);
        ctx.fillRect(x1 - glow, 0, glow, H);
      }
      const kw = Math.max(1, Math.round(roadW * 0.012));
      ctx.fillStyle = light ? '#8894a6' : PAL.kerb;
      ctx.fillRect(x0, 0, kw, H);
      ctx.fillRect(x1 - kw, 0, kw, H);

      // ── distance falloff ──────────────────────────────────────────────────
      // Stepped, not smooth: at this resolution a gradient bands anyway, so the
      // road fades into the night in a handful of deliberate bars instead.
      if (!light) {
        const steps = 7, band = Math.round(H * 0.30) / steps;
        for (let i = 0; i < steps; i++) {
          ctx.globalAlpha = 0.30 * (1 - i / steps);
          ctx.fillStyle = PAL.void0;
          ctx.fillRect(0, Math.round(i * band), W, Math.ceil(band) + 1);
        }
        ctx.globalAlpha = 1;
      }
    }

    function drawTraffic(nowMs) {
      const sp = sprites;
      const list = [];
      for (const c of cars) if (c.on && c.y < SPAWN_Y + 80 && c.y > DESPAWN_Y) list.push(c);
      list.sort((a, b) => b.y - a.y); // far → near
      for (const c of list) {
        const v = VEHICLES[c.kind];
        const img = sp.vkey(c.kind, c.paint);
        const cx = roadX + laneCenter(c.laneF) * u2p;
        const cy = wy2sy(c.y);
        const wpx = v.wid * u2p, lpx = v.len * u2p;
        if (cy < -lpx || cy > H + lpx) continue;
        ctx.globalAlpha = 0.4;
        ctx.drawImage(sp.shadow, cx - wpx * 0.62, cy - lpx * 0.5, wpx * 1.24, lpx * 1.06);
        ctx.globalAlpha = 1;
        ctx.drawImage(img, cx - wpx / 2, cy - lpx / 2, wpx, lpx);
        if (c.brake || c.spd < S.speed * 0.42) {
          ctx.globalAlpha = 0.5;
          const gs = Math.max(4, wpx * 0.5);
          ctx.drawImage(sp.glowRed, cx - wpx * 0.3 - gs / 2, cy + lpx / 2 - gs * 0.55, gs, gs);
          ctx.drawImage(sp.glowRed, cx + wpx * 0.3 - gs / 2, cy + lpx / 2 - gs * 0.55, gs, gs);
          ctx.globalAlpha = 1;
        }
        if (c.changing === -1 && Math.floor(nowMs / 130) % 2 === 0) {
          const sx = cx + c.sigDir * wpx * 0.42;
          ctx.globalAlpha = 0.9;
          const as = Math.max(3, wpx * 0.38);
          ctx.drawImage(sp.glowAmber, sx - as / 2, cy - lpx / 2 - as * 0.3, as, as);
          ctx.drawImage(sp.glowAmber, sx - as / 2, cy + lpx / 2 - as * 0.7, as, as);
          ctx.globalAlpha = 1;
        }
      }
    }

    function drawPlayer(nowMs) {
      const sp = sprites;
      const px = roadX + S.laneX * u2p;
      const pw = sp.playerW, pl = sp.playerL;
      const roll = clamp(S.laneVel * 0.00023, -0.1, 0.1);
      const squash = 1 - Math.min(0.035, Math.abs(S.laneVel) * 0.00004);

      // The player is the brightest source on the road — the one thing the eye
      // should never have to search for.
      // Underglow, kept low: on the pixel grid a strong one shows up as an
      // obvious rectangle behind the car rather than as light.
      const pulse = 0.20 + Math.sin(nowMs * 0.006) * 0.05;
      ctx.globalAlpha = pulse;
      ctx.drawImage(sp.glowCyan, px - pw * 0.85, playerY - pl * 0.4, pw * 1.7, pl * 0.9);
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.45;
      ctx.drawImage(sp.shadow, px - pw * 0.66, playerY - pl * 0.5, pw * 1.32, pl * 1.04);
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(px, playerY);
      ctx.rotate(roll);
      ctx.scale(1, squash);
      ctx.drawImage(sp.player, -pw / 2, -pl / 2, pw, pl);
      ctx.restore();
    }

    function drawPuffs() {
      const sp = sprites;
      for (const p of puffs) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a * 0.5;
        const s = 20 * p.s * (1 + p.age * 2.4);
        ctx.drawImage(sp.smokePuff, p.x - s / 2, p.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
    }

    function drawParticles() {
      for (const p of parts) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        if (p.kind === 2) {
          ctx.globalAlpha = a * 0.4;
          const s = p.s * (1 + p.age * 2);
          ctx.drawImage(sprites.smokePuff, p.x - s, p.y - s, s * 2, s * 2);
        } else {
          ctx.globalAlpha = a;
          ctx.fillStyle = p.c;
          ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
      }
      ctx.globalAlpha = 1;
    }

    function drawFloats() {
      ctx.textAlign = 'center';
      for (const f of floats) {
        if (!f.on) continue;
        const a = 1 - f.age / f.life;
        ctx.globalAlpha = clamp(a * 1.4, 0, 1);
        ctx.font = `900 ${18 + (1 - a) * 3}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = '#04070D';
        ctx.fillText(f.txt, f.x + 1.5, f.y + 1.5);
        ctx.fillStyle = CYAN;
        ctx.fillText(f.txt, f.x, f.y);
      }
      ctx.globalAlpha = 1;
    }

    // ── HUD: score, time, pause, GO, hint, game-over ──
    function drawHUD(nowMs) {
      const score = Math.floor(S.score);
      const popS = 1 + S.scorePop * 0.12;
      // The HUD lives in CSS pixels, not on the pixel-art grid — chunky score
      // digits would be unreadable. Positions come from the virtual grid, so
      // they are converted across here.
      // The HUD lives in CSS pixels, not on the pixel-art grid — chunky score
      // digits would be unreadable. Positions come from the virtual grid, so
      // they are converted across here.
      const hs = (canvas.width / dpr) / W;
      const hW = W * hs, hRoadX = roadX * hs, hRoadW = roadW * hs;

      // Anchor the readouts to the ROAD, not the canvas. On a wide desktop the
      // road is centred with black either side, so canvas-corner placement threw
      // score/time out to the far edges away from the action.
      const hudL = Math.max(16, hRoadX + 12);
      const hudR = Math.min(hW - 16, hRoadX + hRoadW - 12);

      dctx.save();
      dctx.translate(hudL, 46);
      dctx.scale(popS, popS);
      dctx.textAlign = 'left';
      dctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
      dctx.fillStyle = 'rgba(0,0,0,0.7)';
      dctx.fillText(score.toLocaleString(), 2, 2);
      dctx.fillStyle = '#F2F8FF';
      dctx.fillText(score.toLocaleString(), 0, 0);
      dctx.restore();
      dctx.textAlign = 'left';
      dctx.font = '800 10px Inter, system-ui, sans-serif';
      dctx.fillStyle = 'rgba(159,220,255,0.75)';
      dctx.fillText('SCORE', hudL + 1, 61);

      dctx.textAlign = 'right';
      dctx.font = '900 22px "JetBrains Mono", ui-monospace, monospace';
      dctx.fillStyle = 'rgba(0,0,0,0.7)';
      dctx.fillText(S.simT.toFixed(1) + 's', hudR + 2, 44);
      dctx.fillStyle = '#F2F8FF';
      dctx.fillText(S.simT.toFixed(1) + 's', hudR, 42);
      dctx.font = '800 10px Inter, system-ui, sans-serif';
      dctx.fillStyle = 'rgba(159,220,255,0.75)';
      dctx.fillText('TIME', hudR - 1, 58);

      // GO! flash
      if (S.goT < 0.75 && !S.dead) {
        const a = S.goT < 0.5 ? 1 : 1 - (S.goT - 0.5) / 0.25;
        const sc = 1 + S.goT * 0.7;
        dctx.save();
        dctx.globalAlpha = a;
        dctx.translate(hW / 2, (canvas.height / dpr) * 0.38);
        dctx.scale(sc, sc);
        dctx.textAlign = 'center';
        dctx.font = '900 54px Inter, system-ui, sans-serif';
        dctx.fillStyle = 'rgba(0,0,0,0.6)';
        dctx.fillText('GO!', 3, 3);
        dctx.fillStyle = CYAN;
        dctx.fillText('GO!', 0, 0);
        dctx.restore();
      }
      // controls hint
      if (S.hintT < 3.6 && !S.dead) {
        const a = S.hintT < 2.8 ? 0.85 : 0.85 * (1 - (S.hintT - 2.8) / 0.8);
        dctx.globalAlpha = a;
        dctx.textAlign = 'center';
        dctx.font = '700 11px Inter, system-ui, sans-serif';
        dctx.fillStyle = 'rgba(5,8,14,0.6)';
        rr(ctx, hW / 2 - 108, (canvas.height / dpr) - 40, 216, 24, 12); dctx.fill();
        dctx.fillStyle = ICE;
        dctx.fillText('← → / A D  ·  swipe to change lanes', hW / 2, (canvas.height / dpr) - 24);
        dctx.globalAlpha = 1;
      }

      // game-over overlay before values are returned
      if (S.dead && S.deadT > OVERLAY_S) {
        const a = clamp((S.deadT - OVERLAY_S) / 0.35, 0, 1);
        dctx.globalAlpha = a;
        const g = dctx.createLinearGradient(0, (canvas.height / dpr) * 0.28, 0, (canvas.height / dpr) * 0.74);
        g.addColorStop(0, 'rgba(2,3,8,0)');
        g.addColorStop(0.3, 'rgba(2,3,8,0.86)');
        g.addColorStop(0.7, 'rgba(2,3,8,0.86)');
        g.addColorStop(1, 'rgba(2,3,8,0)');
        dctx.fillStyle = g;
        dctx.fillRect(0, (canvas.height / dpr) * 0.28, hW, (canvas.height / dpr) * 0.46);
        dctx.textAlign = 'center';
        dctx.font = '900 38px Inter, system-ui, sans-serif';
        dctx.fillStyle = '#FF4D42';
        dctx.fillText('GAME OVER', hW / 2, (canvas.height / dpr) * 0.42);
        dctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
        dctx.fillStyle = '#F2F8FF';
        dctx.fillText(Math.floor(S.score).toLocaleString(), hW / 2, (canvas.height / dpr) * 0.5);
        dctx.font = '700 13px Inter, system-ui, sans-serif';
        dctx.fillStyle = 'rgba(159,220,255,0.85)';
        dctx.fillText(`survived ${S.simT.toFixed(1)}s`, hW / 2, (canvas.height / dpr) * 0.55);
        dctx.strokeStyle = 'rgba(0,191,255,0.5)';
        dctx.lineWidth = 1.5;
        dctx.beginPath(); dctx.moveTo(hW / 2 - 60, (canvas.height / dpr) * 0.585); dctx.lineTo(hW / 2 + 60, (canvas.height / dpr) * 0.585); dctx.stroke();
        dctx.font = '700 12px Inter, system-ui, sans-serif';
        dctx.fillStyle = 'rgba(180,195,215,0.6)';
        dctx.fillText('waiting for opponent…', hW / 2, (canvas.height / dpr) * 0.625);
        dctx.globalAlpha = 1;
      }
    }

    // ── Main loop ──
    let raf = 0, last = performance.now();
    function loop(now) {
      raf = requestAnimationFrame(loop);
      let dt = (now - last) / 1000;
      last = now;
      dt = Math.min(dt, 1 / 30);

      if (!S.dead) {
        update(dt);
        updateFX(dt);
      } else {
        S.deadT += dt;
        if (S.deadT > FREEZE_S) updateFX(dt); // 0.15s freeze-frame
        if (!S.reported && S.deadT > REPORT_S) {
          S.reported = true;
          cbRef.current.onCrash?.(Math.floor(S.score), Math.floor(S.simT * 1000));
        }
      }
      render(now);
    }

    render(performance.now());
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeT);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      audio?.stop();
    };
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="relative w-full bg-bg flex justify-center overflow-hidden"
      style={{ height: 'calc(100dvh - 56px)' }}
    >
      {/* Night ambience behind the play area. On a wide screen the road cannot
          fill the width without either distorting the cars or cutting the fixed
          700-unit view distance that keeps the match fair, so the play area
          stays portrait and the surround is lit rather than left dead black. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 75% at 50% 62%, rgba(18,80,180,0.16) 0%, rgba(6,12,24,0.5) 45%, rgba(0,0,0,0.92) 100%)',
        }}
      />
      {/* Aspect cap: roadW works out at ~0.44x the canvas height, so a canvas
          about half as wide as it is tall puts the road at ~90% of the frame.
          Narrow screens are already taller than this and are unaffected. */}
      <canvas
        ref={canvasRef}
        className="relative h-full block touch-none select-none w-full"
        style={{ cursor: 'pointer', maxWidth: 'calc((100dvh - 56px) * 0.52)' }}
      />
    </div>
  );
}
