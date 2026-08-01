// ─────────────────────────────────────────────────────────────────────────────
//  Rush Hour — 3D vehicle baking
//
//  Vehicles are real 3D models, but they are NOT rendered every frame. Each one
//  is built, lit and rendered once into an offscreen canvas, and from then on
//  the game blits it like any other sprite. A live 3D scene would mean rewriting
//  the render layer and paying a per-frame GPU cost on phones; baking gives real
//  geometry, materials and lighting for free. The camera is fixed and the cars
//  never rotate in the world, so nothing is lost.
//
//  three.js is imported lazily so it only loads on the Rush Hour route, and
//  every entry point fails soft: if WebGL is unavailable the caller keeps its
//  existing 2D sprite and the game is unaffected.
// ─────────────────────────────────────────────────────────────────────────────

let THREE = null;
let renderer = null;
let failed = false;

// Camera pitch, degrees above the road. Straight down is 90. Dropping it into
// the low 50s is what reveals the flanks, the raked screens and the front
// faces — i.e. what makes the world read as having depth. Much lower and near
// vehicles start hiding the ones behind them, which would hurt readability.
export const CAM_PITCH = 52;

// A tilted camera projects a car's HEIGHT upward on screen, so the sprite has
// to be taller than the vehicle's ground footprint. The footprint sits at the
// bottom of the sprite and the bodywork overhangs above it. Callers blit using
// this factor so the wheels still land exactly on the collision box.
export const SPRITE_OVERSCAN = 2.0;

async function boot() {
  if (failed) return null;
  if (renderer) return THREE;
  try {
    THREE = await import('three');
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    return THREE;
  } catch {
    failed = true;
    return null;
  }
}

// ── Side profiles ───────────────────────────────────────────────────────────
// This is the change that matters. Previously each body was a slab with a
// second slab on top, which from any angle reads as a lozenge. A car's identity
// lives in its SIDE view — bonnet height, windscreen rake, where the cabin sits
// along the wheelbase, how the tail falls away. So every vehicle is authored as
// a side silhouette and extruded across its width.
//
// Coordinates are [along, up]: -0.5 is the nose, +0.5 the tail, 0 the road.
const PROFILE = {
  sedan: {
    body: [[-0.50, 0.05], [-0.49, 0.15], [-0.30, 0.20], [0.30, 0.21], [0.50, 0.17], [0.50, 0.05]],
    cab: [[-0.13, 0.20], [0.01, 0.37], [0.20, 0.37], [0.31, 0.21]],
    w: 0.66, cabW: 0.86, axles: [-0.30, 0.30], tyre: 0.095,
  },
  sports: {
    body: [[-0.50, 0.04], [-0.50, 0.11], [-0.28, 0.15], [0.30, 0.16], [0.50, 0.12], [0.50, 0.04]],
    cab: [[-0.06, 0.15], [0.05, 0.29], [0.21, 0.29], [0.32, 0.16]],
    w: 0.68, cabW: 0.84, axles: [-0.31, 0.30], tyre: 0.092,
  },
  suv: {
    body: [[-0.50, 0.06], [-0.49, 0.20], [-0.32, 0.26], [0.34, 0.27], [0.50, 0.23], [0.50, 0.06]],
    cab: [[-0.20, 0.26], [-0.07, 0.45], [0.25, 0.45], [0.34, 0.27]],
    w: 0.64, cabW: 0.88, axles: [-0.30, 0.31], tyre: 0.115,
  },
  pickup: {
    body: [[-0.50, 0.06], [-0.49, 0.18], [-0.30, 0.24], [0.36, 0.25], [0.50, 0.21], [0.50, 0.06]],
    cab: [[-0.17, 0.24], [-0.05, 0.43], [0.13, 0.43], [0.20, 0.25]],
    w: 0.60, cabW: 0.90, axles: [-0.30, 0.32], tyre: 0.112,
  },
  van: {
    body: [[-0.50, 0.06], [-0.49, 0.22], [-0.38, 0.30], [0.42, 0.33], [0.50, 0.29], [0.50, 0.06]],
    cab: [[-0.35, 0.30], [-0.28, 0.53], [0.40, 0.55], [0.42, 0.33]],
    cabPainted: true,
    w: 0.58, cabW: 0.94, axles: [-0.32, 0.33], tyre: 0.115,
  },
  semi: {
    body: [[-0.50, 0.06], [-0.49, 0.26], [-0.32, 0.34], [0.46, 0.37], [0.50, 0.33], [0.50, 0.06]],
    cab: [[-0.45, 0.34], [-0.41, 0.58], [-0.17, 0.58], [-0.13, 0.34]],
    cabPainted: true,
    w: 0.40, cabW: 0.96, axles: [-0.40, 0.10, 0.36], tyre: 0.12,
  },
  // The player car is the only one with a pointed nose, a canopy set right back
  // over the rear axle and a full-width light bar. It should be identifiable
  // from its silhouette alone.
  player: {
    body: [[-0.50, 0.035], [-0.47, 0.09], [-0.26, 0.135], [0.24, 0.15], [0.50, 0.11], [0.50, 0.035]],
    cab: [[-0.02, 0.135], [0.08, 0.27], [0.22, 0.27], [0.32, 0.15]],
    w: 0.72, cabW: 0.80, axles: [-0.32, 0.31], tyre: 0.10,
  },
};

// Extrude a side profile across the vehicle's width, then orient it so the
// silhouette runs along world Z (the road) and the width across world X.
function extrudeProfile(pts, width, bevel) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(-Math.PI / 2);
  return geo;
}

const paint = (hex) =>
  new THREE.MeshStandardMaterial({ color: hex, roughness: 0.32, metalness: 0.4 });
const glassMat = () =>
  new THREE.MeshStandardMaterial({ color: 0x14283f, roughness: 0.06, metalness: 0.85 });
const tyreMat = () =>
  new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 0.95 });
const trimMat = () =>
  new THREE.MeshStandardMaterial({ color: 0x1a1f28, roughness: 0.6, metalness: 0.5 });
const emissive = (hex, i) =>
  new THREE.MeshStandardMaterial({
    color: hex, emissive: new THREE.Color(hex), emissiveIntensity: i, roughness: 0.35,
  });

function buildVehicle(kind, colour, accent) {
  const P = PROFILE[kind] || PROFILE.sedan;
  const g = new THREE.Group();

  const body = new THREE.Mesh(extrudeProfile(P.body, P.w, 0.016), paint(colour));
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // The greenhouse is a separate volume in dark glass. A coloured body under a
  // dark cabin is the clearest "this is a car" cue there is at small sizes.
  const cab = new THREE.Mesh(
    extrudeProfile(P.cab, P.w * P.cabW, 0.012),
    P.cabPainted ? paint(colour) : glassMat());
  cab.castShadow = true;
  g.add(cab);

  // Cargo bodies get an explicit windscreen instead of a glass greenhouse.
  if (P.cabPainted) {
    const cz = P.cab[0][0];
    const cy = (P.cab[0][1] + P.cab[1][1]) / 2;
    const ws = new THREE.Mesh(
      new THREE.BoxGeometry(P.w * 0.82, (P.cab[1][1] - P.cab[0][1]) * 0.7, 0.03), glassMat());
    ws.position.set(0, cy, cz - 0.012);
    g.add(ws);
  }

  // Wheels, set into the flanks so their outer face is just proud of the body.
  const wheel = new THREE.CylinderGeometry(P.tyre, P.tyre, 0.09, 20);
  const hubGeo = new THREE.CylinderGeometry(P.tyre * 0.5, P.tyre * 0.5, 0.1, 12);
  for (const z of P.axles) {
    for (const x of [-1, 1]) {
      const w = new THREE.Mesh(wheel, tyreMat());
      w.rotation.z = Math.PI / 2;
      w.position.set(x * (P.w / 2 - 0.012), P.tyre, z);
      w.castShadow = true;
      g.add(w);
      const hub = new THREE.Mesh(hubGeo, trimMat());
      hub.rotation.z = Math.PI / 2;
      hub.position.set(x * (P.w / 2 - 0.008), P.tyre, z);
      g.add(hub);
    }
  }

  // Lamps on the actual front and rear faces. With the camera dropped these are
  // visible, and they are most of what sells the depth.
  const noseY = P.body[1][1] * 0.72;
  const tailY = P.body[4][1] * 0.72;
  const headCol = kind === 'player' ? 0xe6f8ff : 0xfff2d2;
  for (const x of [-1, 1]) {
    const h = new THREE.Mesh(
      new THREE.BoxGeometry(P.w * 0.26, 0.045, 0.05),
      emissive(headCol, kind === 'player' ? 4.2 : 3.0));
    h.position.set(x * P.w * 0.28, noseY, -0.495);
    g.add(h);
  }
  const tailBar = new THREE.Mesh(
    new THREE.BoxGeometry(P.w * (kind === 'player' ? 0.82 : 0.7), 0.042, 0.045),
    emissive(kind === 'player' ? 0xff2d55 : 0xff3b30, kind === 'player' ? 3.4 : 2.6));
  tailBar.position.set(0, tailY, 0.495);
  g.add(tailBar);

  // Accent strip along the shoulder line.
  if (accent) {
    for (const x of [-1, 1]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.022, 0.44), emissive(accent, 2.2));
      s.position.set(x * (P.w / 2 - 0.004), P.body[2][1] * 0.86, 0.02);
      g.add(s);
    }
  }
  return g;
}

function makeScene() {
  const scene = new THREE.Scene();
  // Matches the road's light model: cool key from above-left, cyan rim from the
  // right to separate bodywork from dark asphalt, dim night fill.
  const key = new THREE.DirectionalLight(0xe8f4ff, 2.6);
  key.position.set(-2.4, 4.6, -1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -1.2; key.shadow.camera.right = 1.2;
  key.shadow.camera.top = 1.2; key.shadow.camera.bottom = -1.2;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x00bfff, 2.0);
  rim.position.set(2.8, 1.2, 2.4);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0x86c4ff, 0x060a12, 0.7));

  // Invisible ground that catches only the shadow, so cars sit on the road.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.ShadowMaterial({ opacity: 0.42 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  return scene;
}

/**
 * Render one vehicle. The returned canvas is SPRITE_OVERSCAN times taller than
 * the vehicle's footprint; the footprint occupies the bottom of the frame.
 * @returns {Promise<HTMLCanvasElement|null>} null if WebGL is unavailable.
 */
export async function bakeVehicle3D(kind, colour, accent, wpx, lpx) {
  const T = await boot();
  if (!T) return null;
  try {
    const scene = makeScene();
    const model = buildVehicle(kind, colour, accent);
    // Shift the car down-screen so its ground footprint sits flush with the
    // bottom of the sprite; everything above that is bodywork overhang.
    {
      const pitch0 = (CAM_PITCH * Math.PI) / 180;
      const halfYs = 0.5 * SPRITE_OVERSCAN * Math.sin(pitch0);
      model.position.z = (halfYs - 0.5 * Math.sin(pitch0)) / Math.sin(pitch0);
    }
    scene.add(model);

    const outW = Math.max(1, Math.round(wpx));
    const outH = Math.max(1, Math.round(lpx * SPRITE_OVERSCAN));

    // Orthographic, so a car looks the same whichever lane it is in. Under a
    // perspective camera lane position would change a vehicle's shape, making
    // traffic harder to read at speed.
    //
    // The frustum is deliberately ANISOTROPIC. Pitching the camera compresses
    // length on screen by sin(pitch) but leaves width untouched, so width and
    // length cannot both map to the sprite under one uniform scale. Driving the
    // horizontal extent from the model's own width — not from the output aspect
    // — keeps the footprint exactly aligned with the collision box, which is
    // what matters, and the slight vertical stretch is invisible.
    const pitch = (CAM_PITCH * Math.PI) / 180;
    const sinP = Math.sin(pitch);
    const P = PROFILE[kind] || PROFILE.sedan;
    const halfX = (P.w / 2) * 1.06;
    const halfY = 0.5 * SPRITE_OVERSCAN * sinP;
    const cam = new THREE.OrthographicCamera(-halfX, halfX, halfY, -halfY, 0.01, 24);
    const d = 8;
    cam.position.set(0, sinP * d, Math.cos(pitch) * d);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);

    renderer.setPixelRatio(1);
    renderer.setSize(outW, outH, false);
    renderer.render(scene, cam);

    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    out.getContext('2d').drawImage(renderer.domElement, 0, 0);

    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    return out;
  } catch {
    return null;
  }
}
