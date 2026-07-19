// Local Ollama provider: free, unlimited, private, and vision-capable if a
// vision model is pulled (e.g. `ollama pull qwen2.5-vl:7b`). Uses Ollama's
// native /api/chat because the OpenAI-compatible endpoint cannot set num_ctx.
import { parseModelJson } from './json-answer.js';

function base(urlSetting) {
  return (urlSetting || 'http://localhost:11434').replace(/\/+$/, '');
}

export async function askOllama({ baseUrl, model, system, history, question, pageText, screenshotBase64 }) {
  const messages = [{ role: 'system', content: system }];
  for (const turn of history) {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: (turn.parts || []).map((p) => p.text || '').join(''),
    });
  }
  const userMsg = { role: 'user', content: `PAGE CONTEXT:\n${pageText}\n\nUSER SAYS: ${question}` };
  if (screenshotBase64) userMsg.images = [screenshotBase64];
  messages.push(userMsg);

  let res;
  try {
    res = await fetch(`${base(baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: 'json',
        // Skip thinking on reasoning models (qwen3.5); spoken answers need
        // speed, and Ollama silently ignores this on non-thinking models.
        think: false,
        // Default Ollama context is far too small for page text + history.
        options: { temperature: 0.3, num_ctx: 16384 },
      }),
    });
  } catch (netErr) {
    const err = new Error('Could not reach Ollama');
    err.detail = 'Is the Ollama app running? ' + String(netErr && netErr.message ? netErr.message : netErr);
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Ollama error ${res.status}`);
    err.status = res.status;
    try {
      err.detail = (await res.json()).error;
    } catch {
      err.detail = `HTTP ${res.status} ${res.statusText}`;
    }
    console.error('WebSight Ollama error:', err.status, err.detail);
    throw err;
  }

  const data = await res.json();
  return parseModelJson(data.message?.content || '');
}

// Lists locally pulled models; also serves as the connection test.
export async function listOllamaModels(baseUrl) {
  let res;
  try {
    res = await fetch(`${base(baseUrl)}/api/tags`);
  } catch {
    const err = new Error('Could not reach Ollama. Is the app running?');
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}
