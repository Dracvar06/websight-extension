// Service worker: receives questions from the popup, captures the page
// (screenshot + structured text), asks the AI, speaks the answer via
// chrome.tts, and executes confirmed actions through the content script.
import { getProvider } from './lib/provider.js';
import { unverifiedNumbers, numbersNote } from './lib/check-numbers.js';

const DEFAULT_SETTINGS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.5-flash',
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
};

// Element texts that require a spoken confirmation before acting.
const DANGEROUS = /(buy|purchase|order|pay|checkout|confirm|delete|remove|submit|send|subscribe|transfer|comprar|pagar|pedido|eliminar|borrar|enviar|kaufen|bezahlen|bestellen|löschen|senden|acheter|payer|supprimer|envoyer|acquista|paga|elimina|invia)/i;
const CLAIMS_ACTION = /\b(I'?ve|I have|I just|I)\s+(clicked|pressed|opened|taken you|gone|went|scrolled|typed|filled|submitted|navigated|moved you|brought you)\b|^(done|clicked|opened)\b/i;
const NOT_HERE = /\b(don'?t|do not|can'?t|cannot|could ?n[o']t) (see|find)\b|\b(does ?n[o']t|do not|doesn'?t) (have|list|show|mention|include|contain|say)\b|\bno (information|details|mention)\b|\bnot (sure|listed|shown|mentioned|on this page)\b|\bisn'?t (listed|shown|here|on)\b/i;
const IS_QUESTION = /\?$|^(what|when|where|who|whom|which|why|how|is|are|was|were|do|does|did|can|could|should|will|would|has|have|qu[eé]|quan|quin|quina|on|com|qui|cu[aá]ndo|d[oó]nde|qui[eé]n|c[oó]mo|cu[aá]l)\b/i;
// Each decision handleAsk makes, for the end-to-end test (dev/e2e.mjs
// turns it on). Off for everyone else.
function trace(...args) {
  if (globalThis.WEBSIGHT_TRACE) console.log('[websight]', ...args);
}

const PROMISES = /\b(I'?ll|I will|let me|I am going to|I'?m going to|I can)\s+(click|press|open|take you|look|go|check|find|search|navigate)\b/i;
const CONFIRM_WORDS = /^\s*(yes|yeah|yep|sure|confirm|do it|go ahead|sí|si|vale|oui|ja|okay|ok|sim|da)\b/i;

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // Migrate from the single-provider settings of v0.1.
  if (!settings.geminiKey && stored.apiKey) settings.geminiKey = stored.apiKey;
  if (stored.model && !stored.geminiModel) settings.geminiModel = stored.model;
  // gemini-2.5-flash (the old default) is closed to new accounts; upgrade it.
  if (settings.geminiModel === 'gemini-2.5-flash') settings.geminiModel = 'gemini-3.5-flash';
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
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play neural text-to-speech audio for spoken answers',
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

async function scanAndDescribe(tabId, windowId, key) {
  try {
    const settings = await getSettings();
    const provider = getProvider(settings);
    if (provider.vision) {
      const shot = await captureFullPage(tabId, windowId);
      if (shot) fullShots.set(tabId, { key, base64: shot, t: Date.now() });
    }
  } catch {
    /* scan failed (page navigated away, protected page); describe anyway */
  }
  await autoDescribe(tabId, windowId, key);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  describedTabs.delete(tabId);
  tabKeys.delete(tabId);
  fullShots.delete(tabId);
});

async function autoDescribe(tabId, windowId, key) {
  try {
    const settings = await getSettings();
    const provider = getProvider(settings);
    if (provider.needsKey && !provider.apiKey) return;
    const extraction = await messageTab(tabId, { type: 'websight-extract' });
    let screenshotBase64 = '';
    if (provider.vision) {
      const cached = fullShots.get(tabId);
      screenshotBase64 = cached && Date.now() - cached.t < 180000 ? cached.base64 : await captureScreenshot(windowId);
    }
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

async function messageTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Either the page is still loading (right after a click, its content
    // script does not exist yet) or it loaded before the extension did.
    // Wait for the load, then inject if it is still missing.
    await waitForLoad(tabId, 10000);
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/page-extract.js', 'content.js'],
      });
      return chrome.tabs.sendMessage(tabId, msg);
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

// Full-page knowledge: on page load the tab is swept top to bottom and the
// screenshots are stitched into one tall image, so answers can see content
// far below the fold. Cached per tab; capped to keep cost and time sane.
const fullShots = new Map(); // tabId -> { key, base64, t }
const MAX_SCAN_SCREENS = 5;

async function stitchScreenshots(dataUrls, maxWidth) {
  const bitmaps = [];
  for (const u of dataUrls) {
    bitmaps.push(await createImageBitmap(await (await fetch(u)).blob()));
  }
  const scale = Math.min(1, maxWidth / bitmaps[0].width);
  const width = Math.round(bitmaps[0].width * scale);
  const height = bitmaps.reduce((sum, b) => sum + Math.round(b.height * scale), 0);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  let y = 0;
  for (const b of bitmaps) {
    const h = Math.round(b.height * scale);
    ctx.drawImage(b, 0, y, width, h);
    y += h;
  }
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
  return bytesToBase64(new Uint8Array(await jpeg.arrayBuffer()));
}

async function captureFullPage(tabId, windowId) {
  const info = await messageTab(tabId, { type: 'websight-scan-info' });
  const screens = Math.min(info.screens, MAX_SCAN_SCREENS);
  if (screens <= 1) return captureScreenshot(windowId);
  const shots = [];
  for (let i = 0; i < screens; i++) {
    await messageTab(tabId, { type: 'websight-scroll-to', y: i * info.viewportH });
    // Rendering settle time; also respects Chrome's 2-captures/second limit.
    await sleep(600);
    shots.push(await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }));
  }
  await messageTab(tabId, { type: 'websight-scroll-to', y: info.scrollY });
  return stitchScreenshots(shots, 1024);
}

// ---- main flow ----

async function handleAsk(question) {
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
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
    const msg = 'I can only help on regular web pages, and this tab is not one.';
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true };
  }

  const state = await getTabState(tab.id);

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
    // Fall through: treat what they said as a new question.
  }

  let extraction;
  let screenshotBase64 = '';
  try {
    extraction = await messageTab(tab.id, { type: 'websight-extract' });
    if (provider.vision) {
      const cached = fullShots.get(tab.id);
      if (cached && cached.key === pageKey(tab.url) && Date.now() - cached.t < 180000) {
        screenshotBase64 = cached.base64; // whole page, top to bottom
      } else {
        screenshotBase64 = await captureScreenshot(tab.windowId);
      }
    }
  } catch (err) {
    const msg = 'I could not read this page. Try reloading it and asking again.';
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true, detail: String(err) };
  }

  let result;
  let fallbackNote = '';
  try {
    result = await provider.ask({
      history: state.history,
      question,
      pageText: extraction.pageText,
      screenshotBase64,
    });
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
    if (r && r.action && r.action.type === 'click' && IS_QUESTION.test(question.trim())) r.action.type = 'explore';
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
    result = again && again.action ? again : { answer: 'I could not find a way to do that on this page.', lang: result.lang, action: null };
  }
  const firstAnswer = result;
  if (result && !result.action && (NOT_HERE.test(result.answer) || PROMISES.test(result.answer))) {
    // "I don't see that here, I can look if you like": a small model offers
    // instead of looking far more often than it picks a link. Asking it only
    // which link to try is a narrow choice it makes well.
    const pick = await provider
      .ask({
        history: [],
        question: `(Note from the app: the answer to the question below is not on this page. Return the action {"type": "explore", "index": N} with the ONE link most likely to lead to it, and in "answer" a few words on where you will look. If no link is a reasonable bet, return action null.)\n\nQuestion: ${question}`,
        pageText: extraction.pageText,
        screenshotBase64: '',
      })
      .catch(() => null);
    trace('which link?', JSON.stringify(pick && pick.action));
    if (pick && pick.action && pick.action.type === 'explore') result = { ...pick, lang: result.lang || pick.lang };
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
      await messageTab(tab.id, { type: 'websight-action', action: { type: 'click', index: link.index } }).catch(() => null);
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
      extraction = await messageTab(tab.id, { type: 'websight-extract' });
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
    const shown = NOT_HERE.test(result.answer) ? null : await messageTab(tab.id, {
      type: 'websight-show',
      quote: result.quote || '',
      about: `${question} ${result.answer}`,
      numbers: (result.answer.match(/\d[\d.,:/]*\d|\d{2,}/g) || []).filter((n) => !missing.includes(n)),
    }).catch(() => null);
    trace('show me where:', JSON.stringify(result.quote), '->', JSON.stringify(shown));
    if (shown && shown.ok) spoken += ' I have put the cursor on that line, so your screen reader can read it from the page.';
    speak(spoken, { lang: result.lang, rate: settings.rate, voiceName: settings.voiceName });
    return { answer: spoken, note: fallbackNote || undefined };
  }

  const target = extraction.elements.find((e) => e.index === result.action.index);
  result.action.name = target ? target.name : '';

  // What is said around an action is written here, from what the page
  // actually did, never by the model: a model's "I've clicked Buy now"
  // while the app is still waiting for a yes is exactly the kind of words a
  // person who cannot see the screen has no way to check.
  if (target && DANGEROUS.test(target.name)) {
    state.pendingAction = result.action;
    await setTabState(tab.id, state);
    const warning = `That would ${verbFor(result.action)} "${target.name}", which might buy, send or delete something. Nothing has been pressed yet. Press the hotkey and say yes to go ahead, or anything else to cancel.`;
    speak(warning, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: warning, pendingConfirmation: true };
  }

  await setTabState(tab.id, state);
  return performAction(tab, result.action, settings, state);
}

function verbFor(action) {
  return { click: 'press', focus: 'move to', fill: 'type into', back: 'go back' }[action.type] || action.type;
}

function earcon(kind) {
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ type: 'websight-earcon', kind }))
    .catch(() => {});
}

async function snapshot(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'websight-snapshot' });
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
  const say = (text, opts = {}) => speak(text, { rate: settings.rate, voiceName: settings.voiceName, ...opts });
  if (action.type === 'scroll') {
    const outcome = await messageTab(tab.id, { type: 'websight-action', action }).catch(() => ({ ok: false }));
    const spoken = outcome.detail || 'I could not scroll this page.';
    say(spoken);
    return { answer: spoken, actionResult: outcome };
  }

  const name = action.name || 'that';
  earcon('working');
  say(action.type === 'back' ? 'Going back.' : `${verbFor(action)[0].toUpperCase()}${verbFor(action).slice(1)} "${name}".`);
  const before = await snapshot(tab.id);
  let outcome;
  try {
    if (action.type === 'back') {
      await chrome.tabs.goBack(tab.id);
      outcome = { ok: true };
    } else {
      outcome = await messageTab(tab.id, { type: 'websight-action', action });
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
    } else {
      earcon('nothing');
      spoken = `I pressed "${name}", but I cannot see anything change on the page.`;
    }
  }
  say(spoken, { enqueue: true });
  return { answer: spoken, actionResult: outcome };
}

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
    // The neural server failed mid-utterance; recover with the system voice.
    chrome.tts.speak(msg.text, { rate: msg.rate || 1.4 });
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
