// "Take me to the UChicago website": which site is meant, and its real
// address. The address never comes from the AI's memory, where a small
// model can invent one or land on a lookalike; it comes from Wikidata, the
// public database behind Wikipedia, which records each organisation's
// official website. Pure functions; the requests are made in background.js.

// "take me to the UChicago website", "go to ucsb.edu", "open Wikipedia's site"
const GO_TO = /^(?:please\s+|can you\s+|could you\s+)?(?:take me to|go to|open|navigate to|bring me to|visit|ll[eé]vame a|ves a|v[eé]s a|porta'?m a|abre|obre)\s+(.+?)[.?!]*$/i;
const SITE_WORDS = /\s*(?:'s)?\s*\b(?:official\s+)?(?:website|web ?site|site|home ?page|web|p[aà]gina web|lloc web|sitio web)\b\s*$/i;
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?$/i;

// What to go to, or null if this is not a request to go to a site. On a
// normal page, "take me to the admissions page" means a link there, so only
// an explicit website or address counts, unless there is no page at all.
export function siteRequest(question, onWebPage) {
  const m = question.trim().match(GO_TO);
  if (!m) return null;
  let target = m[1].trim().replace(/^the\s+/i, '');
  const domain = target.match(DOMAIN);
  if (domain) return { kind: 'address', url: `https://${domain[1]}${domain[2] || ''}` };
  const saysSite = SITE_WORDS.test(target);
  if (!saysSite && onWebPage) return null;
  target = target.replace(SITE_WORDS, '').trim();
  return target ? { kind: 'name', name: target } : null;
}

const wordsOf = (t) => (t.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);

// The best official website among Wikidata's search results and entities.
// Deprecated statements are skipped; preferred ones win; then an address
// that shares a word with the name ("uchicago" for "UChicago").
export function pickOfficialSite(searchHits, entities, asked) {
  const askedWords = wordsOf(asked);
  let best = null;
  searchHits.forEach((hit, order) => {
    const e = entities[hit.id];
    if (!e) return;
    const label = (e.labels && e.labels.en && e.labels.en.value) || hit.label || '';
    const nameWords = new Set([...askedWords, ...wordsOf(label)]);
    const claims = ((e.claims && e.claims.P856) || []).filter((c) => c.rank !== 'deprecated');
    claims.forEach((c, i) => {
      const url = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
      let host;
      try {
        host = new URL(url).host.replace(/^www\./, '');
      } catch {
        return;
      }
      const hostWords = wordsOf(host.replace(/\./g, ' '));
      const matches = hostWords.some((h) => [...nameWords].some((n) => h.includes(n) || n.includes(h)));
      // "UCSB" is the university's own nickname (an exact alias), not the
      // athletics team's, and ucsb.edu is exactly that word.
      const exactName = hit.match && hit.match.text && hit.match.text.toLowerCase() === asked.trim().toLowerCase();
      const exactHost = askedWords.includes(hostWords[0]);
      const score =
        (c.rank === 'preferred' ? 10 : 0) + (matches ? 5 : 0) + (exactName ? 6 : 0) + (exactHost ? 4 : 0) +
        (/\.(com|edu|org|gov|net)$/.test(host) ? 1 : 0) - i * 0.5 - order * 2;
      if (!best || score > best.score) {
        best = { score, url, host, label, description: (e.descriptions && e.descriptions.en && e.descriptions.en.value) || hit.description || '', matches };
      }
    });
  });
  // An address that shares nothing with the name is not trusted on its own.
  return best && best.matches ? best : best ? { ...best, unsure: true } : null;
}
