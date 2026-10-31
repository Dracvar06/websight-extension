// End-to-end test of the real extension in Chrome for Testing: loads it
// unpacked, opens pages, lets it describe them, asks questions by voice (a
// fake microphone playing test/audio) and by typing, and records what it
// says and how long each step takes.
//
//   cd dev && npm install && npx @puppeteer/browsers install chrome@stable --path browsers
//   node e2e.mjs                      # fixture page, Ollama
//   WS_MODEL=gemma4:e4b node e2e.mjs
//   WS_PAGES=https://en.wikipedia.org/wiki/Kettle node e2e.mjs   # describe real pages only
//
// Results go to dev/results/<time>.json. Needs Ollama and the local voice
// server running (see the README).
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODEL = process.env.WS_MODEL || 'gemma4:e4b';
const ANSWER_TIMEOUT = 180000;

function findChrome() {
  const base = join(here, 'browsers', 'chrome');
  const build = readdirSync(base).sort().pop();
  return join(base, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
}

// Serves dev/fixtures on a local port.
function serveFixtures() {
  const server = createServer((req, res) => {
    try {
      const body = readFileSync(join(here, 'fixtures', (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'shop.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    pipe: true,
    enableExtensions: [root],
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${process.env.WS_MIC_FILE || join(root, 'test', 'audio', 'test-en.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const results = { model: MODEL, started: new Date().toISOString(), steps: [] };
  const server = await serveFixtures();
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
    const sw = await swTarget.worker();
    const extensionId = new URL(swTarget.url()).host;
    // The worker is reachable a moment before the extension APIs are bound.
    while (!(await sw.evaluate(() => typeof chrome === 'object' && !!chrome.storage))) await sleep(100);

    // Settings as a user of the local mode would have them, plus a log of
    // everything spoken. Muted: the test records the words, it does not
    // read them aloud on the laptop.
    const setUp = async () => {
      await sw.evaluate(async (model) => {
        await chrome.storage.local.set({
          provider: 'ollama',
          ollamaModel: model,
          speechEngine: 'whisper',
          ttsEngine: 'system',
          autoDescribe: true,
        });
        if (!globalThis.__spokenLog) {
          globalThis.__spokenLog = [];
          chrome.tts.speak = (text, options, cb) => {
            globalThis.__spokenLog.push({ t: Date.now(), text });
            if (typeof cb === 'function') cb();
          };
        }
      }, MODEL);
    };
    await setUp();
    await sw.evaluate(() => (globalThis.WEBSIGHT_TRACE = true));
    sw.on('console', (m) => m.text().startsWith('[websight]') && console.log('  ' + m.text()));
    const spoken = () => sw.evaluate(() => globalThis.__spokenLog || []);
    const waitForSpeech = async (since, timeout = ANSWER_TIMEOUT) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const said = (await spoken()).filter((s) => s.t >= since);
        if (said.length) return said;
        await sleep(250);
      }
      return [];
    };

    // A scenario is a page plus questions asked one after another in the
    // same conversation, as a person would (dev/scenarios/*.json).
    const scenario = process.env.WS_SCENARIO ? JSON.parse(readFileSync(process.env.WS_SCENARIO, 'utf8')) : null;
    if (scenario) results.scenario = process.env.WS_SCENARIO;
    const pages = scenario
      ? [scenario.url]
      : process.env.WS_PAGES
      ? process.env.WS_PAGES.split(',')
      : [`http://127.0.0.1:${server.address().port}/shop.html`];
    const page = (await browser.pages())[0] || (await browser.newPage());

    for (const url of pages) {
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const said = await waitForSpeech(t0);
      results.steps.push({ step: 'describe on load', url, seconds: (Date.now() - t0) / 1000, said: said.map((s) => s.text) });
      console.log(`describe ${url}: ${((Date.now() - t0) / 1000).toFixed(1)} s\n  ${said.map((s) => s.text).join(' | ') || '(said nothing)'}`);
    }
    if (process.env.WS_PAGES) return;

    // The popup, as the hotkey opens it. It starts recording at once; the
    // fake microphone plays test-en.wav ("What can I click on this page to
    // log in?"), then Enter sends it.
    const openPopup = async () => {
      await page.bringToFront();
      const extension = (await browser.extensions()).get(extensionId);
      await page.triggerExtensionAction(extension);
      const target = await browser.waitForTarget((t) => t.url().startsWith(`chrome-extension://${extensionId}/popup.html`));
      const popup = await target.asPage();
      await popup.waitForSelector('#question');
      return popup;
    };
    const lastAnswer = (popup) =>
      popup.$$eval('#transcript li', (lis) => lis.map((li) => li.textContent).filter((t) => t.startsWith('AI: ')).pop() || '');
    const status = (popup) => popup.$eval('#status', (el) => el.textContent);
    const waitForAnswer = async (popup, before) => {
      const end = Date.now() + ANSWER_TIMEOUT;
      while (Date.now() < end) {
        const answers = await popup.$$eval('#transcript li', (lis) => lis.filter((li) => li.textContent.startsWith('AI: ')).length);
        if (answers > before) return lastAnswer(popup);
        await sleep(250);
      }
      return '(no answer: ' + (await status(popup)) + ')';
    };
    const countAnswers = (popup) => popup.$$eval('#transcript li', (lis) => lis.filter((li) => li.textContent.startsWith('AI: ')).length);
    // What the extension reads from the page, to judge answers against.
    const pageText = () =>
      sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'websight-extract' });
        return r.pageText;
      }).catch((err) => '(could not read: ' + err.message + ')');

    if (scenario) {
      await sw.evaluate(() => chrome.storage.local.set({ speechEngine: 'browser' }));
      for (const question of scenario.questions) {
        const popup = await openPopup();
        await sleep(300);
        await popup.$eval('#question', (el, q) => (el.value = q), question);
        const before = await countAnswers(popup);
        const t0 = Date.now();
        await popup.$eval('#ask-form', (f) => f.requestSubmit());
        // The popup closes when a click moves the tab to another page, as
        // it does for a person; what was said is still in the speech log.
        let answer = await waitForAnswer(popup, before).catch(() => '(popup closed)');
        const seconds = (Date.now() - t0) / 1000;
        // Keep listening until it has been quiet for 8 s: looking on another
        // page closes the popup long before the answer is spoken.
        let said = [];
        for (let quietSince = Date.now(); Date.now() - quietSince < 8000 && Date.now() - t0 < ANSWER_TIMEOUT; ) {
          await sleep(500);
          const now = (await spoken()).filter((x) => x.t >= t0).map((x) => x.text);
          if (now.length !== said.length) quietSince = Date.now();
          said = now;
        }
        if (answer === '(popup closed)') answer = said.join(' ');
        await popup.close().catch(() => {});
        await sleep(3000); // a click may be loading a new page
        const text = await pageText();
        // Where the keyboard focus is on the page: "show me where" puts it on
        // the line the answer came from.
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          return el && el !== document.body ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
        }).catch(() => '');
        console.log('  focus on page:', JSON.stringify(focused));
        const remembered = await sw.evaluate(async () => {
          const all = await chrome.storage.session.get(null);
          return Object.entries(all).filter(([k]) => k.startsWith('tab:')).map(([k, v]) => `${k}=${v.history.length}`).join(' ');
        });
        console.log('  conversation turns stored:', remembered);
        results.steps.push({ step: 'question', question, answer, said, focused, seconds, url: page.url(), pageTextChars: text.length, pageText: text });
        console.log(`Q: ${question}\n  said: ${said.join(' | ')}\n  A: ${answer} (${seconds.toFixed(1)} s, now on ${page.url()}, page text ${text.length} chars)`);
      }
      return;
    }

    {
      const popup = await openPopup();
      await sleep(4500); // the recording is about 3 s long
      const before = await countAnswers(popup);
      const t0 = Date.now();
      // Enter in the question box, which is what submits the form.
      await popup.focus('#question');
      await popup.keyboard.press('Enter');
      await sleep(1500);
      console.log('  status after Enter:', await status(popup));
      const answer = await waitForAnswer(popup, before);
      const heard = await popup.$$eval('#transcript li', (lis) => lis.map((li) => li.textContent).filter((t) => t.startsWith('You: ')).pop() || '');
      results.steps.push({ step: 'voice question', heard, answer, seconds: (Date.now() - t0) / 1000 });
      console.log(`voice: heard "${heard}" -> ${answer} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      await popup.close();
    }

    const typed = [
      ['price', 'How much does it cost?'],
      ['below the fold', 'How long does delivery take?'],
      ['not on the page', 'What do the customer reviews say?'],
      ['action', 'Click the sign in button.'],
      ['dangerous action', 'Buy it.'],
    ];
    // In Whisper mode the popup records from the moment it opens and sends
    // the recording with anything typed; the browser engine just stops.
    await sw.evaluate(() => chrome.storage.local.set({ speechEngine: 'browser' }));
    for (const [step, question] of typed) {
      const popup = await openPopup();
      await sleep(300);
      // Typing: Escape-free path, the form's submit stops the recording.
      await popup.$eval('#question', (el, q) => (el.value = q), question);
      const before = await countAnswers(popup);
      const t0 = Date.now();
      await popup.$eval('#ask-form', (f) => f.requestSubmit());
      let answer = await waitForAnswer(popup, before);
      // Typed text plus whatever the microphone picked up is sent together
      // in Whisper mode; record what was actually asked.
      const asked = await popup.$$eval('#transcript li', (lis) => lis.map((li) => li.textContent).filter((t) => t.startsWith('You: ')).pop() || '');
      await sleep(2000);
      const clicked = await page.evaluate(() => window.__clicked || []);
      results.steps.push({ step, asked, answer, clicked, seconds: (Date.now() - t0) / 1000 });
      console.log(`${step}: asked "${asked}" -> ${answer} [clicked: ${clicked.join(',') || 'nothing'}] (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      await popup.close();
    }
  } finally {
    mkdirSync(join(here, 'results'), { recursive: true });
    const file = join(here, 'results', `${results.started.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(results, null, 2));
    console.log('wrote', file);
    server.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
