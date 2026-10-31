# WebSight - AI sighted friend (Chrome extension)

Talk to an AI that sees the current page and describes it, like a sighted friend
sitting next to you. Built for blind and visually impaired users. Voice in,
voice out, and it can click, focus or fill things when you ask.

## Setup (about 3 minutes)

1. Pick an AI provider:
   - **Gemini** (sees screenshots): https://aistudio.google.com/apikey -
     free tier, about 15 questions per minute and 1,500 per day, no card.
     New accounts must use gemini-3.5-flash or newer (older model names are
     closed to them).
   - **DeepSeek** (text only, cannot see images): https://platform.deepseek.com/api_keys -
     one-time 5 million token free grant for new accounts, no card.
   - **Ollama** (local, sees screenshots): no key, no quota, nothing leaves
     the computer. Install from https://ollama.com, keep the app running, and
     pull a vision model once: `ollama pull gemma4:e4b`. Answers are slower
     than the cloud options. If Test connection reports 403, allow browser
     extensions: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"`
     and restart Ollama.
2. Open `chrome://extensions`, turn on **Developer mode** (top right),
   click **Load unpacked**, and pick this folder.
3. Right-click the WebSight icon, choose **Options**:
   - choose the provider and paste its key, then press **Test connection**
     to confirm the key and model work,
   - press **Enable microphone** and allow it once,
   - set your speaking speed and language.

## Using it

- Press **Alt+Shift+S** (Option+Shift+S on Mac) on any page. Any ongoing
  speech stops, you hear a beep, and it listens. If the hotkey does nothing,
  assign it at `chrome://extensions/shortcuts` - Chrome silently leaves it
  unassigned when another extension already claimed the combo.
- Speak freely: pauses and breaths do NOT cut you off. Send with **Enter** or
  the **Send** button (or Alt+Shift+S inside the window).
- Two speech engines in Settings: **Whisper** (large v3 turbo) understands
  ANY language and auto-detects it; **Browser** needs no key and shows a live
  transcript but is locked to one language.
- Whisper options (set via the server address in Settings):
  - **Local voice server (default)**: `http://localhost:8100/v1`, no key.
    The same always-on server that does the neural voices, so nothing extra
    to start. Free, unlimited, private, about 1 to 4 seconds per question.
  - **Groq cloud**: key from https://console.groq.com/keys, ~2,000
    transcriptions/day free, address `https://api.groq.com/openai/v1`.
  - **Any other OpenAI-compatible or whisper.cpp server**, including one
    bundled with another app. Note that such servers may stop on their own
    (Vowen shuts its server down in resource efficient mode, for example);
    when the configured server does not answer, WebSight automatically uses
    the local voice server instead.
- With the Browser engine, unsent words are restored if the window closes
  mid-dictation. With Whisper, prefer Enter to send: audio is recorded in the
  window and is lost if the window closes before you send.
- Ask anything: "what is this page?", "is there a cheaper option?", "where do
  I unsubscribe?", "click the login button", "scroll down", "open the
  PERSONAL folder".
- Press the hotkey again at any time to interrupt the answer and ask something new.
- Follow-up questions keep context: the conversation for the current tab is
  remembered as you move between pages in that tab, and redisplayed whenever the window
  reopens. Inside the window, press the **Talk** button (or Alt+Shift+S) to
  ask again by voice without closing it, or just type.
- Press **Alt+Shift+N** to start a NEW conversation on the current page:
  it wipes that tab's history and opens the window fresh and listening.
- When a page loads, the extension sweeps it top to bottom photographing
  everything (up to 5 screens, stitched into one tall image), so answers can
  see content far below the fold. The sweep takes about 2 seconds and your
  scroll position is restored. Controlled by the same "Explore each page
  automatically" toggle as the spoken summaries.
- Each tab has its own independent conversation, so you can hold different
  conversations in different tabs at the same time.
- Actions on risky buttons (buy, pay, delete, submit...) are read back first
  and only run after you say "yes".

Change the hotkey at `chrome://extensions/shortcuts` if it clashes with your
screen reader.

## Finding things, and checking them yourself

WebSight's job is to help you find the answer, not to ask you to trust it.

- **Show me where.** An answer from the page comes with the exact line it
  rests on, and the keyboard focus is moved to that line (outlined for a
  sighted helper), so your own screen reader reads the real text. When
  the same line appears twice (UChicago lists "Jan 4, 2027" under two
  plans), the one whose heading matches your question wins, and a short
  card is read whole so the heading comes with the date.
- **Scouting.** When a page loads, up to 30 pages on the same site that its
  menus and links lead to are read quietly in the background as plain text
  (no cookies sent, nothing clicked). If the answer is not on your page,
  the best-matching passages are found by keywords, the AI answers from
  them, and you are taken to that page and put on the line. "Say go back
  to return." Sites that build their text with JavaScript give scouting
  nothing; then it falls back to:
- **Looking via links.** "That is not on this page. Let me look on
  Students." At most two pages, links only, saying where it goes, and
  telling you where you ended up if it found nothing.
- **What actions really did.** The words around a click come from the
  page, not the AI: a new page (named), a menu that opened (and what is in
  it), or "I pressed it, but nothing changed". Short sounds mark working,
  arrived, opened and nothing happened. An AI answer that claims an action
  it did not take ("I've taken you back") is never spoken.
- **Numbers.** A number in an answer that is not written on the page is
  named out loud ("I could not find 39.99 written on the page, so please
  double-check it"). Single digits are only loosely checked, since some
  digit is almost always on the page.
- **No phantom questions.** Whisper turns silence into confident words
  ("you", "Obrigado."); a recording with no real sound in it is never sent.

## Neural voices (default)

The system voices vary a lot by language. For natural speech in every
language, run the bundled neural TTS server (Kokoro + Piper via Speaches,
all local and free):

1. One-time setup is already done in `tts-server/` (a Python venv and the
   voice models, ~400 MB, all inside this folder).
2. The server starts automatically at login and restarts itself if it
   crashes, via the LaunchAgent at
   `~/Library/LaunchAgents/com.websight.tts-server.plist` (the one WebSight
   file outside this folder; it logs to `tts-server/server.log`). To remove
   it: `launchctl bootout gui/$(id -u)/com.websight.tts-server` and delete
   the plist. To run manually instead: `./run-voice-server.sh`.
3. This is the default voice engine; press Test neural voice in Settings to
   hear it. Choose "System voices" there to switch back.

English/Spanish/French/Italian/Portuguese/Hindi/Japanese/Chinese use Kokoro,
Catalan uses Piper (veu "ona"). Languages without a neural voice fall back to
the system voices automatically, as does everything if the server is down.

## How it works

Hotkey opens the popup, which records your question (Whisper on the local
voice server, or the browser's speech engine). The background worker takes a
screenshot of the tab plus a structured text summary (headings, landmarks,
an indexed list of links, buttons and fields with where each link goes,
including links inside closed menus) and sends both to the chosen model
(Gemini, DeepSeek, or Gemma 4 E4B on Ollama) with the conversation history
for that tab. The answer, the line it rests on and any action come back as
JSON. The worker checks the answer against the page (numbers, claimed
actions), scouts or looks via links when it is not there, puts the focus on
the line, and speaks the result.

## Files

- `manifest.json` - Manifest V3, no build step, no dependencies
- `background.js` - orchestrator: capture, AI call, speech, actions, confirmation gate
- `content.js` + `lib/page-extract.js` - page summary, element map, action execution
- `lib/provider.js` - provider abstraction and the shared system prompt
- `lib/gemini.js` + `lib/deepseek.js` + `lib/ollama.js` - REST clients (Gemini and Ollama have vision, DeepSeek is text only)
- `lib/scout.js` - which nearby pages to read and which passages match a question (the reading itself is in `offscreen.js`)
- `lib/check-numbers.js` - numbers in an answer that are not on the page
- `offscreen.js` - plays the neural voice and the sounds; reads scouted pages
- `dev/` - end-to-end tests of the real extension (see Testing)
- `popup.html/js` - voice UI and typed fallback
- `options.html/js` - API key, voice speed, language, microphone
- `test/drive-mock.html` - Drive-like test page (grid items that select on
  click and open on double-click/Enter) for testing extraction and actions
  without the extension: serve the folder and open it in a browser

## Testing

`dev/e2e.mjs` loads the real extension in Chrome for Testing, opens pages,
asks questions by typing (and by a fake microphone), and records what it
says, how long it takes and where the keyboard focus lands. Speech is muted;
the words are logged. Scenarios in `dev/scenarios/` ask follow-up questions
on real sites (UCSB, UChicago).

    cd dev && npm install
    curl -LO https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/mac-arm64/chrome-mac-arm64.zip
    mkdir -p browsers/chrome/mac_arm-156.0.8078.80 && ditto -x -k chrome-mac-arm64.zip browsers/chrome/mac_arm-156.0.8078.80
    node e2e.mjs                                    # the test shop page
    WS_SCENARIO=scenarios/explore.json node e2e.mjs  # one real-site scenario
    ./compare.sh gemma4:e4b gemma4:26b-a4b-24k      # everything, per model

(`@puppeteer/browsers install` lost the Frameworks folder when unzipping on
macOS; `ditto` keeps it.) Known gap: the fake microphone records silence in
Chrome for Testing on macOS, so the voice step only checks that silence is
refused; Whisper itself is checked directly against `test/audio`.

### Results, October 31 2026 (Gemma 4 E4B, local)

Every answer was checked by hand against the page it came from.

| Scenario | Questions | Useful answer | Invented a fact | Typical time |
|---|---|---|---|---|
| Test shop page (price, delivery, reviews, click, buy) | 5 | 5 | 0 | 4–8 s |
| UCSB: open a menu, go to Admissions, go back | 3 | 3 | 0 | 5–7 s |
| UChicago admissions (apply, deadlines, tuition) | 5 | 5 | 0 | 5–23 s |
| UChicago deadlines, three plans with shared dates | 3 | 3, focus on the right plan | 0 | 5 s |
| UCSB facts one link away (Nobel laureates, enrolment) | 2 | 2, taken to the line | 0 | 7–10 s |
| UCSB academic calendar, finals, chancellor | 8 | 1 | 0 | 5–23 s |
| Arrival descriptions | 6 | 6 | 0 | 7–13 s |

The weak spot is the UCSB academic calendar: the model keeps choosing the
events calendar, and the Registrar's dates only appear after a year is
picked from a dropdown, so they are not in any page text. It says it could
not find them, which is the right failure. Gemma 4 26B chose better links
but took 15–140 s per answer on a 24 GB Mac and missed deadlines that were
on the page, so E4B is the default.

## Roadmap

- DeepSeek vision once their vision API is publicly available (text-only provider is already in)
- Continuous mode: describe pages as you browse
- Multi-step tasks, full-page scrolling capture, Firefox port
