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
const CAM_D     = 1750;  // virtual camera distance (world units)
const HORIZON_F = 0.17;  // horizon height as a fraction of the canvas
const HEIGHT_K  = 0.52;  // how much body height leans toward the camera

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

// Extruded body: draws the rear face and side faces beneath an inset roof, so
// the vehicle reads as a solid volume seen from a tilted camera.
// Sprite origin is the vehicle's GROUND FOOTPRINT; the roof floats `lift` above.
function drawShell(g, x, y, w, l, lift, opts) {
  const { roofInset = 0.1, noseInset = 0.16, body, roof, glass, rearGlass = true } = opts;
  const ri = w * roofInset, ni = l * noseInset;

  // ground footprint corners
  const bl = { x: x,     y: y + l }, br = { x: x + w, y: y + l };
  const fl = { x: x + ni * 0.35, y: y }, fr = { x: x + w - ni * 0.35, y: y };
  // roof corners (lifted toward the camera = up-screen)
  const RL = { x: x + ri,         y: y + ni * 0.55 - lift };
  const RR = { x: x + w - ri,     y: y + ni * 0.55 - lift };
  const RBL = { x: x + ri * 0.6,  y: y + l - ni * 0.35 - lift };
  const RBR = { x: x + w - ri * 0.6, y: y + l - ni * 0.35 - lift };

  // ── rear face (the panel facing us) ──
  g.fillStyle = shade(body, -34);
  g.beginPath();
  g.moveTo(bl.x, bl.y); g.lineTo(br.x, br.y);
  g.lineTo(RBR.x, RBR.y); g.lineTo(RBL.x, RBL.y);
  g.closePath(); g.fill();

  // ── side faces ──
  g.fillStyle = shade(body, -52);
  g.beginPath();
  g.moveTo(bl.x, bl.y); g.lineTo(fl.x, fl.y);
  g.lineTo(RL.x, RL.y); g.lineTo(RBL.x, RBL.y);
  g.closePath(); g.fill();
  g.fillStyle = shade(body, -18);
  g.beginPath();
  g.moveTo(br.x, br.y); g.lineTo(fr.x, fr.y);
  g.lineTo(RR.x, RR.y); g.lineTo(RBR.x, RBR.y);
  g.closePath(); g.fill();

  // ── roof (top face) ──
  const rg = g.createLinearGradient(RL.x, 0, RR.x, 0);
  rg.addColorStop(0, shade(roof, -22));
  rg.addColorStop(0.32, shade(roof, 14));
  rg.addColorStop(0.62, roof);
  rg.addColorStop(1, shade(roof, -30));
  g.fillStyle = rg;
  g.beginPath();
  g.moveTo(RL.x, RL.y); g.lineTo(RR.x, RR.y);
  g.lineTo(RBR.x, RBR.y); g.lineTo(RBL.x, RBL.y);
  g.closePath(); g.fill();

  // ── glass: windshield band near the nose, rear window near the tail ──
  const gy0 = RL.y + (RBL.y - RL.y) * 0.14;
  const gy1 = RL.y + (RBL.y - RL.y) * 0.40;
  g.fillStyle = glass;
  g.beginPath();
  g.moveTo(RL.x + ri * 0.5, gy0); g.lineTo(RR.x - ri * 0.5, gy0);
  g.lineTo(RR.x - ri * 0.15, gy1); g.lineTo(RL.x + ri * 0.15, gy1);
  g.closePath(); g.fill();
  // reflection rake
  g.fillStyle = 'rgba(159,220,255,0.22)';
  g.beginPath();
  g.moveTo(RL.x + ri * 0.5, gy1); g.lineTo(RL.x + (RR.x - RL.x) * 0.42, gy0);
  g.lineTo(RL.x + (RR.x - RL.x) * 0.56, gy0); g.lineTo(RL.x + (RR.x - RL.x) * 0.2, gy1);
  g.closePath(); g.fill();
  if (rearGlass) {
    const ry0 = RL.y + (RBL.y - RL.y) * 0.66, ry1 = RL.y + (RBL.y - RL.y) * 0.86;
    g.fillStyle = glass;
    g.beginPath();
    g.moveTo(RL.x + ri * 0.3, ry1); g.lineTo(RR.x - ri * 0.3, ry1);
    g.lineTo(RR.x - ri * 0.6, ry0); g.lineTo(RL.x + ri * 0.6, ry0);
    g.closePath(); g.fill();
  }
  return { bl, br, RL, RR, RBL, RBR };
}

// ── Traffic vehicle ─────────────────────────────────────────────────────────
function bakeVehicle(kind, paint, wpx, lpx, hpx) {
  const PAD = 10;
  const H = lpx + hpx + PAD * 2;
  return bake(wpx + PAD * 2, H, (g) => {
    g.translate(PAD, PAD + hpx);   // origin = ground footprint top-left
    const w = wpx, l = lpx, lift = hpx;

    // wheels poking out below the body
    g.fillStyle = '#07090D';
    const tw = w * 0.09, th = l * 0.15;
    for (const wy of (kind === 'semi' ? [l * 0.1, l * 0.62, l * 0.84] : [l * 0.14, l * 0.68])) {
      g.fillRect(-tw * 0.3, wy, tw, th);
      g.fillRect(w - tw * 0.7, wy, tw, th);
    }

    const dark = '#1B212B';
    const glass = 'rgba(10,16,26,0.94)';

    if (kind === 'semi') {
      // trailer (tall box) then the cab in front of it
      drawShell(g, 0, l * 0.26, w, l * 0.74, lift, {
        roofInset: 0.05, noseInset: 0.04, body: '#20262F', roof: '#39414D', glass, rearGlass: false,
      });
      // trailer ribs on the roof
      g.strokeStyle = 'rgba(0,0,0,0.32)'; g.lineWidth = 1;
      for (let i = 1; i < 9; i++) {
        const yy = l * 0.26 - lift + (l * 0.74) * (i / 9);
        g.beginPath(); g.moveTo(w * 0.08, yy); g.lineTo(w * 0.92, yy); g.stroke();
      }
      // livery spine
      g.fillStyle = paint;
      g.fillRect(w * 0.42, l * 0.3 - lift, w * 0.16, l * 0.66);
      // cab
      drawShell(g, w * 0.04, 0, w * 0.92, l * 0.3, lift * 0.86, {
        roofInset: 0.12, noseInset: 0.2, body: paint, roof: paint, glass,
      });
      // stacks
      g.fillStyle = '#4C5563';
      g.fillRect(w * 0.05, -lift * 0.9, w * 0.05, lift * 0.55);
      g.fillRect(w * 0.9, -lift * 0.9, w * 0.05, lift * 0.55);
    } else {
      drawShell(g, 0, 0, w, l, lift, {
        roofInset: kind === 'sports' ? 0.16 : kind === 'van' ? 0.07 : 0.12,
        noseInset: kind === 'sports' ? 0.24 : kind === 'van' ? 0.08 : 0.16,
        body: paint, roof: paint, glass,
        rearGlass: kind !== 'pickup',
      });

      if (kind === 'pickup') {
        // open bed carved into the rear of the roof plane
        g.fillStyle = '#0C1016';
        g.fillRect(w * 0.14, l * 0.52 - lift, w * 0.72, l * 0.34);
        g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const yy = l * 0.52 - lift + (l * 0.34) * (i / 4);
          g.beginPath(); g.moveTo(w * 0.16, yy); g.lineTo(w * 0.84, yy); g.stroke();
        }
      } else if (kind === 'sports') {
        g.fillStyle = shade(paint, -40);
        g.fillRect(w * 0.04, l * 0.9 - lift, w * 0.92, l * 0.05);   // wing
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(w * 0.46, l * 0.06 - lift, w * 0.08, l * 0.2);   // nose stripe
      } else if (kind === 'suv') {
        g.fillStyle = shade(paint, -46);
        g.fillRect(w * 0.2, l * 0.2 - lift, w * 0.03, l * 0.5);     // roof rails
        g.fillRect(w * 0.77, l * 0.2 - lift, w * 0.03, l * 0.5);
      } else if (kind === 'van') {
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(w * 0.12, l * 0.5 - lift, w * 0.76, l * 0.02);
      }
      // mirrors
      g.fillStyle = dark;
      g.fillRect(-w * 0.06, l * 0.24 - lift * 0.7, w * 0.08, l * 0.04);
      g.fillRect(w * 0.98, l * 0.24 - lift * 0.7, w * 0.08, l * 0.04);
    }

    // headlights spill forward off the nose
    g.fillStyle = 'rgba(230,244,255,0.9)';
    g.fillRect(w * 0.1, -1, w * 0.2, Math.max(2, l * 0.022));
    g.fillRect(w * 0.7, -1, w * 0.2, Math.max(2, l * 0.022));
    // signature tail bar across the rear FACE (not the roof) so it reads in 3D
    const bh = Math.max(2.6, l * 0.03);
    g.fillStyle = 'rgba(255,45,35,0.3)';
    g.fillRect(w * 0.05, l - bh * 2.2, w * 0.9, bh * 2.2);
    g.fillStyle = '#FF3B2F';
    g.fillRect(w * 0.05, l - bh, w * 0.9, bh);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(w * 0.45, l - bh, w * 0.1, bh);
  });
}

// ── Player car — the Duely Interceptor ──────────────────────────────────────
function bakePlayer(wpx, lpx, hpx) {
  const PAD = 16;
  return bake(wpx + PAD * 2, lpx + hpx + PAD * 2, (g) => {
    g.translate(PAD, PAD + hpx);
    const w = wpx, l = lpx, lift = hpx;

    g.fillStyle = '#05070B';
    const tw = w * 0.1, th = l * 0.15;
    for (const wy of [l * 0.13, l * 0.68]) {
      g.fillRect(-tw * 0.32, wy, tw, th);
      g.fillRect(w - tw * 0.68, wy, tw, th);
    }

    drawShell(g, 0, 0, w, l, lift, {
      roofInset: 0.17, noseInset: 0.26,
      body: '#1E4C9E', roof: '#2C6BD6',      // bright Duely blue, high contrast
      glass: 'rgba(16,32,54,0.9)',
    });

    // carbon weave across the roof
    g.save();
    g.beginPath();
    g.rect(w * 0.17, -lift, w * 0.66, l * 0.86);
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.03)'; g.lineWidth = 1;
    for (let i = -l; i < w + l; i += 5) { g.beginPath(); g.moveTo(i, -lift); g.lineTo(i - l * 0.4, l); g.stroke(); }
    g.restore();

    // electric-blue emissives with baked bloom
    const bloom = (x0, y0, x1, y1, cw) => {
      for (const [lw, al] of [[cw * 6, 0.18], [cw * 3, 0.38], [cw, 1]]) {
        g.strokeStyle = `rgba(120,225,255,${al})`;
        g.lineWidth = lw; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
    };
    // front chevron across the nose
    bloom(w * 0.16, -lift + l * 0.02, w * 0.5, -lift - l * 0.02, 2.4);
    bloom(w * 0.84, -lift + l * 0.02, w * 0.5, -lift - l * 0.02, 2.4);
    // roof spine
    bloom(w * 0.5, -lift + l * 0.14, w * 0.5, -lift + l * 0.74, 1.5);
    // side skirt lines along the lower body
    bloom(w * 0.03, l * 0.3, w * 0.03, l * 0.9, 1.6);
    bloom(w * 0.97, l * 0.3, w * 0.97, l * 0.9, 1.6);
    // twin rear light strips on the rear FACE
    for (const [lw, al] of [[13, 0.22], [7, 0.42], [3, 1]]) {
      g.strokeStyle = `rgba(140,232,255,${al})`; g.lineWidth = lw; g.lineCap = 'round';
      g.beginPath(); g.moveTo(w * 0.12, l * 0.965); g.lineTo(w * 0.42, l * 0.965); g.stroke();
      g.beginPath(); g.moveTo(w * 0.58, l * 0.965); g.lineTo(w * 0.88, l * 0.965); g.stroke();
    }
    // headlights
    g.fillStyle = '#FFFFFF';
    g.fillRect(w * 0.1, -lift - 2, w * 0.2, Math.max(3, l * 0.032));
    g.fillRect(w * 0.7, -lift - 2, w * 0.2, Math.max(3, l * 0.032));
    g.fillStyle = 'rgba(190,240,255,0.55)';
    g.fillRect(w * 0.06, -lift - 3, w * 0.28, Math.max(4, l * 0.05));
    g.fillRect(w * 0.66, -lift - 3, w * 0.28, Math.max(4, l * 0.05));
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

// ── City skyline strip (parallax, tiles horizontally) ───────────────────────
function bakeSkyline(w, h, rand, density, tint) {
  return bake(w, h, (g, W, H) => {
    let x = -20;
    while (x < W + 20) {
      const bw = 18 + rand() * 46;
      const bh = H * (0.28 + rand() * (density === 'dense' ? 0.68 : 0.4));
      const y = H - bh;
      g.fillStyle = tint;
      g.fillRect(x, y, bw, bh);
      // lit windows
      g.fillStyle = 'rgba(120,220,255,0.85)';
      for (let wy = y + 5; wy < H - 4; wy += 8) {
        for (let wx = x + 4; wx < x + bw - 3; wx += 7) {
          if (((wx * 31 + wy * 17) % 13) < 4) g.fillRect(wx, wy, 2, 3);
        }
      }
      // occasional roof beacon
      if (rand() < 0.22) {
        g.fillStyle = 'rgba(255,90,70,0.75)';
        g.fillRect(x + bw / 2 - 1, y - 3, 2, 3);
      }
      x += bw + 4 + rand() * 12;
    }
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
      u2p = Math.min((playerY - H * 0.02) / VIEW_AHEAD, (W * 0.965) / (LANES * LANE_U));
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
        skyFar:  bakeSkyline(Math.max(520, W), Math.max(60, H * 0.13), makePRNG(21), 'sparse', '#243247'),
        skyMid:  bakeSkyline(Math.max(560, W), Math.max(70, H * 0.16), makePRNG(43), 'dense',  '#1A2436'),
        skyNear: bakeSkyline(Math.max(600, W), Math.max(80, H * 0.19), makePRNG(87), 'dense',  '#121B29'),
        smokePuff: bake(48, 48, (g, w, h) => {
          const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
          gr.addColorStop(0, 'rgba(176,190,210,0.5)');
          gr.addColorStop(1, 'rgba(176,190,210,0)');
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
        }),
        vignette: bake(W, H, (g) => {
          const v = g.createRadialGradient(W / 2, H * 0.6, Math.min(W, H) * 0.36, W / 2, H * 0.6, Math.max(W, H) * 0.8);
          v.addColorStop(0, 'rgba(0,0,0,0)');
          v.addColorStop(1, 'rgba(6,10,18,0.2)');
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
    // ── Projection: tilted camera. Screen position AND scale fall off with
    //    distance, which is what turns a flat scroller into a road with depth.
    //    Gameplay is untouched — lanes and hitboxes stay in world space.
    const PERSP_FAR = CAM_D / (CAM_D + VIEW_AHEAD);
    const perspAt = (wy) => CAM_D / (CAM_D + clamp(wy, -260, VIEW_AHEAD * 1.6));
    const horizonY = () => H * HORIZON_F;
    const wy2sy = (wy) => {
      const t = (1 - perspAt(wy)) / (1 - PERSP_FAR);
      return playerY - (playerY - horizonY()) * t;
    };
    const halfAt = (wy) => (roadW / 2) * perspAt(wy);
    const laneXAt = (laneF, wy) => W / 2 + ((laneF + 0.5) / LANES * 2 - 1) * halfAt(wy);

    // Scenery zones give the run a sense of journey without touching gameplay.
    const ZONES = ['city', 'open', 'bridge', 'tunnel', 'rain'];
    const zoneAt = (t) => ZONES[Math.floor(t / 26) % ZONES.length];

    function render(nowMs) {
      const sp = sprites;
      const light = isLight();
      const zone = zoneAt(S.simT);
      const inTunnel = zone === 'tunnel';
      const raining = zone === 'rain';
      S.tunnelA = clamp(S.tunnelA + (inTunnel ? 1 : -1) * 0.03, 0, 1);

      const shx = S.shake ? (frand() - 0.5) * 16 * S.shake : 0;
      const shy = S.shake ? (frand() - 0.5) * 12 * S.shake : 0;
      const tilt = clamp(S.laneVel * 0.0000075, -0.009, 0.009);
      const camX = -(S.laneX - LANE_U * LANES / 2) * u2p * 0.022;

      drawSky(light, zone);

      ctx.save();
      ctx.translate(W / 2 + shx + camX, H + shy);
      ctx.rotate(tilt);
      ctx.translate(-W / 2, -H);

      drawGroundPlane(light);
      drawRoad();
      drawRoadside(nowMs);
      drawOverheads();
      drawTraffic(nowMs);
      if (!S.dead) drawPlayer(nowMs);
      drawPuffs();
      drawParticles();
      drawFloats();
      ctx.restore();

      drawAtmosphere(light, raining, nowMs);

      if (S.flash > 0.01) {
        ctx.globalAlpha = S.flash;
        ctx.drawImage(sp.edgeFlash, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (!light) ctx.drawImage(sp.vignette, 0, 0);
      drawHUD(nowMs);
    }

    // ── Sky + parallax skyline above the horizon ──
    function drawSky(light, zone) {
      const hy = horizonY();
      const sp = sprites;
      ctx.fillStyle = light ? '#f0f4f8' : '#000000';
      ctx.fillRect(0, 0, W, H);
      if (light) return;   // light mode keeps the page background clean

      const g = ctx.createLinearGradient(0, 0, 0, hy);
      if (zone === 'tunnel') { g.addColorStop(0, '#141922'); g.addColorStop(1, '#1B2532'); }
      else if (zone === 'rain') { g.addColorStop(0, '#131A26'); g.addColorStop(1, '#22354D'); }
      else { g.addColorStop(0, '#101620'); g.addColorStop(0.5, '#182436'); g.addColorStop(1, '#27405E'); }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, hy);

      if (zone === 'tunnel') return;   // no skyline inside a tunnel

      // three bands, each scrolling at its own rate = parallax depth
      const bands = [
        { img: sp.skyFar,  rate: 0.006, a: 0.5,  yOff: 0 },
        { img: sp.skyMid,  rate: 0.014, a: 0.75, yOff: 2 },
        { img: sp.skyNear, rate: 0.028, a: 1,    yOff: 4 },
      ];
      for (const b of bands) {
        const iw = b.img.width;
        const off = (S.dist * b.rate) % iw;
        ctx.globalAlpha = b.a;
        const y = hy - b.img.height + b.yOff;
        for (let x = -off; x < W; x += iw) ctx.drawImage(b.img, x, y);
        ctx.globalAlpha = 1;
      }

      // horizon glow + haze so the road fades in rather than starting abruptly
      // ambient horizon bloom — the light source the whole scene sits under
      const hz = ctx.createLinearGradient(0, hy - H * 0.12, 0, hy + H * 0.06);
      hz.addColorStop(0, 'rgba(60,190,255,0)');
      hz.addColorStop(0.6, 'rgba(70,190,255,0.34)');
      hz.addColorStop(1, 'rgba(60,190,255,0)');
      ctx.fillStyle = hz;
      ctx.fillRect(0, hy - H * 0.12, W, H * 0.18);
    }

    // Ground beyond the tarmac — keeps the world from ending at the road edge.
    function drawGroundPlane(light) {
      if (light) return;
      const hy = horizonY();
      const g = ctx.createLinearGradient(0, hy, 0, H);
      g.addColorStop(0, '#1A2331');
      g.addColorStop(0.45, '#141B26');
      g.addColorStop(1, '#0F141C');
      ctx.fillStyle = g;
      ctx.fillRect(0, hy, W, H - hy);
    }

    // ── Road: a true trapezoid narrowing toward the horizon ──
    function drawRoad() {
      const sp = sprites;
      const hy = horizonY();
      const steps = 22;
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const wy = VIEW_AHEAD * (i / steps);
        pts.push({ sy: wy2sy(wy), half: halfAt(wy) });
      }
      // clip to the road shape, then blit the tiled surface inside it
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(W / 2 - pts[0].half, pts[0].sy);
      for (const q of pts) ctx.lineTo(W / 2 - q.half, q.sy);
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(W / 2 + pts[i].half, pts[i].sy);
      ctx.closePath();
      ctx.clip();

      // Perspective-correct-ish: draw the tile in horizontal slices, each scaled
      // to that slice's road width. Cheap and reads correctly.
      const tileH = sp.road.height;
      const scroll = (S.dist * VISUAL_SCROLL * u2p) % tileH;
      const SL = 26;
      for (let i = 0; i < SL; i++) {
        const wy0 = VIEW_AHEAD * (i / SL), wy1 = VIEW_AHEAD * ((i + 1) / SL);
        const y0 = wy2sy(wy1), y1 = wy2sy(wy0);
        const hw = halfAt((wy0 + wy1) / 2);
        const srcY = ((wy0 * u2p - scroll) % tileH + tileH) % tileH;
        const srcH = Math.max(1, (wy1 - wy0) * u2p);
        ctx.drawImage(sp.road, 0, srcY, sp.road.width, Math.min(srcH, tileH - srcY),
                      W / 2 - hw, y0, hw * 2, Math.max(1, y1 - y0));
      }
      ctx.restore();

      // fog fade into the horizon
      const fg = ctx.createLinearGradient(0, hy, 0, hy + H * 0.22);
      fg.addColorStop(0, 'rgba(52,86,124,0.85)');
      fg.addColorStop(0.5, 'rgba(40,66,98,0.4)');
      fg.addColorStop(1, 'rgba(36,60,90,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(0, hy, W, H * 0.22);

      // glowing edge rails follow the trapezoid
      for (const side of [-1, 1]) {
        ctx.beginPath();
        pts.forEach((q, i) => {
          const x = W / 2 + side * q.half;
          i === 0 ? ctx.moveTo(x, q.sy) : ctx.lineTo(x, q.sy);
        });
        ctx.strokeStyle = 'rgba(60,205,255,0.45)'; ctx.lineWidth = 7;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(120,225,255,0.9)'; ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(240,252,255,0.95)'; ctx.lineWidth = 1.2;
        ctx.stroke();
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
        const pr = perspAt((wy + wy1) / 2);
        const rw = 14 * pr;
        if (y1 < horizonY() - 2) continue;
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
        const sy = wy2sy(wy), pr = perspAt(wy), half = halfAt(wy);
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
      const sy = wy2sy(wy), pr = perspAt(wy), half = halfAt(wy);
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
      const pr = perspAt(wy);
      if (pr <= 0.02) return;
      const sy = wy2sy(wy);
      const cx = laneXAt(laneF, wy);
      const w = wpx * pr, l = lpx * pr, lift = hpx * pr;
      if (sy < horizonY() - l || sy > H + l) return;

      // contact shadow on the tarmac
      ctx.globalAlpha = 0.5;
      ctx.drawImage(sprites.shadow, cx - w * 0.72, sy - l * 0.86, w * 1.44, l * 0.9);
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
      ctx.globalAlpha = 0.55;
      ctx.drawImage(sp.shadow, cx - w * 0.78, sy - l * 0.85, w * 1.56, l * 0.9);
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
          const y = horizonY() + (H - horizonY()) * (t * t);
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
