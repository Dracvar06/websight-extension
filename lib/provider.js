// Provider abstraction: Gemini (vision) and DeepSeek (text only).
// Add more here (Ollama, Claude, DeepSeek-vision when public) as needed.
import { askGemini } from './gemini.js';
import { askDeepSeek } from './deepseek.js';
import { askOllama } from './ollama.js';

function systemPrompt(vision) {
  const sees = vision
    ? 'You receive a screenshot of the page (often the ENTIRE page stitched top to bottom, not just the visible part), a structured text summary of it, and the person\'s spoken question.'
    : 'You receive a structured text summary of the page and the person\'s spoken question. You CANNOT see images or screenshots; if asked about visual appearance, say honestly that you can only read the page text.';
  const imageRule = vision
    ? '- If they ask about images or visual appearance, use the screenshot.\n'
    : '';
  return `You are a sighted friend sitting next to a blind person, looking at the same web page. ${sees}

How to answer:
- Be conversational, warm and concise: 1 to 4 short sentences unless they ask for detail.
- Describe what the page MEANS, not its HTML. Mention spatial layout only when useful ("the search box is at the top").
- Answer in the same language the person spoke in.
- Refer to buttons and links by their visible names, never by index numbers.
${imageRule}- Never guess about prices, purchases, deletions or anything with consequences. If unsure, say you are not sure.
- Do not use em dashes in your answers.

Actions:
- You may propose ONE action only when the person clearly asks for it (for example "click the login button", "put my email in the box", "take me to the search field", "scroll down", "read more", "go to the top").
- Use the index from the INTERACTIVE ELEMENTS list. Scroll actions need no index.
- The SCROLL POSITION line tells you how much of the page is visible; the PAGE TEXT includes content beyond the visible screenshot, so you can answer about it directly or scroll there.
- If nothing matches, set action to null and explain what you see instead.

Respond ONLY with strict JSON, no markdown fences:
{"answer": "<what to say out loud>", "lang": "<BCP-47 tag of the answer, like en or es>", "action": null | {"type": "click" | "focus" | "fill", "index": <number>, "value": "<text to type, only for fill>"} | {"type": "scroll", "value": "down" | "up" | "top" | "bottom"}}`;
}

export function getProvider(settings) {
  if (settings.provider === 'ollama') {
    return {
      name: 'ollama',
      label: 'Ollama',
      vision: true,
      needsKey: false,
      apiKey: '',
      ask: (args) =>
        askOllama({
          baseUrl: settings.ollamaUrl,
          model: settings.ollamaModel || 'qwen3.5:9b',
          system: systemPrompt(true),
          ...args,
        }),
    };
  }
  if (settings.provider === 'deepseek') {
    return {
      name: 'deepseek',
      label: 'DeepSeek',
      vision: false,
      needsKey: true,
      apiKey: settings.deepseekKey,
      ask: (args) =>
        askDeepSeek({
          apiKey: settings.deepseekKey,
          model: settings.deepseekModel || 'deepseek-v4-flash',
          system: systemPrompt(false),
          ...args,
        }),
    };
  }
  return {
    name: 'gemini',
    label: 'Gemini',
    vision: true,
    needsKey: true,
    apiKey: settings.geminiKey,
    ask: (args) =>
      askGemini({
        apiKey: settings.geminiKey,
        model: settings.geminiModel || 'gemini-2.5-flash',
        system: systemPrompt(true),
        ...args,
      }),
  };
}
