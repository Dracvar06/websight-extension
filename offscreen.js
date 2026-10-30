// Offscreen document: plays neural TTS audio (service workers cannot play
// sound). Fetches speech from the local Speaches server and queues it.
// Languages without a neural voice are refused so the background falls back
// to the system voice.
const VOICES = {
  en: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'af_heart' },
  es: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'ef_dora' },
  fr: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'ff_siwis' },
  it: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'if_sara' },
  pt: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'pf_dora' },
  hi: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'hf_alpha' },
  ja: { model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'jf_alpha' },
  zh: { model: 'suronek/Kokoro-82M-v1.1-zh-ONNX', voice: 'zf_xiaoxiao' },
  ca: { model: 'speaches-ai/piper-ca_ES-upc_ona-medium', voice: 'ona' },
};

let queue = [];
let current = null;
let playing = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'websight-tts-play') {
    const base = (msg.lang || '').toLowerCase().split('-')[0];
    const cfg = VOICES[base];
    if (!cfg) {
      sendResponse({ ok: false, reason: 'no neural voice for this language' });
      return false;
    }
    if (!msg.enqueue) stopAll();
    queue.push({ text: msg.text, cfg, rate: msg.rate || 1.4, url: msg.url });
    playNext();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'websight-earcon') {
    earcon(msg.kind);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'websight-tts-stop') {
    stopAll();
    sendResponse({ ok: true });
    return false;
  }
});

function stopAll() {
  queue = [];
  if (current) {
    current.pause();
    URL.revokeObjectURL(current.src);
    current = null;
  }
  playing = false;
}

async function playNext() {
  if (playing || !queue.length) return;
  playing = true;
  const item = queue.shift();
  try {
    const base = (item.url || 'http://localhost:8100/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: item.cfg.model,
        voice: item.cfg.voice,
        input: item.text,
        response_format: 'wav',
      }),
    });
    if (!res.ok) throw new Error(`TTS server HTTP ${res.status}`);
    const blob = await res.blob();
    await new Promise((resolve) => {
      current = new Audio(URL.createObjectURL(blob));
      current.playbackRate = item.rate;
      current.onended = current.onerror = () => {
        if (current) URL.revokeObjectURL(current.src);
        current = null;
        resolve();
      };
      current.play().catch(resolve);
    });
  } catch (err) {
    console.error('WebSight neural TTS failed:', err);
    // Let the background speak this text with the system voice instead.
    chrome.runtime.sendMessage({ type: 'websight-tts-failed', text: item.text, rate: item.rate }).catch(() => {});
  }
  playing = false;
  playNext();
}

// Short sounds that say what an action did, before any words: a sighted
// person sees the page change; these let you hear it.
const EARCONS = {
  working: [[660, 0.06]],
  arrived: [[523, 0.09], [784, 0.14]],
  opened: [[784, 0.1]],
  nothing: [[220, 0.22]],
};

function earcon(kind) {
  const notes = EARCONS[kind];
  if (!notes) return;
  const ctx = new AudioContext();
  let t = ctx.currentTime;
  for (const [freq, length] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + length);
    t += length + 0.03;
  }
  setTimeout(() => ctx.close(), (t - ctx.currentTime) * 1000 + 200);
}
