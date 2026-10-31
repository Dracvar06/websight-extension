#!/bin/bash
# One-time setup of WebSight's free helpers on this Mac, all running only on
# this computer:
#   - the voice server: understands speech (Whisper) and speaks with natural
#     voices (Kokoro, Piper for Catalan), on port 8100
#   - the search engine (SearXNG), for "take me to the admissions page", on
#     port 8888
#   - the local AI model (Gemma 4 E4B in Ollama), if Ollama is installed
# Both servers start at login from then on. Safe to run again: anything
# already installed is skipped.
#
# Run it from the WebSight folder:   ./setup-local-servers.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$PWD"
AGENTS="$HOME/Library/LaunchAgents"
step() { printf '\n== %s\n' "$1"; }

step "Checking tools"
if ! command -v brew >/dev/null; then
  echo "Homebrew is needed first. Install it from https://brew.sh, then run this again."
  exit 1
fi
command -v uv >/dev/null || brew install uv
command -v git >/dev/null || brew install git

# Starts a server at login and keeps it running (restarts it if it stops).
start_at_login() {
  local label="$1" script="$2" log="$3"
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key><array><string>$script</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$log</string>
    <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
  # An older copy is stopped first; macOS takes a moment to let go of it,
  # and registering again too soon fails with "Bootstrap failed: 5".
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  for attempt in 1 2 3; do
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist" 2>/dev/null && return 0
    sleep 2
  done
  echo "Could not set $label to start at login. Try: launchctl bootstrap gui/$(id -u) $AGENTS/$label.plist"
  exit 1
}

wait_for() {
  for _ in $(seq 1 90); do
    curl -fs -o /dev/null "$1" && return 0
    sleep 2
  done
  echo "It did not start. Look at the log: $2"
  exit 1
}

mkdir -p "$AGENTS"

step "Voice server (speech recognition and natural voices)"
[ -d tts-server/src ] || git clone --depth 1 https://github.com/speaches-ai/speaches.git tts-server/src
mkdir -p tts-server/models
(cd tts-server/src && uv sync)
start_at_login com.websight.tts-server "$DIR/run-voice-server.sh" "$DIR/tts-server/server.log"
wait_for http://127.0.0.1:8100/v1/models "$DIR/tts-server/server.log"
for model in deepdml/faster-whisper-large-v3-turbo-ct2 speaches-ai/Kokoro-82M-v1.0-ONNX speaches-ai/piper-ca_ES-upc_ona-medium; do
  if [ -d "tts-server/models/models--${model//\//--}" ]; then
    echo "Already downloaded: $model"
  else
    echo "Downloading $model (the speech model is about 1.6 GB)..."
    curl -fs -X POST "http://127.0.0.1:8100/v1/models/$model" >/dev/null
  fi
done

step "Search engine (SearXNG)"
[ -d search-server/src ] || git clone --depth 1 https://github.com/searxng/searxng.git search-server/src
if [ ! -x search-server/.venv/bin/python ]; then
  uv venv -q --python 3.12 search-server/.venv
  VIRTUAL_ENV="$DIR/search-server/.venv" uv pip install -q setuptools wheel
  VIRTUAL_ENV="$DIR/search-server/.venv" uv pip install -q -r search-server/src/requirements.txt -r search-server/src/requirements-server.txt
  VIRTUAL_ENV="$DIR/search-server/.venv" uv pip install -q --no-build-isolation -e search-server/src
fi
if [ ! -f search-server/settings.yml ]; then
  cat > search-server/settings.yml <<YAML
# WebSight's local search engine: only this computer can reach it.
use_default_settings: true
general:
  instance_name: "WebSight search"
search:
  safe_search: 0
  formats:
    - html
    - json
server:
  port: 8888
  bind_address: "127.0.0.1"
  limiter: false
  image_proxy: false
  secret_key: "$(openssl rand -hex 32)"
YAML
fi
pkill -f "searx.webapp" 2>/dev/null || true
start_at_login com.websight.search-server "$DIR/run-search-server.sh" "$DIR/search-server/server.log"
wait_for http://127.0.0.1:8888/healthz "$DIR/search-server/server.log"

step "Local AI model (Ollama)"
if command -v ollama >/dev/null; then
  ollama pull gemma4:e4b
else
  echo "Ollama is not installed, so this was skipped. To add the free, private AI later:"
  echo "install the app from https://ollama.com, open it once, then run: ollama pull gemma4:e4b"
fi

step "Done"
echo "Voice server:  http://127.0.0.1:8100 (starts at login)"
echo "Search engine: http://127.0.0.1:8888 (starts at login)"
echo "To remove them later: launchctl bootout gui/\$(id -u)/com.websight.tts-server"
echo "                      launchctl bootout gui/\$(id -u)/com.websight.search-server"
echo "and delete the two com.websight files in ~/Library/LaunchAgents."
