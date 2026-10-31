// Claude (Anthropic) provider. Messages API over plain fetch, no SDK: the
// extension has no build step to bundle one. Sees screenshots.
// Key from https://platform.claude.com, paid per use.
import { parseModelJson } from './json-answer.js';

const BASE = 'https://api.anthropic.com/v1';

function headers(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
    // The key is the person's own and stays in this extension's storage.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

export async function askClaude({ apiKey, model, system, history, question, pageText, screenshotBase64 }) {
  const messages = [];
  // History is stored in Gemini shape ({role, parts}); convert.
  for (const turn of history) {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: (turn.parts || []).map((p) => p.text || '').join('') || '(empty)',
    });
  }
  const content = [];
  if (screenshotBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } });
  }
  content.push({ type: 'text', text: `PAGE CONTEXT:\n${pageText}\n\nUSER SAYS: ${question}` });
  messages.push({ role: 'user', content });

  let res;
  try {
    res = await fetch(`${BASE}/messages`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system,
        messages,
        // Spoken answers about one page: quick beats deep.
        output_config: { effort: 'low' },
      }),
    });
  } catch (netErr) {
    const err = new Error('Network request to Claude failed');
    err.detail = String(netErr && netErr.message ? netErr.message : netErr);
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Claude API error ${res.status}`);
    // 529 is Anthropic's "overloaded": treat it like any busy service.
    err.status = res.status === 529 ? 503 : res.status;
    try {
      err.detail = (await res.json()).error?.message;
    } catch {
      err.detail = `HTTP ${res.status} ${res.statusText}`;
    }
    throw err;
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    return { answer: 'Claude declined to answer this one. Try asking another way.', lang: 'en', action: null };
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseModelJson(text);
}

// Validates the key and reports which models it can use.
export async function listClaudeModels(apiKey) {
  const res = await fetch(`${BASE}/models?limit=100`, { headers: headers(apiKey) });
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
