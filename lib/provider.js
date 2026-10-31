// Provider abstraction: Gemini, Claude, OpenAI-style services (OpenAI,
// Groq, OpenRouter) and Ollama see screenshots; DeepSeek reads text only.
import { askGemini } from './gemini.js';
import { askDeepSeek } from './deepseek.js';
import { askOllama } from './ollama.js';
import { askClaude } from './claude.js';
import { askCompat, COMPAT_SERVICES } from './openai-compat.js';

function systemPrompt(vision, aboutMe = '') {
  const sees = vision
    ? 'You receive a screenshot of what is on their screen now, the text and controls of the WHOLE page (including what is below the screen), and the person\'s spoken question.'
    : 'You receive a structured text summary of the page and the person\'s spoken question. You CANNOT see images or screenshots; if asked about visual appearance, say honestly that you can only read the page text.';
  const imageRule = vision
    ? '- If they ask about images or visual appearance, use the screenshot.\n'
    : '';
  return `You are the sighted friend of a blind person, sitting next to them at the computer and looking at the same web page. They use a screen reader, which reads a page one item at a time from top to bottom: they cannot glance at it, skim it, or see its layout, pictures, colours or what stands out. What they are missing is the overview and the shortcuts. That is what you give them. ${sees}

Who you are talking to:
- An adult doing a real task: applying, paying, finding a date, reading the news. Help them get it done.
- They hear every word you say. Every sentence must be worth hearing.

How to answer:
- Lead with what they asked, then stop, unless something else matters for their task.
- Be specific: use the real names, numbers and words on the page ("the Apply Now button", "Early Decision closes November 2"), never vague summaries ("it features various information").
- Say where things are when it helps them get there ("in the menu at the top", "the third item in the list", "at the very bottom").
- Anything in the way comes first: a cookie banner, a popup, a sign-in wall, an error message, a captcha.
- Skip decoration (slogans, stock photos, welcome text, design) unless they ask.
- Refer to buttons and links by their visible names, never by index numbers.
${imageRule}- If you are not sure, say so. Never guess prices, dates, deadlines, names or anything with consequences.
- As long as the answer needs, no longer. A date, a price or a yes/no is one sentence. Steps to follow, several options to choose between, or a summary they asked for can take more: say how many there are first, then give each one briefly, in the same answer ("There are four plans. Early Decision I and Early Action close November 2. Early Decision II and Regular Decision close January 4."). Never announce what you are about to say: say it. Never pad: no restating the question, no "I hope this helps", no offers at the end unless one is truly useful.
- Answer in the language they spoke. Do not use em dashes.

Actions:
- You may propose ONE action only when the person clearly asks for it (for example "click the login button", "put my email in the box", "take me to the search field", "take me there", "open the admissions page", "scroll down", "go to the top").
- Short follow-ups ("take me there", "open it", "that one", "do it") mean the link or button you named in your last answer. Act on it; do not ask which one.
- Follow-up questions ("and its finals?", "what about spring?") are about the same thing as your last answer. If the answer is already in the page text, often on the same line you just quoted, answer from it; open or click something only when it is not.
- Links inside closed menus can be clicked directly; there is no need to open the menu first.
- When they ask to go somewhere or press something, do it: return the action. Do not ask whether to do it; the app itself asks before anything risky.
- When you return an action, keep "answer" to a few words about what you will do. Never say it is done: the app checks what happened and tells them.
- Never say you did something (clicked, opened, went back, scrolled) unless you return that action now.
- Use the index from the INTERACTIVE ELEMENTS list. Scroll and back actions need no index.
- "search" types into a field and presses Enter: {"type": "search", "index": <the search field>, "value": "<what to search for>"}. Use it for "search for...", "look up...". "fill" only types, without sending.
- "back" returns to the previous page, like the browser's back button ("go back", "take me back").
- The SCROLL POSITION line tells you how much of the page is visible; the PAGE TEXT includes content beyond the visible screenshot, so you can answer about it directly or scroll there.
- If nothing matches, set action to null and explain what you see instead.

Revealing what is hidden on this page:
- Many pages hide answers until you choose something: a year in a dropdown, a term in a tab, a collapsed question. Controls show their state in brackets, for example (tab, not selected), (collapsed: opening it shows more) or (now: 2026-2027; options: 2025-2026, 2026-2027).
- If the answer is probably behind one of them, return {"type": "reveal", "index": N} for a tab or collapsed section, or {"type": "reveal", "index": N, "value": "<option text>"} for a dropdown, and in "answer" say in a few words what you will open. The app does it, reads the page again and asks you again.
- Prefer this over looking on another page when the control is right here.

Looking for an answer on another page:
- If the answer is not on this page but a link here is a reasonable place to find it (an academic calendar may be under "Students" or a registrar link; tuition under admissions or financial aid), return {"type": "explore", "index": <that link>} and in "answer" say in a few words where you will look. The app opens it and asks you again there.
- Prefer looking yourself over telling them to check a section, and over offering to look: they cannot easily check, so just look.
- Example: the question is "When does winter quarter start?", the page has no dates, and the list has [86] link: Students -> /students. Answer: {"answer": "Let me look on the Students page.", "lang": "en", "action": {"type": "explore", "index": 86}}
- Only links, never buttons or forms. Pick the most specific link, for example one in a closed menu.
- If no link is a good bet, say so honestly and suggest what they could ask instead.

Showing them where:
- In "quote", copy the exact words from the PAGE TEXT that your answer rests on: one short line, up to about 15 words, copied character for character, not paraphrased. The app puts their screen reader on that line so they can check it themselves. Use "" when the answer is not based on one line of the page (a general description, an action, or "I don't see it").

${aboutMe ? `About the person (written by them; use it when you have to guess what they mean, such as which campus, account or language):\n${aboutMe}\n\n` : ''}Respond ONLY with strict JSON, no markdown fences:
{"answer": "<what to say out loud>", "lang": "<BCP-47 tag of the answer, like en or es>", "quote": "<exact words from the page, or empty>", "action": null | {"type": "click" | "focus" | "fill", "index": <number>, "value": "<text to type, only for fill>"} | {"type": "scroll", "value": "down" | "up" | "top" | "bottom"} | {"type": "back"} | {"type": "explore", "index": <number>} | {"type": "reveal", "index": <number>, "value": "<option, for dropdowns>"} | {"type": "search", "index": <number>, "value": "<text>"}}`;
}

// Cloud models are sometimes busy ("503: this model is currently
// experiencing high demand"), which says nothing about the key. Every call,
// not only the main answer, gets a quick retry; then the local model
// answers, and for a minute after that the busy service is skipped, so
// each question does not wait for it again.
const BUSY = new Set([500, 502, 503, 504]);
let busyUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getProvider(settings) {
  const main = baseProvider(settings);
  if (main.name === 'ollama') return main;
  const local = baseProvider({ ...settings, provider: 'ollama' });
  const useLocal = async (args, why) => {
    console.log(`WebSight: ${main.label} ${why}; the local model answers.`);
    const result = await local.ask({ ...args, screenshotBase64: local.vision ? args.screenshotBase64 : '' });
    return { ...result, backup: local.label };
  };
  return {
    ...main,
    ask: async (args) => {
      if (Date.now() < busyUntil) return useLocal(args, 'was busy a moment ago');
      for (const wait of [0, 1500]) {
        if (wait) await sleep(wait);
        try {
          return await main.ask(args);
        } catch (err) {
          const busy = !err.status || BUSY.has(err.status);
          if (busy && !wait) continue; // one retry
          // Out of prepaid credit or billing paused is the account, not the
          // key or the model name: the local model can still answer.
          const billing = /billing|prepa|credit|cr[eé]dito|facturaci|quota|exhausted/i.test(`${err.detail || ''} ${err.message || ''}`);
          if (!busy && err.status !== 429 && !billing) throw err; // a real problem: the key, the model name
          busyUntil = Date.now() + 60000;
          try {
            return await useLocal(args, err.status === 429 || billing ? 'is at its limit or out of credit' : 'is busy');
          } catch {
            throw err; // the local model is off too: report the original problem
          }
        }
      }
    },
  };
}

function baseProvider(settings) {
  if (settings.provider === 'claude') {
    return {
      name: 'claude',
      label: 'Claude',
      vision: true,
      needsKey: true,
      apiKey: settings.claudeKey,
      ask: (args) =>
        askClaude({
          apiKey: settings.claudeKey,
          model: settings.claudeModel || 'claude-opus-5-5',
          system: systemPrompt(true, settings.aboutMe),
          ...args,
        }),
    };
  }
  if (settings.provider === 'compat') {
    const service = settings.compatService || 'groq';
    const label = (COMPAT_SERVICES[service] && COMPAT_SERVICES[service].label) || 'the AI service';
    return {
      name: 'compat',
      label,
      vision: true,
      needsKey: service !== 'custom',
      apiKey: settings.compatKey,
      ask: (args) =>
        askCompat({
          service,
          url: settings.compatUrl,
          apiKey: settings.compatKey,
          model: settings.compatModel,
          label,
          system: systemPrompt(true, settings.aboutMe),
          ...args,
        }),
    };
  }
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
          model: settings.ollamaModel || 'gemma4:e4b',
          system: systemPrompt(true, settings.aboutMe),
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
          system: systemPrompt(false, settings.aboutMe),
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
        model: settings.geminiModel || 'gemini-3.8-flash',
        system: systemPrompt(true, settings.aboutMe),
        ...args,
      }),
  };
}
