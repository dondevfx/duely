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

// ── Camera ───────────────────────────────────────────────────────────────────
// Virtual camera pulled back and tilted ~17 degrees off vertical. Far objects
// render at ~71% scale — enough to read as 3D, nowhere near a racing sim.
// Purely a projection change: lanes, hitboxes and spawning stay world-space.
// Near-orthographic top-down. The road runs straight off the top of the screen —
// there is no horizon and no vanishing point. Depth comes from a gentle width
// taper, body height and lighting instead of perspective convergence.
const TAPER     = 0.10;  // road narrows only 10% across the whole view
const HEIGHT_K  = 0.30;  // how far body height leans toward the camera
const ROAD_FRAC = 0.90;  // road occupies 90% of the canvas width — it is the hero

// Duely palette
const CYAN  = '#00BFFF';
const ICE   = '#9FDCFF';

// Sizes are in world units and drive BOTH the sprite and the hitbox, so art and
// collision can never drift apart.
// len/wid drive gameplay (hitboxes) and are UNCHANGED. `hgt` is purely visual:
// it extrudes the body so each class has its own silhouette from the tilted
// camera — a sports car sits low and wide, a semi towers over everything.
const VEHICLES = {
  sedan:  { len: 81,  wid: 53, hgt: 40, close: 1.00, weight: 26 },
  suv:    { len: 90,  wid: 58, hgt: 56, close: 1.05, weight: 20 },
  pickup: { len: 95,  wid: 56, hgt: 50, close: 1.05, weight: 14 },
  sports: { len: 75,  wid: 51, hgt: 30, close: 0.78, weight: 14 },
  van:    { len: 107, wid: 60, hgt: 66, close: 1.12, weight: 14 },
  semi:   { len: 174, wid: 66, hgt: 82, close: 1.22, weight: 8  },
};
const PLAYER_W_U = 56;   // player world width  (sprite + hitbox)
const PLAYER_L_U = 117;  // player world length (sprite + hitbox)
const PLAYER_H_U = 38;   // player body height (visual only)
const VKEYS = Object.keys(VEHICLES);
const VTOTAL = VKEYS.reduce((a, k) => a + VEHICLES[k].weight, 0);

// Bright, saturated paints so traffic never sinks into the asphalt.
const PAINTS = [
  '#EEF2F7', '#C8D0DA', '#2F86EE', '#E24444', '#39424E',
  '#F0A93C', '#33B98C', '#8A6BE6', '#E8E2D6', '#9AA5B2',
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
//  SPRITE BAKERY — every vehicle is baked once as an extruded 3D form
//  (roof + rear face + side faces), then blitted and scaled by perspective.
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

function bakeGlow(hex, r) {
  const n = parseInt(hex.slice(1), 16);
  const rc = (n >> 16) & 255, gc = (n >> 8) & 255, bc = n & 255;
  return bake(r * 2, r * 2, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, `rgba(${rc},${gc},${bc},0.9)`);
    gr.addColorStop(0.4, `rgba(${rc},${gc},${bc},0.3)`);
    gr.addColorStop(1, `rgba(${rc},${gc},${bc},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
}

function bakeSoftShadow(w, h) {
  return bake(w, h, (g, W, H) => {
    const gr = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)');
    gr.addColorStop(0.65, 'rgba(0,0,0,0.26)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.translate(W / 2, H / 2); g.scale(1, H / W); g.translate(-W / 2, -W / 2);
    g.fillStyle = gr; g.fillRect(0, H / 2 - W / 2, W, W);
    g.restore();
  });
}

// Illustrated vehicle body. Seen from a near top-down camera: a shaped roof with
// a real paint gradient and specular sweep, glass with sky reflection, plus a
// short extruded rear/side face so it reads as a solid object rather than a
// rectangle. Origin is the ground footprint; the roof sits `lift` above it.
function drawBody(g, x, y, w, l, lift, o) {
  const {
    body, roofInset = 0.12, noseR = 0.30, tailR = 0.18,
    glassA = 0.30, glassB = 0.62, cabW = 0.78, roofArc = 0.55,
  } = o;

  // ── silhouette: rounded nose, squarer tail ──
  const shape = (ox, oy, sw, sl) => {
    const nr = sw * noseR, tr = sw * tailR;
    g.beginPath();
    g.moveTo(ox + nr, oy);
    g.lineTo(ox + sw - nr, oy);
    g.quadraticCurveTo(ox + sw, oy, ox + sw, oy + nr);
    g.lineTo(ox + sw, oy + sl - tr);
    g.quadraticCurveTo(ox + sw, oy + sl, ox + sw - tr, oy + sl);
    g.lineTo(ox + tr, oy + sl);
    g.quadraticCurveTo(ox, oy + sl, ox, oy + sl - tr);
    g.lineTo(ox, oy + nr);
    g.quadraticCurveTo(ox, oy, ox + nr, oy);
    g.closePath();
  };

  // ── extruded rear + sides (the volume under the roof) ──
  // Kept clearly lighter than pure shadow so vehicles never read as black slabs.
  g.fillStyle = shade(body, -24);
  shape(x, y - lift + lift, w, l);
  g.fill();

  // ── roof / upper body with a proper paint gradient ──
  const ry = y - lift;
  const pg = g.createLinearGradient(x, 0, x + w, 0);
  pg.addColorStop(0.00, shade(body, -46));
  pg.addColorStop(0.14, shade(body, -8));
  pg.addColorStop(0.34, shade(body, 34));   // specular sweep
  pg.addColorStop(0.48, shade(body, 10));
  pg.addColorStop(0.72, body);
  pg.addColorStop(1.00, shade(body, -54));
  g.fillStyle = pg;
  shape(x, ry, w, l);
  g.fill();

  // clip everything else to the body
  g.save();
  shape(x, ry, w, l);
  g.clip();

  // lengthwise shading: bright over the bonnet, falling away to the tail
  const lg = g.createLinearGradient(0, ry, 0, ry + l);
  lg.addColorStop(0, 'rgba(255,255,255,0.16)');
  lg.addColorStop(0.3, 'rgba(255,255,255,0.02)');
  lg.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = lg;
  g.fillRect(x, ry, w, l);

  // crisp specular strip running down the shoulder line
  g.fillStyle = 'rgba(255,255,255,0.2)';
  g.beginPath();
  g.moveTo(x + w * 0.3, ry);
  g.lineTo(x + w * 0.37, ry);
  g.lineTo(x + w * 0.32, ry + l);
  g.lineTo(x + w * 0.25, ry + l);
  g.closePath(); g.fill();

  // ── cabin glass: one continuous canopy with a sky reflection ──
  const cw = w * cabW, cx = x + (w - cw) / 2;
  const gy0 = ry + l * glassA, gy1 = ry + l * glassB;
  const gg = g.createLinearGradient(0, gy0, 0, gy1);
  gg.addColorStop(0, 'rgba(150,205,255,0.5)');
  gg.addColorStop(0.35, 'rgba(28,44,68,0.95)');
  gg.addColorStop(1, 'rgba(46,68,98,0.9)');
  g.fillStyle = gg;
  g.beginPath();
  g.moveTo(cx + cw * 0.1, gy0);
  g.lineTo(cx + cw * 0.9, gy0);
  g.quadraticCurveTo(cx + cw, gy0 + (gy1 - gy0) * roofArc, cx + cw * 0.88, gy1);
  g.lineTo(cx + cw * 0.12, gy1);
  g.quadraticCurveTo(cx, gy0 + (gy1 - gy0) * roofArc, cx + cw * 0.1, gy0);
  g.closePath(); g.fill();
  // reflection rake across the glass
  g.fillStyle = 'rgba(190,232,255,0.28)';
  g.beginPath();
  g.moveTo(cx + cw * 0.12, gy1);
  g.lineTo(cx + cw * 0.5, gy0);
  g.lineTo(cx + cw * 0.66, gy0);
  g.lineTo(cx + cw * 0.28, gy1);
  g.closePath(); g.fill();

  // panel seams
  g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x + w * 0.06, gy0 - l * 0.03); g.lineTo(x + w * 0.94, gy0 - l * 0.03); g.stroke();
  g.beginPath(); g.moveTo(x + w * 0.06, gy1 + l * 0.03); g.lineTo(x + w * 0.94, gy1 + l * 0.03); g.stroke();

  g.restore();

  // outline keeps the silhouette crisp against the asphalt
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1.4;
  shape(x, ry, w, l); g.stroke();
  return { ry };
}

// ── Traffic vehicle ─────────────────────────────────────────────────────────
function bakeVehicle(kind, paint, wpx, lpx, hpx) {
  const PAD = 10;
  return bake(wpx + PAD * 2, lpx + hpx + PAD * 2, (g) => {
    g.translate(PAD, PAD + hpx);
    const w = wpx, l = lpx, lift = hpx;

    // wheels / tyre contact
    g.fillStyle = '#0A0D12';
    const tw = w * 0.085, th = l * 0.15;
    for (const wy of (kind === 'semi' ? [l * 0.1, l * 0.6, l * 0.84] : [l * 0.13, l * 0.7])) {
      g.fillRect(-tw * 0.25, wy, tw, th);
      g.fillRect(w - tw * 0.75, wy, tw, th);
    }

    if (kind === 'semi') {
      // trailer: long, flat, ribbed, with a livery stripe
      drawBody(g, 0, l * 0.28, w, l * 0.72, lift, {
        body: '#C9D2DD', roofInset: 0.04, noseR: 0.06, tailR: 0.06,
        glassA: 2, glassB: 2.1, cabW: 0.1,      // no cabin on the box
      });
      g.save();
      g.beginPath(); g.rect(0, l * 0.28 - lift, w, l * 0.72); g.clip();
      g.strokeStyle = 'rgba(40,50,64,0.35)'; g.lineWidth = 1;
      for (let i = 1; i < 11; i++) {
        const yy = l * 0.28 - lift + (l * 0.72) * (i / 11);
        g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke();
      }
      g.fillStyle = paint;
      g.fillRect(0, l * 0.28 - lift + l * 0.26, w, l * 0.12);
      g.restore();
      // tractor
      drawBody(g, w * 0.03, 0, w * 0.94, l * 0.3, lift * 0.9, {
        body: paint, noseR: 0.22, tailR: 0.1, glassA: 0.2, glassB: 0.52, cabW: 0.82,
      });
      g.fillStyle = '#59636F';
      g.fillRect(w * 0.05, -lift * 0.95, w * 0.045, lift * 0.55);
      g.fillRect(w * 0.905, -lift * 0.95, w * 0.045, lift * 0.55);
    } else {
      const spec = {
        sports: { noseR: 0.42, tailR: 0.26, glassA: 0.34, glassB: 0.60, cabW: 0.66, roofArc: 0.8 },
        sedan:  { noseR: 0.32, tailR: 0.20, glassA: 0.28, glassB: 0.64, cabW: 0.78, roofArc: 0.55 },
        suv:    { noseR: 0.22, tailR: 0.12, glassA: 0.20, glassB: 0.74, cabW: 0.84, roofArc: 0.35 },
        pickup: { noseR: 0.24, tailR: 0.08, glassA: 0.18, glassB: 0.46, cabW: 0.82, roofArc: 0.4 },
        van:    { noseR: 0.16, tailR: 0.06, glassA: 0.10, glassB: 0.34, cabW: 0.88, roofArc: 0.3 },
      }[kind];
      drawBody(g, 0, 0, w, l, lift, { body: paint, ...spec });

      if (kind === 'pickup') {
        g.fillStyle = 'rgba(8,11,16,0.92)';
        g.fillRect(w * 0.1, l * 0.52 - lift, w * 0.8, l * 0.36);
        g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const yy = l * 0.52 - lift + (l * 0.36) * (i / 4);
          g.beginPath(); g.moveTo(w * 0.12, yy); g.lineTo(w * 0.88, yy); g.stroke();
        }
        g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1.2;
        g.strokeRect(w * 0.1, l * 0.52 - lift, w * 0.8, l * 0.36);
      } else if (kind === 'sports') {
        g.fillStyle = shade(paint, -46);
        g.fillRect(w * 0.05, l * 0.9 - lift, w * 0.9, l * 0.045);
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(w * 0.46, l * 0.04 - lift, w * 0.08, l * 0.22);
      } else if (kind === 'suv') {
        g.fillStyle = shade(paint, -40);
        g.fillRect(w * 0.19, l * 0.22 - lift, w * 0.035, l * 0.46);
        g.fillRect(w * 0.775, l * 0.22 - lift, w * 0.035, l * 0.46);
      } else if (kind === 'van') {
        g.fillStyle = 'rgba(255,255,255,0.07)';
        g.fillRect(w * 0.1, l * 0.52 - lift, w * 0.8, l * 0.015);
      }
      // door mirrors
      g.fillStyle = shade(paint, -34);
      g.fillRect(-w * 0.055, l * 0.26 - lift, w * 0.075, l * 0.035);
      g.fillRect(w * 0.98, l * 0.26 - lift, w * 0.075, l * 0.035);
    }

    // headlights (front) — bright, with a soft spill
    const hh = Math.max(2.4, l * 0.026);
    g.fillStyle = 'rgba(255,252,238,0.95)';
    g.fillRect(w * 0.08, -lift, w * 0.22, hh);
    g.fillRect(w * 0.7, -lift, w * 0.22, hh);
    g.fillStyle = 'rgba(255,248,220,0.28)';
    g.fillRect(w * 0.05, -lift - hh * 0.8, w * 0.28, hh * 2);
    g.fillRect(w * 0.67, -lift - hh * 0.8, w * 0.28, hh * 2);

    // full-width tail bar on the rear face
    const bh = Math.max(2.8, l * 0.032);
    g.fillStyle = 'rgba(255,60,45,0.32)';
    g.fillRect(w * 0.04, l - bh * 2.4, w * 0.92, bh * 2.4);
    g.fillStyle = '#FF4436';
    g.fillRect(w * 0.04, l - bh, w * 0.92, bh);
    g.fillStyle = 'rgba(255,220,215,0.7)';
    g.fillRect(w * 0.44, l - bh, w * 0.12, bh);
  });
}

// ── Player car — the Duely Interceptor ──────────────────────────────────────
function bakePlayer(wpx, lpx, hpx) {
  const PAD = 18;
  return bake(wpx + PAD * 2, lpx + hpx + PAD * 2, (g) => {
    g.translate(PAD, PAD + hpx);
    const w = wpx, l = lpx, lift = hpx;

    g.fillStyle = '#05070B';
    const tw = w * 0.095, th = l * 0.15;
    for (const wy of [l * 0.12, l * 0.7]) {
      g.fillRect(-tw * 0.3, wy, tw, th);
      g.fillRect(w - tw * 0.7, wy, tw, th);
    }

    // wide, planted stance with a sharp nose
    drawBody(g, 0, 0, w, l, lift, {
      body: '#2A6AD8', noseR: 0.44, tailR: 0.16,
      glassA: 0.3, glassB: 0.62, cabW: 0.7, roofArc: 0.75,
    });

    const bloom = (x0, y0, x1, y1, cw) => {
      for (const [lw, al] of [[cw * 6, 0.2], [cw * 3, 0.4], [cw, 1]]) {
        g.strokeStyle = `rgba(140,232,255,${al})`;
        g.lineWidth = lw; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
    };
    // cool rim light around the whole shell — reads instantly against gray road
    g.strokeStyle = 'rgba(150,225,255,0.55)'; g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(w * 0.06, -lift + l * 0.12);
    g.lineTo(w * 0.02, -lift + l * 0.86);
    g.moveTo(w * 0.94, -lift + l * 0.12);
    g.lineTo(w * 0.98, -lift + l * 0.86);
    g.stroke();

    // signature: nose chevron + roof spine + skirts
    bloom(w * 0.18, -lift + l * 0.055, w * 0.5, -lift + l * 0.012, 2.4);
    bloom(w * 0.82, -lift + l * 0.055, w * 0.5, -lift + l * 0.012, 2.4);
    bloom(w * 0.5, -lift + l * 0.16, w * 0.5, -lift + l * 0.72, 1.5);
    bloom(w * 0.045, -lift + l * 0.34, w * 0.045, -lift + l * 0.88, 1.7);
    bloom(w * 0.955, -lift + l * 0.34, w * 0.955, -lift + l * 0.88, 1.7);
    // twin rear strips
    for (const [lw, al] of [[14, 0.24], [7, 0.45], [3, 1]]) {
      g.strokeStyle = `rgba(150,236,255,${al})`; g.lineWidth = lw; g.lineCap = 'round';
      g.beginPath(); g.moveTo(w * 0.12, l * 0.96); g.lineTo(w * 0.43, l * 0.96); g.stroke();
      g.beginPath(); g.moveTo(w * 0.57, l * 0.96); g.lineTo(w * 0.88, l * 0.96); g.stroke();
    }
    // headlights
    g.fillStyle = '#FFFFFF';
    g.fillRect(w * 0.09, -lift - 2, w * 0.22, Math.max(3, l * 0.03));
    g.fillRect(w * 0.69, -lift - 2, w * 0.22, Math.max(3, l * 0.03));
    g.fillStyle = 'rgba(200,242,255,0.5)';
    g.fillRect(w * 0.05, -lift - 4, w * 0.3, Math.max(5, l * 0.05));
    g.fillRect(w * 0.65, -lift - 4, w * 0.3, Math.max(5, l * 0.05));
  });
}

// ── Road tile (wraps every 320u) ────────────────────────────────────────────
function bakeRoadTile(roadW, u2p, rand) {
  const tileH = 320 * u2p;
  const laneW = roadW / LANES;
  return bake(roadW, tileH, (g, W, H) => {
    // Soft gray asphalt — light enough to read at a glance, with a gentle
    // cross-road falloff so the centre catches more ambient light.
    const base = g.createLinearGradient(0, 0, W, 0);
    base.addColorStop(0, '#262C35');
    base.addColorStop(0.5, '#333A45');
    base.addColorStop(1, '#262C35');
    g.fillStyle = base; g.fillRect(0, 0, W, H);

    for (let i = 0; i < W * H / 40; i++) {
      const x = rand() * W, y = rand() * H;
      g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)';
      g.fillRect(x, y, 1.4, 1.4);
    }
    // tyre polish down each lane
    for (let l = 0; l < LANES; l++) {
      const cx = laneW * (l + 0.5);
      for (const off of [-laneW * 0.18, laneW * 0.18]) {
        const wg = g.createLinearGradient(cx + off - laneW * 0.1, 0, cx + off + laneW * 0.1, 0);
        wg.addColorStop(0, 'rgba(0,0,0,0)');
        wg.addColorStop(0.5, 'rgba(0,0,0,0.10)');
        wg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = wg;
        g.fillRect(cx + off - laneW * 0.1, 0, laneW * 0.2, H);
      }
    }
    g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      let x = rand() * W, y = rand() * H;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (rand() - 0.5) * 40; y += rand() * 26; g.lineTo(x, y); }
      g.stroke();
    }
    // reflective dashes
    const dashOn = 34 * u2p, cycle = 80 * u2p;
    for (let l = 1; l < LANES; l++) {
      const x = laneW * l;
      for (let y = 0; y < H; y += cycle) {
        for (const [lw, al] of [[10, 0.08], [5.4, 0.2], [3.1, 1]]) {
          g.strokeStyle = `rgba(245,250,255,${al})`;
          g.lineWidth = lw; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x, y + dashOn); g.stroke();
        }
      }
    }
    g.fillStyle = 'rgba(240,247,255,0.9)';
    g.fillRect(laneW * 0.06, 0, 3, H);
    g.fillRect(W - laneW * 0.06 - 3, 0, 3, H);
    for (const x of [1.5, W - 1.5]) {
      for (const [lw, al] of [[16, 0.16], [8, 0.4], [3, 1]]) {
        g.strokeStyle = `rgba(60,205,255,${al})`;
        g.lineWidth = lw;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }
    }
  });
}

function bakeRailTile(u2p) {
  const h = 80 * u2p, w = 16;
  return bake(w, h, (g) => {
    const rg = g.createLinearGradient(0, 0, w, 0);
    rg.addColorStop(0, '#2C333D'); rg.addColorStop(0.45, '#5A6472'); rg.addColorStop(1, '#232932');
    g.fillStyle = rg; g.fillRect(3, 0, w - 6, h);
    g.fillStyle = 'rgba(60,205,255,0.34)'; g.fillRect(4, 0, 2, h);
    g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(6, 0, 2, h);
    g.fillStyle = '#1A1F27';
    rr(g, 0, h * 0.42, w, h * 0.14, 2); g.fill();
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
    const ctx = canvas.getContext('2d', { alpha: false });
    const rand = makePRNG(seed);        // gameplay randomness — identical for both players
    const frand = Math.random;          // FX-only randomness
    const audio = createAudio();

    // ── Layout (fixed view distance in units ⇒ identical gameplay everywhere) ──
    let W = 0, H = 0, u2p = 1, roadW = 0, laneW = 0, roadX = 0, playerY = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let sprites = null;

    function layout() {
      W = canvas.clientWidth || 360;
      H = canvas.clientHeight || 640;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      playerY = H * PLAYER_YF;
      // Scale is set by the road width so it always fills ROAD_FRAC of the
      // canvas; the view then extends as far up the screen as that allows.
      u2p = (W * ROAD_FRAC) / (LANES * LANE_U);
      laneW = LANE_U * u2p;
      roadW = laneW * LANES;
      roadX = (W - roadW) / 2;
      bakeAll();
    }

    // Site theme — the off-road surround must match the page behind it.
    // Checked per frame so switching theme applies without a re-bake.
    const isLight = () => document.documentElement.classList.contains('light');

    function bakeAll() {
      const bakeRand = makePRNG(1234567); // art randomness — stable, never gameplay
      const vs = {};
      const playerW = PLAYER_W_U * u2p, playerL = PLAYER_L_U * u2p, playerH = PLAYER_H_U * u2p * HEIGHT_K;
      sprites = {
        vs,
        vkey(kind, paint) {
          const k = kind + '|' + paint;
          if (!vs[k]) {
            const v = VEHICLES[kind];
            vs[k] = bakeVehicle(kind, paint, v.wid * u2p, v.len * u2p, v.hgt * u2p * HEIGHT_K);
          }
          return vs[k];
        },
        player: bakePlayer(playerW, playerL, playerH),
        playerW, playerL, playerH,
        road: bakeRoadTile(roadW, u2p, bakeRand),
        rail: bakeRailTile(u2p),
        shadow: bakeSoftShadow(160, 200),
        glowCyan: bakeGlow(CYAN, 64),
        glowRed: bakeGlow('#FF3B30', 36),
        glowAmber: bakeGlow('#FFB020', 28),
        glowWhite: bakeGlow('#FFF3D6', 44),
        // three parallax skyline bands: far haze, mid, near
        smokePuff: bake(48, 48, (g, w, h) => {
          const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
          gr.addColorStop(0, 'rgba(176,190,210,0.5)');
          gr.addColorStop(1, 'rgba(176,190,210,0)');
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
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
      laneX: LANE_U * 1.5, laneVel: 0, targetLane: 1, camX: 0,
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
        const pLane = S.laneX / LANE_U - 0.5;
        const px = laneXAt(pLane, 0), py = wy2sy(0);
        puffAt(px - sprites.playerW * 0.34, py - sprites.playerL * 0.08, 0.8 + frand() * 0.4);
        puffAt(px + sprites.playerW * 0.34, py - sprites.playerL * 0.08, 0.8 + frand() * 0.4);
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
          crashBurst(laneXAt(S.laneX / LANE_U - 0.5, 0), wy2sy(0) - sprites.playerL * 0.4);
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
          addFloat(laneXAt(c.laneF, c.y), wy2sy(c.y) - 24, `+${pts}${S.combo > 1 ? ' ×' + S.combo : ''}`);
          sparkTrail((laneXAt(c.laneF, c.y) + laneXAt(S.laneX / LANE_U - 0.5, 0)) / 2, wy2sy(c.y), 5);
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
    // ── Projection ──────────────────────────────────────────────────────────
    // Vertical mapping is LINEAR (a true top-down scroller, so nothing warps and
    // readability is perfect). Depth is suggested only by a 10% width taper and
    // by vehicle shading, never by a vanishing point. The road simply runs off
    // the top of the screen.
    const wy2sy = (wy) => playerY - wy * u2p;
    const taperAt = (wy) => 1 - TAPER * clamp(wy / VIEW_AHEAD, 0, 1.2);
    const halfAt = (wy) => (roadW / 2) * taperAt(wy);
    const laneXAt = (laneF, wy) => W / 2 + ((laneF + 0.5) / LANES * 2 - 1) * halfAt(wy);
    // Ambience shifts slowly so the run feels like a journey without ever
    // introducing scenery that competes with the road.
    const MOODS = [
      { glow: 'rgba(60,150,255,0.20)', haze: 'rgba(90,140,190,0.16)' },
      { glow: 'rgba(70,200,255,0.18)', haze: 'rgba(80,150,200,0.14)' },
      { glow: 'rgba(120,110,255,0.18)', haze: 'rgba(110,120,190,0.16)' },
      { glow: 'rgba(0,210,220,0.18)',  haze: 'rgba(70,160,180,0.14)' },
    ];
    const moodAt = (t) => MOODS[Math.floor(t / 30) % MOODS.length];

    function render(nowMs) {
      const sp = sprites;
      const light = isLight();
      const mood = moodAt(S.simT);

      const shx = S.shake ? (frand() - 0.5) * 14 * S.shake : 0;
      const shy = S.shake ? (frand() - 0.5) * 10 * S.shake : 0;
      // Smoothed camera follow — a touch of lateral drift, no lurching.
      S.camX += ((S.laneX - LANE_U * LANES / 2) * u2p * -0.02 - S.camX) * 0.12;

      drawBackdrop(light, mood);

      ctx.save();
      ctx.translate(shx + S.camX, shy);

      drawRoad(light, mood);
      drawRoadside(nowMs, light);
      drawOverheads();
      drawTraffic(nowMs);
      if (!S.dead) drawPlayer(nowMs);
      drawPuffs();
      drawParticles();
      drawFloats();
      ctx.restore();

      drawAtmosphere(light, nowMs, mood);

      if (S.flash > 0.01) {
        ctx.globalAlpha = S.flash;
        ctx.drawImage(sp.edgeFlash, 0, 0);
        ctx.globalAlpha = 1;
      }
      drawHUD(nowMs);
    }

    // ── Backdrop: pure atmosphere. No skyline, no wallpaper — just a graded
    //    field with a distant glow so the strips beside the road read as space
    //    rather than empty black.
    function drawBackdrop(light, mood) {
      if (light) { ctx.fillStyle = '#eef2f7'; ctx.fillRect(0, 0, W, H); return; }
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#141A24');
      g.addColorStop(0.45, '#10151E');
      g.addColorStop(1, '#0B0F16');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // distant glow bleeding in from the top — implies a world beyond the frame
      const gl = ctx.createRadialGradient(W / 2, -H * 0.1, 0, W / 2, -H * 0.1, H * 0.75);
      gl.addColorStop(0, mood.glow);
      gl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gl;
      ctx.fillRect(0, 0, W, H * 0.7);
    }

    // ── Road: the hero of the screen. Fills 90% of the width and runs straight
    //    off the top edge — never a floating bridge with black margins.
    function drawRoad(light, mood) {
      const sp = sprites;
      // Sample the road edge from BELOW the player all the way off the top, in
      // one continuous bottom -> top order, so the clip polygon is simple.
      const wyBot = (playerY - (H + 60)) / u2p;     // negative = behind the player
      const wyTop = (playerY + 60) / u2p;           // far enough to leave the frame
      const steps = 16;
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const wy = wyBot + (wyTop - wyBot) * (i / steps);
        pts.push({ sy: wy2sy(wy), half: halfAt(Math.max(0, wy)) });
      }
      const yTop = pts[pts.length - 1].sy;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(W / 2 - pts[0].half, pts[0].sy);
      for (const q of pts) ctx.lineTo(W / 2 - q.half, q.sy);      // up the left edge
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(W / 2 + pts[i].half, pts[i].sy); // down the right
      ctx.closePath();
      ctx.clip();

      // tiled asphalt, scrolling with the world
      const tileH = sp.road.height;
      const scroll = (S.dist * VISUAL_SCROLL * u2p) % tileH;
      for (let y = pts[0].sy; y > yTop - tileH; y -= tileH) {
        const yy = y - ((scroll) % tileH);
        const hw = halfAt(Math.max(0, (playerY - yy) / u2p));
        ctx.drawImage(sp.road, W / 2 - hw, yy - tileH, hw * 2, tileH);
      }

      // ambient pool of light around the player, falling off up the road
      const sh = ctx.createLinearGradient(0, yTop, 0, H);
      sh.addColorStop(0, 'rgba(120,170,230,0.015)');
      sh.addColorStop(0.7, 'rgba(160,200,255,0.075)');
      sh.addColorStop(1, 'rgba(120,170,230,0.03)');
      ctx.fillStyle = sh;
      ctx.fillRect(0, yTop, W, H - yTop);
      ctx.restore();

      // haze where the road leaves the frame so it fades rather than cuts
      const fg = ctx.createLinearGradient(0, 0, 0, H * 0.34);
      fg.addColorStop(0, mood.haze);
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, W, H * 0.34);

      // edge lighting: soft blue bloom under a crisp white line
      for (const side of [-1, 1]) {
        ctx.beginPath();
        pts.forEach((q, i) => {
          const x = W / 2 + side * q.half;
          i === 0 ? ctx.moveTo(x, q.sy) : ctx.lineTo(x, q.sy);
        });
        ctx.strokeStyle = 'rgba(60,180,255,0.26)'; ctx.lineWidth = 14; ctx.stroke();
        ctx.strokeStyle = 'rgba(95,210,255,0.5)';  ctx.lineWidth = 6;  ctx.stroke();
        ctx.strokeStyle = 'rgba(242,251,255,0.95)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // ── Guard rails + street lights, both perspective-scaled ──
    function drawRoadside(nowMs) {
      const sp = sprites;
      const railStep = 40;
      for (let wy = 0; wy < VIEW_AHEAD; wy += railStep) {
        const wy1 = wy + railStep;
        const y0 = wy2sy(wy1), y1 = wy2sy(wy);
        const h0 = halfAt(wy1), h1 = halfAt(wy);
        const pr = taperAt((wy + wy1) / 2);
        const rw = 14 * pr;
        if (y1 < -40) continue;
        for (const side of [-1, 1]) {
          const x0 = W / 2 + side * h0, x1 = W / 2 + side * h1;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x0 + side * 2, y0); ctx.lineTo(x0 + side * rw, y0);
          ctx.lineTo(x1 + side * rw, y1); ctx.lineTo(x1 + side * 2, y1);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(sp.rail, Math.min(x0, x1) - rw, y0, rw * 2 + Math.abs(x1 - x0), y1 - y0);
          ctx.restore();
        }
      }
      // street lights sweeping past, scaled by distance
      for (const pole of S.poles) {
        const wy = pole.y;
        if (wy < -60 || wy > VIEW_AHEAD) continue;
        const sy = wy2sy(wy), pr = taperAt(wy), half = halfAt(wy);
        const x = W / 2 + pole.side * half * 1.2;
        const poleH = 120 * u2p * pr, arm = half * 0.34;
        ctx.strokeStyle = `rgba(38,44,54,${0.5 + pr * 0.5})`;
        ctx.lineWidth = Math.max(1, 3.5 * pr);
        ctx.beginPath();
        ctx.moveTo(x, sy); ctx.lineTo(x, sy - poleH);
        ctx.lineTo(x - pole.side * arm, sy - poleH);
        ctx.stroke();
        const gs = 52 * pr;
        ctx.globalAlpha = 0.85;
        ctx.drawImage(sp.glowWhite, x - pole.side * arm - gs / 2, sy - poleH - gs / 2, gs, gs);
        // pool of light thrown onto the tarmac
        ctx.globalAlpha = 0.12 * (1 - S.tunnelA);
        const ps = half * 1.5;
        ctx.drawImage(sp.glowWhite, x - pole.side * arm - ps / 2, sy - ps * 0.28, ps, ps * 0.55);
        ctx.globalAlpha = 1;
      }
    }

    // ── Overhead gantries / bridge spans ──
    function drawOverheads() {
      if (S.event !== 'gantry' && S.event !== 'overpass') return;
      const wy = S.eventY;
      if (wy < -80 || wy > VIEW_AHEAD) return;
      const sy = wy2sy(wy), pr = taperAt(wy), half = halfAt(wy);
      const lift = 150 * u2p * pr;
      if (S.event === 'overpass') {
        ctx.fillStyle = '#0A0E16';
        ctx.fillRect(W / 2 - half * 1.5, sy - lift, half * 3, lift * 0.42);
        ctx.fillStyle = 'rgba(0,191,255,0.25)';
        ctx.fillRect(W / 2 - half * 1.5, sy - lift + lift * 0.42 - 2, half * 3, 2);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(W / 2 - half, sy - 2, half * 2, lift * 0.16);
      } else {
        ctx.fillStyle = '#151A22';
        ctx.fillRect(W / 2 - half * 1.14, sy - lift, half * 2.28, 9 * pr);
        ctx.fillRect(W / 2 - half * 1.14, sy - lift, 7 * pr, lift);
        ctx.fillRect(W / 2 + half * 1.14 - 7 * pr, sy - lift, 7 * pr, lift);
        for (let i = 0; i < 2; i++) {
          const sx = W / 2 - half * 0.75 + i * half * 0.85, sw = half * 0.62, sh = 22 * pr;
          ctx.fillStyle = 'rgba(5,9,18,0.95)';
          ctx.fillRect(sx, sy - lift - sh, sw, sh);
          ctx.strokeStyle = 'rgba(0,191,255,0.75)'; ctx.lineWidth = Math.max(1, 1.4 * pr);
          ctx.strokeRect(sx, sy - lift - sh, sw, sh);
          ctx.fillStyle = 'rgba(0,191,255,0.5)';
          ctx.fillRect(sx + 5 * pr, sy - lift - sh + 5 * pr, sw * 0.5, 3.5 * pr);
          ctx.fillRect(sx + 5 * pr, sy - lift - sh + 12 * pr, sw * 0.32, 3.5 * pr);
        }
      }
    }

    // ── Vehicles: scaled by perspective, grounded with contact shadows ──
    function drawVehicleSprite(img, wy, laneF, wpx, lpx, hpx, tint) {
      const pr = taperAt(wy);
      if (pr <= 0.02) return;
      const sy = wy2sy(wy);
      const cx = laneXAt(laneF, wy);
      const w = wpx * pr, l = lpx * pr, lift = hpx * pr;
      if (sy < -l - 60 || sy > H + l) return;

      // contact shadow on the tarmac
      ctx.globalAlpha = 0.34;
      ctx.drawImage(sprites.shadow, cx - w * 0.68, sy - l * 0.4, w * 1.36, l * 0.5);
      ctx.globalAlpha = 1;
      // wet-road reflection under the body
      ctx.save();
      ctx.globalAlpha = 0.09;
      ctx.translate(cx, sy);
      ctx.scale(1, -0.55);
      ctx.drawImage(img, -w / 2 - (10 * pr), -l - lift, w + 20 * pr, l + lift);
      ctx.restore();
      // body
      const padX = 10 * pr, padY = 10 * pr;
      ctx.drawImage(img,
        cx - w / 2 - padX,
        sy - l - lift - padY,
        w + padX * 2,
        l + lift + padY * 2);
      return { cx, sy, w, l, lift, pr };
    }

    function drawTraffic(nowMs) {
      const sp = sprites;
      const list = [];
      for (const c of cars) if (c.on && c.y < VIEW_AHEAD + 120 && c.y > DESPAWN_Y) list.push(c);
      list.sort((a, b) => b.y - a.y);           // far → near
      for (const c of list) {
        const v = VEHICLES[c.kind];
        const img = sp.vkey(c.kind, c.paint);
        const r = drawVehicleSprite(img, c.y, c.laneF,
          v.wid * u2p, v.len * u2p, v.hgt * u2p * HEIGHT_K);
        if (!r) continue;
        // headlight wash thrown forward
        if (r.pr > 0.3) {
          ctx.globalAlpha = 0.16 + S.tunnelA * 0.12;
          const gs = r.w * 2.6;
          ctx.drawImage(sp.glowWhite, r.cx - gs / 2, r.sy - r.l - r.lift - gs * 0.7, gs, gs);
          ctx.globalAlpha = 1;
        }
        // every car gets a soft tail marker so none of them vanish into the road
        ctx.globalAlpha = 0.3;
        const ts = r.w * 0.7;
        ctx.drawImage(sp.glowRed, r.cx - r.w * 0.34 - ts / 2, r.sy - ts / 2, ts, ts);
        ctx.drawImage(sp.glowRed, r.cx + r.w * 0.34 - ts / 2, r.sy - ts / 2, ts, ts);
        ctx.globalAlpha = 1;
        // brake glow on the rear face
        if (c.brake || c.spd < S.speed * 0.42) {
          ctx.globalAlpha = 0.75;
          const gs = r.w * 1.05;
          ctx.drawImage(sp.glowRed, r.cx - r.w * 0.36 - gs / 2, r.sy - gs / 2, gs, gs);
          ctx.drawImage(sp.glowRed, r.cx + r.w * 0.36 - gs / 2, r.sy - gs / 2, gs, gs);
          ctx.globalAlpha = 1;
        }
        // indicator while changing lanes
        if (c.changing === -1 && Math.floor(nowMs / 130) % 2 === 0) {
          const gs = r.w * 0.6;
          const sx = r.cx + c.sigDir * r.w * 0.46;
          ctx.globalAlpha = 0.9;
          ctx.drawImage(sp.glowAmber, sx - gs / 2, r.sy - r.l - r.lift, gs, gs);
          ctx.drawImage(sp.glowAmber, sx - gs / 2, r.sy - gs, gs, gs);
          ctx.globalAlpha = 1;
        }
      }
    }

    function drawPlayer(nowMs) {
      const sp = sprites;
      const laneF = S.laneX / LANE_U - 0.5;
      const roll = clamp(S.laneVel * 0.00023, -0.1, 0.1);
      const squash = 1 - Math.min(0.03, Math.abs(S.laneVel) * 0.000022);
      const cx = laneXAt(laneF, 0), sy = wy2sy(0);
      const w = sp.playerW, l = sp.playerL, lift = sp.playerH;

      // pulsing underglow pool
      const pulse = 0.62 + Math.sin(nowMs * 0.006) * 0.1;
      ctx.globalAlpha = pulse;
      const gs = w * 3.1;
      ctx.drawImage(sp.glowCyan, cx - gs / 2, sy - gs * 0.42, gs, gs * 0.75);
      ctx.globalAlpha = 1;
      // contact shadow
      ctx.globalAlpha = 0.3;
      ctx.drawImage(sp.shadow, cx - w * 0.72, sy - l * 0.42, w * 1.44, l * 0.55);
      ctx.globalAlpha = 1;
      // reflection
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.translate(cx, sy);
      ctx.scale(1, -0.55);
      ctx.drawImage(sp.player, -w / 2 - 16, -l - lift, w + 32, l + lift);
      ctx.restore();
      // headlight cones ahead
      ctx.globalAlpha = 0.2 + S.tunnelA * 0.18;
      const hs = w * 3.6;
      ctx.drawImage(sp.glowCyan, cx - hs / 2, sy - l - lift - hs * 0.72, hs, hs);
      ctx.globalAlpha = 1;
      // body with roll + suspension squash
      ctx.save();
      ctx.translate(cx, sy);
      ctx.rotate(roll);
      ctx.scale(1, squash);
      ctx.drawImage(sp.player, -w / 2 - 16, -l - lift - 16, w + 32, l + lift + 32);
      ctx.restore();
    }

    function drawPuffs() {
      const sp = sprites;
      for (const p of puffs) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a * 0.45;
        const s2 = 20 * p.s * (1 + p.age * 2.4);
        ctx.drawImage(sp.smokePuff, p.x - s2 / 2, p.y - s2 / 2, s2, s2);
      }
      ctx.globalAlpha = 1;
    }

    function drawParticles() {
      for (const p of parts) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        if (p.kind === 2) {
          ctx.globalAlpha = a * 0.4;
          const s2 = p.s * (1 + p.age * 2);
          ctx.drawImage(sprites.smokePuff, p.x - s2, p.y - s2, s2 * 2, s2 * 2);
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

    // ── Atmosphere: tunnel darkening, rain, speed streaks ──
    function drawAtmosphere(light, raining, nowMs) {
      if (light) return;
      if (S.tunnelA > 0.01) {
        ctx.fillStyle = `rgba(20,30,46,${S.tunnelA * 0.12})`;
        ctx.fillRect(0, 0, W, H);
        // ceiling strips flying past
        const gap = 190 * u2p;
        const off = (S.dist * u2p) % gap;
        ctx.globalAlpha = S.tunnelA * 0.55;
        for (let wy = 0; wy < VIEW_AHEAD; wy += 190) {
          const sy = wy2sy(wy - (off / u2p) % 190);
          const half = halfAt(wy) * 1.1;
          const gg = ctx.createLinearGradient(0, sy - 4, 0, sy + 6);
          gg.addColorStop(0, 'rgba(0,191,255,0)');
          gg.addColorStop(0.5, 'rgba(0,191,255,0.5)');
          gg.addColorStop(1, 'rgba(0,191,255,0)');
          ctx.fillStyle = gg;
          ctx.fillRect(W / 2 - half, sy - 4, half * 2, 10);
        }
        ctx.globalAlpha = 1;
      }

      if (raining) {
        const n = 90;
        ctx.strokeStyle = 'rgba(150,200,255,0.24)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const seedx = (i * 97) % 1000 / 1000, seedy = (i * 53) % 1000 / 1000;
          const x = seedx * W + Math.sin(nowMs * 0.0004 + i) * 8;
          const y = ((seedy * H) + (nowMs * 1.5 + i * 37) % H) % H;
          ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 16);
        }
        ctx.stroke();
      }

      const d = diff();
      if (d > 0.3 && !S.dead) {
        ctx.strokeStyle = `rgba(180,225,255,${(d - 0.3) * 0.26})`;
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 10; i++) {
          const t = ((nowMs * (1.1 + d) * 0.0012) + i * 0.31) % 1;
          const y = H * (t * t);
          const side = i % 2 ? 1 : -1;
          const x = W / 2 + side * (roadW * 0.5 + 18 + t * 40);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 26 + t * 90); ctx.stroke();
        }
      }
    }

    // ── HUD: score, time, pause, GO, hint, game-over ──
    function drawHUD(nowMs) {
      const score = Math.floor(S.score);
      const popS = 1 + S.scorePop * 0.12;

      // Anchor the readouts to the ROAD, not the canvas. On a wide desktop the
      // road is centred with black either side, so canvas-corner placement threw
      // score/time out to the far edges away from the action.
      const hudL = Math.max(16, roadX + 12);
      const hudR = Math.min(W - 16, roadX + roadW - 12);

      ctx.save();
      ctx.translate(hudL, 46);
      ctx.scale(popS, popS);
      ctx.textAlign = 'left';
      ctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(score.toLocaleString(), 2, 2);
      ctx.fillStyle = '#F2F8FF';
      ctx.fillText(score.toLocaleString(), 0, 0);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(159,220,255,0.75)';
      ctx.fillText('SCORE', hudL + 1, 61);

      ctx.textAlign = 'right';
      ctx.font = '900 22px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(S.simT.toFixed(1) + 's', hudR + 2, 44);
      ctx.fillStyle = '#F2F8FF';
      ctx.fillText(S.simT.toFixed(1) + 's', hudR, 42);
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(159,220,255,0.75)';
      ctx.fillText('TIME', hudR - 1, 58);

      // GO! flash
      if (S.goT < 0.75 && !S.dead) {
        const a = S.goT < 0.5 ? 1 : 1 - (S.goT - 0.5) / 0.25;
        const sc = 1 + S.goT * 0.7;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(W / 2, H * 0.38);
        ctx.scale(sc, sc);
        ctx.textAlign = 'center';
        ctx.font = '900 54px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillText('GO!', 3, 3);
        ctx.fillStyle = CYAN;
        ctx.fillText('GO!', 0, 0);
        ctx.restore();
      }
      // controls hint
      if (S.hintT < 3.6 && !S.dead) {
        const a = S.hintT < 2.8 ? 0.85 : 0.85 * (1 - (S.hintT - 2.8) / 0.8);
        ctx.globalAlpha = a;
        ctx.textAlign = 'center';
        ctx.font = '700 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(5,8,14,0.6)';
        rr(ctx, W / 2 - 108, H - 40, 216, 24, 12); ctx.fill();
        ctx.fillStyle = ICE;
        ctx.fillText('← → / A D  ·  swipe to change lanes', W / 2, H - 24);
        ctx.globalAlpha = 1;
      }

      // game-over overlay before values are returned
      if (S.dead && S.deadT > OVERLAY_S) {
        const a = clamp((S.deadT - OVERLAY_S) / 0.35, 0, 1);
        ctx.globalAlpha = a;
        const g = ctx.createLinearGradient(0, H * 0.28, 0, H * 0.74);
        g.addColorStop(0, 'rgba(2,3,8,0)');
        g.addColorStop(0.3, 'rgba(2,3,8,0.86)');
        g.addColorStop(0.7, 'rgba(2,3,8,0.86)');
        g.addColorStop(1, 'rgba(2,3,8,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, H * 0.28, W, H * 0.46);
        ctx.textAlign = 'center';
        ctx.font = '900 38px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#FF4D42';
        ctx.fillText('GAME OVER', W / 2, H * 0.42);
        ctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillStyle = '#F2F8FF';
        ctx.fillText(Math.floor(S.score).toLocaleString(), W / 2, H * 0.5);
        ctx.font = '700 13px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(159,220,255,0.85)';
        ctx.fillText(`survived ${S.simT.toFixed(1)}s`, W / 2, H * 0.55);
        ctx.strokeStyle = 'rgba(0,191,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(W / 2 - 60, H * 0.585); ctx.lineTo(W / 2 + 60, H * 0.585); ctx.stroke();
        ctx.font = '700 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(180,195,215,0.6)';
        ctx.fillText('waiting for opponent…', W / 2, H * 0.625);
        ctx.globalAlpha = 1;
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
    <div className="relative w-full bg-bg" style={{ height: 'calc(100dvh - 56px)' }}>
      <canvas ref={canvasRef} className="w-full h-full block touch-none select-none" style={{ cursor: 'pointer' }} />
    </div>
  );
}
