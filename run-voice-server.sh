#!/bin/bash
# Local voice server for WebSight: does BOTH speech-to-text (Whisper
# large-v3-turbo, any language auto-detected) and text-to-speech (Kokoro for
# most languages, Piper for Catalan), via Speaches. Everything runs on this
# computer, free and private. Models live in tts-server/models.
# Extension settings: Whisper server address AND neural voice server address
# both point to http://localhost:8100/v1
# launchd starts with a minimal PATH that does not include Homebrew.
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/tts-server/src"
export HF_HUB_CACHE="$(dirname "$PWD")/models"
# CoreML chokes on the Piper models on Apple Silicon; CPU is plenty fast.
export UNSTABLE_ORT_OPTS__EXCLUDE_PROVIDERS='["TensorrtExecutionProvider","CoreMLExecutionProvider"]'
exec uv run uvicorn --factory speaches.main:create_app --host 127.0.0.1 --port 8100
