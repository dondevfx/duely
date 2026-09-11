// SEO: one list of public pages drives the prerendered HTML, the sitemap and
// the in-app title/description. These hold that together.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', ...p);
const load = (...p) => import(pathToFileURL(FE(...p)).href);

test('every public page has its own title and description, of sensible length', async () => {
  const { SEO_PAGES } = await load('src', 'data', 'seo.js');
  const titles = new Set(), descs = new Set();
  for (const p of SEO_PAGES) {
    assert.ok(p.title.length <= 65, `${p.path}: title is ${p.title.length} chars`);
    assert.ok(p.description.length >= 40 && p.description.length <= 170, `${p.path}: description is ${p.description.length} chars`);
    assert.ok(!titles.has(p.title), `${p.path}: duplicate title`);
    assert.ok(!descs.has(p.description), `${p.path}: duplicate description`);
    titles.add(p.title); descs.add(p.description);
  }
});

test('every game on the home grid has an SEO page', async () => {
  const { SEO_PAGES } = await load('src', 'data', 'seo.js');
  const { GAMES } = await load('src', 'data', 'games.js');
  const paths = new Set(SEO_PAGES.map(p => p.path));
  for (const g of GAMES) assert.ok(paths.has(g.route), `${g.title} (${g.route}) has no SEO page`);
});

test('the prerender rewrites every tag and never leaves the home ones behind', async () => {
  const { renderPage, sitemap } = await load('scripts', 'prerender-seo.mjs').catch(() => ({}));
  if (!renderPage) {
    // Importing the build script needs dist/index.html only when run directly;
    // the functions themselves are pure.
    assert.fail('prerender-seo.mjs could not be imported');
  }
  const html = fs.readFileSync(FE('index.html'), 'utf8');
  const { SEO_PAGES } = await load('src', 'data', 'seo.js');
  const tower = SEO_PAGES.find(p => p.path === '/game/tower');
  const out = renderPage(html, tower);
  assert.match(out, /<title>Tower — 1v1 Block Stacking \| Duely<\/title>/);
  assert.match(out, /<link rel="canonical" href="https:\/\/www\.duely\.us\/game\/tower" \/>/);
  assert.match(out, /<meta property="og:url" content="https:\/\/www\.duely\.us\/game\/tower" \/>/);
  assert.match(out, /<h1>Tower<\/h1>/);
  assert.doesNotMatch(out, /content="Play real-time 1v1 skill games against real players/,
    'a home description was left on the tower page');
  // The app itself is untouched: same bundle, same splash.
  assert.match(out, /<script type="module" src="\/src\/main\.jsx"><\/script>/);
  assert.match(out, /<span class="boot-mark">Duely<\/span>/);

  const xml = sitemap(SEO_PAGES, '2026-01-01');
  assert.match(xml, /<loc>https:\/\/www\.duely\.us\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.duely\.us\/game\/tower<\/loc>/);
  assert.equal((xml.match(/<url>/g) || []).length, SEO_PAGES.length);
});

test('previews use absolute URLs, and the site has one official address', () => {
  const html = fs.readFileSync(FE('index.html'), 'utf8');
  assert.match(html, /og:image" content="https:\/\/www\.duely\.us\/og-image\.png"/);
  assert.doesNotMatch(html, /content="\/og-image\.png"/, 'a relative preview image is ignored by several apps');
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.duely\.us\/" \/>/);

  const v = JSON.parse(fs.readFileSync(FE('vercel.json'), 'utf8'));
  assert.equal(v.cleanUrls, true, 'the per-page files would never be served at their clean URLs');
  const r = (v.redirects || []).find(x => x.has?.some(h => h.type === 'host' && h.value === 'duely.us'));
  assert.ok(r && r.permanent && r.destination.startsWith('https://www.duely.us/'), 'duely.us is not sent to www');
});

test('robots.txt points at the sitemap and keeps personal pages out', () => {
  const robots = fs.readFileSync(FE('public', 'robots.txt'), 'utf8');
  assert.match(robots, /^Sitemap: https:\/\/www\.duely\.us\/sitemap\.xml$/m);
  for (const p of ['/wallet', '/admin', '/profile', '/tournaments/', '/challenge/', '/reset-password']) {
    assert.match(robots, new RegExp(`^Disallow: ${p.replace(/\//g, '\\/')}$`, 'm'), `${p} is crawlable`);
  }
});

test('an address that is not a page gets a real 404, and people still land home', async () => {
  const { render404 } = await load('scripts', 'prerender-seo.mjs');
  const out = render404(fs.readFileSync(FE('index.html'), 'utf8'));
  assert.match(out, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(out, /rel="canonical"/, 'a 404 claiming to be the home page is the duplicate it exists to avoid');
  assert.match(out, /<span class="boot-mark">Duely<\/span>/, 'the 404 must still be the app');

  // Only the app's real routes go to the app; anything else falls to 404.html.
  const v = JSON.parse(fs.readFileSync(FE('vercel.json'), 'utf8'));
  assert.ok(!v.rewrites.some(r => r.source === '/(.*)'), 'a catch-all still answers every address with a 200');
  const app = fs.readFileSync(FE('src', 'App.jsx'), 'utf8');
  const routes = [...app.matchAll(/<Route path="([^"*]+)"/g)].map(m => m[1]).filter(p => !p.startsWith('/__'));
  const covered = (p) => v.rewrites.some(r => {
    if (r.source === p) return true;
    const base = r.source.replace(/\/:path\*$/, '');
    return r.source.endsWith(':path*') && p.startsWith(base + '/');
  });
  for (const p of routes) {
    const concrete = p.replace(/:[^/]+/g, 'x');
    assert.ok(covered(concrete), `${p} is a real page but would be served as a 404`);
  }
});

test('game pages describe themselves as games, with a breadcrumb', async () => {
  const { renderPage, structuredData } = await load('scripts', 'prerender-seo.mjs');
  const { SEO_PAGES } = await load('src', 'data', 'seo.js');
  const tower = SEO_PAGES.find(p => p.path === '/game/tower');
  const data = structuredData(tower);
  const game = data['@graph'].find(x => x['@type'] === 'VideoGame');
  assert.equal(game.name, 'Tower');
  assert.equal(game.url, 'https://www.duely.us/game/tower');
  assert.ok(!('offers' in game), 'no prices in the game description');
  assert.ok(data['@graph'].some(x => x['@type'] === 'BreadcrumbList'));
  assert.match(renderPage(fs.readFileSync(FE('index.html'), 'utf8'), tower), /"@type":"VideoGame"/);
  assert.equal(structuredData(SEO_PAGES.find(p => p.path === '/leaderboard')), null);
});

test('every game shares its own image, and the image exists', async () => {
  const { SEO_PAGES, OG_IMAGES } = await load('src', 'data', 'seo.js');
  for (const [route, slug] of Object.entries(OG_IMAGES)) {
    assert.ok(fs.existsSync(FE('public', 'og', `${slug}.jpg`)), `public/og/${slug}.jpg is missing`);
    assert.equal(SEO_PAGES.find(p => p.path === route).image, `https://www.duely.us/og/${slug}.jpg`);
  }
});

test('pages load their own code, and the translator does not block the page', () => {
  const app = fs.readFileSync(FE('src', 'App.jsx'), 'utf8');
  assert.match(app, /const TowerGame\s+= lazyPage\(\(\) => import\('\.\/pages\/TowerGame'\)\)/);
  assert.match(app, /<Suspense fallback=\{null\}>/);
  assert.match(app, /prefetchPages\(\)/, 'pages would load on first click instead of in the background');
  const lp = fs.readFileSync(FE('src', 'utils', 'lazyPage.js'), 'utf8');
  assert.match(lp, /window\.location\.reload\(\)/, 'a tab from before a deploy would break on its next page');
  const html = fs.readFileSync(FE('index.html'), 'utf8');
  assert.doesNotMatch(html, /<script src="\/\/translate\.google\.com/, 'Google Translate still blocks the page');
});

test('the home and games grids link to every game with a real link', () => {
  // The cards were divs that navigated on click: from the home page and
  // /games there was no link a crawler could follow to any game.
  const card = fs.readFileSync(FE('src', 'components', 'GameVideoCard.jsx'), 'utf8');
  assert.match(card, /const Root = available \? Link : 'div';/);
  for (const page of ['Home.jsx', 'Games.jsx']) {
    const src = fs.readFileSync(FE('src', 'pages', page), 'utf8');
    assert.match(src, /<GameVideoCard/, `${page} no longer renders the game cards`);
  }
});

test('the home page heading names the site, and the outline has an h2', () => {
  const home = fs.readFileSync(FE('src', 'pages', 'Home.jsx'), 'utf8');
  const h1 = home.match(/<h1[\s\S]*?<\/h1>/)[0];
  assert.match(h1, /<span className="sr-only">Duely — <\/span>/, 'the main heading never says "Duely"');
  assert.match(h1, /1v1/, 'the visible heading changed');
  assert.match(home, /<h2 className="font-bold text-white mb-3 xl:mb-2">How Duely Works<\/h2>/);
});

test('a trailing slash is not a second copy of a page', () => {
  const v = JSON.parse(fs.readFileSync(FE('vercel.json'), 'utf8'));
  assert.equal(v.trailingSlash, false, '/game/tower/ and /game/tower both answer 200');
});

test('the build runs the prerender, and the app keeps titles right after navigation', () => {
  const pkg = JSON.parse(fs.readFileSync(FE('package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /vite build && node scripts\/prerender-seo\.mjs/);
  const app = fs.readFileSync(FE('src', 'App.jsx'), 'utf8');
  assert.match(app, /<PageMeta \/>/);
});
