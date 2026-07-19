// Service worker: receives questions from the popup, captures the page
// (screenshot + structured text), asks the AI, speaks the answer via
// chrome.tts, and executes confirmed actions through the content script.
import { getProvider } from './lib/provider.js';

const DEFAULT_SETTINGS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.5-flash',
  deepseekKey: '',
  deepseekModel: 'deepseek-v4-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3.5:9b',
  rate: 1.4,
  speechLang: 'auto',
  voiceName: '',
};

// Element texts that require a spoken confirmation before acting.
const DANGEROUS = /(buy|purchase|order|pay|checkout|confirm|delete|remove|submit|send|subscribe|transfer|comprar|pagar|pedido|eliminar|borrar|enviar|kaufen|bezahlen|bestellen|löschen|senden|acheter|payer|supprimer|envoyer|acquista|paga|elimina|invia)/i;
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

function speak(text, { lang, rate, enqueue = false, voiceName } = {}) {
  const options = { rate: rate || 1.4, enqueue };
  // A user-chosen voice always wins; otherwise match the answer language.
  if (voiceName) options.voiceName = voiceName;
  else if (lang) options.lang = lang;
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) chrome.storage.session.remove(`tab:${tabId}`);
});

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
    // Content script missing (page loaded before install). Inject and retry.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/page-extract.js', 'content.js'],
    });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function captureScreenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  return downscaleToBase64(dataUrl, 1024);
}

async function downscaleToBase64(dataUrl, maxWidth) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const buffer = await jpeg.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---- main flow ----

async function handleAsk(question) {
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
    if (provider.vision) screenshotBase64 = await captureScreenshot(tab.windowId);
  } catch (err) {
    const msg = 'I could not read this page. Try reloading it and asking again.';
    speak(msg, { rate: settings.rate, voiceName: settings.voiceName });
    return { answer: msg, error: true, detail: String(err) };
  }

  let result;
  try {
    result = await provider.ask({
      history: state.history,
      question,
      pageText: extraction.pageText,
      screenshotBase64,
    });
  } catch (err) {
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

  // Keep history light: text only, no screenshots, last 8 exchanges.
  state.history.push(
    { role: 'user', parts: [{ text: question }] },
    { role: 'model', parts: [{ text: JSON.stringify({ answer: result.answer, action: result.action }) }] }
  );
  state.history = state.history.slice(-16);
  state.elements = extraction.elements;

  if (!result.action) {
    await setTabState(tab.id, state);
    speak(result.answer, { lang: result.lang, rate: settings.rate, voiceName: settings.voiceName });
    return { answer: result.answer };
  }

  const target = extraction.elements.find((e) => e.index === result.action.index);
  const targetName = target ? target.name : 'that element';

  if (target && DANGEROUS.test(targetName)) {
    state.pendingAction = result.action;
    await setTabState(tab.id, state);
    const warning = `${result.answer} This will ${result.action.type} "${targetName}". Press the hotkey and say yes to confirm, or anything else to cancel.`;
    speak(warning, { lang: result.lang, rate: settings.rate, voiceName: settings.voiceName });
    return { answer: warning, pendingConfirmation: true };
  }

  await setTabState(tab.id, state);
  speak(result.answer, { lang: result.lang, rate: settings.rate, voiceName: settings.voiceName });
  return performAction(tab, result.action, settings, state, true);
}

async function performAction(tab, action, settings, state, enqueue = false) {
  let outcome;
  try {
    outcome = await messageTab(tab.id, { type: 'websight-action', action });
  } catch (err) {
    outcome = { ok: false, detail: 'The page changed before I could do that.' };
  }

  let spoken = outcome.detail || (outcome.ok ? 'Done.' : 'That did not work.');
  if (outcome.ok && action.type === 'click') {
    // Give navigations a moment, then report where we ended up.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const { title } = await messageTab(tab.id, { type: 'websight-title' });
      if (title) spoken += ` You are now on: ${title}.`;
    } catch {
      spoken += ' The page is loading.';
    }
  }
  speak(spoken, { rate: settings.rate, enqueue, voiceName: settings.voiceName });
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
