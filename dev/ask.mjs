// Asks the model about a page saved by e2e.mjs, without a browser, to try
// prompt changes quickly. The screenshot is not used (text only).
//   node ask.mjs results/<file>.json "When does the winter quarter start?"
import { readFileSync } from 'node:fs';
import { getProvider } from '../lib/provider.js';

const [file, question] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(file, 'utf8')).steps.filter((s) => s.pageText);
const pageText = steps[0].pageText;
const provider = getProvider({ provider: 'ollama', ollamaModel: process.env.WS_MODEL || 'gemma4:e4b' });
const t0 = Date.now();
const result = await provider.ask({ history: [], question, pageText, screenshotBase64: '' });
console.log(JSON.stringify(result), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
