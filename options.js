import { listModels } from './lib/gemini.js';
import { listDeepSeekModels } from './lib/deepseek.js';
import { listOllamaModels } from './lib/ollama.js';

const DEFAULTS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.5-flash',
  deepseekKey: '',
  deepseekModel: 'deepseek-v4-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3.5:9b',
  rate: 1.4,
  voiceName: '',
  speechEngine: 'browser',
  speechLang: 'auto',
  whisperUrl: 'https://api.groq.com/openai/v1',
  whisperKey: '',
  whisperModel: 'whisper-large-v3-turbo',
};

const el = {};
for (const id of ['provider', 'geminiKey', 'geminiModel', 'deepseekKey', 'deepseekModel', 'ollamaUrl', 'ollamaModel', 'rate', 'voiceName', 'speechEngine', 'speechLang', 'whisperUrl', 'whisperKey', 'whisperModel']) {
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
  // gemini-2.5-flash (the old default) is closed to new accounts; upgrade it.
  if (s.geminiModel === 'gemini-2.5-flash') s.geminiModel = 'gemini-3.5-flash';
  for (const id of Object.keys(el)) el[id].value = s[id];
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
      speechEngine: el.speechEngine.value,
      speechLang: el.speechLang.value,
      whisperUrl: el.whisperUrl.value.trim() || DEFAULTS.whisperUrl,
      whisperKey: el.whisperKey.value.trim(),
      whisperModel: el.whisperModel.value.trim() || DEFAULTS.whisperModel,
    });
    saveStatusEl.textContent = 'Saved.';
    setTimeout(() => (saveStatusEl.textContent = ''), 2000);
  }, 300);
}

for (const id of Object.keys(el)) el[id].addEventListener('input', save);

el.rate.addEventListener('input', () => {
  rateValueEl.textContent = Number(el.rate.value).toFixed(1) + 'x';
});

document.getElementById('toggle-keys').addEventListener('click', (e) => {
  const showing = el.geminiKey.type === 'text';
  el.geminiKey.type = el.deepseekKey.type = el.whisperKey.type = showing ? 'password' : 'text';
  e.target.textContent = showing ? 'Show keys' : 'Hide keys';
});

document.getElementById('test-connection').addEventListener('click', async () => {
  const provider = el.provider.value;
  testStatusEl.className = '';
  let wanted;
  let fetchModels;
  if (provider === 'ollama') {
    wanted = el.ollamaModel.value.trim() || DEFAULTS.ollamaModel;
    fetchModels = () => listOllamaModels(el.ollamaUrl.value.trim() || DEFAULTS.ollamaUrl);
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
    if (models.includes(wanted)) {
      testStatusEl.textContent = `Connected. The model ${wanted} is available. You are good to go.`;
      testStatusEl.className = 'ok';
    } else if (provider === 'ollama') {
      testStatusEl.textContent = models.length
        ? `Ollama is running, but ${wanted} is not installed. Installed models: ${models.join(', ')}. Pull it with: ollama pull ${wanted}`
        : `Ollama is running but has no models. In the terminal run: ollama pull ${wanted}`;
      testStatusEl.className = 'bad';
    } else {
      const suggestions = models.filter((m) => /flash|chat|v4/i.test(m)).slice(0, 5);
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

document.getElementById('test-voice').addEventListener('click', () => {
  chrome.tts.stop();
  const opts = { rate: Number(el.rate.value) };
  if (el.voiceName.value) opts.voiceName = el.voiceName.value;
  chrome.tts.speak('This is how WebSight will sound at this speed.', opts);
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
