// Any service that speaks OpenAI's chat completions API, with screenshots:
// OpenAI itself, Groq (fast, free tier), OpenRouter (many models, some
// free), and "any other AI service" by address (Mistral, xAI, Together, LM
// Studio, and most others offer this same API). Plain fetch, no SDK. A model that cannot see images answers from
// the page text alone when the service refuses the screenshot.
import { parseModelJson } from './json-answer.js';

export const COMPAT_SERVICES = {
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', jsonMode: true },
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1', jsonMode: true },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', jsonMode: false },
};

function base(service, url) {
  return ((service === 'custom' ? url : COMPAT_SERVICES[service]?.url) || url || '').replace(/\/+$/, '');
}

export async function askCompat({ service, url, apiKey, model, system, history, question, pageText, screenshotBase64, label }) {
  if (!model) {
    const err = new Error(`No ${label} model chosen`);
    err.status = 404;
    err.detail = 'Choose a model in Settings; Test connection lists them.';
    throw err;
  }
  const messages = [{ role: 'system', content: system }];
  // History is stored in Gemini shape ({role, parts}); convert.
  for (const turn of history) {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: (turn.parts || []).map((p) => p.text || '').join(''),
    });
  }
  const text = `PAGE CONTEXT:\n${pageText}\n\nUSER SAYS: ${question}`;
  const withImage = screenshotBase64
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } }]
    : text;

  const send = (content) =>
    fetch(`${base(service, url)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [...messages, { role: 'user', content }],
        ...(COMPAT_SERVICES[service]?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        max_tokens: 2048,
      }),
    });

  let res;
  try {
    res = await send(withImage);
    // A text-only model rejects the image with a 400: answer from the text.
    if (res.status === 400 && screenshotBase64) res = await send(text);
  } catch (netErr) {
    const err = new Error(`Network request to ${label} failed`);
    err.detail = String(netErr && netErr.message ? netErr.message : netErr);
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`${label} API error ${res.status}`);
    err.status = res.status;
    try {
      err.detail = (await res.json()).error?.message;
    } catch {
      err.detail = `HTTP ${res.status} ${res.statusText}`;
    }
    throw err;
  }

  const data = await res.json();
  return parseModelJson(data.choices?.[0]?.message?.content || '');
}

// Validates the key and reports which models it can use.
export async function listCompatModels(service, url, apiKey) {
  const res = await fetch(`${base(service, url)}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json()).error?.message || detail;
    } catch {
      /* body not JSON */
    }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}
