#!/bin/bash
# Fallback local Whisper server for WebSight (normally unnecessary: Vowen's
# always-on server at http://localhost:58765 does the same job).
# Needs whisper.cpp (brew install whisper-cpp). Reuses Vowen's model to avoid
# a duplicate 1.5 GB download; drops back to models/ if you add a copy there.
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
MODEL="$HOME/Library/Application Support/vowen/models/ggml-large-v3-turbo.bin"
[ -f "models/ggml-large-v3-turbo.bin" ] && MODEL="models/ggml-large-v3-turbo.bin"
if [ ! -f "$MODEL" ]; then
  echo "No Whisper model found. Download one with:"
  echo "  mkdir -p models && curl -L -o models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
  exit 1
fi
exec whisper-server -m "$MODEL" --port 8090 -l auto
