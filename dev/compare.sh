#!/bin/sh
# Runs every scenario plus the shop page on each model given, one after the
# other, and unloads each model afterwards so memory is given back.
#   ./compare.sh gemma4:e4b gemma4:26b-a4b-24k
cd "$(dirname "$0")"
for model in "$@"; do
  echo "=== $model"
  WS_MODEL=$model node e2e.mjs
  for s in scenarios/actions.json scenarios/explore.json scenarios/ucsb.json scenarios/uchicago.json scenarios/deadline.json scenarios/scout.json scenarios/scout2.json; do
    WS_MODEL=$model WS_SCENARIO=$s node e2e.mjs
  done
  ollama stop "$model"
done
