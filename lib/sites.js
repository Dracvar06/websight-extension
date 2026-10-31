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
  if (!m) {
    // On a new tab there is nothing else it can mean: "UChicago website",
    // or a misheard "jake me to UChicago", is still a site to go to.
    if (onWebPage || /^(what|how|where|who|why|when|which|is|are|can|could|do|does|help|search|look\s*up|busca|cerca|qu[eèé]|c[oó]mo|on|quin)\b/i.test(question.trim())) return null;
    const loose = question.trim().replace(/[.?!]+$/, '').replace(/^(?:\S+\s+)?me\s+(?:to\s+)?/i, '').replace(/^the\s+/i, '').replace(SITE_WORDS, '').trim();
    if (!loose || loose.split(/\s+/).length > 6) return null;
    const domain = loose.match(DOMAIN);
    if (domain) return { kind: 'address', url: `https://${domain[1]}${domain[2] || ''}` };
    return { kind: 'name', name: loose, heard: question.trim() };
  }
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

// "Take me to the admissions page", "go to financial aid": a page on the
// site they are on. Not "open it", "go back", "go to the top", and not
// "open the menu" ("open" is for things on this page).
const PAGE_GO = /^(?:please\s+|can you\s+|could you\s+)?(?:take me to|go to|bring me to|navigate to|find|ll[eé]vame a|porta'?m a)\s+(?:the\s+)?(.+?)[.?!]*$/i;
const NOT_A_PAGE = /^(?:it|that|this|there|here|back|top|bottom|start|end|beginning|next|previous|(?:the\s+)?(?:top|bottom|next|previous|first|last)(?:\s+\w+)?)$/i;
export function pageRequest(question) {
  const m = question.trim().match(PAGE_GO);
  if (!m) return null;
  const phrase = m[1].replace(/\b(?:page|section|website|site|p[aà]gina)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!phrase || NOT_A_PAGE.test(phrase) || phrase.split(' ').length > 8) return null;
  return phrase;
}
