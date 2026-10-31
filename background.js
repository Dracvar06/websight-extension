// Service worker: receives questions from the popup, captures the page
// (screenshot + structured text), asks the AI, speaks the answer via
// chrome.tts, and executes confirmed actions through the content script.
import { getProvider } from './lib/provider.js';
import { unverifiedNumbers, numbersNote } from './lib/check-numbers.js';
import { pickLinks, bestPassages, terms, siteOf } from './lib/scout.js';
import { siteRequest, pageRequest, pickOfficialSite } from './lib/sites.js';
import { searchRequest, parseResults, onSite, sitemapEntries, rankUrls, splitNameAndPage, nameFromUrl } from './lib/web-search.js';

const DEFAULT_SETTINGS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.8-flash',
  deepseekKey: '',
  deepseekModel: 'deepseek-v4-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma4:e4b',
  rate: 1.4,
  speechLang: 'auto',
  voiceName: '',
  autoDescribe: true,
  ttsEngine: 'neural',
  ttsUrl: 'http://localhost:8100/v1',
  aboutMe: '',
  searchEngine: 'searxng',
  searchUrl: 'http://localhost:8888',
  searchKey: '',
};

// Element texts that require a spoken confirmation before acting.
const DANGEROUS = /(buy|purchase|order|pay|checkout|confirm|delete|remove|submit|send|subscribe|transfer|comprar|pagar|pedido|eliminar|borrar|enviar|kaufen|bezahlen|bestellen|löschen|senden|acheter|payer|supprimer|envoyer|acquista|paga|elimina|invia)/i;
const CLAIMS_ACTION = /\b(I'?ve|I have|I just|I)\s+(clicked|pressed|opened|taken you|gone|went|scrolled|typed|filled|submitted|navigated|moved you|brought you)\b|^(done|clicked|opened)\b/i;
const NOT_HERE = /\b(don'?t|do not|can'?t|cannot|could ?n[o']t) (see|find)\b|\b(does ?n[o']t|do not|doesn'?t) (have|list|show|display|mention|include|contain|say|state|give|provide|specify)\b|\bno (information|details|mention)\b|\bnot (sure|listed|shown|displayed|visible|available|mentioned|on this page)\b|\bisn'?t (listed|shown|here|on)\b/i;
const IS_QUESTION = /\?$|^(what|when|where|who|whom|which|why|how|is|are|was|were|do|does|did|can|could|should|will|would|has|have|qu[eé]|quan|quin|quina|on|com|qui|cu[aá]ndo|d[oó]nde|qui[eé]n|c[oó]mo|cu[aá]l)\b/i;
// Each decision handleAsk makes, for the end-to-end test (dev/e2e.mjs
// turns it on). Off for everyone else.
function trace(...args) {
  if (globalThis.WEBSIGHT_TRACE) console.log('[websight]', ...args);
}

const ANNOUNCES = /\b(I will|I'?ll|let me|I am going to|I'?m going to) (read|list|tell|go through|give|explain|describe)\b(?![^.]*\bif you\b)|\b(here (they|it) (is|are)|as follows|are listed below)[.:]?\s*$/i;
// "Academic year: 2026-2027; Terms tab: Winter": what dropdowns and tabs
// show now, so the model can see that "last year" is not what is chosen.
function chosenNow(elements) {
  const parts = [];
  for (const e of elements || []) {
    if (e.role === 'dropdown' && e.state) parts.push(`${e.name}: ${(e.state.match(/now: ([^;]*)/) || [])[1] || '?'}`);
    if (e.state === 'tab, selected') parts.push(`tab selected: ${e.name}`);
  }
  return parts.join('; ') || 'nothing to choose';
}

// The planning question's reply: what is needed, then the steps. Both
// required, so a small model cannot skip the plan.
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    needs: { type: 'string' },
    steps: {
      type: 'array',
      items: { type: 'object', properties: { index: { type: 'integer' }, value: { type: 'string' } }, required: ['index', 'value'] },
    },
    answer: { type: 'string' },
  },
  required: ['needs', 'steps', 'answer'],
};

// Things on a page that only change what it shows: never links that leave
// it, never anything that sounds like it acts (DANGEROUS), and not the
// furniture every page has (search, menus, carousels, video players).
const NOT_WORTH_TRYING = /search|menu|navigation|close|dismiss|share|print|play|pause|mute|video|slide|previous|next|carousel|cookie|accept|reject|zoom|full.?screen|fit to page|log ?in|sign ?in|skip|chat|feedback|language|keyboard|shortcut|scroll (up|down|left|right)|row selection|screen reader tips/i;

function tryCandidates(question, elements) {
  const wanted = new Set(terms(question));
  const out = [];
  for (const e of elements) {
    if (e.href || DANGEROUS.test(e.name) || NOT_WORTH_TRYING.test(e.name) || e.hidden) continue;
    if (e.role === 'dropdown') {
      const now = (e.state.match(/now: ([^;]*)/) || [])[1] || '';
      const options = ((e.state.match(/options: (.*)$/) || [])[1] || '').split(', ').filter((o) => o && o !== now && o !== '...');
      for (const o of options.slice(0, 4)) out.push({ e, value: o });
      continue;
    }
    const pressable = ['button', 'item', 'tab', 'summary', 'menuitem'].includes(e.role) || /^tab, not|collapsed/.test(e.state || '');
    if (pressable && e.state !== 'tab, selected' && e.state !== 'expanded') out.push({ e, value: '' });
  }
  // Most promising first: words from the question, then tabs and collapsed
  // sections, then everything else in page order.
  const score = (c) =>
    terms(`${c.e.name} ${c.value}`).filter((t) => wanted.has(t)).length * 10 + (/^tab|collapsed/.test(c.e.state || '') ? 2 : 0);
  return out.map((c, i) => ({ ...c, s: score(c) - i / 1000 })).sort((a, b) => b.s - a.s).slice(0, 6);
}

async function tryThings(tab, question, extraction, settings, provider, state, alreadyOpened = []) {
  // Not again what the plan already pressed.
  const done = alreadyOpened.join(' | ');
  const candidates = tryCandidates(question, extraction.elements).filter((c) => !done.includes(`"${c.e.name}"`));
  const opened = [];
  if (!candidates.length) return { opened, extraction };
  trace('trying:', JSON.stringify(candidates.map((c) => [c.e.name, c.value])));
  speak('That is not shown yet. Let me try a few things on this page.', { rate: settings.rate, voiceName: settings.voiceName });
  const wanted = new Set(terms(question));
  const started = Date.now();
  let current = extraction;
  for (const c of candidates) {
    if (Date.now() - started > 30000) break;
    const label = c.value ? `${c.value} in "${c.e.name}"` : `"${c.e.name}"`;
    earcon('working');
    speak(`Trying ${label}.`, { rate: settings.rate, voiceName: settings.voiceName, enqueue: true });
    const before = new Set(pageLines(current.pageText));
    const outcome = await actOn(tab.id, { type: 'reveal', index: c.e.index, value: c.value }, current.elements).catch(() => null);
    if (!outcome || !outcome.ok) continue;
    opened.push(c.value ? `chose ${c.value} in "${c.e.name}"` : `opened "${c.e.name}"`);
    await sleep(1500);
    const after = await extractAll(tab.id).catch(() => null);
    if (!after) continue;
    current = after;
    const appeared = pageLines(after.pageText).filter((l) => !before.has(l));
    const relevant = appeared.some((l) => terms(l).some((t) => wanted.has(t)) || /\d{1,2}[/.-]\d{1,2}|\b(19|20)\d\d\b|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d/i.test(l));
    trace('tried', label, '->', appeared.length, 'new lines', relevant ? '(relevant)' : '');
    if (!relevant) continue;
    const answer = await provider
      .ask({
        history: state.history,
        question: `${question}\n\n(Note from the app: trying things on the page, you ${opened[opened.length - 1]}. This text appeared: \"${appeared.join(' / ').slice(0, 1500)}\". The page has chosen now: ${chosenNow(after.elements)}. If this answers the question, answer directly and plainly. If not, say you do not see it. Do not guess.)`,
        pageText: after.pageText,
        screenshotBase64: '',
      })
      .catch(() => null);
    trace('after trying ->', JSON.stringify(answer && answer.answer));
    if (answer && !answer.action && !NOT_HERE.test(answer.answer)) return { result: answer, extraction: after, opened };
  }
  // Nothing worked: put the page back as it was.
  if (opened.length) {
    await chrome.tabs.reload(tab.id).catch(() => null);
    await waitForLoad(tab.id);
    await sleep(800);
    current = await extractAll(tab.id).catch(() => current);
  }
  return { opened, extraction: current };
}

function hasChoices(elements) {
  return (elements || []).some((e) => e.role === 'dropdown' || /^tab|collapsed/.test(e.state || ''));
}

// The page text as lines, for telling what a click made appear.
const pageLines = (text) => (text.split('PAGE TEXT:')[1] || text).split('\n').map((l) => l.trim()).filter((l) => l.length > 3);

const REMEMBER = /^(?:please\s+)?(?:remember|recorda|recuerda)(?:\s+(?:that|que))?\s+(.+?)[.!]*$/i;
const SEARCH_COMMAND = /^(?:please\s+)?(?:search|look up|busca|cerca)\s+(?:on\s+)?(?:this site|the site|this page|here|aquí|aqu[ií])?\s*(?:for|per|por)?\s*(.+?)[.?!]*$/i;
const PROMISES = /\b(I'?ll|I will|let me|I am going to|I'?m going to|I can)\s+(click|press|open|take you|look|go|check|find|search|navigate)\b/i;
const CONFIRM_WORDS = /^\s*(yes|yeah|yep|sure|confirm|do it|go ahead|sí|si|vale|oui|ja|okay|ok|sim|da)\b/i;

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // Migrate from the single-provider settings of v0.1.
  if (!settings.geminiKey && stored.apiKey) settings.geminiKey = stored.apiKey;
  if (stored.model && !stored.geminiModel) settings.geminiModel = stored.model;
  // Older defaults (2.5 is closed to new accounts, 3.5 is a generation behind) move to the current Flash.
  if (/^gemini-(2\.5|3\.5)-flash$/.test(settings.geminiModel)) settings.geminiModel = 'gemini-3.8-flash';
  return settings;
}

// macOS novelty and low-quality voices that automatic matching must never
// pick (the user can still choose them explicitly in settings).
const UGLY_VOICES = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|compact|eloquence/i;
const NICE_VOICES = /samantha|daniel|karen|moira|tessa|montserrat|montse|jordi|m[oó]nica|paulina|anna|am[eé]lie|alice|luciana|joana|ellen|thomas|yuna|kyoko|milena|zosia/i;

let voicesCache = null;
async function pickVoice(lang) {
  if (!lang) return null;
  if (!voicesCache) voicesCache = await new Promise((r) => chrome.tts.getVoices((v) => r(v || [])));
  const base = lang.toLowerCase().split('-')[0];
  const candidates = voicesCache.filter(
    (v) => (v.lang || '').toLowerCase().startsWith(base) && !UGLY_VOICES.test(v.voiceName || '')
  );
  if (!candidates.length) return null;
  const exact = candidates.filter((v) => (v.lang || '').toLowerCase() === lang.toLowerCase());
  const pool = exact.length ? exact : candidates;
  const preferred = pool.find((v) => NICE_VOICES.test(v.voiceName || ''));
  return (preferred || pool[0]).voiceName;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK', 'DOM_PARSER'],
    justification: 'Play spoken answers, and read nearby pages of a site as text to find answers on them',
  });
}

async function speak(text, { lang, rate, enqueue = false, voiceName } = {}) {
  const settings = await getSettings();
  if (settings.ttsEngine === 'neural') {
    try {
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({
        type: 'websight-tts-play',
        text,
        lang: lang || 'en',
        rate: rate || settings.rate,
        enqueue,
        url: settings.ttsUrl,
      });
      if (res && res.ok) return;
      // No neural voice for this language: fall through to the system voice.
    } catch {
      /* offscreen unavailable: fall through to the system voice */
    }
  }
  const options = { rate: rate || 1.4, enqueue };
  // A user-chosen voice always wins; otherwise pick a decent voice for the
  // answer language rather than letting Chrome land on a novelty voice.
  if (voiceName) {
    options.voiceName = voiceName;
  } else if (lang) {
    const auto = await pickVoice(lang);
    if (auto) options.voiceName = auto;
    else options.lang = lang;
  }
  chrome.tts.speak(text, options);
}

// ---- per-tab state in session storage (survives service worker restarts) ----

async function getTabState(tabId) {
  const key = `tab:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || { history: [], elements: [], pendingAction: null };
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [`tab:${tabId}`]: state });
}

// SPAs like Google Maps rewrite the URL constantly (map coordinates, filters,
// scroll state). Normalize to the part that identifies the actual page so we
// only react to real page changes.
const tabKeys = new Map(); // tabId -> normalized page key

function pageKey(u) {
  try {
    const url = new URL(u);
    const path = url.pathname
      .split('/')
      .filter((seg) => seg && !seg.startsWith('@'))
      .join('/');
    return `${url.origin}/${path}`;
  } catch {
    return u;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const key = pageKey(changeInfo.url);
  if (tabKeys.get(tabId) === key) return; // same page, cosmetic URL change
  tabKeys.set(tabId, key);
  // A new page: its elements and any pending yes/no no longer apply, but
  // the conversation goes on ("take me there", then "when is it?").
  getTabState(tabId).then((state) =>
    setTabState(tabId, { ...state, elements: [], pendingAction: null })
  );
  // A description of the page they just left is no use to them any more.
  if (autoSpeech && autoSpeech.tabId === tabId) {
    autoSpeech = null;
    stopSpeech();
  }
});

// ---- automatic page description on load ----

const describedTabs = new Map(); // tabId -> { url, t }
// Auto-descriptions must never talk over a conversation the user is having.
let lastManualActivity = 0;
// The page an automatic description is being spoken for, so it can be cut
// off when the person leaves that page.
let autoSpeech = null; // { tabId, key }

function stopSpeech() {
  chrome.tts.stop();
  chrome.runtime.sendMessage({ type: 'websight-tts-stop' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !tab.active) return;
  if (!/^https?:/i.test(tab.url || '')) return;
  const settings = await getSettings();
  if (!settings.autoDescribe) return;
  const key = pageKey(tab.url);
  const prev = describedTabs.get(tabId);
  if (prev && prev.key === key) return; // this page was already described
  describedTabs.set(tabId, { key, t: Date.now() });
  setTimeout(() => scanAndDescribe(tabId, tab.windowId, key), 800);
});

// The page is never scrolled to be seen: its whole text is read from the
// page itself, and the screenshot shows what is on screen now, as a friend
// looking at the screen would.
async function scanAndDescribe(tabId, windowId, key) {
  await autoDescribe(tabId, windowId, key);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  describedTabs.delete(tabId);
  tabKeys.delete(tabId);
});

async function autoDescribe(tabId, windowId, key) {
  try {
    const settings = await getSettings();
    const provider = getProvider(settings);
    if (provider.needsKey && !provider.apiKey) return;
    const extraction = await extractAll(tabId, '');
    scoutAround(tabId, extraction); // in the background, while it describes
    let screenshotBase64 = '';
    if (provider.vision) screenshotBase64 = await captureScreenshot(windowId);
    const question =
      'I just opened this page. Orient me in at most three short sentences: what site and page this is and what it is for; then the two or three most useful things I can read or do here, by their names, and roughly where they are. If anything blocks the page (a cookie banner, popup, sign-in wall or error), say that first. Skip slogans and decoration.';
    const result = await provider.ask({
      history: [],
      question,
      pageText: extraction.pageText,
      screenshotBase64,
    });
    if (!result.answer) return;
    // The AI call above takes seconds; the world may have changed. If the
    // user asked something meanwhile (or an answer is being spoken), this
    // description is stale noise - drop it instead of talking over them.
    if (Date.now() - lastManualActivity < 15000) return;
    // They may have moved on to another page while the AI was thinking.
    // (Clicking through pages quickly used to leave the new page silent: a
    // description still playing, or a 20 s cooldown, skipped it for good.)
    const now = await chrome.tabs.get(tabId).catch(() => null);
    if (!now || pageKey(now.url || '') !== key) return;
    const state = await getTabState(tabId);
    state.history.push(
      { role: 'user', parts: [{ text: question }] },
      { role: 'model', parts: [{ text: JSON.stringify({ answer: result.answer, action: null }) }] }
    );
    state.history = state.history.slice(-16);
    state.elements = extraction.elements;
    await setTabState(tabId, state);
    autoSpeech = { tabId, key };
    // Queued, so it waits for an answer that is still being spoken.
    speak(result.answer, { lang: result.lang, rate: settings.rate, voiceName: settings.voiceName, enqueue: true });
  } catch {
    /* page not describable (chrome page, mid-navigation, provider down) */
  }
}

// Alt+Shift+N: wipe this tab's conversation and reopen the popup fresh.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'new-conversation') return;
  chrome.tts.stop();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) await chrome.storage.session.remove(`tab:${tab.id}`);
  try {
    await chrome.action.openPopup();
  } catch {
    // Popup could not be opened programmatically (e.g. no focused window).
    const settings = await getSettings();
    speak('New conversation. Press the hotkey to talk.', { rate: settings.rate, voiceName: settings.voiceName });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab:${tabId}`);
});

// ---- page capture ----

// The content script also runs inside frames (all_frames); a message for
// "the page" must go to the top frame only, or any frame may answer it.
const TOP = { frameId: 0 };

async function messageTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, TOP);
  } catch {
    // Either the page is still loading (right after a click, its content
    // script does not exist yet) or it loaded before the extension did.
    // Wait for the load, then inject if it is still missing.
    await waitForLoad(tabId, 10000);
    try {
      return await chrome.tabs.sendMessage(tabId, msg, TOP);
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/page-extract.js', 'content.js'],
      });
      return chrome.tabs.sendMessage(tabId, msg, TOP);
    }
  }
}

async function captureScreenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  return downscaleToBase64(dataUrl, 1024);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function downscaleToBase64(dataUrl, maxWidth) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return bytesToBase64(new Uint8Array(await jpeg.arrayBuffer()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- reading the page, embedded frames included ----

// A calendar, a form or a report is often another site's page inside a
// frame (UCSB's academic calendar is a Power BI report). Its text and
// controls are read too, numbered after the page's own, and actions on
// them are sent to that frame.
// A long page's text does not fit a small model whole. It gets the
// beginning, then the parts further down that match the question, each
// under its heading, so the bottom of a long page is not invisible.
const PAGE_TEXT_BUDGET = 12000;
let askingAbout = ''; // the question being answered, while handleAsk runs

function fitPageText(pageText, question) {
  const at = pageText.indexOf('PAGE TEXT:\n');
  if (at < 0) return pageText;
  const head = pageText.slice(0, at);
  const text = pageText.slice(at + 'PAGE TEXT:\n'.length);
  if (text.length <= PAGE_TEXT_BUDGET) return pageText;
  const start = text.slice(0, question ? 5000 : PAGE_TEXT_BUDGET);
  if (!question) return `${head}PAGE TEXT (the beginning of a long page):\n${start}`;
  const headings = new Set((head.match(/^H[123]: (.*)$/gm) || []).map((h) => h.slice(4).trim()));
  const rest = text.slice(5000).split('\n').map((l) => (headings.has(l.trim()) ? `# ${l.trim()}` : l)).join('\n');
  const parts = bestPassages(question, [{ title: '', url: '', text: rest }], 12);
  let picked = '';
  for (const p of parts) {
    const piece = `${p.heading ? `Under "${p.heading}": ` : ''}${p.text}\n\n`;
    if (picked.length + piece.length > PAGE_TEXT_BUDGET - 5000) break;
    picked += piece;
  }
  return `${head}PAGE TEXT (a long page: its beginning, then the parts further down that match the question):\n${start}${picked ? `\n\n[... further down the page ...]\n\n${picked.trim()}` : ''}`;
}

async function extractAll(tabId, question = askingAbout) {
  const top = await messageTab(tabId, { type: 'websight-extract' });
  top.pageText = fitPageText(top.pageText, question);
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const ws = window.__websight;
        if (!ws || !ws.extract || window === window.top) return null;
        if (window.innerWidth * window.innerHeight < 20000) return null; // tracking pixels, hidden frames
        return { ...ws.extract(), url: location.href, title: document.title };
      },
    });
  } catch {
    /* no access to the frames; the page itself is enough */
  }
  const elements = top.elements.map((e) => ({ ...e, frameId: 0, local: e.index }));
  let next = elements.reduce((m, e) => Math.max(m, e.index), -1) + 1;
  const sections = [];
  for (const f of frames) {
    const r = f && f.result;
    if (!r || sections.length >= 3) continue;
    const text = (r.pageText.split('PAGE TEXT:')[1] || '').trim();
    if (!r.elements.length && text.length < 40) continue;
    const lines = [];
    for (const e of r.elements) {
      elements.push({ ...e, index: next, frameId: f.frameId, local: e.index });
      lines.push(`[${next}] ${e.role}: ${e.name}${e.state ? ` (${e.state})` : ''}`);
      next++;
    }
    let host = '';
    try {
      host = new URL(r.url).host;
    } catch {
      /* about:blank and the like */
    }
    sections.push(
      `EMBEDDED FRAME (part of this page${host ? `, from ${host}` : ''}${r.title ? `, "${r.title}"` : ''}):\nITS CONTROLS:\n${lines.join('\n') || '(none)'}\nITS TEXT:\n${text.slice(0, 6000) || '(none)'}`
    );
  }
  return { pageText: top.pageText + (sections.length ? '\n\n' + sections.join('\n\n') : ''), elements };
}

// For the end-to-end test: read a tab the way questions do.
globalThis.websightDebug = { extractAll: (tabId) => extractAll(tabId) };

// Sends an action to the frame its element lives in.
function actOn(tabId, action, elements) {
  const el = (elements || []).find((e) => e.index === action.index);
  if (el && el.frameId) {
    return chrome.tabs.sendMessage(tabId, { type: 'websight-action', action: { ...action, index: el.local } }, { frameId: el.frameId });
  }
  return messageTab(tabId, { type: 'websight-action', action });
}

// "Show me where" in the page, or else in one of its frames.
async function showAnywhere(tabId, msg) {
  const shown = await messageTab(tabId, msg).catch(() => null);
  if (shown && shown.ok) return shown;
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window !== window.top && !!window.__websight });
  } catch {
    return shown;
  }
  for (const f of frames) {
    if (!f.result) continue;
    const inFrame = await chrome.tabs.sendMessage(tabId, msg, { frameId: f.frameId }).catch(() => null);
    if (inFrame && inFrame.ok) return inFrame;
  }
  return shown;
}

// ---- scouting (lib/scout.js): nearby pages read ahead, as plain text ----

const scouted = new Map(); // page url -> { t, pages: Promise<page[]> }

function scoutAround(tabId, extraction) {
  const url = sansHash(extraction.pageText.match(/^URL: (.*)$/m)?.[1] || '');
  if (!url) return Promise.resolve([]);
  const cached = scouted.get(url);
  if (cached && Date.now() - cached.t < 10 * 60000) return cached.pages;
  const links = pickLinks(extraction.elements || [], url);
  const pages = ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ type: 'websight-scout', urls: links.map((l) => l.url) }))
    .then((r) => (r && r.pages) || [])
    .catch(() => []);
  scouted.set(url, { t: Date.now(), pages });
  for (const [key, value] of scouted) if (Date.now() - value.t > 10 * 60000) scouted.delete(key);
  pages.then((p) => trace('scouted', p.length, 'of', links.length, 'nearby pages for', url));
  return pages;
}

// Pages a search engine finds on this site for the question, read the same
// way as scouted ones (no cookies). Only with a real engine: a sitemap
// matches addresses, not answers.
async function searchedPages(question, extraction, settings, alreadyPromise) {
  if (!settings || (settings.searchEngine || 'searxng') === 'sitemap') return [];
  let host;
  try {
    host = new URL(extraction.pageText.match(/^URL: (.*)$/m)?.[1] || '').host;
  } catch {
    return [];
  }
  const found = (await findOnSite(host, question, settings).catch(() => [])).filter((r) => r.via !== 'sitemap');
  const already = new Set((await alreadyPromise).map((p) => p.url));
  const urls = found.map((r) => sansHash(r.url)).filter((u) => !already.has(u)).slice(0, 4);
  if (!urls.length) return [];
  const r = await ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ type: 'websight-scout', urls }))
    .catch(() => null);
  trace('read', (r && r.pages || []).length, 'search results');
  return (r && r.pages) || [];
}

// The answer from the nearby pages, or null. The model sees only the few
// passages that match the question, numbered, and says which one it used.
async function answerFromScouting(provider, question, extraction, history, settings) {
  const scoutedPages = Promise.race([scoutAround(null, extraction), sleep(12000).then(() => [])]);
  const pages = [...(await scoutedPages), ...(await searchedPages(question, extraction, settings, scoutedPages))];
  const best = bestPassages(question, pages, 4);
  trace('best passages:', JSON.stringify(best.map((b) => [b.page.title, b.heading, b.score.toFixed(1)])));
  if (!best.length) return null;
  const text = best
    .map((b, i) => `[${i + 1}] From the page "${b.page.title}" (${b.page.url})${b.heading ? `, under "${b.heading}"` : ''}:\n${b.text}`)
    .join('\n\n');
  const result = await provider
    .ask({
      history,
      question: `${question}\n\n(Note from the app: the answer is not on the page they are on. Above are passages from nearby pages of the same site, numbered. If one of them answers the question, answer from it, copy its exact words into "quote", and set "source" to its number. If none does, say so and set "source" to 0. Use no other knowledge. Answer directly (\"UCSB has 24,673 students\"), without mentioning passages or nearby pages: the app says where it is.)`,
      pageText: `PASSAGES FROM NEARBY PAGES (read by the app; the person is not on these pages):\n\n${text}`,
      screenshotBase64: '',
    })
    .catch(() => null);
  trace('answer from nearby pages ->', JSON.stringify(result && { answer: result.answer, source: result.source, quote: result.quote }));
  if (!result || result.action || NOT_HERE.test(result.answer)) return null;
  let source = result.source >= 1 && result.source <= best.length ? result.source : 0;
  // Small models often quote the right passage and forget its number.
  if (!source && result.quote) {
    const q = result.quote.toLowerCase().replace(/\s+/g, ' ').trim();
    const i = best.findIndex((b) => b.text.toLowerCase().replace(/\s+/g, ' ').includes(q.slice(0, 60)));
    if (i >= 0) source = i + 1;
  }
  if (!source) return null;
  return { result, page: best[source - 1].page };
}

// ---- finding a page on a site with a search engine (lib/web-search.js) ----

// Pages on this site that match the words, best first: [{ url, title }].
// The chosen engine first; if it is not running or has no key, the site's
// own sitemap. Results on any other site are dropped.
async function findOnSite(host, phrase, settings) {
  const site = siteOf(host);
  const engine = settings.searchEngine || 'searxng';
  const needsKey = engine === 'tavily' || engine === 'brave';
  if (engine !== 'sitemap' && !(needsKey && !settings.searchKey)) {
    const req = searchRequest(engine, { site, phrase, key: settings.searchKey, url: settings.searchUrl });
    const json = await fetchJson(req.url, 8000, req.init);
    const found = onSite(parseResults(engine, json), site);
    trace('web search', engine, JSON.stringify(phrase), 'on', site, '->', found.length, json ? '' : '(no answer)');
    if (found.length) return found.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet, via: engine }));
  }
  const urls = await sitemapUrls(host);
  const ranked = rankUrls(urls, phrase).slice(0, 5);
  trace('sitemap', host, urls.length, 'pages ->', JSON.stringify(ranked.slice(0, 3)));
  return ranked.map((url) => ({ url, title: '', snippet: '', via: 'sitemap' }));
}

const sitemaps = new Map(); // host -> { t, urls: Promise<string[]> }

function sitemapUrls(host) {
  const cached = sitemaps.get(host);
  if (cached && Date.now() - cached.t < 30 * 60000) return cached.urls;
  const fetchText = (url) =>
    fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(6000) })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => t.slice(0, 3000000))
      .catch(() => '');
  const urls = (async () => {
    const robots = await fetchText(`https://${host}/robots.txt`);
    const listed = [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    const queue = listed.length ? listed.slice(0, 4) : [`https://${host}/sitemap.xml`];
    const pages = [];
    let fetched = 0;
    while (queue.length && fetched < 12 && pages.length < 50000) {
      const { pages: p, sitemaps: more } = sitemapEntries(await fetchText(queue.shift()));
      fetched++;
      pages.push(...p);
      queue.push(...more.slice(0, 12 - fetched));
    }
    return pages;
  })();
  sitemaps.set(host, { t: Date.now(), urls });
  return urls;
}

// "Take me to the admissions page" on a site: the search engine's best page
// on this same site. Null when there is no clear one, so the page's own
// links are tried as before.
async function goToPageOnSite(tab, phrase, settings, state, host = new URL(tab.url).host) {
  const say = (text) => speak(text, { rate: settings.rate, voiceName: settings.voiceName });
  earcon('working');
  const found = await findOnSite(host, phrase, settings);
  const best = found.find((r) => sansHash(r.url) !== sansHash(tab.url || ''));
  if (!best) return null;
  const title = best.title || (await pageTitle(best.url)) || nameFromUrl(best.url);
  const words = `Going to "${title.slice(0, 120)}", on ${siteOf(new URL(best.url).host)}. Say go back if it is not the one.`;
  say(words);
  noteDown(state, `Searched ${siteOf(host)} for "${phrase}" (${best.via}) and went to ${best.url}`);
  await setTabState(tab.id, state);
  await chrome.tabs.update(tab.id, { url: best.url });
  await waitForNavigation(tab.id, tab.url, 5000);
  await waitForLoad(tab.id);
  earcon('arrived');
  lastManualActivity = 0; // let the page be described when it loads
  return { answer: words };
}

// ---- going to a website by name (lib/sites.js) ----

async function fetchJson(url, ms = 8000, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, credentials: 'omit' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The official website for a name, from Wikidata (see lib/sites.js).
async function officialSite(name) {
  const search = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&uselang=en&format=json&limit=6&origin=*`);
  if (!search || !search.search || !search.search.length) return null;
  const ids = search.search.map((x) => x.id).join('|');
  const data = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=claims|labels|descriptions&languages=en&format=json&origin=*`);
  return data && data.entities ? pickOfficialSite(search.search, data.entities, name) : null;
}

async function pageTitle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: controller.signal });
    const html = res.ok ? (await res.text()).slice(0, 200000) : '';
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// "I'm a physics major" said back as "you're a physics major".
function yours(text) {
  const swap = { "i'm": "you're", 'i am': 'you are', i: 'you', my: 'your', me: 'you', mine: 'yours', 'i’m': 'you’re' };
  return text.replace(/\b(i['’]m|i am|i|my|me|mine)\b/gi, (w) => swap[w.toLowerCase()] || w);
}

function pickSaidOption(question, options, elements) {
  if (!options || !options.length || IS_QUESTION.test(question.trim())) return null;
  const words = terms(question).filter((w) => !/^(one|that|link|option|button|page|please|open|take|go|click|press|first|second|third|last)$/.test(w));
  if (!words.length || words.length > 5) return null;
  const hits = options.filter((name) => {
    const t = terms(name);
    return words.every((w) => t.some((n) => n.startsWith(w) || w.startsWith(n)));
  });
  if (hits.length !== 1) return null;
  return elements.find((e) => e.name === hits[0]) || null;
}

// Chrome lets no extension read or photograph its own pages, for safety,
// so say what the page is instead of "I could not read it".
function protectedPage(url = '') {
  if (/^chrome:\/\/(newtab|new-tab-page)|^chrome-search:|^about:blank|^$/.test(url)) return 'This is a new tab, with no website open yet.';
  if (/chromewebstore|chrome\.google\.com\/webstore/.test(url)) return 'This is the Chrome Web Store, which Chrome does not let extensions read.';
  if (/^chrome:\/\/settings/.test(url)) return "This is Chrome's settings, which Chrome does not let extensions read.";
  if (/^chrome:\/\/extensions/.test(url)) return "This is Chrome's extensions page, which Chrome does not let extensions read.";
  return 'This is one of Chrome\'s own pages, which Chrome does not let extensions read.';
}

function noteDown(state, line) {
  state.notes = [...(state.notes || []), `- ${line}`].slice(-12);
}

async function goToSite(tab, site, settings, provider, state) {
  const say = (text) => speak(text, { rate: settings.rate, voiceName: settings.voiceName });
  const go = async (url, words) => {
    if (site.heard && !site.confirmed) {
      // Said without "take me to", maybe misheard: a yes first.
      state.pendingAction = { type: 'goto', url, name: site.name };
      await setTabState(tab.id, state);
      const msg = `I heard "${site.heard}". ${words.replace(/^Going to /, 'Do you want ').replace(/\.$/, '')}? Say yes to go there.`;
      say(msg);
      return { answer: msg, pendingConfirmation: true };
    }
    say(words);
    earcon('working');
    noteDown(state, `Went to ${url} (${words.replace(/^Going to /, '').slice(0, 120)})`);
    await setTabState(tab.id, state);
    await chrome.tabs.update(tab.id, { url });
    await waitForNavigation(tab.id, tab.url, 5000);
    await waitForLoad(tab.id);
    earcon('arrived');
    lastManualActivity = 0; // let the page be described when it loads
    return { answer: words };
  };
  if (site.kind === 'address') {
    // An address they said themselves is used as said.
    return go(site.url, `Going to ${new URL(site.url).host}.`);
  }
  const official = await officialSite(site.name);
  trace('official site for', site.name, '->', JSON.stringify(official && { url: official.url, label: official.label, unsure: official.unsure }));
  if (official && !official.unsure) {
    const host = official.host;
    const what = (official.description || '').split(/[,;(]/)[0].trim();
    return go(official.url, `Going to ${host}, the official website of ${official.label}${what ? ` (${what})` : ''}, according to Wikidata.`);
  }
  // "UCSB undergraduate admissions": the organisation, then a page on its
  // official site, found by search there and nowhere else.
  if (!official || official.unsure) {
    for (const split of splitNameAndPage(site.name).slice(0, 3)) {
      const org = await officialSite(split.name);
      trace('official site for', split.name, '->', JSON.stringify(org && { url: org.url, unsure: org.unsure }));
      if (!org || org.unsure) continue;
      if (site.heard) return go(org.url, `Going to ${org.host}, the official website of ${org.label}.`);
      say(`Looking for ${split.page} on ${org.host}, the official website of ${org.label}.`);
      const went = await goToPageOnSite(tab, split.page, settings, state, org.host);
      if (went) return went;
      return go(org.url, `I could not find ${split.page} there, so I am going to the home page of ${org.host}.`);
    }
  }
  // Not confirmed: the model's guess, checked by loading it, and only
  // with a yes. Lookalike sites are exactly what this must not land on.
  const guess = official ? { url: official.url } : await provider
    .ask({
      history: [],
      question: `(Note from the app: what is the official website address of "${site.name}"? Put it in "answer" as a full https address, nothing else. If you are not sure, answer "unknown".)`,
      pageText: '',
      screenshotBase64: '',
    })
    .then((r) => ({ url: ((r && r.answer) || '').match(/https?:\/\/[^\s"']+/)?.[0] || '' }))
    .catch(() => ({ url: '' }));
  const title = guess.url ? await pageTitle(guess.url) : '';
  trace('unconfirmed guess', guess.url, JSON.stringify(title));
  if (!guess.url || !title) {
    const msg = site.heard
      ? `I heard "${site.heard}", and could not find a website called ${site.name}. If I misheard, say it again, or say "go to" and the address.`
      : `I could not find the official website of ${site.name}. If you know its address, say "go to" and the address.`;
    say(msg);
    return { answer: msg };
  }
  state.pendingAction = { type: 'goto', url: guess.url, name: site.name };
  await setTabState(tab.id, state);
  const msg = `I could not confirm the official website of ${site.name}. My best guess is ${new URL(guess.url).host}, a page titled "${title}". Say yes to go there, or anything else to cancel.`;
  say(msg);
  return { answer: msg, pendingConfirmation: true };
}

// ---- main flow ----

async function handleAsk(question) {
  askingAbout = question;
  try {
    return await answerQuestion(question);
  } finally {
    askingAbout = '';
  }
}

async function answerQuestion(question) {
  lastManualActivity = Date.now();
  autoSpeech = null;
  const settings = await getSettings();
  const provider = getProvider(settings);
  if (provider.needsKey && !provider.apiKey) {
    const msg = `No API key is set for ${provider.label}. Open the WebSight settings and paste one.`;
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    const msg = 'I could not find the tab you are on.';
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true };
  }
  const onWebPage = /^https?:/i.test(tab.url || '');
  const state = await getTabState(tab.id);

  // "Remember that I'm a physics major": added to About me (Settings), which
  // every question carries, so later guesses fit them.
  const remember = question.trim().match(REMEMBER);
  if (remember) {
    const fact = remember[1].trim().replace(/^i('m| am)\b/i, 'I am');
    const aboutMe = `${settings.aboutMe ? settings.aboutMe + '\n' : ''}${fact[0].toUpperCase()}${fact.slice(1)}.`.slice(-2000);
    await chrome.storage.local.set({ aboutMe });
    const msg = `I will remember that ${yours(remember[1].trim().replace(/[.!]+$/, ''))}. It is in Settings, under About me, if you want to change it.`;
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg };
  }

  // "Take me to the UChicago website" works anywhere, a new tab included.
  const site = !state.pendingAction && siteRequest(question, onWebPage);
  if (site) return goToSite(tab, site, settings, provider, state);
  // "Take me to the admissions page": search this site, as a chatbot
  // would, unless a link on this page plainly is it.
  const wantsPage = !site && onWebPage && !state.pendingAction && pageRequest(question);
  if (wantsPage) {
    const wanted = terms(wantsPage);
    const extraction = await extractAll(tab.id).catch(() => null);
    const plainLink = extraction && extraction.elements.some((e) => !e.hidden && e.href && wanted.every((w) => terms(e.name).includes(w)));
    if (!plainLink) {
      const went = await goToPageOnSite(tab, wantsPage, settings, state).catch(() => null);
      if (went) return went;
    }
  }
  // "Search for cheap flights" on a new tab: the person's own default
  // search engine, as if typed in the address bar.
  const searchHere = !onWebPage && !state.pendingAction && question.trim().match(SEARCH_COMMAND);
  if (searchHere) {
    const words = `Searching for "${searchHere[1].trim()}".`;
    speak(words, { rate: settings.rate, voiceName: settings.voiceName });
    earcon('working');
    await chrome.search.query({ text: searchHere[1].trim(), tabId: tab.id });
    lastManualActivity = 0;
    return { answer: words };
  }
  if (!onWebPage && !state.pendingAction) {
    const msg = `${protectedPage(tab.url)} Say a website to go to, for example "take me to the UChicago website", or "search for" and what you want to find.`;
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true };
  }

  // Pending dangerous action: "yes" executes it, anything else cancels.
  if (state.pendingAction) {
    const pending = state.pendingAction;
    state.pendingAction = null;
    await setTabState(tab.id, state);
    if (CONFIRM_WORDS.test(question)) {
      return performAction(tab, pending, settings, state);
    }
    speak('Okay, cancelled.', { rate: settings.rate, voiceName: settings.voiceName });
    if (!question.trim() || /^(no|nope|cancel|stop)\b/i.test(question.trim())) {
      return { answer: 'Okay, cancelled.' };
    }
    // Treat what they said as a new question, from the start (it may be
    // a site to go to, or this may be a new tab).
    return answerQuestion(question);
  }

  let extraction;
  let screenshotBase64 = '';
  try {
    extraction = await extractAll(tab.id);
    scoutAround(tab.id, extraction); // usually already done when the page loaded
    if (provider.vision) screenshotBase64 = await captureScreenshot(tab.windowId);
  } catch (err) {
    const msg = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(tab.url || '')
      ? `${protectedPage(tab.url)} You can still say a website to go to.`
      : 'I could not read this page. Try reloading it and asking again.';
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true, detail: String(err) };
  }

  let result;
  let fallbackNote = '';
  // "Search this site for X": nothing to interpret, so no model. The
  // page's own search box is used, as a person would.
  const searchFor = question.trim().match(SEARCH_COMMAND);
  const searchBox = searchFor && (extraction.elements.find((e) => e.search && !e.hidden) || extraction.elements.find((e) => e.search));
  // "The undergraduate one", right after options were read out: the one
  // whose name has those words, if exactly one does. No model, so no
  // near-miss elsewhere on the page ("Undergraduate Majors - Catalog").
  const picked = pickSaidOption(question, state.lastOptions, extraction.elements);
  state.lastOptions = null;
  try {
    if (picked) {
      result = { answer: '', lang: '', action: { type: 'click', index: picked.index } };
      trace('picked from the options just read ->', picked.name);
    } else if (searchBox) {
      result = { answer: '', lang: '', action: { type: 'search', index: searchBox.index, value: searchFor[1].trim() } };
      trace('search command ->', searchBox.name, JSON.stringify(searchFor[1]));
    } else {
      // What was tried and found earlier in this tab, so a follow-up builds
      // on it (the conversation history has the words, not what was done).
      const notes = (state.notes || []).slice(-10).join('\n');
      result = await provider.ask({
        history: state.history,
        question: notes ? `${question}\n\n(Notes from earlier in this tab, oldest first:\n${notes})` : question,
        pageText: extraction.pageText,
        screenshotBase64,
      });
      if (result && result.backup) fallbackNote = `Answered by the local model because ${provider.label} is busy or at its limit.`;
    }
  } catch (err) {
    // Quota exhausted or service overloaded: quietly try the backup
    // providers so the user is never stranded mid-day.
    if (err.status === 429 || err.status === 503) {
      for (const name of ['deepseek', 'ollama']) {
        if (name === settings.provider) continue;
        if (name === 'deepseek' && !settings.deepseekKey) continue;
        const backup = getProvider({ ...settings, provider: name });
        try {
          result = await backup.ask({
            history: state.history,
            question,
            pageText: extraction.pageText,
            screenshotBase64: backup.vision ? screenshotBase64 : '',
          });
          fallbackNote = `Answered by the ${backup.label} backup because ${provider.label} is at its limit or overloaded.`;
          break;
        } catch {
          /* backup unavailable too; try the next one */
        }
      }
    }
    if (result) {
      // A backup saved the day; continue with its answer.
    } else {
    let msg = `I could not reach ${provider.label}. Check your internet connection.`;
    if (provider.name === 'ollama' && !err.status) {
      msg = 'I could not reach Ollama. Make sure the Ollama app is running on this computer.';
    } else if (provider.name === 'ollama' && err.status === 403) {
      msg = 'Ollama blocked the extension. It needs to allow browser extensions; see the settings page.';
    } else if (err.status === 429) {
      msg = `The ${provider.label} rate limit was hit. Wait a minute and try again.`;
    } else if (err.status === 503) {
      msg = `${provider.label} is overloaded right now. Try again in a few seconds.`;
    } else if (err.status === 404) {
      msg = 'The model name in settings is not recognized. Open settings and use Test connection.';
    } else if (err.status === 402) {
      msg = 'The DeepSeek account has no balance left. The free tokens may be used up.';
    } else if (err.status === 400 || err.status === 401 || err.status === 403) {
      msg = `${provider.label} rejected the request. Check the API key in settings with Test connection.`;
    }
      speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
      return { answer: msg, error: true, detail: err.detail || String(err) };
    }
  }

  // "There are four plans. I will read out the deadlines." and then nothing:
  // a small model announces a list instead of giving it. Asked once more.
  if (result && !result.action && ANNOUNCES.test(result.answer)) {
    const full = await provider
      .ask({
        history: state.history,
        question: `${question}\n\n(Note from the app: your answer announced the details but did not give them. Give them now, in full, briefly.)`,
        pageText: extraction.pageText,
        screenshotBase64: '',
      })
      .catch(() => null);
    trace('announced without saying; asked again ->', JSON.stringify(full && full.answer));
    if (full && !full.action && !ANNOUNCES.test(full.answer)) result = full;
  }

  // A model that says it clicked or went somewhere without asking for the
  // action has done nothing; a person who cannot see the screen would
  // believe it. Seen in testing: "I've taken you back to the previous page".
  if (result && !result.action && CLAIMS_ACTION.test(result.answer)) {
    console.warn('WebSight: dropped an answer claiming an action that was not taken:', result.answer);
    result = { answer: 'I have not done anything on the page. Could you say again what you would like me to do?', lang: result.lang, action: null };
  }

  // Not on this page, but a link here probably leads to it: go and look,
  // at most two pages deep, saying where at each step. Links only, so
  // nothing is bought, sent or submitted on the way.
  trace('asked', JSON.stringify(question), '->', JSON.stringify(result && { answer: result.answer, action: result.action }));
  // A question is answered, never just clicked away from: "When does
  // winter quarter start?" once got a click on an unrelated event and
  // "Done". Treated as looking on that page, so an answer still comes.
  const keepAnswering = (r) => {
    // It already reads the whole page; scrolling never answers a question.
    if (r && r.action && r.action.type === 'scroll' && IS_QUESTION.test(question.trim())) {
      return { ...r, action: null, answer: NOT_HERE.test(r.answer) ? r.answer : 'I do not see that on this page yet.' };
    }
    if (r && r.action && r.action.type === 'click' && IS_QUESTION.test(question.trim())) {
      // A tab or a collapsed section shows more here; a link goes elsewhere.
      const el = extraction.elements.find((e) => e.index === r.action.index);
      r.action.type = el && el.href ? 'explore' : 'reveal';
    }
    return r;
  };
  keepAnswering(result);
  let hops = 0;
  let foundOn = '';
  let answeredThere = false;
  if (result && !result.action && PROMISES.test(result.answer) && !IS_QUESTION.test(question.trim())) {
    // "I will click Sign in" with no action: nothing would happen and
    // nothing would be said. Asked once more, plainly.
    const again = await provider
      .ask({
        history: state.history,
        question: `${question}\n\n(Note from the app: you said you would do this but returned no action. Return the action now, or action null and say plainly that you cannot.)`,
        pageText: extraction.pageText,
        screenshotBase64: '',
      })
      .catch(() => null);
    trace('promised without acting; asked again ->', JSON.stringify(again && again.action));
    // "I can take you to Undergraduate Admission or Graduate Admissions" is
    // a real choice, not a broken promise: put it to the person.
    const offersChoice = /\bor\b/i.test(result.answer) && /\bI can\b/i.test(result.answer);
    result = again && again.action ? again
      : offersChoice ? { ...result, answer: `${result.answer.replace(/[.\s]+$/, '')}. Which one?` }
      : { answer: 'I could not find a way to do that on this page.', lang: result.lang, action: null };
  }
  const firstAnswer = result;
  const opened = [];
  let triedNote = '';

  // Behind this page's own controls? Plan every change first, then make
  // them all, then check the page shows what was planned. A small model
  // deciding one click at a time forgets the second step ("last year's
  // winter" is a year AND a term); writing the list first does not.
  const wantsControls = result && IS_QUESTION.test(question.trim()) && hasChoices(extraction.elements) &&
    ((!result.action && (NOT_HERE.test(result.answer) || PROMISES.test(result.answer))) || (result.action && result.action.type === 'reveal'));
  if (wantsControls) {
    const plan = await provider
      .ask({
        history: [],
        question: `${question}\n\n(Note from the app: plan before touching anything. The page has chosen now: ${chosenNow(extraction.elements)}. In "needs", write what the question needs the page to show (which year, term, plan or option; \"last year\" means the year before the one chosen now; \"next\" the one after). Then in "steps" list every control change needed to get there, in order, as {"index": N, "value": "<the exact option text for a dropdown, otherwise empty>"}: only dropdowns, tabs, and buttons or sections that show more. Use [] if the page already shows it or no control here can. In "answer", a few words.)`,
        pageText: extraction.pageText,
        screenshotBase64: '',
        schema: PLAN_SCHEMA,
      })
      .catch(() => null);
    const steps = ((plan && plan.steps) || [])
      .map((st) => ({ ...st, control: extraction.elements.find((e) => e.index === st.index) }))
      .map((st) => (st.control && st.control.role !== 'dropdown' ? { ...st, value: '' } : st))
      .filter((st) => st.control && !st.control.href && !DANGEROUS.test(st.control.name) && !NOT_WORTH_TRYING.test(st.control.name))
      .slice(0, 4);
    trace('plan:', JSON.stringify(plan && plan.needs), JSON.stringify(steps.map((st) => [st.control.name, st.value])));
    if (steps.length) {
      const say = steps.map((st) => (st.value ? `choose ${st.value} in "${st.control.name}"` : `open "${st.control.name}"`));
      earcon('working');
      speak(`Let me ${say.join(', then ')}.`, { rate: settings.rate, voiceName: settings.voiceName });
      const shownBefore = new Set(pageLines(extraction.pageText));
      const problems = [];
      for (const st of steps) {
        const outcome = await actOn(tab.id, { type: 'reveal', index: st.index, value: st.value }, extraction.elements).catch(() => null);
        if (outcome && outcome.ok) opened.push(st.value ? `chose ${st.value} in "${st.control.name}"` : `opened "${st.control.name}"`);
        else problems.push(`could not ${st.value ? `choose ${st.value} in` : 'open'} "${st.control.name}"${outcome && outcome.detail ? ` (${outcome.detail})` : ''}`);
        await sleep(1200);
      }
      try {
        const before = extraction.elements;
        extraction = await extractAll(tab.id);
        screenshotBase64 = provider.vision ? await captureScreenshot(tab.windowId) : '';
        // Did the page take the choices? A dropdown that still shows the
        // old year means any answer would be about the wrong year.
        for (const st of steps) {
          if (!st.value) continue;
          const now = extraction.elements.find((e) => e.role === 'dropdown' && e.name === st.control.name && e.frameId === st.control.frameId);
          const shows = now && (now.state.match(/now: ([^;]*)/) || [])[1];
          if (shows && !shows.toLowerCase().includes(st.value.toLowerCase())) problems.push(`"${st.control.name}" still shows ${shows}`);
        }
        trace('after the plan:', chosenNow(extraction.elements), problems.length ? `problems: ${problems.join('; ')}` : '');
        const appeared = pageLines(extraction.pageText).filter((l) => !shownBefore.has(l)).join(' / ').slice(0, 1500);
        result = keepAnswering(
          await provider
            .ask({
              history: state.history,
              question: `${question}\n\n(Note from the app: you ${opened.join(', then ') || 'changed nothing'}${problems.length ? `; but ${problems.join('; ')}` : ''}. This text appeared: \"${appeared || '(no new text)'}\". The page has chosen now: ${chosenNow(extraction.elements)}. If that matches what they asked and the text answers it, answer directly and plainly. If it does not match, say plainly what the page shows instead. Do not guess.)`,
              pageText: extraction.pageText,
              screenshotBase64,
            })
            .catch(() => null)
        ) || { answer: 'I changed the page, but I could not get an answer about it.', lang: result.lang, action: null };
        if (problems.length && !result.action) result.noShow = result.noShow || false;
        void before;
      } catch {
        result = { answer: 'I changed the page, but I could not read it afterwards.', lang: result.lang, action: null, noShow: true };
      }
      trace('after the plan ->', JSON.stringify({ answer: result.answer, action: result.action }));
    }
  }

  // Still not found, and the page has things to press: try them like a
  // curious person would (tabs, tiles, "show more", dropdown options), one
  // at a time, watching what text appears. The model is only asked when
  // something relevant shows up, so trying is cheap. Nothing that leaves
  // the page, sends a form or sounds risky; the page is reloaded after if
  // nothing worked, so it is left as it was.
  if (result && !result.action && IS_QUESTION.test(question.trim()) && NOT_HERE.test(result.answer)) {
    const tried = await tryThings(tab, question, extraction, settings, provider, state, opened);
    if (tried.result) {
      result = tried.result;
      extraction = tried.extraction;
      opened.push(...tried.opened);
    } else if (tried.opened.length) {
      triedNote = ` I tried ${quoteList(tried.opened.map((o) => o.replace(/^(opened|chose) /, '')))} on this page, but none of them showed it, so I put the page back as it was.`;
      extraction = tried.extraction;
    }
  }

  // Not on this page: first the nearby pages read ahead. If one has it,
  // take them there and put them on the line.
  let takenTo = '';
  if (result && !result.action && IS_QUESTION.test(question.trim()) && (NOT_HERE.test(result.answer) || PROMISES.test(result.answer))) {
    const found = await answerFromScouting(provider, question, extraction, state.history, settings);
    if (found) {
      earcon('working');
      await chrome.tabs.update(tab.id, { url: found.page.url }).catch(() => null);
      await waitForNavigation(tab.id, tab.url, 4000);
      const loaded = await waitForLoad(tab.id);
      lastManualActivity = Date.now(); // this answer replaces its description
      try {
        await sleep(500);
        extraction = await extractAll(tab.id);
        earcon('arrived');
        takenTo = (loaded && loaded.title) || found.page.title;
        result = { ...found.result, action: null };
      } catch {
        // Could not open it: still answer, and say where it is.
        result = { ...found.result, action: null, answer: `${found.result.answer} That is on the page "${found.page.title}", but I could not open it.` };
        extraction = { ...extraction, pageText: extraction.pageText + '\n' + found.page.text };
      }
    }
  }
  if (!takenTo && result && !result.action && (NOT_HERE.test(result.answer) || PROMISES.test(result.answer))) {
    // "I don't see that here, I can look if you like": a small model offers
    // instead of looking far more often than it picks a link. Asking it only
    // which link to try is a narrow choice it makes well.
    const pick = await provider
      .ask({
        history: [],
        question: `(Note from the app: the answer to the question below is not visible on this page. If a dropdown, tab or collapsed section here probably shows it, return {"type": "reveal", "index": N} (with "value" set to the option for a dropdown). Otherwise return {"type": "explore", "index": N} with the ONE link most likely to lead to it. In "answer" say in a few words what you will open. If nothing is a reasonable bet, return action null.)\n\nQuestion: ${question}`,
        pageText: extraction.pageText,
        screenshotBase64: '',
      })
      .catch(() => null);
    trace('which link?', JSON.stringify(pick && pick.action));
    if (pick && pick.action && ['explore', 'click', 'reveal'].includes(pick.action.type)) {
      result = keepAnswering({ ...pick, lang: result.lang || pick.lang });
    }
  }
  // The answer is behind a control on this page (a year in a dropdown, a
  // term in a tab, a collapsed question): open it, read the page again and
  // ask again, up to three times, saying each time what it opens.
  while (result && result.action && result.action.type === 'reveal') {
    const control = extraction.elements.find((e) => e.index === result.action.index);
    if (opened.length >= 3 || !control || DANGEROUS.test(control.name)) {
      result = opened.length
        ? { answer: 'I opened what I could here, but I still cannot see that.', lang: result.lang, action: null }
        : firstAnswer && !firstAnswer.action
        ? firstAnswer
        : { answer: 'I could not find that on this page.', lang: result.lang, action: null };
      break;
    }
    let value = result.action.value ? String(result.action.value) : '';
    if (control.role === 'dropdown' && !value) {
      // A dropdown needs an option; ask for exactly that.
      const which = await provider
        .ask({
          history: [],
          question: `(Note from the app: to answer the question below, which option of the dropdown "${control.name}" should be chosen? It is ${control.state}. Return {"type": "reveal", "index": ${control.index}, "value": "<one option, copied exactly>"}.)\n\nQuestion: ${question}`,
          pageText: extraction.pageText,
          screenshotBase64: '',
        })
        .catch(() => null);
      value = (which && which.action && which.action.value) || '';
      result.action.value = value;
      trace('dropdown option ->', value);
    }
    trace('revealing', control.name, value);
    earcon('working');
    speak(value ? `Let me choose ${value} in "${control.name}".` : `Let me open "${control.name}".`, { rate: settings.rate, voiceName: settings.voiceName });
    const outcome = await actOn(tab.id, result.action, extraction.elements).catch(() => ({ ok: false }));
    if (!outcome || !outcome.ok) {
      const why = (outcome && outcome.detail) || 'It did not work.';
      result = { answer: `I tried to open "${control.name}", but: ${why}`, lang: result.lang, action: null, noShow: true };
      break;
    }
    opened.push(value ? `chose ${value} in "${control.name}"` : `opened "${control.name}"`);
    await sleep(1500);
    const shownBefore = new Set(pageLines(extraction.pageText));
    try {
      extraction = await extractAll(tab.id);
      screenshotBase64 = provider.vision ? await captureScreenshot(tab.windowId) : '';
    } catch {
      result = { answer: 'I opened it, but I could not read the page afterwards.', lang: result.lang, action: null };
      break;
    }
    result = keepAnswering(
      await provider
        .ask({
          history: state.history,
          question: `${question}\n\n(Note from the app: you ${opened[opened.length - 1]}. That made this text appear on the page:\n\"${pageLines(extraction.pageText).filter((l) => !shownBefore.has(l)).join(' / ').slice(0, 1500) || '(no new text)'}\"\nWhat the page has chosen now: ${chosenNow(extraction.elements)}.\nFirst check that this matches what they asked (the right year, term, plan). If it does and the text answers the question, answer directly and plainly. ${opened.length < 3 ? 'If something else still has to be chosen (another year, another tab), reveal it instead of answering.' : 'Do not open anything more; if the choice does not match, say so.'})`,
          pageText: extraction.pageText,
          screenshotBase64,
        })
        .catch(() => ({ answer: 'I opened it, but I could not get an answer.', lang: '', action: null }))
    );
    trace('after revealing ->', JSON.stringify({ answer: result.answer, action: result.action }));
    if (result && !result.action && NOT_HERE.test(result.answer) && opened.length < 3) {
      // Often a second choice is needed (last year's winter term: the year,
      // then the tab), and a small model stops after the first.
      const next = await provider
        .ask({
          history: [],
          question: `(Note from the app: so far you ${opened.join(' and ')}, and the answer to the question below is still not visible. If another dropdown option, tab or collapsed section here probably shows it, return {"type": "reveal", "index": N} with "value" set to the option for a dropdown. Otherwise return action null.)\n\nQuestion: ${question}`,
          pageText: extraction.pageText,
          screenshotBase64: '',
        })
        .catch(() => null);
      trace('reveal what next?', JSON.stringify(next && next.action));
      if (next && next.action && next.action.type === 'reveal') result = { ...next, lang: result.lang || next.lang };
    }
  }

  while (result && result.action && result.action.type === 'explore') {
    const link = extraction.elements.find((e) => e.index === result.action.index);
    const leadsElsewhere = link && link.href && sansHash(link.href) !== sansHash((await chrome.tabs.get(tab.id)).url);
    if (hops >= 2 || !link || !leadsElsewhere || DANGEROUS.test(link.name)) {
      // Nowhere sensible to look: keep the model's own first answer ("I
      // don't see any reviews") unless it only offered to look.
      result = hops
        ? { answer: `I looked, but I could not find that. You are now on the page "${foundOn}"; say "go back" to return.`, lang: result.lang, action: null }
        : firstAnswer && !firstAnswer.action && !PROMISES.test(firstAnswer.answer)
        ? firstAnswer
        : { answer: 'I could not find that on this page, and no link here looks like it leads to it.', lang: result.lang, action: null };
      answeredThere = false;
      break;
    }
    hops++;
    trace('exploring', link.name, link.to || '');
    earcon('working');
    speak(`That is not on this page. Let me look on "${link.name}".`, { rate: settings.rate, voiceName: settings.voiceName });
    // Opened by its address rather than clicked: a menu heading such as
    // UCSB's "About" is a link that only opens its dropdown when clicked.
    const before = await snapshot(tab.id);
    if (link.href && link.href.split('#')[0] !== (before ? before.url : '').split('#')[0]) {
      await chrome.tabs.update(tab.id, { url: link.href }).catch(() => null);
    } else {
      await actOn(tab.id, { type: 'click', index: link.index }, extraction.elements).catch(() => null);
    }
    if (!(await waitForNavigation(tab.id, before ? before.url : tab.url))) {
      result = { answer: `I opened "${link.name}", but it stayed on this page, so I could not look there.`, lang: result.lang, action: null };
      answeredThere = false;
      break;
    }
    const loaded = await waitForLoad(tab.id);
    lastManualActivity = Date.now(); // the answer below replaces its description
    try {
      await sleep(500);
      extraction = await extractAll(tab.id);
      screenshotBase64 = provider.vision ? await captureScreenshot(tab.windowId) : '';
    } catch {
      result = { answer: `I opened "${link.name}", but I could not read the new page.`, lang: result.lang, action: null };
      answeredThere = false;
      break;
    }
    foundOn = (loaded && loaded.title) || link.name;
    answeredThere = true;
    earcon('arrived');
    result = await provider
      .ask({
        history: state.history,
        question: `${question}\n\n(Note from the app: you followed the link "${link.name}" to look for this and are now on a new page. If the answer is here, give it. ${hops >= 2 ? 'Do not explore further: if it is not here, say honestly that you could not find it.' : 'If not, you may explore one more link.'})`,
        pageText: extraction.pageText,
        screenshotBase64,
      })
      .catch(() => ({ answer: 'I opened the page, but I could not get an answer about it.', lang: '', action: null }));
    keepAnswering(result);
    trace('on the new page ->', JSON.stringify({ answer: result.answer, action: result.action }));
  }
  if (answeredThere && !result.action) {
    // Where it was found is said by the app, not left to the model.
    result.answer = `On the page "${foundOn}": ${result.answer}`;
  } else if (hops && !result.action) {
    // Looking moved them somewhere and did not end with an answer: they
    // must still know where they are now.
    const now = await chrome.tabs.get(tab.id).catch(() => null);
    if (now && sansHash(now.url) !== sansHash(tab.url)) {
      result.answer += ` You are now on the page "${now.title || now.url}". Say "go back" to return.`;
    }
  }

  // Keep history light: text only, no screenshots, last 8 exchanges.
  state.history.push(
    { role: 'user', parts: [{ text: question }] },
    { role: 'model', parts: [{ text: JSON.stringify({ answer: result.answer, action: result.action }) }] }
  );
  state.history = state.history.slice(-16);
  state.elements = extraction.elements;

  if (!result.action) {
    await setTabState(tab.id, state);
    let spoken = result.answer;
    // Numbers not written on the page are named, so they know exactly what
    // to double-check. (The page text is what the answer was given; a
    // number read only from the screenshot is flagged too, on purpose.)
    const missing = unverifiedNumbers(result.answer, extraction.pageText, question);
    if (missing.length) trace('numbers not on the page:', missing.join(', '));
    spoken += numbersNote(missing);
    // Then put them on the line it came from, to check with their own
    // screen reader.
    // Nothing to point at when the answer is that it is not there.
    // A question back ("Undergraduate or Graduate Admission?") is not a
    // line to read; remember the choices it names for the reply instead.
    const asksBack = /\?\s*$/.test(result.answer);
    if (asksBack) {
      const said = result.answer.toLowerCase();
      state.lastOptions = [...new Set(extraction.elements.map((e) => e.name).filter((n) => n && n.length > 3 && said.includes(n.split(' - ')[0].toLowerCase())))];
    }
    const shown = asksBack || result.noShow || NOT_HERE.test(result.answer) ? null : await showAnywhere(tab.id, {
      type: 'websight-show',
      quote: result.quote || '',
      about: `${question} ${result.answer}`,
      numbers: (result.answer.match(/\d[\d.,:/]*\d|\d{2,}/g) || []).filter((n) => !missing.includes(n)),
    }).catch(() => null);
    trace('show me where:', JSON.stringify(result.quote), '->', JSON.stringify(shown));
    // What was pressed or tried, said about the page it happened on.
    const movedOn = Boolean(takenTo || answeredThere || hops);
    const doneHere = [
      opened.length ? `I ${opened.join(' and ')}` : '',
      triedNote ? triedNote.trim().replace(/^I tried/, 'I tried').replace(/ on this page,/, ',') : '',
    ].filter(Boolean);
    if (doneHere.length) spoken += movedOn ? ` Before that, on the first page, ${doneHere.join('. ')}${/[.]$/.test(doneHere[doneHere.length - 1]) ? '' : '.'}` : ` On the page, ${doneHere.join('. ')}${/[.]$/.test(doneHere[doneHere.length - 1]) ? '' : '.'}`;
    if (takenTo) {
      spoken += ` That is on the page "${takenTo}", so I have taken you there${shown && shown.ok ? ' and put the cursor on that line' : ''}. Say "go back" to return.`;
    } else if (shown && shown.ok) {
      spoken += ' I have put the cursor on that line, so your screen reader can read it from the page.';
    }
    const where = (extraction.pageText.match(/^TITLE: (.*)$/m) || [])[1] || 'this page';
    noteDown(state, `On "${where}": asked "${question.slice(0, 80)}"${opened.length ? `; I ${opened.join(', ')}` : ''}; answer: ${result.answer.slice(0, 160)}${result.quote ? `; from the page line "${result.quote.slice(0, 200)}"` : ''}`);
    await setTabState(tab.id, state);
    speak(spoken, { lang: result.lang, rate: settings.rate, voiceName: settings.voiceName });
    return { answer: spoken, note: fallbackNote || undefined };
  }

  const target = extraction.elements.find((e) => e.index === result.action.index);
  result.action.name = target ? target.name : '';

  // What is said around an action is written here, from what the page
  // actually did, never by the model: a model's "I've clicked Buy now"
  // while the app is still waiting for a yes is exactly the kind of words a
  // person who cannot see the screen has no way to check.
  const risk = await assessRisk(result.action, target, provider, extraction.pageText);
  trace('risk:', target && target.name, '->', JSON.stringify(risk));
  if (risk.level === 'refuse') {
    await setTabState(tab.id, state);
    speak(risk.why, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: risk.why };
  }
  if (risk.level === 'ask') {
    state.pendingAction = result.action;
    await setTabState(tab.id, state);
    const warning = `That would ${verbFor(result.action)} "${target ? target.name : 'that'}", which ${risk.why}. Nothing has been pressed yet. Press the hotkey and say yes to go ahead, or anything else to cancel.`;
    speak(warning, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: warning, pendingConfirmation: true };
  }

  await setTabState(tab.id, state);
  return performAction(tab, result.action, settings, state);
}

// Whether an action needs a yes first, in the spirit of a permission
// check: clear rules decide most cases at once; a button whose name says
// nothing ("Continue", "OK", "Save") is put to the model as a narrow
// question about this page. Reading, following links, opening tabs,
// scrolling and going back never need asking.
const UNCLEAR = /^(ok|okay|continue|next|confirm|done|save|apply|yes|go|proceed|finish|complete|update|accept|agree|submit|send|place|enviar|continuar|aceptar|guardar|confirmar|seg[uü]ent|desa|d'acord)\b/i;
const ACTS_BY_ADDRESS = /log ?out|sign ?out|unsubscribe|delete|remove|cancel|deactivate/i;

async function assessRisk(action, target, provider, pageText) {
  if (!target || ['scroll', 'back', 'reveal', 'explore'].includes(action.type)) return { level: 'safe' };
  if (action.type === 'search') {
    if (target.sensitive) return { level: 'refuse', why: 'I do not type passwords or card numbers. Please type that yourself.' };
    // A search box is free to use; any other field would send its form.
    return target.search || target.searchForm ? { level: 'safe' } : { level: 'ask', why: 'would type this and send the form' };
  }
  if (action.type === 'fill' || action.type === 'focus') {
    if (target.sensitive && action.type === 'fill') {
      return { level: 'refuse', why: `I do not type ${target.sensitive === 'card' ? 'card numbers' : 'passwords'}. I have not touched that field; please type it yourself.` };
    }
    return { level: 'safe' }; // typing sends nothing by itself
  }
  if (DANGEROUS.test(target.name)) return { level: 'ask', why: 'might buy, send or delete something' };
  if (target.href) {
    return ACTS_BY_ADDRESS.test(target.href + ' ' + target.name) ? { level: 'ask', why: 'might sign you out or remove something' } : { level: 'safe' };
  }
  if (target.submits && target.searchForm) return { level: 'safe' };
  if (target.submits || UNCLEAR.test(target.name.trim())) {
    // The narrow question, text only, answered with a strict shape.
    const verdict = await provider
      .ask({
        history: [],
        question: `(Note from the app, a safety check. On this page, could pressing "${target.name}"${target.submits ? ` (it sends a form with: ${target.form || 'unknown fields'})` : ' (it is not part of any form, so it sends nothing by itself)'} buy or pay for something, send a message or application, post publicly, delete or cancel something, or change account settings? Set "risky" to true if it could, false if it only moves through or shows content. In "why", a few words.)`,
        pageText: pageText.slice(0, 6000),
        screenshotBase64: '',
        schema: RISK_SCHEMA,
      })
      .catch(() => null);
    if (!verdict || verdict.risky !== false) {
      const reason = verdict && verdict.why ? verdict.why.replace(/[.]$/, '') : '';
      return { level: 'ask', why: target.submits ? 'would send this form' : `I am not sure is safe to press without asking${reason ? ` (${reason[0].toLowerCase()}${reason.slice(1)})` : ''}` };
    }
  }
  return { level: 'safe' };
}

const RISK_SCHEMA = {
  type: 'object',
  properties: { risky: { type: 'boolean' }, why: { type: 'string' }, answer: { type: 'string' } },
  required: ['risky', 'why', 'answer'],
};

function verbFor(action) {
  return { click: 'press', focus: 'move to', fill: 'type into', back: 'go back', search: 'search with' }[action.type] || action.type;
}

function earcon(kind) {
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ type: 'websight-earcon', kind }))
    .catch(() => {});
}

async function snapshot(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'websight-snapshot' }, TOP);
  } catch {
    return null; // the page is unloading: a navigation started
  }
}

const sansHash = (u) => (u || '').split('#')[0];

// Whether the tab starts going to another page within `timeout`. A fixed
// wait missed pages that began loading late: a click that moved the person
// to "Theater & Dance" was reported as "nothing changed".
async function waitForNavigation(tabId, fromUrl, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await sleep(200);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.pendingUrl && sansHash(tab.pendingUrl) !== sansHash(fromUrl)) return true;
    if (sansHash(tab.url) !== sansHash(fromUrl)) return true;
  }
  return false;
}

async function waitForLoad(tabId, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete') return tab;
    await sleep(250);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

const quoteList = (names) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// Does the action, then says what really happened: a new page (and which),
// something that opened (and what is in it), or nothing at all.
async function performAction(tab, action, settings, state) {
  lastManualActivity = Date.now();
  if (action.type === 'goto') {
    // Confirmed after "I could not confirm the official website".
    return goToSite(tab, { kind: 'address', url: action.url }, settings, null, state);
  }
  const say = (text, opts = {}) => speak(text, { rate: settings.rate, voiceName: settings.voiceName, ...opts });
  if (action.type === 'scroll') {
    const outcome = await actOn(tab.id, action, state.elements).catch(() => ({ ok: false }));
    const spoken = outcome.detail || 'I could not scroll this page.';
    say(spoken);
    return { answer: spoken, actionResult: outcome };
  }

  const name = action.name || 'that';
  earcon('working');
  say(
    action.type === 'back'
      ? 'Going back.'
      : action.type === 'search'
      ? `Searching for "${action.value}".`
      : `${verbFor(action)[0].toUpperCase()}${verbFor(action).slice(1)} "${name}".`
  );
  const before = await snapshot(tab.id);
  let outcome;
  try {
    if (action.type === 'back') {
      await chrome.tabs.goBack(tab.id);
      outcome = { ok: true };
    } else {
      outcome = await actOn(tab.id, action, state.elements);
    }
  } catch {
    outcome = action.type === 'back' ? { ok: false, detail: 'there is no previous page in this tab.' } : { ok: false };
  }
  if (!outcome || !outcome.ok) {
    earcon('nothing');
    const spoken = `I could not ${verbFor(action)} "${name}": ${outcome && outcome.detail ? outcome.detail : 'the page changed before I could.'}`;
    say(spoken, { enqueue: true });
    return { answer: spoken, actionResult: outcome };
  }
  if (action.type === 'focus' || action.type === 'fill') {
    const spoken = action.type === 'fill' ? `Typed it into "${name}".` : `The cursor is on "${name}" now.`;
    say(spoken, { enqueue: true });
    return { answer: spoken, actionResult: outcome };
  }

  const navigated = await waitForNavigation(tab.id, before ? before.url : tab.url);
  let after = navigated ? null : await snapshot(tab.id);
  let spoken;
  if (navigated || !after || (before && sansHash(after.url) !== sansHash(before.url))) {
    // A new page: wait for it, then name it. Its description follows.
    const loaded = await waitForLoad(tab.id);
    after = await snapshot(tab.id);
    const title = (after && after.title) || (loaded && loaded.title) || '';
    earcon('arrived');
    spoken = title ? `Done. You are on a new page: ${title}.` : 'Done. A new page is loading.';
    lastManualActivity = 0; // let the new page be described
  } else {
    const had = new Set(before ? before.names : []);
    const added = after.names.filter((n) => !had.has(n));
    if (after.dialogs > (before ? before.dialogs : 0)) {
      earcon('opened');
      spoken = `A window opened on top of the page${added.length ? `, with ${quoteList(added.slice(0, 6))}` : ''}.`;
    } else if (added.length) {
      earcon('opened');
      const shown = added.slice(0, 8);
      spoken = `That opened ${added.length} new option${added.length === 1 ? '' : 's'}: ${quoteList(shown)}${added.length > shown.length ? ', and more' : ''}.`;
      // So "the undergraduate one" picks from what was just read out.
      state.lastOptions = shown;
      await setTabState(tab.id, state);
    } else {
      // No new buttons or links, but the text may have changed ("Step 2 of
      // 3"); say what is new rather than "nothing changed".
      const oldLines = new Set(before ? before.lines || [] : []);
      const newLines = (after.lines || []).filter((l) => !oldLines.has(l));
      if (newLines.length) {
        earcon('opened');
        spoken = `That changed the page. It now says: ${newLines.slice(0, 2).join('. ').slice(0, 300)}`;
      } else {
        earcon('nothing');
        spoken = `I pressed "${name}", but I cannot see anything change on the page.`;
      }
    }
  }
  say(spoken, { enqueue: true });
  return { answer: spoken, actionResult: outcome };
}

// Settings saved by older versions point Whisper at Groq with no key, which
// cannot work; the local voice server does the same job, free and private.
chrome.storage.local.get(['speechEngine', 'whisperUrl', 'whisperKey']).then((s) => {
  if (s.whisperUrl && /groq\.com/.test(s.whisperUrl) && !s.whisperKey) {
    chrome.storage.local.set({
      whisperUrl: 'http://localhost:8100/v1',
      whisperModel: 'deepdml/faster-whisper-large-v3-turbo-ct2',
      ...(s.speechEngine === 'browser' ? { speechEngine: 'whisper' } : {}),
    });
  }
});

// ---- messages from popup and options ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'websight-ask') {
    handleAsk(msg.question)
      .then(sendResponse)
      .catch((err) => sendResponse({ answer: 'Something went wrong.', error: true, detail: String(err) }));
    return true; // async response
  }
  if (msg.type === 'websight-stop-speech') {
    chrome.tts.stop();
    chrome.runtime.sendMessage({ type: 'websight-tts-stop' }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'websight-tts-failed') {
    // The neural server failed mid-utterance; recover with a decent system
    // voice, not whatever Chrome lands on.
    pickVoice('en').then((voiceName) => chrome.tts.speak(msg.text, { rate: msg.rate || 1.4, ...(voiceName ? { voiceName } : {}) }));
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'websight-test-search') {
    findOnSite('www.ucsb.edu', 'undergraduate admission', msg.settings)
      .then((results) => sendResponse({ results }))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === 'websight-test-voice') {
    (async () => {
      chrome.tts.stop();
      if (msg.engine === 'neural') {
        try {
          await ensureOffscreen();
          const res = await chrome.runtime.sendMessage({ type: 'websight-tts-play', text: msg.text, lang: 'en', rate: msg.rate, url: msg.url });
          if (res && res.ok) return;
        } catch {
          /* fall through to the system voice */
        }
      }
      const voiceName = msg.voiceName || (await pickVoice('en'));
      chrome.tts.speak(msg.text, { rate: msg.rate, ...(voiceName ? { voiceName } : {}) });
    })();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'websight-history') {
    // The popup loses its DOM every time it closes; the conversation lives
    // here, so hand it back for redisplay.
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return sendResponse({ lines: [] });
      const state = await getTabState(tab.id);
      const lines = [];
      for (const turn of state.history) {
        const text = (turn.parts || []).map((p) => p.text || '').join('');
        if (turn.role === 'user') {
          lines.push({ who: 'You', text });
        } else {
          let answer = text;
          try {
            answer = JSON.parse(text).answer || text;
          } catch {
            /* older entries may not be JSON */
          }
          lines.push({ who: 'AI', text: answer });
        }
      }
      sendResponse({ lines });
    })();
    return true;
  }
});
