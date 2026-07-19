#!/bin/bash
# Local neural text-to-speech (and speech-to-text) server for WebSight,
# powered by Speaches (Kokoro for English/Spanish, Piper for Catalan).
# Models download on first use into tts-server/models (self-contained).
# Extension setting: TTS server address http://localhost:8100
# launchd starts with a minimal PATH that does not include Homebrew.
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/tts-server/src"
export HF_HUB_CACHE="$(dirname "$PWD")/models"
# CoreML chokes on the Piper models on Apple Silicon; CPU is plenty fast.
export UNSTABLE_ORT_OPTS__EXCLUDE_PROVIDERS='["TensorrtExecutionProvider","CoreMLExecutionProvider"]'
exec uv run uvicorn --factory speaches.main:create_app --host 127.0.0.1 --port 8100
