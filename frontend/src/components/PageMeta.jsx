import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SITE, SEO_PAGES, NOINDEX_PREFIXES, seoFor } from '../data/seo';

const HOME = SEO_PAGES[0];

function setMeta(selector, attr, value) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement(selector.startsWith('link') ? 'link' : 'meta');
    const m = selector.match(/\[(name|property|rel)="([^"]+)"\]/);
    if (m) el.setAttribute(m[1], m[2]);
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

/**
 * The page's title, description and canonical, kept right as the route
 * changes. Renders nothing. The first load already has the right tags from
 * the prerendered file; this keeps them right after in-app navigation, which
 * is what Google's renderer and a shared link both see.
 */
export default function PageMeta() {
  const { pathname } = useLocation();

  useEffect(() => {
    const page = seoFor(pathname);
    const clean = (pathname || '/').replace(/\/+$/, '') || '/';
    const title = page?.title || HOME.title;
    const description = page?.description || HOME.description;
    const url = SITE + (page ? (page.path === '/' ? '/' : page.path) : clean);

    document.title = title;
    setMeta('meta[name="description"]', 'content', description);
    setMeta('link[rel="canonical"]', 'href', url);
    setMeta('meta[property="og:url"]', 'content', url);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', description);
    const image = page?.image || HOME.image;
    setMeta('meta[property="og:image"]', 'content', image);
    setMeta('meta[name="twitter:image"]', 'content', image);

    const hidden = NOINDEX_PREFIXES.some(p => clean === p.replace(/\/$/, '') || clean.startsWith(p));
    const robots = document.head.querySelector('meta[name="robots"]');
    if (hidden) setMeta('meta[name="robots"]', 'content', 'noindex');
    else if (robots) robots.remove();
  }, [pathname]);

  return null;
}
