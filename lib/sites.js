// "Take me to the UChicago website": which site is meant, and its real
// address. The address never comes from the AI's memory, where a small
// model can invent one or land on a lookalike; it comes from Wikidata, the
// public database behind Wikipedia, which records each organisation's
// official website. Pure functions; the requests are made in background.js.

// "take me to the UChicago website", "go to ucsb.edu", "open Wikipedia's site"
// Spoken requests start politely: "Hey there, can you please take me to...".
const LEAD_IN = String.raw`(?:(?:hey|hi|hello|ok|okay|so|right)\b[\s,]*(?:there\b[\s,]*)?)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
const GO_TO = new RegExp(String.raw`^${LEAD_IN}(?:take me to|go to|open|navigate to|bring me to|visit|ll[eé]vame a|ves a|v[eé]s a|porta'?m a|abre|obre)\s+(.+?)[.?!]*$`, 'i');
const SITE_WORDS = /\s*(?:'s)?\s*\b(?:official\s+)?(?:website|web ?site|site|home ?page|web|p[aà]gina web|lloc web|sitio web)\b\s*$/i;
// "the website of Caprabo", "the official site for UCSB"
const SITE_OF = /^(?:(?:the|la|el)\s+)?(?:official\s+)?(?:website|web ?site|site|home ?page|web|p[aà]gina web|lloc web|sitio web)\s+(?:of|for|de|del)\s+(?:the\s+|la\s+|el\s+)?/i;
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?$/i;

// What to go to, or null if this is not a request to go to a site. On a
// normal page, "take me to the admissions page" means a link there, so only
// an explicit website or address counts, unless there is no page at all.
export function siteRequest(question, onWebPage) {
  const m = question.trim().match(GO_TO);
  if (!m) return null; // anything else is for the AI to understand
  let target = m[1].trim();
  const saysSiteFirst = SITE_OF.test(target);
  target = target.replace(SITE_OF, '').replace(/^the\s+/i, '');
  const domain = target.match(DOMAIN);
  if (domain) return { kind: 'address', url: `https://${domain[1]}${domain[2] || ''}` };
  const saysSite = saysSiteFirst || SITE_WORDS.test(target);
  if (!saysSite && onWebPage) return null;
  target = target.replace(SITE_WORDS, '').trim();
  return target ? { kind: 'name', name: target } : null;
}

const wordsOf = (t) => (t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);
const SMALL_WORDS = /^(?:the|and|for|del|dels|els|les|los|las|des|una|uno|que)$/;
// Part of a word counts only when it is long enough to mean something:
// "gov" (gov.uk) is not "Govern Basc".
const partOf = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));

// The best official website among Wikidata's search results and entities.
// Deprecated statements are skipped; preferred ones win; then an address
// that shares a word with the name ("uchicago" for "UChicago").
// byName: the hits came from a search by words, so the entity must itself
// be named what they said, in some language ("Govern Basc" for "Govern del
// País Basc"); then its own address is trusted even when it shares no word
// with the name (euskadi.eus).
export function pickOfficialSite(searchHits, entities, asked, byName = false) {
  const askedWords = wordsOf(asked);
  const content = askedWords.filter((w) => !SMALL_WORDS.test(w));
  const named = (e) =>
    Object.values(e.labels || {}).some((l) => {
      const lw = wordsOf(l.value);
      const covered = content.filter((w) => lw.some((x) => partOf(w, x))).length;
      return content.length && covered >= Math.max(1, Math.ceil(content.length / 2)) && (content.length === 1 || covered >= 2);
    });
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
      const matches = hostWords.some((h) => [...nameWords].some((n) => partOf(h, n)));
      // "UCSB" is the university's own nickname (an exact alias), not the
      // athletics team's, and ucsb.edu is exactly that word.
      const exactName = hit.match && hit.match.text && hit.match.text.toLowerCase() === asked.trim().toLowerCase();
      const exactHost = askedWords.includes(hostWords[0]);
      const score =
        (c.rank === 'preferred' ? 10 : 0) + (matches ? 5 : 0) + (exactName ? 6 : 0) + (exactHost ? 4 : 0) +
        (/\.(com|edu|org|gov|net)$/.test(host) ? 1 : 0) - i * 0.5 - order * 2;
      if (!best || score > best.score) {
        best = { score, url, host, label, description: (e.descriptions && e.descriptions.en && e.descriptions.en.value) || hit.description || '', matches: matches || (byName && named(e)) };
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
