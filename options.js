import { listModels } from './lib/gemini.js';
import { listDeepSeekModels } from './lib/deepseek.js';
import { listOllamaModels } from './lib/ollama.js';
import { listClaudeModels } from './lib/claude.js';
import { listCompatModels } from './lib/openai-compat.js';

const DEFAULTS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.8-flash',
  deepseekKey: '',
  deepseekModel: 'deepseek-v4-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma4:e4b',
  rate: 1.4,
  voiceName: '',
  autoDescribe: true,
  ttsEngine: 'neural',
  ttsUrl: 'http://localhost:8100/v1',
  speechEngine: 'whisper',
  speechLang: 'auto',
  whisperUrl: 'http://localhost:8100/v1',
  whisperKey: '',
  whisperModel: 'deepdml/faster-whisper-large-v3-turbo-ct2',
  aboutMe: '',
  claudeKey: '',
  claudeModel: 'claude-opus-5-5',
  compatService: 'groq',
  compatUrl: '',
  compatKey: '',
  compatModel: '',
  searchEngine: 'searxng',
  searchUrl: 'http://localhost:8888',
  searchKey: '',
};

const el = {};
for (const id of ['provider', 'geminiKey', 'geminiModel', 'deepseekKey', 'deepseekModel', 'ollamaUrl', 'ollamaModel', 'rate', 'voiceName', 'ttsEngine', 'ttsUrl', 'speechEngine', 'speechLang', 'whisperUrl', 'whisperKey', 'whisperModel', 'aboutMe', 'searchEngine', 'searchUrl', 'searchKey', 'claudeKey', 'claudeModel', 'compatService', 'compatUrl', 'compatKey', 'compatModel']) {
  el[id] = document.getElementById(id);
}
const rateValueEl = document.getElementById('rate-value');
const saveStatusEl = document.getElementById('save-status');
const testStatusEl = document.getElementById('test-status');
const micStatusEl = document.getElementById('mic-status');

let saveTimer = null;

async function populateVoices() {
  const voices = await new Promise((resolve) => chrome.tts.getVoices(resolve));
  const sel = el.voiceName;
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Automatic (match answer language)';
  sel.appendChild(auto);
  for (const v of (voices || [])
    .filter((v) => v.voiceName)
    .sort((a, b) => a.voiceName.localeCompare(b.voiceName))) {
    const o = document.createElement('option');
    o.value = v.voiceName;
    o.textContent = `${v.voiceName} (${v.lang || 'unknown language'})`;
    sel.appendChild(o);
  }
}

async function load() {
  await populateVoices();
  const stored = await chrome.storage.local.get(null);
  const s = { ...DEFAULTS, ...stored };
  // Migrate from the single-provider settings of v0.1.
  if (!s.geminiKey && stored.apiKey) s.geminiKey = stored.apiKey;
  if (stored.model && !stored.geminiModel) s.geminiModel = stored.model;
  // Older defaults (2.5 is closed to new accounts, 3.5 is a generation behind) move to the current Flash.
  if (/^gemini-(2\.5|3\.5)-flash$/.test(s.geminiModel)) s.geminiModel = 'gemini-3.8-flash';
  for (const id of Object.keys(el)) el[id].value = s[id];
  document.getElementById('autoDescribe').checked = Boolean(s.autoDescribe);
  rateValueEl.textContent = Number(s.rate).toFixed(1) + 'x';
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({
      provider: el.provider.value,
      geminiKey: el.geminiKey.value.trim(),
      geminiModel: el.geminiModel.value.trim() || DEFAULTS.geminiModel,
      deepseekKey: el.deepseekKey.value.trim(),
      deepseekModel: el.deepseekModel.value.trim() || DEFAULTS.deepseekModel,
      ollamaUrl: el.ollamaUrl.value.trim() || DEFAULTS.ollamaUrl,
      ollamaModel: el.ollamaModel.value.trim() || DEFAULTS.ollamaModel,
      rate: Number(el.rate.value),
      voiceName: el.voiceName.value,
      autoDescribe: document.getElementById('autoDescribe').checked,
      ttsEngine: el.ttsEngine.value,
      ttsUrl: el.ttsUrl.value.trim() || DEFAULTS.ttsUrl,
      speechEngine: el.speechEngine.value,
      speechLang: el.speechLang.value,
      whisperUrl: el.whisperUrl.value.trim() || DEFAULTS.whisperUrl,
      whisperKey: el.whisperKey.value.trim(),
      whisperModel: el.whisperModel.value.trim() || DEFAULTS.whisperModel,
      aboutMe: el.aboutMe.value.trim().slice(0, 2000),
      claudeKey: el.claudeKey.value.trim(),
      claudeModel: el.claudeModel.value.trim() || DEFAULTS.claudeModel,
      compatService: el.compatService.value,
      compatUrl: el.compatUrl.value.trim(),
      compatKey: el.compatKey.value.trim(),
      compatModel: el.compatModel.value.trim(),
      searchEngine: el.searchEngine.value,
      searchUrl: el.searchUrl.value.trim() || DEFAULTS.searchUrl,
      searchKey: el.searchKey.value.trim(),
    });
    saveStatusEl.textContent = 'Saved.';
    setTimeout(() => (saveStatusEl.textContent = ''), 2000);
  }, 300);
}

for (const id of Object.keys(el)) el[id].addEventListener('input', save);
document.getElementById('autoDescribe').addEventListener('change', save);

el.rate.addEventListener('input', () => {
  rateValueEl.textContent = Number(el.rate.value).toFixed(1) + 'x';
});

document.getElementById('toggle-keys').addEventListener('click', (e) => {
  const showing = el.geminiKey.type === 'text';
  el.geminiKey.type = el.deepseekKey.type = el.whisperKey.type = el.searchKey.type = el.claudeKey.type = el.compatKey.type = showing ? 'password' : 'text';
  e.target.textContent = showing ? 'Show keys' : 'Hide keys';
});

document.getElementById('test-search').addEventListener('click', async () => {
  const status = document.getElementById('search-status');
  status.textContent = 'Searching ucsb.edu for "undergraduate admission"...';
  const r = await chrome.runtime.sendMessage({
    type: 'websight-test-search',
    settings: { searchEngine: el.searchEngine.value, searchUrl: el.searchUrl.value.trim() || DEFAULTS.searchUrl, searchKey: el.searchKey.value.trim() },
  }).catch((err) => ({ error: String(err) }));
  if (!r || r.error) status.textContent = `The test failed: ${(r && r.error) || 'no answer'}.`;
  else if (!r.results.length) status.textContent = 'Nothing found. The engine may not be running, or the key may be wrong.';
  else status.textContent = `${r.results[0].via === 'sitemap' && el.searchEngine.value !== 'sitemap' ? 'The search engine did not answer, so the sitemap was used. ' : 'Works. '}Top result: ${r.results[0].title || r.results[0].url}`;
});

document.getElementById('test-connection').addEventListener('click', async () => {
  const provider = el.provider.value;
  testStatusEl.className = '';
  let wanted;
  let fetchModels;
  if (provider === 'ollama') {
    wanted = el.ollamaModel.value.trim() || DEFAULTS.ollamaModel;
    fetchModels = () => listOllamaModels(el.ollamaUrl.value.trim() || DEFAULTS.ollamaUrl);
  } else if (provider === 'claude' || provider === 'compat') {
    const key = (provider === 'claude' ? el.claudeKey.value : el.compatKey.value).trim();
    if (!key && !(provider === 'compat' && el.compatService.value === 'custom')) {
      testStatusEl.textContent = 'No API key entered yet.';
      testStatusEl.className = 'bad';
      return;
    }
    wanted = provider === 'claude' ? el.claudeModel.value.trim() || DEFAULTS.claudeModel : el.compatModel.value.trim();
    fetchModels = () =>
      provider === 'claude' ? listClaudeModels(key) : listCompatModels(el.compatService.value, el.compatUrl.value.trim(), key);
  } else {
    const key = (provider === 'deepseek' ? el.deepseekKey.value : el.geminiKey.value).trim();
    if (!key) {
      testStatusEl.textContent = `No ${provider === 'deepseek' ? 'DeepSeek' : 'Gemini'} API key entered yet.`;
      testStatusEl.className = 'bad';
      return;
    }
    wanted = (provider === 'deepseek' ? el.deepseekModel.value : el.geminiModel.value).trim();
    fetchModels = () => (provider === 'deepseek' ? listDeepSeekModels(key) : listModels(key));
  }
  testStatusEl.textContent = 'Testing...';
  try {
    const models = await fetchModels();
    if (!wanted) {
      testStatusEl.textContent = `Connected. Now type a model in the Model field. Some available: ${models.filter((m) => /vision|vl|scout|maverick|gemma|:free|mini|4o|gpt/i.test(m)).slice(0, 8).join(', ') || models.slice(0, 8).join(', ')}`;
      testStatusEl.className = 'bad';
    } else if (models.includes(wanted)) {
      testStatusEl.textContent = `Connected. The model ${wanted} is available. You are good to go.`;
      testStatusEl.className = 'ok';
    } else if (provider === 'ollama') {
      testStatusEl.textContent = models.length
        ? `Ollama is running, but ${wanted} is not installed. Installed models: ${models.join(', ')}. Pull it with: ollama pull ${wanted}`
        : `Ollama is running but has no models. In the terminal run: ollama pull ${wanted}`;
      testStatusEl.className = 'bad';
    } else {
      const suggestions = models.filter((m) => /flash|chat|v4|haiku|vision|vl|scout|maverick|gemma|:free|mini/i.test(m)).slice(0, 8);
      testStatusEl.textContent = `The key works, but the model ${wanted} is NOT available. Try one of: ${suggestions.join(', ') || models.slice(0, 5).join(', ')}`;
      testStatusEl.className = 'bad';
    }
  } catch (err) {
    testStatusEl.textContent =
      provider === 'ollama'
        ? `Could not reach Ollama (${err.status || 'network error'}): ${err.message}. Is the Ollama app running?`
        : `The key was rejected (${err.status || 'network error'}): ${err.message}`;
    testStatusEl.className = 'bad';
  }
});

document.getElementById('test-whisper').addEventListener('click', async () => {
  const whisperStatusEl = document.getElementById('whisper-status');
  const url = (el.whisperUrl.value.trim() || DEFAULTS.whisperUrl).replace(/\/+$/, '');
  whisperStatusEl.textContent = 'Testing...';
  try {
    const res = await fetch(url + '/');
    whisperStatusEl.textContent = `The server at ${url} is reachable (HTTP ${res.status}). You are good to go.`;
  } catch {
    whisperStatusEl.textContent = `Cannot reach ${url}. Is the server running? Vowen's always-on server is http://localhost:58765`;
  }
});

document.getElementById('test-tts').addEventListener('click', async () => {
  const ttsStatusEl = document.getElementById('tts-status');
  const url = (el.ttsUrl.value.trim() || DEFAULTS.ttsUrl).replace(/\/+$/, '');
  ttsStatusEl.textContent = 'Generating a voice sample...';
  try {
    const res = await fetch(`${url}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'speaches-ai/piper-ca_ES-upc_ona-medium',
        voice: 'ona',
        input: 'Hola! Aquesta és la veu neural en català de WebSight.',
        response_format: 'wav',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const audio = new Audio(URL.createObjectURL(await res.blob()));
    audio.playbackRate = Number(el.rate.value) || 1.4;
    audio.play();
    ttsStatusEl.textContent = 'The neural voice server works. You should be hearing a Catalan sample.';
  } catch (err) {
    ttsStatusEl.textContent = `Cannot reach the neural voice server (${err.message}). Start it with run-tts-server.sh from the project folder.`;
  }
});

// Plays the voice that answers will really use: the engine chosen above,
// even before Save.
document.getElementById('test-voice').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'websight-test-voice',
    text: 'This is how WebSight will sound at this speed.',
    rate: Number(el.rate.value),
    engine: el.ttsEngine.value,
    url: el.ttsUrl.value.trim(),
    voiceName: el.voiceName.value,
  });
});

document.getElementById('mic-button').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micStatusEl.textContent = 'Microphone is enabled. The hotkey will listen right away.';
  } catch {
    micStatusEl.textContent = 'Microphone access was denied. Voice input will not work, but you can still type questions.';
  }
});

async function checkShortcuts() {
  const listEl = document.getElementById('shortcut-status');
  listEl.textContent = '';
  const labels = {
    _execute_action: 'Talk (continue the conversation)',
    'new-conversation': 'New conversation',
  };
  const commands = await chrome.commands.getAll();
  for (const c of commands) {
    const li = document.createElement('li');
    const name = labels[c.name] || c.name;
    li.textContent = c.shortcut
      ? `${name}: ${c.shortcut}`
      : `${name}: NOT ASSIGNED. Set it at chrome://extensions/shortcuts`;
    if (!c.shortcut) li.style.color = '#a00';
    listEl.appendChild(li);
  }
}

load();
checkShortcuts();
