// ─────────────────────────────────────────────────────────────────────────────
//  Rush Hour — 3D vehicle baking
//
//  The vehicles are real 3D models, but they are NOT rendered every frame. Each
//  one is built, lit and rendered once into an offscreen canvas at the exact
//  pixel size it will appear on screen, and from then on the game blits it like
//  any other sprite.
//
//  This is deliberate. A live 3D scene would mean rewriting the render layer,
//  a per-frame GPU cost on phones, and a camera change that would affect how
//  the game reads. Baking gives the thing that was actually asked for — cars
//  that are genuinely three-dimensional, with real geometry, real materials and
//  real lighting — at zero per-frame cost and with no risk to the 60fps budget.
//  The camera is fixed and near-top-down, so nothing is lost by baking: the
//  cars never rotate in the world.
//
//  three.js is imported lazily so it only loads on the Rush Hour route, and
//  every entry point fails soft: if WebGL is unavailable the caller keeps its
//  existing 2D sprite and the game is unaffected.
// ─────────────────────────────────────────────────────────────────────────────

let THREE = null;
let renderer = null;
let failed = false;

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

// Rounded top-down outline → an extruded, bevelled solid. This is what gives
// the bodies real thickness and catches the light along every edge.
function extrude(pts, depth, bevel) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 12,
  });
}

const paint = (hex, rough = 0.30) =>
  new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.35 });

const glassMat = () =>
  new THREE.MeshStandardMaterial({ color: 0x060c16, roughness: 0.05, metalness: 1.0 });

const tyreMat = () =>
  new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.92, metalness: 0.0 });

const emissive = (hex, strength = 2.4) =>
  new THREE.MeshStandardMaterial({
    color: hex, emissive: new THREE.Color(hex), emissiveIntensity: strength, roughness: 0.4,
  });

// ── Body plans ──────────────────────────────────────────────────────────────
// Half-width profiles, nose (-L/2) to tail (+L/2), mirrored automatically. The
// silhouettes are angular and faceted on purpose: rounded plans are what made
// the earlier art read as soap bars.
function plan(profile) {
  const right = profile.map(([y, x]) => [x, y]);
  const left = [...profile].reverse().map(([y, x]) => [-x, y]);
  return [...right, ...left];
}

const BODY = {
  sedan: plan([[-0.50, 0.22], [-0.44, 0.34], [-0.30, 0.44], [0.06, 0.46], [0.30, 0.44], [0.44, 0.36], [0.50, 0.26]]),
  suv: plan([[-0.50, 0.28], [-0.44, 0.40], [-0.28, 0.47], [0.14, 0.48], [0.40, 0.46], [0.50, 0.38]]),
  pickup: plan([[-0.50, 0.26], [-0.42, 0.40], [-0.26, 0.46], [0.16, 0.47], [0.44, 0.45], [0.50, 0.40]]),
  sports: plan([[-0.50, 0.16], [-0.40, 0.34], [-0.22, 0.46], [0.10, 0.48], [0.36, 0.44], [0.50, 0.30]]),
  van: plan([[-0.50, 0.30], [-0.42, 0.44], [-0.26, 0.49], [0.34, 0.50], [0.50, 0.44]]),
  semi: plan([[-0.50, 0.28], [-0.44, 0.42], [-0.30, 0.48], [0.40, 0.50], [0.50, 0.46]]),
  player: plan([[-0.50, 0.14], [-0.42, 0.30], [-0.30, 0.42], [-0.10, 0.48], [0.18, 0.47], [0.38, 0.42], [0.50, 0.24]]),
};

// Cabin plans sit on top of the body and are what read as "this is a car" from
// above — roof, screens and shoulders in one silhouette.
const CABIN = {
  sedan: plan([[-0.20, 0.30], [-0.10, 0.36], [0.14, 0.36], [0.24, 0.28]]),
  suv: plan([[-0.24, 0.36], [-0.12, 0.40], [0.22, 0.40], [0.32, 0.34]]),
  pickup: plan([[-0.22, 0.34], [-0.12, 0.38], [0.02, 0.38], [0.08, 0.32]]),
  sports: plan([[-0.10, 0.30], [0.00, 0.34], [0.16, 0.33], [0.24, 0.26]]),
  van: plan([[-0.30, 0.38], [-0.20, 0.44], [0.34, 0.45], [0.42, 0.40]]),
  semi: plan([[-0.44, 0.36], [-0.36, 0.42], [-0.16, 0.42], [-0.10, 0.36]]),
  player: plan([[-0.14, 0.28], [-0.04, 0.34], [0.16, 0.33], [0.26, 0.24]]),
};

const HEIGHT = {
  sedan: [0.30, 0.24], suv: [0.42, 0.30], pickup: [0.36, 0.26],
  sports: [0.22, 0.20], van: [0.52, 0.34], semi: [0.60, 0.34],
  player: [0.26, 0.22],
};

function extentsOf(planPts) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const [x, z] of planPts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1, w: x1 - x0, l: z1 - z0, cz: (z0 + z1) / 2 };
}

function buildVehicle(kind, colour, accent, widthRatio) {
  const g = new THREE.Group();
  const [bodyH, cabH] = HEIGHT[kind] || HEIGHT.sedan;
  const bodyPlan = BODY[kind] || BODY.sedan;
  const cabPlan = CABIN[kind] || CABIN.sedan;
  const be = extentsOf(bodyPlan), ce = extentsOf(cabPlan);
  const GROUND = 0.08;
  const bodyTop = GROUND + bodyH;
  const roofTop = bodyTop + cabH;

  const body = new THREE.Mesh(extrude(bodyPlan, bodyH, 0.022), paint(colour));
  body.rotation.x = -Math.PI / 2;
  body.position.y = GROUND;
  body.castShadow = true;
  g.add(body);

  const cabin = new THREE.Mesh(extrude(cabPlan, cabH, 0.018), paint(colour, 0.28));
  cabin.rotation.x = -Math.PI / 2;
  cabin.position.y = bodyTop;
  cabin.castShadow = true;
  g.add(cabin);

  // Glass is the ROOF, not something buried inside the cabin. Viewed from above
  // that is the only way it can be seen at all: a glazed panel following the
  // cabin outline, with a painted roof bar across the middle splitting it into
  // a windscreen and a rear screen.
  if (kind !== 'van' && kind !== 'semi') {
    const glass = new THREE.Mesh(extrude(cabPlan, 0.02, 0.012), glassMat());
    glass.rotation.x = -Math.PI / 2;
    glass.position.y = roofTop + 0.002;
    glass.scale.set(0.84, 0.84, 1);
    glass.position.z = ce.cz * 0.16;
    g.add(glass);

    const roofBar = new THREE.Mesh(
      new THREE.BoxGeometry(ce.w * 0.86, 0.03, ce.l * 0.26), paint(colour, 0.3));
    roofBar.position.set(0, roofTop + 0.012, ce.cz);
    g.add(roofBar);
  } else {
    // cargo bodies get a cab windscreen at the nose instead
    const ws = new THREE.Mesh(new THREE.BoxGeometry(ce.w * 0.74, 0.02, ce.l * 0.3), glassMat());
    ws.position.set(0, roofTop + 0.004, ce.z0 + ce.l * 0.2);
    g.add(ws);
  }

  // Wheels have to sit PROUD of the flanks or the body hides them completely
  // from this camera. Half the tyre showing is what reads as a wheel.
  const wheelR = kind === 'semi' || kind === 'van' ? 0.125 : 0.105;
  const wheel = new THREE.CylinderGeometry(wheelR, wheelR, 0.16, 18);
  const axles = kind === 'semi' ? [-0.34, 0.18, 0.34] : [be.z0 + 0.16, be.z1 - 0.16];
  for (const z of axles) {
    for (const x of [-1, 1]) {
      const w = new THREE.Mesh(wheel, tyreMat());
      w.rotation.z = Math.PI / 2;
      w.position.set(x * (be.x1 + 0.05), wheelR, z);
      w.castShadow = true;
      g.add(w);
    }
  }

  // Lamps go on the upper surface near each end, angled into view. On the nose
  // face they were invisible from directly above.
  const lampY = bodyTop - 0.01;
  for (const x of [-1, 1]) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(be.w * 0.24, 0.05, 0.07),
      emissive(kind === 'player' ? 0xdff6ff : 0xfff0cc, 3.4));
    m.position.set(x * be.x1 * 0.52, lampY, be.z0 + 0.045);
    g.add(m);
  }
  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(be.w * 0.72, 0.05, 0.055),
    emissive(kind === 'player' ? 0xff2d55 : 0xff3b30, 3.0));
  tail.position.set(0, lampY, be.z1 - 0.04);
  g.add(tail);

  // Accent strips run along the top of each flank, where the camera can see
  // them, rather than down the side where it cannot.
  if (accent) {
    for (const x of [-1, 1]) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.03, be.l * 0.52), emissive(accent, 2.0));
      strip.position.set(x * be.x1 * 0.88, bodyTop - 0.005, be.cz);
      g.add(strip);
    }
  }

  g.scale.set(widthRatio, 1, 1);
  return g;
}

// ── The one scene, reused for every bake ────────────────────────────────────
function makeScene() {
  const scene = new THREE.Scene();

  // Same light model as the road: a cool key from above and slightly left, a
  // dim blue ambient for the night, and a cyan rim to separate cars from the
  // asphalt behind them.
  const key = new THREE.DirectionalLight(0xdfefff, 2.4);
  key.position.set(-2.2, 5.2, -1.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -1.6; key.shadow.camera.right = 1.6;
  key.shadow.camera.top = 1.6; key.shadow.camera.bottom = -1.6;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x00bfff, 2.2);
  rim.position.set(2.6, 1.4, 2.2);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0x8ec8ff, 0x070c14, 0.75));
  return scene;
}

/**
 * Render one vehicle to an offscreen canvas.
 * @returns {Promise<HTMLCanvasElement|null>} null if WebGL is unavailable.
 */
export async function bakeVehicle3D(kind, colour, accent, wpx, lpx) {
  const T = await boot();
  if (!T) return null;
  try {
    const scene = makeScene();
    // Sprites are taller than they are wide; the models are authored square in
    // plan, so they are squashed to the real width:length ratio here. Getting
    // this wrong clips the bodies against the frustum.
    const widthRatio = wpx / lpx;
    const g = buildVehicle(kind, colour, accent, widthRatio);
    scene.add(g);

    // Near-top-down with a few degrees of tilt, so a little of the flanks and
    // the roof edge show. Orthographic, so vehicles in different lanes are not
    // skewed differently — a perspective camera would make lane position change
    // how a car looks, which would hurt readability.
    // Frustum derived from the model's real extents plus margin for the tilt,
    // rather than a guessed constant.
    const halfZ = 0.5 * 1.12;
    const halfX = 0.5 * widthRatio * 1.12;
    const cam = new THREE.OrthographicCamera(-halfX, halfX, halfZ, -halfZ, 0.1, 20);
    cam.position.set(0, 6, 0.62);
    cam.lookAt(0, 0.16, 0);

    renderer.setPixelRatio(1);
    renderer.setSize(Math.max(1, Math.round(wpx)), Math.max(1, Math.round(lpx)), false);
    renderer.render(scene, cam);

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(wpx));
    out.height = Math.max(1, Math.round(lpx));
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
