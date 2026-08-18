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
     pull a vision model once: `ollama pull qwen3.5:9b`. Answers are slower
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
  remembered (until you navigate away) and redisplayed whenever the window
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

## Neural voices (optional, recommended)

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
3. In Settings, set Voice engine to "Neural local server" and press
   Test neural voice.

English/Spanish/French/Italian/Portuguese/Hindi/Japanese/Chinese use Kokoro,
Catalan uses Piper (veu "ona"). Languages without a neural voice fall back to
the system voices automatically, as does everything if the server is down.

## How it works

Hotkey opens the popup, which records your question (Web Speech API). The
background worker takes a screenshot of the tab plus a structured text summary
(headings, landmarks, an indexed list of links/buttons/fields) and sends both
to Gemini Flash with the conversation history for that tab. The answer is
spoken with `chrome.tts`. If the model proposes an action, the content script
executes it against the indexed element map.

## Files

- `manifest.json` - Manifest V3, no build step, no dependencies
- `background.js` - orchestrator: capture, AI call, speech, actions, confirmation gate
- `content.js` + `lib/page-extract.js` - page summary, element map, action execution
- `lib/provider.js` - provider abstraction and the shared system prompt
- `lib/gemini.js` + `lib/deepseek.js` - REST clients (Gemini has vision, DeepSeek is text only)
- `popup.html/js` - voice UI and typed fallback
- `options.html/js` - API key, voice speed, language, microphone
- `test/drive-mock.html` - Drive-like test page (grid items that select on
  click and open on double-click/Enter) for testing extraction and actions
  without the extension: serve the folder and open it in a browser

## Roadmap

- DeepSeek vision once their vision API is publicly available (text-only provider is already in)
- Continuous mode: describe pages as you browse
- Multi-step tasks, full-page scrolling capture, Firefox port
