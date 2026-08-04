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
// World units visible above the player — fixed on all devices, because both
// players in a match must get the same reaction distance whatever they play on.
// This value also decides where the player sits on screen: the player line is
// placed at VIEW_AHEAD * scale, so lowering it moves the car DOWN the screen.
// 590 puts it in the bottom third at normal phone and desktop aspects.
const VIEW_AHEAD   = 590;
const PLAYER_YF    = 0.78;   // legacy default; the player line is derived in layout()
const SPAWN_Y      = 880;    // > VIEW_AHEAD + longest vehicle, so nothing pops in
const DESPAWN_Y    = -280;

const SPD_START    = 585;    // u/s
const SPD_MAX      = 1150;
// Seconds to full difficulty. Shortened from 48: the old curve spent most of a
// minute easing in, so a run only became interesting once it was nearly over.
const RAMP_S       = 26;
// The first stretch stays a warm-up, matching the old pace to the knee. Past
// RAMP_KNEE the curve is deliberately steeper than it used to be — by 25s it
// now runs at ~906 u/s where the old curve gave ~884, and by 30s ~1058 against
// ~971 — so the run tightens noticeably from that point instead of drifting.
const RAMP_KNEE    = 10;     // seconds before the difficulty curve steepens
const KNEE_AT      = 0.30;   // difficulty reached at the knee
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
// How far outside the hitboxes still counts as a near miss, in world units.
// Widening this makes the bonus easier to earn without touching collisions —
// the hitbox itself is unchanged, so nothing about crashing gets more lenient.
// Near misses are earned by CUTTING IN BEHIND a vehicle, never by sitting
// alongside one. Running level with a car in the next lane is not a piece of
// driving — the gap does not change and there is no decision in it. Slipping in
// behind one, just after its tail has passed, is.
//   NEAR_BAND — how far to the side of the car the player may be, in world units
//   NEAR_TAIL — how far behind its rear bumper still counts
// How close behind a car the player must get, IN ITS LANE, before a swerve out
// counts at all. This was 150 — a lane and a half back, so a player could arm
// it while still far away, drift across, and be paid for an ordinary pass. At
// 52 the nose is genuinely on the car's bumper before it arms.
const NEAR_ARM     = 52;
// And the swerve has to be a reaction to that, not a leisurely drift: the move
// must complete within this many seconds of arming.
const NEAR_WINDOW  = 0.85;
const NEAR_BAND    = 88;
const NEAR_TAIL    = 74;

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
  road0:  '#0B0E14', road1:  '#101420', road2:  '#151A29',
  line:   '#E6F2FF', lineDim:'#5C7CA8',
  kerb:   '#1250B4', kerbDim:'#0A2A5C',
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
const PLAYER_L_U = 104;  // player world length (sprite + hitbox)
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
// Underglow shaped like the thing it is under.
//
// bakeGlow below produces square rings, which is fine for a small point source
// like a lamp but reads as a glowing rectangle parked beneath the car. This
// builds the glow from the car's OWN silhouette instead: the sprite is stamped
// a few times at increasing size and low alpha, then the accumulation is
// tinted, so the light hugs the bodywork.
function bakeShapedGlow(sprite, hex, pad) {
  const w = sprite.width, l = sprite.height;
  const W2 = w + pad * 2, H2 = l + pad * 2;
  return bake(W2, H2, (g) => {
    const STEPS = 3;
    for (let i = STEPS; i >= 1; i--) {
      const grow = (pad * i) / STEPS;
      g.globalAlpha = 0.16 + 0.10 * (STEPS - i);
      g.drawImage(sprite, pad - grow, pad - grow, w + grow * 2, l + grow * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = hex;
    g.fillRect(0, 0, W2, H2);
  });
}

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
      // Rounded rather than square: a hard-cornered box never reads as light.
      rr(g, Math.round(w / 2 - rad), Math.round(h / 2 - rad), rad * 2, rad * 2, Math.max(1, Math.round(rad * 0.55)));
      g.fill();
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

// ── Player car ──────────────────────────────────────────────────────────────
// A GT3 RS read from above: wide low body, pronounced front wheel arches that
// stand proud of the nose, a cab-forward roof, a waisted middle, huge rear
// haunches, and a swan-neck wing that overhangs the bodywork. Black bodywork
// with a blue centre section and grey arches and aero, which also keeps it
// clearly apart from traffic without using traffic's colours.
function bakePlayer(wpx, lpx) {
  const w = Math.max(10, Math.round(wpx));
  const l = Math.max(16, Math.round(lpx));
  const cx = Math.floor(w / 2);

  const BLACK   = '#101418';   // bodywork
  const BLACK_HI= '#2A3138';   // lit flank
  const BLACK_LO= '#080A0D';   // shaded flank
  const BLUE    = '#1668FF';   // centre section
  const BLUE_HI = '#63AEFF';
  const GREY    = '#79838F';   // arches, splitter, wing
  const GREY_HI = '#AFB9C4';
  const EDGE    = '#04070B';

  // Half-width down the length. The two bulges are the wheel arches — on a GT3
  // RS they are the widest points of the car, wider than the doors, and that is
  // most of what makes the shape recognisable from above.
  const KEYS = [
    [0.00, 0.56], [0.05, 0.66], [0.10, 0.80], [0.17, 0.84],
    [0.24, 0.80], [0.34, 0.70], [0.46, 0.70], [0.58, 0.76],
    [0.66, 0.88], [0.76, 0.90], [0.86, 0.84], [0.94, 0.78],
    [1.00, 0.70],
  ];
  const halfAtF = (f) => {
    for (let i = 1; i < KEYS.length; i++) {
      if (f <= KEYS[i][0]) {
        const [f0, v0] = KEYS[i - 1], [f1, v1] = KEYS[i];
        return v0 + (v1 - v0) * ((f - f0) / (f1 - f0 || 1));
      }
    }
    return KEYS[KEYS.length - 1][1];
  };

  return bake(w, l, (g) => {
    const half = [];
    for (let y = 0; y < l; y++) half[y] = Math.max(1, Math.round(halfAtF(y / (l - 1)) * (w / 2)));

    // tyres, sitting in the arches
    const tyreL = Math.max(2, Math.round(l * 0.10));
    for (const ty of [Math.round(l * 0.12), Math.round(l * 0.68)]) {
      for (let y = ty; y < Math.min(l, ty + tyreL); y++) {
        px(g, cx - half[y] - 1, y, 2, 1, PAL.tyre);
        px(g, cx + half[y] - 1, y, 2, 1, PAL.tyre);
      }
    }

    // body: outline, black fill, lit left flank, shaded right
    for (let y = 0; y < l; y++) {
      const h = half[y];
      px(g, cx - h, y, h * 2, 1, EDGE);
      if (h > 1) px(g, cx - h + 1, y, (h - 1) * 2, 1, BLACK);
      if (h > 2) {
        px(g, cx - h + 1, y, 1, 1, BLACK_HI);
        px(g, cx + h - 2, y, 1, 1, BLACK_LO);
      }
    }

    // grey arch caps over both axles — the RS cue
    for (const [ay, ah] of [[Math.round(l * 0.09), Math.round(l * 0.11)],
                            [Math.round(l * 0.65), Math.round(l * 0.13)]]) {
      for (let y = ay; y < Math.min(l, ay + ah); y++) {
        px(g, cx - half[y] + 1, y, 1, 1, GREY);
        px(g, cx + half[y] - 2, y, 1, 1, GREY);
      }
    }

    // blue centre section, nose to tail, narrowing over the cabin
    const bw = Math.max(2, Math.round(w * 0.34));
    px(g, cx - Math.floor(bw / 2), Math.round(l * 0.05), bw, Math.round(l * 0.30), BLUE);
    px(g, cx - Math.floor(bw / 2), Math.round(l * 0.05), 1, Math.round(l * 0.30), BLUE_HI);
    px(g, cx - Math.floor(bw / 2), Math.round(l * 0.60), bw, Math.round(l * 0.24), BLUE);
    px(g, cx - Math.floor(bw / 2), Math.round(l * 0.60), 1, Math.round(l * 0.24), BLUE_HI);

    // grey front splitter
    const spY = Math.max(1, Math.round(l * 0.03));
    px(g, cx - half[spY] + 1, spY, (half[spY] - 1) * 2, 1, GREY);

    // headlights, set into the arches
    const hl = Math.max(2, Math.round(l * 0.07));
    const hw = Math.max(2, Math.round(w * 0.14));
    px(g, cx - half[hl] + 2, hl, hw, 1, PAL.lampW);
    px(g, cx + half[hl] - 2 - hw, hl, hw, 1, PAL.lampW);

    // cab-forward glasshouse
    const c0 = Math.round(l * 0.34), c1 = Math.round(l * 0.58);
    for (let y = c0; y < c1; y++) {
      const t = (y - c0) / Math.max(1, c1 - c0 - 1);
      const gh = Math.max(1, Math.round(half[y] * (0.74 - 0.20 * t)));
      px(g, cx - gh, y, gh * 2, 1, PAL.glass);
      if (y === c0) px(g, cx - gh, y, gh * 2, 1, PAL.glassLit);
      if (t > 0.2 && t < 0.6) px(g, cx - gh + 1, y, 1, 1, PAL.glassLit);
    }

    // engine louvres over the rear deck
    const lv = Math.round(l * 0.62);
    for (let i = 0; i < 3; i++) {
      const y = lv + i * 2;
      if (y < l) px(g, cx - Math.round(w * 0.22), y, Math.round(w * 0.44), 1, BLACK_LO);
    }

    // swan-neck wing: grey, standing clear and overhanging both flanks
    const wy = Math.round(l * 0.855);
    const wingH = Math.max(2, Math.round(l * 0.05));
    const wingW = Math.min(w, half[wy] * 2 + Math.max(2, Math.round(w * 0.14)));
    const wx = cx - Math.floor(wingW / 2);
    px(g, wx, wy, wingW, wingH, EDGE);
    px(g, wx + 1, wy, wingW - 2, 1, GREY_HI);
    px(g, wx + 1, wy + 1, wingW - 2, Math.max(1, wingH - 2), GREY);
    // the two uprights
    px(g, cx - Math.round(w * 0.18), wy + wingH, 1, 2, GREY);
    px(g, cx + Math.round(w * 0.18), wy + wingH, 1, 2, GREY);

    // tail: red clusters, grey diffuser between them
    const ty2 = l - Math.max(2, Math.round(l * 0.05));
    const tw = Math.max(2, Math.round(w * 0.2));
    px(g, cx - half[l - 2] + 1, ty2, tw, 1, PAL.lampR);
    px(g, cx + half[l - 2] - 1 - tw, ty2, tw, 1, PAL.lampR);
    px(g, cx - Math.round(w * 0.16), l - 1, Math.max(2, Math.round(w * 0.32)), 1, GREY);
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
      // The road fills the width. Scale therefore comes from the width alone,
      // snapped to a whole pixel so lane lines and cars never straddle one.
      laneW = Math.max(8, Math.floor((W * 0.995) / LANES));
      u2p = laneW / LANE_U;
      roadW = laneW * LANES;
      roadX = Math.round((W - roadW) / 2);

      // Because the scale is now set by the width, the player line has to move
      // to keep the view ahead at exactly VIEW_AHEAD units. That constancy is a
      // fairness requirement, not a style choice: both players in a match must
      // get the same reaction distance whatever device they are on. The clamp
      // guarantees some road behind the player; the canvas aspect is capped in
      // the JSX so the clamp never actually binds.
      playerY = Math.round(clamp(VIEW_AHEAD * u2p, H * 0.52, H * 0.82));
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
        playerGlow: bakeShapedGlow(bakePlayer(playerW, playerL), CYAN, Math.max(2, Math.round(playerW * 0.16))),
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
      spd: 0, near: false, armed: false, armedAt: 0, sig: 0, sigDir: 0, changeAt: -1, changing: 0, brake: false,
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

    // Two-piece curve. Up to RAMP_KNEE it climbs gently to KNEE_AT; after that
    // it accelerates to full difficulty by RAMP_S. A single smoothstep spent
    // too long being easy — by 16s it was barely a fifth of the way up.
    const diff = () => {
      const t = S.simT;
      if (t <= RAMP_KNEE) return smooth(t / RAMP_KNEE) * KNEE_AT;
      const u = clamp((t - RAMP_KNEE) / (RAMP_S - RAMP_KNEE), 0, 1);
      return KNEE_AT + (1 - KNEE_AT) * smooth(u);
    };
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
      // Non-passive: this preventDefault is what stops the browser starting a
      // text selection (and the blue highlight that comes with it) on a swipe.
      if (e.cancelable) e.preventDefault();
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
      audio?.resume();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      sw.active = true; sw.id = e.pointerId;
      sw.startX = x; sw.fired = false;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ } }
    };
    const onPointerMove = (e) => {
      if (!sw.active || sw.fired || e.pointerId !== sw.id) return;
      if (e.cancelable) e.preventDefault();
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
    // Dev-only inspection hook. `import.meta.env.DEV` is statically false in a
    // production build, so this whole block is dropped by the bundler and never
    // reaches players. It exists so survivability can be PROVEN by solving real
    // runs headlessly, rather than assumed from reading the spawner.
    if (import.meta.env.DEV) {
      canvas.__rh = { S, cars, VEHICLES, LANES, LANE_U, PLAYER_L_U, PLAYER_W_U, move, laneCenter };
    }

    window.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    const noSelect = (e) => e.preventDefault();
    canvas.addEventListener('selectstart', noSelect);
    canvas.addEventListener('contextmenu', noSelect);

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
    // A lane counts as clear only if nothing occupies it anywhere along the
    // stretch the player still has to drive through — including cars that are
    // part-way through a lane change into it.
    function laneRunClear(l) {
      for (const c of cars) {
        if (!c.on) continue;
        if (c.y < -60 || c.y > SPAWN_Y + 240) continue;
        if (Math.round(c.laneF) === l || c.lane === l) return false;
        if (c.changing === -1 && clamp(c.lane + c.sigDir, 0, LANES - 1) === l) return false;
      }
      return true;
    }

    // How long a car indicates before it moves. Long enough to read and react
    // to, which is the point — the indicator is information, not decoration.
    const SIGNAL_S = 1.5;

    // Is `target` clear for `c` to move into? Considers cars occupying the lane,
    // cars sliding into it, and cars indicating into it — without the last two,
    // two vehicles can pick the same gap from opposite sides and merge into one
    // another.
    function laneChangeClear(c, target) {
      if (target < 0 || target > LANES - 1) return false;
      // The open lane stays open. Without this an indicating car can seal the
      // only way through after the wave has already committed to leaving it.
      if (target === S.corridor) return false;
      for (const o of cars) {
        if (!o.on || o === c) continue;
        const occupies = Math.round(o.laneF) === target || o.lane === target;
        const heading = o.changing !== 0 && clamp(o.lane + (o.changing === -1 ? o.sigDir : 0), 0, LANES - 1) === target;
        if (!occupies && !heading) continue;
        if (Math.abs(o.y - c.y) < 300) return false;
      }
      return true;
    }

    function spawnWave() {
      const d = diff();
      S.waveN++;
      // ── Guaranteeing a way through ──────────────────────────────────────
      // The corridor is the lane deliberately left open. It random-walks by at
      // most one lane per wave so the player can always follow it.
      //
      // Leaving it free at spawn time is NOT enough on its own, which is what
      // used to let a wall form: a slow car from an EARLIER wave can still be
      // sitting in the lane the corridor moves into, and the player closes on
      // it. So the corridor may only move to a lane that is genuinely empty
      // across the whole approach, and if no candidate is, it stays put.
      const step = rand();
      const want = clamp(S.corridor + (step < 0.44 ? -1 : step < 0.88 ? 1 : 0), 0, LANES - 1);
      S.corridor = laneRunClear(want) ? want
                 : laneRunClear(S.corridor) ? S.corridor
                 : (laneRunClear(clamp(S.corridor - 1, 0, LANES - 1)) ? clamp(S.corridor - 1, 0, LANES - 1)
                 : laneRunClear(clamp(S.corridor + 1, 0, LANES - 1)) ? clamp(S.corridor + 1, 0, LANES - 1)
                 : S.corridor);

      // How many lanes a single wave may block. With four lanes, three blocked
      // at once leaves exactly one gap and reads as a wall — fine deep into a
      // run, far too much in the opening seconds.
      const maxBlock = S.simT < 7 ? 1 : S.simT < 16 ? 2 : 3;
      let n = 1 + Math.floor(rand() * maxBlock);
      if (S.waveN % 6 === 0) n = Math.max(1, n - 1);   // breathing pocket
      if (S.simT < 4) n = 1;                           // gentle first seconds

      // ── Which lanes this wave blocks ────────────────────────────────────
      // Leaving one lane open is not sufficient on its own. Blocking lanes 1
      // and 2 while leaving 0 and 3 open technically leaves a gap, but a player
      // over on lane 3 is walled off from the corridor on lane 0 and dies with
      // a clear lane visible on the far side of the screen. Solving real runs
      // headlessly turns that up as a genuine death.
      //
      // So the OPEN lanes are always kept contiguous: a single window that
      // contains the corridor. Whatever falls outside the window is blocked,
      // which means the player can always walk to the corridor one lane at a
      // time without crossing a blocked lane. Note this depends only on the
      // corridor and the seeded RNG, never on where the player is — both
      // players in a match must get an identical road.
      n = Math.min(n, LANES - 1);
      const openWidth = LANES - n;
      const aMin = Math.max(0, S.corridor - openWidth + 1);
      const aMax = Math.min(S.corridor, LANES - openWidth);
      const a = aMin + Math.floor(rand() * (aMax - aMin + 1));
      const lanes = [];
      for (let l = 0; l < LANES; l++) if (l < a || l >= a + openWidth) lanes.push(l);
      for (let i = lanes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      }
      const closing = CLOSE_MIN + (CLOSE_MAX - CLOSE_MIN) * d + over() * OD_CLOSE;
      let spawned = 0;
      for (const l of lanes.slice(0, n)) {
        if (laneHeadway(l) < closing * 0.95 + 190) continue; // deterministic headway guard
        const c = take(cars); if (!c) continue;
        const kind = pick();
        c.on = true; c.kind = kind;
        c.paint = PAINTS[Math.floor(rand() * PAINTS.length)];
        // Stagger each car in the wave, so a wave never arrives as a rank of
        // cars line abreast across the road.
        c.y = SPAWN_Y + rand() * 70 + spawned * (120 + rand() * 90);
        c.laneF = l; c.lane = l;
        c.spd = S.speed - closing * VEHICLES[kind].close * (0.86 + rand() * 0.28);
        c.near = false; c.armed = false; c.armedAt = 0; c.brake = rand() < 0.16;
        c.sig = 0; c.sigDir = 0; c.changing = 0;
        // pre-rolled lane change — deterministic, fires only well ahead of the player
        c.changeAt = (S.simT > 11 && kind !== 'semi' && rand() < 0.18 + d * 0.22 + over() * 0.12) ? S.simT + 0.8 + rand() * 2.0 : -1;
        spawned++;
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
      // Steering is deliberately quick rather than pretty: a stiffer spring and
      // heavier damping, so a lane is crossed in about 90ms and settled in
      // roughly 150ms with no overshoot. At these speeds an input that takes a
      // fifth of a second to land feels broken.
      S.laneVel += (targetX - S.laneX) * 1350 * dt;
      S.laneVel *= Math.exp(-46 * dt);
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
          if (laneChangeClear(c, target)) {
            c.sig = SIGNAL_S; c.sigDir = dir; c.changing = -1;
            S.changeCooldown = Math.max(0.45, 1.1 - over() * 0.35);
          }
          c.changeAt = -1;
        }
        if (c.changing === -1) {
          c.sig -= dt;
          // Re-check on the way in. The gap was clear when the indicator came
          // on, but 1.5 seconds is long enough for another car to move into it
          // — including one indicating the other way into the same lane.
          if (!laneChangeClear(c, c.lane + c.sigDir)) {
            c.changing = 0; c.sig = 0; c.sigDir = 0;
          } else if (c.sig <= 0) {
            c.changing = 1; c.lane = clamp(c.lane + c.sigDir, 0, LANES - 1);
          }
        } else if (c.changing === 1) {
          c.laneF += (c.lane - c.laneF) * Math.min(1, dt * 5);
          if (Math.abs(c.laneF - c.lane) < 0.02) { c.laneF = c.lane; c.changing = 0; }
        }

        const cx = laneCenter(c.laneF), px = S.laneX;
        const v = VEHICLES[c.kind];
        const dx = Math.abs(cx - px);
        const sumW = (v.wid * HIT_FORGIVE + pw) / 2;
        const overlapY = Math.abs(c.y) < (v.len * HIT_FORGIVE + pl) / 2;
        // Gap from the player's nose to the car's rear bumper. Positive c.y is
        // ahead of the player, so this is only meaningful while the player is
        // behind the car.
        const rearGap = (c.y - (v.len * HIT_FORGIVE) / 2) - pl / 2;
        const behindRear = rearGap > -2 && rearGap < NEAR_TAIL;

        // Closing on this car IN ITS OWN LANE arms it. Without this, simply
        // driving up an adjacent lane satisfied "behind and laterally clear"
        // and scored — which is why points were coming from ordinary passes on
        // the left or right. A near miss now requires the player to have been
        // lined up on the car's tail and then swerved out of it.
        if (!c.armed && c.y > 0 && dx < sumW && rearGap < NEAR_ARM) {
          c.armed = true;
          c.armedAt = S.simT;
        }
        if (c.y < -(v.len * HIT_FORGIVE + pl) / 2) c.armed = false;

        if (!S.dead && overlapY && dx < sumW) {
          // ── CRASH ──
          S.dead = true; S.deadT = 0; S.shake = 1; S.flash = 1;
          crashBurst(roadX + px * u2p, playerY);
          audio?.crash();
          break;
        }
        // near miss — cutting in just behind a car's tail, laterally just clear
        if (!c.near && c.armed && S.simT - c.armedAt < NEAR_WINDOW
            && !S.dead && behindRear && dx >= sumW && dx < sumW + NEAR_BAND) {
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
        if (c.changing === -1 && Math.floor(nowMs / 220) % 2 === 0) {
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
      const pulse = 0.34 + Math.sin(nowMs * 0.006) * 0.07;
      ctx.globalAlpha = pulse;
      ctx.drawImage(sp.playerGlow,
        px - sp.playerGlow.width / 2, playerY - sp.playerGlow.height / 2,
        sp.playerGlow.width, sp.playerGlow.height);
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

      // Score sits centred over the road — it decides the match, so it gets the
      // most readable position on screen.
      const hudC = hRoadX + hRoadW / 2;
      dctx.save();
      dctx.translate(hudC, 46);
      dctx.scale(popS, popS);
      dctx.textAlign = 'center';
      dctx.font = '900 34px "JetBrains Mono", ui-monospace, monospace';
      dctx.fillStyle = 'rgba(0,0,0,0.7)';
      dctx.fillText(score.toLocaleString(), 2, 2);
      dctx.fillStyle = '#F2F8FF';
      dctx.fillText(score.toLocaleString(), 0, 0);
      dctx.restore();
      dctx.textAlign = 'center';
      dctx.font = '800 10px Inter, system-ui, sans-serif';
      dctx.fillStyle = 'rgba(159,220,255,0.75)';
      dctx.fillText('SCORE', hudC, 63);

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
      canvas.removeEventListener('selectstart', noSelect);
      canvas.removeEventListener('contextmenu', noSelect);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      audio?.stop();
    };
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="relative w-full bg-bg flex justify-center overflow-hidden select-none"
      style={{
        height: 'calc(100dvh - 56px)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'none',
      }}
    >
      {/* Night ambience behind the play area. On a wide screen the road cannot
          fill the width without either distorting the cars or cutting the fixed
          700-unit view distance that keeps the match fair, so the play area
          stays portrait and the surround is lit rather than left dead black. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          // Plain surround either side of the play area: black in dark mode,
        // white in light mode, matching the page behind it.
        background: 'var(--rh-surround, #000000)',
        }}
      />
      {/* Aspect cap: roadW works out at ~0.44x the canvas height, so a canvas
          about half as wide as it is tall puts the road at ~90% of the frame.
          Narrow screens are already taller than this and are unaffected. */}
      <canvas
        ref={canvasRef}
        className="relative h-full block touch-none select-none w-full"
        style={{ cursor: 'pointer', maxWidth: 'calc((100dvh - 56px) * 0.50)' }}
      />
    </div>
  );
}
