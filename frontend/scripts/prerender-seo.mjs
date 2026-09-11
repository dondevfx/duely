// After `vite build`: one static HTML file per public page, a 404 page, and
// sitemap.xml.
//
// The app renders in the browser, so before this every URL was served the
// same index.html — one title and one description for the whole site. Each
// file written here is that same index.html (same bundle, same splash, same
// app) with its own <title>, description, canonical, social tags, share image,
// structured data and a plain-text summary inside the existing <noscript>.
// Nothing a visitor sees changes: the app loads and takes over exactly as
// before.
//
// Written as /game/tower.html etc.; vercel.json's cleanUrls serves it at
// /game/tower. A URL that is none of the app's routes gets 404.html — the same
// app, which sends a person home exactly as before, but with a real 404 status
// so a search engine does not index it as a copy of the home page.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEO_PAGES, SITE, SITE_NAME, DEFAULT_IMAGE, isGamePage } from '../src/data/seo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function must(html, re, replacement, what) {
  if (!re.test(html)) throw new Error(`prerender-seo: could not find ${what} in dist/index.html`);
  return html.replace(re, replacement);
}

const urlOf = (page) => SITE + (page.path === '/' ? '/' : page.path);

// Search engines' own vocabulary for "this page is a game you can play here",
// and where it sits in the site. No prices or offers: the page is described
// as the game it is.
export function structuredData(page) {
  if (!isGamePage(page)) return null;
  const url = urlOf(page);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'VideoGame',
        name: page.heading,
        description: page.description,
        url,
        image: page.image || DEFAULT_IMAGE,
        genre: 'Skill game',
        playMode: ['SinglePlayer', 'MultiPlayer'],
        gamePlatform: 'Web browser',
        applicationCategory: 'Game',
        operatingSystem: 'Any',
        publisher: { '@type': 'Organization', name: SITE_NAME, url: `${SITE}/` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Games', item: `${SITE}/games` },
          { '@type': 'ListItem', position: 3, name: page.heading, item: url },
        ],
      },
    ],
  };
}

export function renderPage(html, page) {
  const url = urlOf(page);
  const image = page.image || DEFAULT_IMAGE;
  let out = html;
  out = must(out, /<title>[\s\S]*?<\/title>/, `<title>${esc(page.title)}</title>`, '<title>');
  out = must(out, /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${esc(page.description)}" />`, 'meta description');
  out = must(out, /<link rel="canonical" href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${url}" />`, 'canonical');
  out = must(out, /<meta property="og:url" content="[^"]*"\s*\/?>/,
    `<meta property="og:url" content="${url}" />`, 'og:url');
  out = must(out, /<meta property="og:title" content="[^"]*"\s*\/?>/,
    `<meta property="og:title" content="${esc(page.title)}" />`, 'og:title');
  out = must(out, /<meta property="og:description" content="[^"]*"\s*\/?>/,
    `<meta property="og:description" content="${esc(page.description)}" />`, 'og:description');
  out = must(out, /<meta property="og:image" content="[^"]*"\s*\/?>/,
    `<meta property="og:image" content="${image}" />`, 'og:image');
  out = must(out, /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:title" content="${esc(page.title)}" />`, 'twitter:title');
  out = must(out, /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:description" content="${esc(page.description)}" />`, 'twitter:description');
  out = must(out, /<meta name="twitter:image" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:image" content="${image}" />`, 'twitter:image');
  // The summary for readers with no JavaScript — crawlers that do not render,
  // link previews. Shown to nobody with a working browser.
  //
  // Anchored on the boot-note block, not the first "<noscript>": the comment
  // above the splash mentions the tag by name, and matching that deleted the
  // splash itself from every page.
  out = must(out, /<noscript>\s*<div class="boot-note">[\s\S]*?<\/noscript>/, `<noscript>
        <div class="boot-note">
          <h1>${esc(page.heading)}</h1>
          <p>${esc(page.body)}</p>
          <p>Duely needs JavaScript to run. Please enable it, or open
             <a href="${url}">${url}</a> in a current browser.</p>
        </div>
      </noscript>`, '<noscript>');
  const data = structuredData(page);
  if (data) {
    // "<" escaped so nothing in the data can close the script tag.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    out = must(out, /<\/head>/, `    <script type="application/ld+json">${json}</script>\n  </head>`, '</head>');
  }
  return out;
}

export function render404(html) {
  let out = html;
  out = must(out, /<title>[\s\S]*?<\/title>/, `<title>Page not found — ${SITE_NAME}</title>`, '<title>');
  // No canonical: this page is not the home page, and saying it was is the
  // duplicate the 404 exists to avoid.
  out = must(out, /\s*<link rel="canonical" href="[^"]*"\s*\/?>/, '', 'canonical');
  out = must(out, /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="This page does not exist." />\n    <meta name="robots" content="noindex" />`, 'meta description');
  return out;
}

export function sitemap(pages, lastmod) {
  const rows = pages.map(p => `  <url>
    <loc>${urlOf(p)}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${(p.priority ?? 0.5).toFixed(1)}</priority>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows}
</urlset>
`;
}

// Only when run directly (the build), not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const template = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const page of SEO_PAGES) {
    const file = page.path === '/' ? join(dist, 'index.html') : join(dist, `${page.path.slice(1)}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(template, page));
  }
  writeFileSync(join(dist, '404.html'), render404(template));
  writeFileSync(join(dist, 'sitemap.xml'), sitemap(SEO_PAGES, new Date().toISOString().slice(0, 10)));
  console.log(`prerender-seo: ${SEO_PAGES.length} pages + 404.html + sitemap.xml`);
}
