// Gemini Flash provider. Plain REST, no SDK.
// Free tier: get a key at https://aistudio.google.com/apikey
import { parseModelJson } from './json-answer.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Validates the key and reports which flash models this key can use.
export async function listModels(apiKey) {
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}&pageSize=200`);
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
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

export async function askGemini({ apiKey, model, system, history, question, pageText, screenshotBase64 }) {
  const parts = [];
  if (screenshotBase64) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: screenshotBase64 } });
  }
  parts.push({ text: `PAGE CONTEXT:\n${pageText}\n\nUSER SAYS: ${question}` });

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [...history, { role: 'user', parts }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 2048,
    },
  };

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    const err = new Error('Network request to Gemini failed');
    err.detail = String(netErr && netErr.message ? netErr.message : netErr);
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Gemini API error ${res.status}`);
    err.status = res.status;
    try {
      err.detail = (await res.json()).error?.message;
    } catch {
      err.detail = `HTTP ${res.status} ${res.statusText}`;
    }
    console.error('WebSight Gemini error:', err.status, err.detail);
    throw err;
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
  return parseModelJson(text);
}
