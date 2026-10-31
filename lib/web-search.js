// Finding a page on a site the way a chatbot does: ask a search engine,
// which has already read the whole site, instead of clicking through its
// menus. Only results on the site the person is already on (or the one
// Wikidata confirmed as official) are ever used, so a search can never send
// them to a lookalike.
//
// Search engines, in order of privacy:
// - SearXNG on this computer (no account, no key; it asks the big engines
//   without saying who is asking).
// - Tavily or Brave, with the person's own free key.
// - No engine at all: the site's own sitemap, the list of its pages many
//   sites publish for search engines. Free and private, but patchy.
//
// Pure functions; the requests are made in background.js.

import { siteOf, terms } from './scout.js';

export const SEARCH_ENGINES = ['searxng', 'tavily', 'brave', 'sitemap'];

// The request for one search, restricted to one site.
export function searchRequest(engine, { site, phrase, key, url }) {
  const q = `site:${site} ${phrase}`;
  if (engine === 'searxng') {
    return { url: `${(url || 'http://localhost:8888').replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json`, init: {} };
  }
  if (engine === 'tavily') {
    return {
      url: 'https://api.tavily.com/search',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: phrase, include_domains: [site], max_results: 6 }),
      },
    };
  }
  if (engine === 'brave') {
    return {
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`,
      init: { headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
    };
  }
  return null;
}

// Every engine's answer as [{ url, title, snippet }].
export function parseResults(engine, json) {
  if (!json) return [];
  const raw = engine === 'brave' ? (json.web && json.web.results) || [] : json.results || [];
  return raw
    .map((r) => ({ url: r.url || '', title: (r.title || '').replace(/<[^>]+>/g, ''), snippet: (r.content || r.description || '').replace(/<[^>]+>/g, '') }))
    .filter((r) => /^https?:\/\//.test(r.url));
}

// Only pages on that site (any subdomain: registrar.sa.ucsb.edu is UCSB),
// and only real pages, not files.
export function onSite(results, site) {
  const seen = new Set();
  return results.filter((r) => {
    let u;
    try {
      u = new URL(r.url);
    } catch {
      return false;
    }
    const key = u.href.split('#')[0];
    if (seen.has(key) || siteOf(u.host) !== site || /\.(pdf|zip|docx?|xlsx?|pptx?)(\?|$)/i.test(u.pathname)) return false;
    seen.add(key);
    return true;
  });
}

// Addresses listed in a sitemap, and the further sitemaps an index lists.
export function sitemapEntries(xml) {
  const locs = [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

// Sitemap pages whose address has the words asked for ("undergraduate
// admission" finds /applying/undergraduate-admission), best first. At least
// half the words must be in the address.
export function rankUrls(urls, phrase) {
  const wanted = [...new Set(terms(phrase))];
  if (!wanted.length) return [];
  const scored = [];
  for (const url of urls) {
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const words = terms(`${u.host.split('.')[0]} ${decodeURIComponent(u.pathname)}`);
    const hits = wanted.filter((w) => words.some((x) => x === w || (w.length > 4 && (x.startsWith(w) || w.startsWith(x))))).length;
    if (hits * 2 < wanted.length || !hits) continue;
    scored.push({ url, hits, depth: u.pathname.split('/').filter(Boolean).length });
  }
  return scored.sort((a, b) => b.hits - a.hits || a.depth - b.depth).map((s) => s.url);
}

// "UCSB undergraduate admissions": which part names the organisation and
// which the page. Tried longest first: "UCSB undergraduate", then "UCSB".
export function splitNameAndPage(name) {
  const words = name.trim().split(/\s+/);
  const out = [];
  for (let k = words.length - 1; k >= 1; k--) {
    out.push({ name: words.slice(0, k).join(' ').replace(/'s$/i, ''), page: words.slice(k).join(' ') });
  }
  return out;
}

// A readable name for a sitemap page with no title yet:
// /applying/undergraduate-admission -> "undergraduate admission".
export function nameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || new URL(url).host).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ');
  } catch {
    return url;
  }
}
