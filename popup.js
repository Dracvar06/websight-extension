// Popup: opened by the global hotkey. Two voice engines:
// - whisper: records audio while you speak (any language, auto-detected) and
//   transcribes it via an OpenAI-compatible endpoint (Groq free tier by
//   default) when you press Send.
// - browser: Chrome's built-in recognition with a live transcript, locked to
//   one language.
// Neither engine ever sends on silence; sending is always a key press.
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const form = document.getElementById('ask-form');
const questionInput = document.getElementById('question');
const talkBtn = document.getElementById('talk');

let busy = false;
let listening = false; // the user wants the mic open

// browser engine state
let recognition = null;
let sendOnEnd = false;
let finalTranscript = '';

// whisper engine state
let recorder = null;
let mediaStream = null;
let audioChunks = [];

let settings = {
  speechEngine: 'browser',
  speechLang: 'auto',
  whisperUrl: 'http://localhost:8100/v1',
  whisperKey: '',
  whisperModel: 'deepdml/faster-whisper-large-v3-turbo-ct2',
};

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function setTalkUI(on) {
  talkBtn.textContent = on ? '\u{1F3A4} Send' : '\u{1F3A4} Talk';
  talkBtn.setAttribute('aria-label', on ? 'Send your spoken question' : 'Talk: ask by voice');
}

function addLine(who, text) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.className = who === 'You' ? 'you' : 'ai';
  label.textContent = who + ': ';
  li.appendChild(label);
  li.appendChild(document.createTextNode(text));
  transcriptEl.appendChild(li);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function beep(freq, ms) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, ms);
  } catch {
    /* audio unavailable */
  }
}

// Typed drafts survive the popup being toggled shut.
function saveDraft() {
  const v = questionInput.value.trim();
  if (v) chrome.storage.session.set({ 'websight-draft': v });
  else chrome.storage.session.remove('websight-draft');
}

async function ask(question) {
  if (busy || !question.trim()) return;
  busy = true;
  chrome.storage.session.remove('websight-draft');
  addLine('You', question);
  setStatus('Thinking...', 'thinking');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'websight-ask', question });
    if (res && res.answer) {
      addLine('AI', res.answer);
      if (res.note) addLine('Details', res.note);
      if (res.error && res.detail) addLine('Details', res.detail);
      setStatus(res.error ? 'There was a problem.' : 'Press Talk or Alt+Shift+S to ask again.', res.error ? 'error' : '');
    } else {
      setStatus('No answer came back. Try again.', 'error');
    }
  } catch {
    setStatus('Could not talk to the extension. Try again.', 'error');
  }
  busy = false;
  questionInput.focus();
}

// ---- whisper engine: record, then transcribe on send ----

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus('Microphone is blocked. Enable it in Settings, or type your question.', 'error');
    questionInput.focus();
    return;
  }
  audioChunks = [];
  recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => {
    if (e.data.size) audioChunks.push(e.data);
  };
  recorder.start();
  listening = true;
  setTalkUI(true);
  beep(880, 120);
  setStatus('Recording with Whisper... pauses are fine, any language works. Press Enter or Send when you are done.', 'listening');
}

// Convert the recording to 16 kHz mono WAV: whisper.cpp's server needs WAV
// (no ffmpeg required this way) and every cloud endpoint accepts it too.
async function toWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + mono.length * 2));
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  out.setUint32(4, 36 + mono.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  writeStr(36, 'data');
  out.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

function stopRecordingAndSend() {
  if (!recorder || recorder.state === 'inactive') return;
  listening = false;
  setTalkUI(false);
  beep(440, 100);
  recorder.onstop = async () => {
    mediaStream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = [];
    if (blob.size < 1000) {
      setStatus('I did not record anything. Press Talk to try again, or type.');
      return;
    }
    setStatus('Transcribing...', 'thinking');
    try {
      const text = await transcribe(await toWav(blob));
      const typed = questionInput.value.trim();
      questionInput.value = '';
      const question = (typed ? typed + ' ' : '') + text;
      if (question.trim()) ask(question);
      else setStatus('I did not hear any words. Press Talk to try again, or type.');
    } catch (err) {
      setStatus('Transcription failed: ' + err.message + '. You can type instead.', 'error');
      questionInput.focus();
    }
  };
  recorder.stop();
}

// The always-on local voice server, used as a backup whenever the configured
// transcription server is unreachable (for example Vowen's bundled server
// sleeping in resource efficient mode).
const LOCAL_VOICE_SERVER = {
  url: 'http://localhost:8100/v1',
  model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
};

async function transcribe(blob) {
  const configured = {
    url: (settings.whisperUrl || LOCAL_VOICE_SERVER.url).replace(/\/+$/, ''),
    model: settings.whisperModel || LOCAL_VOICE_SERVER.model,
    key: settings.whisperKey,
  };
  try {
    return await transcribeWith(blob, configured);
  } catch (err) {
    if (configured.url === LOCAL_VOICE_SERVER.url) throw err;
    // Configured server is down or refused: fall back to the local one.
    try {
      const text = await transcribeWith(blob, LOCAL_VOICE_SERVER);
      setStatus('Used the local voice server because the configured one did not answer.');
      return text;
    } catch {
      throw err;
    }
  }
}

async function transcribeWith(blob, { url, model, key }) {
  const body = new FormData();
  body.append('file', blob, 'question.wav');
  body.append('model', model);
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(`${url}/audio/transcriptions`, { method: 'POST', headers, body });
    if (res.status === 404) {
      // whisper.cpp's server (Vowen's included) uses /inference instead of
      // the OpenAI path, and transcribes as English unless told to detect.
      const alt = new FormData();
      alt.append('file', blob, 'question.wav');
      alt.append('language', 'auto');
      res = await fetch(`${url}/inference`, { method: 'POST', headers, body: alt });
    }
  } catch {
    throw new Error('could not reach the transcription service');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json()).error?.message || detail;
    } catch {
      /* body not JSON */
    }
    if (res.status === 401) detail = 'the transcription API key was rejected. Check it in Settings';
    throw new Error(detail);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

// ---- browser engine: live transcript, one language ----

function startListening() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    setStatus('Voice input is not available. Type your question.');
    questionInput.focus();
    return;
  }
  recognition = new Rec();
  if (settings.speechLang && settings.speechLang !== 'auto') recognition.lang = settings.speechLang;
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalTranscript += result[0].transcript + ' ';
      else interim += result[0].transcript;
    }
    questionInput.value = (finalTranscript + interim).replace(/\s+/g, ' ').trim();
    saveDraft();
  };
  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      listening = false;
      setTalkUI(false);
      setStatus('Microphone is blocked. Enable it in Settings, or type your question.', 'error');
      questionInput.focus();
    }
    // 'no-speech' and 'aborted' are normal during a long pause.
  };
  recognition.onend = () => {
    if (listening) {
      // Chrome ends recognition sessions on its own after silence;
      // keep the mic open until the user says to send.
      setTimeout(() => {
        if (listening) {
          try {
            recognition.start();
          } catch {
            /* already restarting */
          }
        }
      }, 150);
    } else if (sendOnEnd) {
      sendOnEnd = false;
      const q = questionInput.value.trim();
      questionInput.value = '';
      finalTranscript = '';
      if (q) ask(q);
      else setStatus('I did not hear anything. Press Talk to try again, or type.');
    }
  };

  recognition.start();
  listening = true;
  setTalkUI(true);
  beep(880, 120);
  setStatus('Listening with the BROWSER engine (single language - switch to Whisper in Settings for any language)... Press Enter or Send when you are done.', 'listening');
}

function stopListeningAndSend() {
  if (!recognition || !listening) return;
  listening = false;
  sendOnEnd = true;
  setTalkUI(false);
  beep(440, 100);
  recognition.stop();
}

// ---- shared control flow ----

function whisperMode() {
  return settings.speechEngine === 'whisper';
}

function talk() {
  if (busy) return;
  if (listening) {
    if (whisperMode()) stopRecordingAndSend();
    else stopListeningAndSend();
    return;
  }
  chrome.runtime.sendMessage({ type: 'websight-stop-speech' }).catch(() => {});
  if (whisperMode()) {
    startRecording();
  } else {
    // Seed with anything already typed or restored, so speech appends to it.
    finalTranscript = questionInput.value.trim() ? questionInput.value.trim() + ' ' : '';
    startListening();
  }
}

talkBtn.addEventListener('click', talk);

// Same combo as the global hotkey: starts listening, or sends if listening.
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    talk();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (listening && whisperMode()) {
    // Enter while recording means: done talking, transcribe and send.
    stopRecordingAndSend();
    return;
  }
  listening = false;
  sendOnEnd = false;
  if (recognition) recognition.abort();
  setTalkUI(false);
  const q = questionInput.value;
  questionInput.value = '';
  finalTranscript = '';
  ask(q);
});

questionInput.addEventListener('input', saveDraft);

async function restoreConversation() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'websight-history' });
    for (const line of res && res.lines ? res.lines : []) addLine(line.who, line.text);
  } catch {
    /* no history available */
  }
}

(async function init() {
  // Opening the popup doubles as the interrupt gesture: kill ongoing speech.
  chrome.runtime.sendMessage({ type: 'websight-stop-speech' }).catch(() => {});
  questionInput.focus();
  await restoreConversation();
  settings = await chrome.storage.local.get(settings);
  const { 'websight-draft': draft } = await chrome.storage.session.get('websight-draft');
  if (draft) questionInput.value = draft;
  talk();
})();
