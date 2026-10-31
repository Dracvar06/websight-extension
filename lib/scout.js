// Scouting: the painful part of finding things on a big site, done ahead.
// When a page loads, the pages its menus and main links lead to (same
// site only) are read quietly in the background as plain text. When the
// answer is not on the person's page, the passages that best match the
// question are found here by keywords, with no AI, and the AI answers
// from them. Then the person is taken to that page and put on the line,
// so the finding is the AI's and the checking is theirs.
//
// Pure functions only; the fetching and HTML parsing happen in the
// offscreen document (service workers have no DOMParser).

const MAX_PAGES = 30;

// Pages are fetched without cookies, so nothing is done as the person.
// Still never fetched: links that can act on their own through a token in
// the address (one-click unsubscribe, delete, cancel), and files that are
// not pages.
const SKIP = /log ?out|sign ?out|unsubscribe|delete|remove|cancel|checkout|\.(pdf|zip|docx?|xlsx?|pptx?|jpe?g|png|gif|mp[34]|mov)(\?|$)/i;

// "registrar.sa.ucsb.edu" and "www.ucsb.edu" are the same site: the
// academic calendar of a university often lives on a subdomain.
export function siteOf(host) {
  const parts = host.replace(/^www\./, '').split('.');
  const twoLevel = /^(co|ac|gov|edu|org|com|net)$/.test(parts[parts.length - 2] || '') && parts.length > 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

// Which links to read: same site, real pages, not the current one, menus
// first (they are the site's own map), then the rest in page order.
export function pickLinks(elements, currentUrl) {
  let here;
  try {
    here = new URL(currentUrl);
  } catch {
    return [];
  }
  const site = siteOf(here.host);
  const seen = new Set([here.href.split('#')[0]]);
  const ranked = [...elements.filter((e) => e.hidden), ...elements.filter((e) => !e.hidden)];
  const picked = [];
  for (const e of ranked) {
    if (picked.length >= MAX_PAGES) break;
    if (!e.href || SKIP.test(e.href) || SKIP.test(e.name || '')) continue;
    let url;
    try {
      url = new URL(e.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || siteOf(url.host) !== site) continue;
    const key = url.href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ url: key, name: e.name || '' });
  }
  return picked;
}

const STOP = new Set(
  ('a an and are as at be by can do does for from has have how i if in is it its me my of on or our so than that the their them then there these this to was what when where which who why will with you your ' +
    'el la los las de del y en un una que es por para con como cuando donde qué cuándo dónde quin quina quan on és amb per els les del al')
    .split(' ')
);

// Crude stemming, enough that "enrolled" finds "enrollment" and
// "deadlines" finds "deadline".
function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  return w
    .replace(/(ments?|ings?|ions?|ed)$/, '')
    .replace(/(s|x|z|ch|sh)es$/, '$1')
    .replace(/([^s])s$/, '$1')
    .replace(/(.)\1$/, '$1');
}

export function terms(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

// Paragraph-sized pieces of a page, each kept with the heading above it so
// a passage like "Jan 4, 2027" still says what it is the date of.
export function passages(page) {
  const out = [];
  let heading = '';
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    if (text.length > 20) out.push({ heading, text });
    buffer = '';
  };
  for (const line of page.text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('# ')) {
      flush();
      heading = l.slice(2);
      continue;
    }
    buffer += (buffer ? ' ' : '') + l;
    if (buffer.length > 500) flush();
  }
  flush();
  return out;
}

// The passages that best match the question, across all scouted pages:
// BM25-style keyword scoring, with a bonus when the words are in the
// page's title or the passage's heading.
export function bestPassages(question, pages, limit = 4) {
  const q = [...new Set(terms(question))];
  if (!q.length) return [];
  const all = [];
  for (const page of pages) {
    const titleTerms = new Set(terms(page.title));
    for (const p of passages(page)) all.push({ page, ...p, words: terms(p.heading + ' ' + p.text), titleTerms });
  }
  if (!all.length) return [];
  const avg = all.reduce((n, p) => n + p.words.length, 0) / all.length;
  const df = new Map(q.map((t) => [t, all.filter((p) => p.words.includes(t)).length]));
  const scored = all.map((p) => {
    let score = 0;
    for (const t of q) {
      const tf = p.words.filter((w) => w === t).length;
      const n = df.get(t);
      if (!n) continue;
      const idf = Math.log(1 + (all.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (p.words.length / avg)));
      if (p.titleTerms.has(t)) score += idf * 0.5;
      if (terms(p.heading).includes(t)) score += idf * 0.5;
    }
    return { score, page: p.page, heading: p.heading, text: p.text };
  });
  return scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
