// After `vite build`: one static HTML file per public page, and sitemap.xml.
//
// The app renders in the browser, so before this every URL was served the
// same index.html — one title and one description for the whole site. Each
// file written here is that same index.html (same bundle, same splash, same
// app) with its own <title>, description, canonical, social tags and a
// plain-text summary inside the existing <noscript>. Nothing a visitor sees
// changes: the app loads and takes over exactly as before.
//
// Written as /game/tower.html etc.; vercel.json's cleanUrls serves it at
// /game/tower. Anything not listed still falls through to index.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEO_PAGES, SITE, DEFAULT_IMAGE } from '../src/data/seo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const template = readFileSync(join(dist, 'index.html'), 'utf8');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function must(html, re, replacement, what) {
  if (!re.test(html)) throw new Error(`prerender-seo: could not find ${what} in dist/index.html`);
  return html.replace(re, replacement);
}

export function renderPage(html, page) {
  const url = SITE + (page.path === '/' ? '/' : page.path);
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
  out = must(out, /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:title" content="${esc(page.title)}" />`, 'twitter:title');
  out = must(out, /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
    `<meta name="twitter:description" content="${esc(page.description)}" />`, 'twitter:description');
  // The summary for readers with no JavaScript — crawlers that do not render,
  // link previews. Shown to nobody with a working browser.
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
  return out;
}

export function sitemap(pages, lastmod) {
  const rows = pages.map(p => `  <url>
    <loc>${SITE}${p.path === '/' ? '/' : p.path}</loc>
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
  for (const page of SEO_PAGES) {
    const file = page.path === '/' ? join(dist, 'index.html') : join(dist, `${page.path.slice(1)}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(template, page));
  }
  writeFileSync(join(dist, 'sitemap.xml'), sitemap(SEO_PAGES, new Date().toISOString().slice(0, 10)));
  console.log(`prerender-seo: ${SEO_PAGES.length} pages + sitemap.xml (image ${DEFAULT_IMAGE})`);
}
