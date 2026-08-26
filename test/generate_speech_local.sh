#!/bin/bash
# Generate the Timon benchmark audio corpus locally with macOS `say`.
# No API key required. Output files are written to $AUDIO_DIR/timon_test_<ID>.wav
# (16 kHz mono PCM WAV) matching the IDs in test/corpus.json.
#
# Voice map follows the corpus `accent` field:
#   american    -> Samantha (en_US)
#   british     -> Daniel   (en_GB)
#   australian  -> Karen    (en_AU)
#   indian      -> Rishi    (en_IN)
#
# Usage: test/generate_speech_local.sh
# Env:   AUDIO_DIR (default /tmp)

set -e

AUDIO_DIR="${AUDIO_DIR:-/tmp}"
CORPUS_FILE="test/corpus.json"

if [ ! -f "$CORPUS_FILE" ]; then
  echo "Error: corpus file not found at $CORPUS_FILE (run from repo root)"
  exit 1
fi

command -v say >/dev/null 2>&1 || { echo "Error: macOS 'say' required"; exit 1; }
command -v afconvert >/dev/null 2>&1 || { echo "Error: macOS 'afconvert' required"; exit 1; }

for i in $(seq 0 19); do
  ENTRY=$(jq -r ".[$i]" "$CORPUS_FILE")
  ID=$(echo "$ENTRY" | jq -r '.id')
  TEXT=$(echo "$ENTRY" | jq -r '.text')
  ACCENT=$(echo "$ENTRY" | jq -r '.accent')

  case "$ACCENT" in
    american)   VOICE="Samantha" ;;
    british)    VOICE="Daniel" ;;
    australian) VOICE="Karen" ;;
    indian)     VOICE="Rishi" ;;
    *)          VOICE="Samantha" ;;
  esac

  AIFF="$AUDIO_DIR/timon_test_$ID.aiff"
  WAV="$AUDIO_DIR/timon_test_$ID.wav"

  say -v "$VOICE" -r 170 -o "$AIFF" "$TEXT"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$AIFF" "$WAV"
  rm -f "$AIFF"
  echo "Generated $WAV (accent=$ACCENT, voice=$VOICE)"
done

echo "Done. $AUDIO_DIR now contains the corpus audio."
