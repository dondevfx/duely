// ─────────────────────────────────────────────────────────────────────────────
//  Rush Hour — vehicle artwork
//
//  Vehicles are authored as SVG rather than drawn with canvas calls. Canvas
//  path-and-gradient art has a low ceiling: it produces smooth blobs with no
//  panel detail, which is what made the previous vehicles read as generic. SVG
//  lets the art carry shut lines, glass frit, lamp clusters, mirrors and wheel
//  detail at whatever density the design needs, and it costs nothing at run
//  time because each vehicle is rasterized once per size and then blitted.
//
//  Everything here is pure: given a paint colour and a pixel size it returns a
//  string. Nothing touches game state.
// ─────────────────────────────────────────────────────────────────────────────

// Lighten (positive) or darken (negative) a hex colour by `amt` per channel.
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// Rasterize an SVG string into an offscreen canvas at an exact pixel size.
// Data URLs do not taint the canvas and never hit the network, so this is safe
// under a strict CSP and cannot fail mid-run.
export function rasterize(svg, wpx, hpx) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(wpx));
      c.height = Math.max(1, Math.round(hpx));
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, c.width, c.height);
      resolve(c);
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// Shared definitions: the light model lives here so every vehicle is lit the
// same way — a cool key from above and slightly left, matching the road.
function defs(id, paint) {
  return `
  <defs>
    <linearGradient id="body${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0"    stop-color="${shade(paint, -62)}"/>
      <stop offset="0.10" stop-color="${shade(paint, -16)}"/>
      <stop offset="0.30" stop-color="${shade(paint, 34)}"/>
      <stop offset="0.50" stop-color="${shade(paint, 10)}"/>
      <stop offset="0.80" stop-color="${shade(paint, -18)}"/>
      <stop offset="1"    stop-color="${shade(paint, -68)}"/>
    </linearGradient>
    <linearGradient id="roof${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0"    stop-color="${shade(paint, -30)}"/>
      <stop offset="0.32" stop-color="${shade(paint, 46)}"/>
      <stop offset="1"    stop-color="${shade(paint, -34)}"/>
    </linearGradient>
    <linearGradient id="glass${id}" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0"    stop-color="#BFE4FF" stop-opacity="0.85"/>
      <stop offset="0.30" stop-color="#2C4C74" stop-opacity="0.97"/>
      <stop offset="1"    stop-color="#101F33" stop-opacity="0.97"/>
    </linearGradient>
    <linearGradient id="lamp${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#FFFDF2"/>
      <stop offset="0.55" stop-color="#FFE9A8"/>
      <stop offset="1"   stop-color="#8C7A45"/>
    </linearGradient>
    <linearGradient id="tail${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#5A1210"/>
      <stop offset="0.5" stop-color="#E8352A"/>
      <stop offset="1"   stop-color="#FF6A5A"/>
    </linearGradient>
    <linearGradient id="tyre${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0"   stop-color="#05070A"/>
      <stop offset="0.45" stop-color="#22272F"/>
      <stop offset="1"   stop-color="#05070A"/>
    </linearGradient>
  </defs>`;
}

// ── Sedan ───────────────────────────────────────────────────────────────────
// Authored at 220 x 340 and scaled to whatever the layout needs. Nose points
// up. Proportions follow VEHICLES.sedan so the art and the hitbox agree.
export function sedanSVG(paint) {
  const id = 's';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 340" width="220" height="340">
  ${defs(id, paint)}

  <!-- Wheels sit under the flanks with only their outer shoulder showing.
       Kept dark and tight: pulled any further out they read as ears. -->
  <g>
    <rect x="14"  y="62"  width="22" height="66" rx="9" fill="url(#tyre${id})"/>
    <rect x="184" y="62"  width="22" height="66" rx="9" fill="url(#tyre${id})"/>
    <rect x="14"  y="222" width="22" height="66" rx="9" fill="url(#tyre${id})"/>
    <rect x="184" y="222" width="22" height="66" rx="9" fill="url(#tyre${id})"/>
    <g fill="#ffffff" opacity="0.12">
      <rect x="20"  y="70"  width="6" height="50" rx="3"/>
      <rect x="190" y="70"  width="6" height="50" rx="3"/>
      <rect x="20"  y="230" width="6" height="50" rx="3"/>
      <rect x="190" y="230" width="6" height="50" rx="3"/>
    </g>
  </g>

  <!-- Body shell. The flanks run near-vertical through the cabin and the
       corners stay tight — an oval silhouette is what makes a top-down car
       read as a bar of soap rather than as a car. -->
  <path id="shell" d="
    M 78 10
    C 96 3, 124 3, 142 10
    C 170 21, 189 50, 191 96
    L 193 198
    C 193 260, 189 300, 181 318
    C 174 331, 156 336, 110 336
    C 64 336, 46 331, 39 318
    C 31 300, 27 260, 27 198
    L 29 96
    C 31 50, 50 21, 78 10 Z"
    fill="url(#body${id})" stroke="#05070C" stroke-width="5" stroke-linejoin="round"/>

  <clipPath id="clip${id}"><use href="#shell"/></clipPath>
  <g clip-path="url(#clip${id})">
    <!-- nose-to-tail form: light gathers on the bonnet, the tail falls away -->
    <rect x="0" y="0"   width="220" height="110" fill="#ffffff" opacity="0.11"/>
    <rect x="0" y="256" width="220" height="84"  fill="#000000" opacity="0.22"/>

    <!-- panel shut lines go on before the glass, so they never cross it -->
    <g stroke="#04070C" stroke-width="2.6" opacity="0.55" fill="none">
      <path d="M 30 100 L 190 100"/>
      <path d="M 30 204 L 190 204"/>
      <path d="M 30 262 L 190 262"/>
    </g>

    <!-- roof panel, clearly lighter than the flanks so the cabin reads as
         roof / glass / roof rather than as one dark smear -->
    <rect x="56" y="150" width="108" height="56" fill="url(#roof${id})"/>
    <!-- door glass, tucked between the roof and the flank -->
    <rect x="42"  y="152" width="14" height="52" rx="3" fill="#152740"/>
    <rect x="164" y="152" width="14" height="52" rx="3" fill="#152740"/>

    <!-- windscreen: raked back, so it is wider at its base -->
    <path d="M 74 104 L 146 104 L 158 150 L 62 150 Z" fill="url(#glass${id})"
          stroke="#04070C" stroke-width="3" stroke-linejoin="round"/>
    <path d="M 86 106 L 100 106 L 84 148 L 70 148 Z" fill="#EAF6FF" opacity="0.16"/>
    <!-- rear screen: the mirror of it -->
    <path d="M 62 206 L 158 206 L 148 250 L 72 250 Z" fill="url(#glass${id})"
          stroke="#04070C" stroke-width="3" stroke-linejoin="round"/>

    <!-- door handles -->
    <rect x="34"  y="176" width="15" height="7" rx="3.5" fill="#04070C" opacity="0.6"/>
    <rect x="171" y="176" width="15" height="7" rx="3.5" fill="#04070C" opacity="0.6"/>

    <!-- one specular sweep, the "expensive paint" cue -->
    <path d="M 58 0 L 76 0 L 62 340 L 44 340 Z" fill="#ffffff" opacity="0.11"/>
    <!-- rocker shadow tight to each flank -->
    <rect x="27"  y="70" width="10" height="230" fill="#000000" opacity="0.32"/>
    <rect x="183" y="70" width="10" height="230" fill="#000000" opacity="0.32"/>
  </g>

  <!-- Wing mirrors: the strongest read-at-a-glance cue in a top-down car.
       Dark and stubby — in body colour they looked like little flags. -->
  <path d="M 29 142 L 13 146 L 12 157 L 29 154 Z" fill="#2A3038" stroke="#05070C" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M 191 142 L 207 146 L 208 157 L 191 154 Z" fill="#2A3038" stroke="#05070C" stroke-width="2.5" stroke-linejoin="round"/>

  <!-- lamp clusters -->
  <path d="M 44 28 L 82 20 L 86 39 L 48 47 Z" fill="url(#lamp${id})" stroke="#05070C" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 176 28 L 138 20 L 134 39 L 172 47 Z" fill="url(#lamp${id})" stroke="#05070C" stroke-width="3" stroke-linejoin="round"/>
  <rect x="86" y="24" width="48" height="10" rx="5" fill="#05070C" opacity="0.8"/>
  <path d="M 42 298 L 90 298 L 90 320 L 45 320 Z" fill="url(#tail${id})" stroke="#05070C" stroke-width="3" stroke-linejoin="round"/>
  <path d="M 178 298 L 130 298 L 130 320 L 175 320 Z" fill="url(#tail${id})" stroke="#05070C" stroke-width="3" stroke-linejoin="round"/>
</svg>`;
}
