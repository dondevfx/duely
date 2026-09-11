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

test('the build runs the prerender, and the app keeps titles right after navigation', () => {
  const pkg = JSON.parse(fs.readFileSync(FE('package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /vite build && node scripts\/prerender-seo\.mjs/);
  const app = fs.readFileSync(FE('src', 'App.jsx'), 'utf8');
  assert.match(app, /<PageMeta \/>/);
});
