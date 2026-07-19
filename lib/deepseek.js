// DeepSeek provider. OpenAI-compatible REST, no SDK. TEXT ONLY: the public
// DeepSeek API has no vision endpoint, so screenshots are never sent.
// New accounts get a one-time 5M token grant: https://platform.deepseek.com
import { parseModelJson } from './json-answer.js';

const BASE = 'https://api.deepseek.com';

export async function askDeepSeek({ apiKey, model, system, history, question, pageText }) {
  const messages = [{ role: 'system', content: system }];
  // History is stored in Gemini shape ({role, parts}); convert.
  for (const turn of history) {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: (turn.parts || []).map((p) => p.text || '').join(''),
    });
  }
  messages.push({ role: 'user', content: `PAGE CONTEXT:\n${pageText}\n\nUSER SAYS: ${question}` });

  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });
  } catch (netErr) {
    const err = new Error('Network request to DeepSeek failed');
    err.detail = String(netErr && netErr.message ? netErr.message : netErr);
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`DeepSeek API error ${res.status}`);
    err.status = res.status;
    try {
      err.detail = (await res.json()).error?.message;
    } catch {
      err.detail = `HTTP ${res.status} ${res.statusText}`;
    }
    console.error('WebSight DeepSeek error:', err.status, err.detail);
    throw err;
  }

  const data = await res.json();
  return parseModelJson(data.choices?.[0]?.message?.content || '');
}

// Validates the key and reports which models it can use.
export async function listDeepSeekModels(apiKey) {
  const res = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
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
